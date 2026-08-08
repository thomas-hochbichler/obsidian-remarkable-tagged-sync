/**
 * PROTOTYPE -- ticket 03. Throwaway; the spec keeps the decisions, not this file.
 *
 * `../../vision-ocr-quality/prototype/bench.ts` scores FLAT TEXT. An LLM returns structured
 * Markdown, so scoring it raw charges four character errors for writing `# Heading` where the truth
 * says `Heading` -- the better transcription loses. This is that harness with two changes:
 *
 *   1. Markdown-tolerant normalisation, applied to BOTH sides (`--legacy` restores the old rules,
 *      which is how the re-based Vision baseline is read against the old one).
 *   2. A backend seam at "PNG in, transcript out", so ticket 04 drops a candidate in with one
 *      adapter instead of forking the harness. The route is still open (tickets 01/02/10), so the
 *      transport is a flag, not a hard-wired provider.
 *
 * Everything the shipped Vision path does is carried over verbatim from `bench.ts` -- per-segment
 * true stroke width plus the rescue pass (`vision-ocr-quality/spec.md` §2, §4.2) -- because the
 * control only means something if it reproduces the shipped 26.0 % / 79.5 %.
 *
 *   npx esbuild .scratch/managed-local-llm-ocr/prototype/mdbench.ts --bundle --platform=node \
 *     --format=cjs --external:iconv-lite --outfile=$SCRATCH/mdbench.cjs
 *   node $SCRATCH/mdbench.cjs <corpusDir> [--legacy] [--backend=vision|cmd|dir]
 *     [--cmd='llama-mtmd-cli ... --image {png}'] [--from=<dir>] [--dump=<dir>] [--json=out.json]
 */
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { encodeGrayscalePng } from "../../../src/png-encoder";
import { rasterizePage } from "../../../src/page-rasterizer";
import { parseRmV6, type RmPage, type RmStroke } from "../../../src/rm-parser";
import { clusterStrokes } from "../../../src/margin-notes";
import { sanitizeTranscript } from "../../../pro/llm-transcript";

// ---------------------------------------------------------------------------- the seam

/** One page as a backend returned it. `lines` may hold nulls -- Vision emits observations with no candidate. */
interface PageResult {
	lines: (string | null)[];
	/** Normalised, bottom-left origin. Vision only; the rescue pass needs it and text backends have none. */
	boxes?: { x: number; y: number; w: number; h: number }[];
	error?: string;
}

/**
 * PNG in, transcript out -- the whole contract. A candidate that runs as a child process, one that
 * runs in Obsidian's renderer (route 2 cannot be driven from Node at all), and one that is a pile of
 * files someone produced by hand all satisfy it, which is why the seam sits here and not at a
 * provider interface.
 */
interface Backend {
	name: string;
	/** `names` is parallel to `paths`: the page a shot belongs to, so a `dir` backend can find its file. */
	run(paths: string[], names: string[]): Promise<PageResult[]>;
	/** Vision returns per-line geometry; nothing else does, and the rescue pass is skipped without it. */
	geometry: boolean;
}

// ---------------------------------------------------------------------------- Vision backend

/**
 * The shipped driver's settings only: accurate level, language auto-detect, correction on. Every
 * knob `bench.ts` sweeps was decided by `vision-ocr-quality` and is not open here.
 */
const VISION_OCR_JXA = `
ObjC.import('Foundation');
ObjC.import('Vision');
function ocrOne(path) {
  var fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath($(path))) return { error: 'not_found' };
  var url = $.NSURL.fileURLWithPath($(path));
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;
  req.usesLanguageCorrection = true;
  try { req.automaticallyDetectsLanguage = true; } catch (e) {}
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  var ok = handler.performRequestsError($.NSArray.arrayWithObject(req), $());
  if (!ok) return { error: 'unreadable_image' };
  var res = req.results;
  if (res.isNil()) return { error: 'no_results' };
  var lines = [], boxes = [];
  for (var i = 0; i < res.count; i++) {
    var obs = res.objectAtIndex(i);
    var cands = obs.topCandidates(1);
    if (cands.isNil() || cands.count == 0) { lines.push(null); continue; }
    lines.push(ObjC.unwrap(cands.objectAtIndex(0).string));
    var bb = obs.boundingBox;
    boxes.push({ x: bb.origin.x, y: bb.origin.y, w: bb.size.width, h: bb.size.height });
  }
  return { lines: lines, boxes: boxes };
}
function run(argv) {
  var pages = [];
  for (var j = 0; j < argv.length; j++) {
    var r;
    try { r = ocrOne(argv[j]); } catch (e) { r = { error: 'exception', detail: String(e) }; }
    pages.push(r);
  }
  return JSON.stringify({ pages: pages });
}
`;

const visionBackend: Backend = {
	name: "vision",
	geometry: true,
	run(paths) {
		return new Promise((resolve, reject) => {
			const child = execFile(
				"/usr/bin/osascript",
				["-l", "JavaScript", "-", ...paths],
				{ maxBuffer: 256 * 1024 * 1024, timeout: 600_000 },
				(err, stdout, stderr) => {
					if (err) return reject(new Error(`osascript failed: ${err.message} :: ${stderr}`));
					const pages = (JSON.parse(stdout) as { pages: Partial<PageResult>[] }).pages;
					resolve(pages.map((p) => ({ lines: p.lines ?? [], boxes: p.boxes ?? [], error: p.error })));
				},
			);
			child.stdin!.end(VISION_OCR_JXA);
		});
	},
};

/**
 * Any command that takes a PNG and prints a transcript. `{png}` is substituted; stdout is the
 * transcript, stderr is the model's log noise and is dropped. Sequential on purpose -- a local model
 * owns the machine's RAM and running two would measure contention, not the model.
 *
 * `sanitizeTranscript` is the SHIPPED envelope stripper (`pro/llm-transcript.ts`), not a local
 * re-implementation: a candidate must be scored through the same peeling the plugin would do.
 */
function cmdBackend(template: string): Backend {
	return {
		name: "cmd",
		geometry: false,
		async run(paths) {
			const out: PageResult[] = [];
			for (const png of paths) {
				const parts = template.replace(/\{png\}/g, png).match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
				const argv = parts.map((a) => a.replace(/^['"]|['"]$/g, ""));
				out.push(
					await new Promise<PageResult>((resolve) => {
						execFile(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 }, (err, stdout) => {
							const text = sanitizeTranscript(stdout ?? "");
							resolve({ lines: text ? text.split("\n") : [], error: err ? `cmd: ${err.message.split("\n")[0]}` : undefined });
						});
					}),
				);
			}
			return out;
		},
	};
}

/**
 * Transcripts someone else produced, one `<page>.txt` per page. This is the route-2 escape hatch:
 * a model running inside Obsidian's renderer can never be spawned from here, so it writes files and
 * the harness scores them. It is also how a synthetic hypothesis is fed in to test the metric itself.
 */
function dirBackend(dir: string): Backend {
	return {
		name: `dir:${basename(dir)}`,
		geometry: false,
		async run(_paths, names) {
			return names.map((name) => {
				const file = join(dir, `${name}.txt`);
				if (!existsSync(file)) return { lines: [], error: "no_transcript" };
				const text = sanitizeTranscript(readFileSync(file, "utf8"));
				return { lines: text ? text.split("\n") : [] };
			});
		},
	};
}

// ---------------------------------------------------------------------------- the shipped raster

/** reMarkable's translucent tools (pdf-renderer.ts:87-91). */
const HIGHLIGHTER_PEN_TYPES = new Set([5, 18, 23]);
const isTranslucent = (stroke: RmStroke) => HIGHLIGHTER_PEN_TYPES.has(stroke.penType);

/**
 * `vision-ocr-quality` §2, reproduced exactly: one stroke per segment carrying that segment's own
 * true width (quarter-pixels / 4). The prototype's mechanism, not the shipped one -- but the shipped
 * one draws the same pixels, and this is what produced 26.0 %.
 */
function perPointWidth(page: RmPage): RmPage {
	return {
		...page,
		layers: page.layers.map((l) => ({
			...l,
			strokes: l.strokes.flatMap((s) => {
				if (isTranslucent(s) || s.points.length < 2) return [s];
				const out: RmStroke[] = [];
				for (let i = 0; i < s.points.length - 1; i++) {
					const w = Math.max(s.points[i].width, s.points[i + 1].width);
					out.push({ ...s, brushSize: w > 0 ? w / 4 : s.brushSize, points: [s.points[i], s.points[i + 1]] });
				}
				return out;
			}),
		})),
	};
}

/** Quiet space around a rescued crop (`bench.ts`). */
const CROP_PADDING_PX = 40;
/** `vision-ocr-quality` §4.2 ships the 40 px clusterer. */
const RESCUE_LINE_HEIGHT_PX = 40;

/** Which ink clusters does no observation cover? Frames converted per `bench.ts`; see its comment. */
function uncoveredClusters(page: RmPage, rendered: RmPage, lineHeightPx: number, boxes: PageResult["boxes"]) {
	const all = rendered.layers.flatMap((l) => l.strokes);
	const ink = page.layers.flatMap((l) => l.strokes).filter((s) => !isTranslucent(s));
	if (ink.length === 0) return [];
	const clusters = clusterStrokes(ink, lineHeightPx);

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, pad = 0;
	for (const st of all) {
		pad = Math.max(pad, Math.min(Math.max((st.brushSize > 0 ? st.brushSize : 2) / 2, 0.5), 50));
		for (const pt of st.points) {
			minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
			maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
		}
	}
	minX -= pad; minY -= pad;
	const w = Math.max(1, maxX + pad - minX), h = Math.max(1, maxY + pad - minY);

	return clusters.filter((c) => {
		const cx0 = (c.bounds.minX - minX) / w, cx1 = (c.bounds.maxX - minX) / w;
		const cy0 = 1 - (c.bounds.maxY - minY) / h, cy1 = 1 - (c.bounds.minY - minY) / h;
		const covered = (boxes ?? []).some((b) => {
			const ox = Math.min(cx1, b.x + b.w) - Math.max(cx0, b.x);
			const oy = Math.min(cy1, b.y + b.h) - Math.max(cy0, b.y);
			return ox > 0 && oy > (cy1 - cy0) * 0.3;
		});
		return !covered;
	});
}

/** A cluster's vertical centre in Vision's normalised, bottom-left frame. */
function clusterCenterY(rendered: RmPage, bounds: { minY: number; maxY: number }): number {
	let minY = Infinity, maxY = -Infinity, pad = 0;
	for (const st of rendered.layers.flatMap((l) => l.strokes)) {
		pad = Math.max(pad, Math.min(Math.max((st.brushSize > 0 ? st.brushSize : 2) / 2, 0.5), 50));
		for (const pt of st.points) { minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y); }
	}
	const h = Math.max(1, maxY + pad - (minY - pad));
	return 1 - ((bounds.minY + bounds.maxY) / 2 - (minY - pad)) / h;
}

// ---------------------------------------------------------------------------- normalisation

/**
 * Transport artefacts, both scoring modes. Carried verbatim from `bench.ts`: Unicode form and
 * typographic punctuation measure the keyboard, not the OCR. Case, spelling and real punctuation are
 * untouched -- a wrong capital is a genuine error and costs full price.
 */
function normalizeText(text: string): string {
	return text
		.normalize("NFC")
		.replace(/[‘’ʼ]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[‐-―]/g, "-")
		.replace(/ /g, " ");
}

/** `bench.ts`'s line rules, unchanged: trim, drop a leading bullet GLYPH, collapse runs of space. */
function legacyLine(line: string): string {
	return line.trim().replace(/^[•·◦●▪○*]\s*/, "").trim().replace(/\s+/g, " ");
}

/**
 * The Markdown rules. The line `bench.ts` drew is extended, not moved: MARKUP is a transport
 * artefact and is erased from both sides; TEXT is not touched. `# Heading` and `Heading` are the
 * same transcription of the same ink, and `- item` where the writer drew a bullet must be neither a
 * win nor a loss -- so every list marker goes, including the ones already in the ground truth.
 *
 * The price, stated rather than hidden: a candidate that bullets a page the writer wrote flat pays
 * nothing for it, and one that flattens a hierarchy the writer drew is not caught. Both are
 * structure judgements, and structure is read off the dump, not off CER.
 *
 * Case, spelling, punctuation, `->` arrows and a drawn `-` that is not a list marker all still cost.
 */
function markdownLine(line: string): string[] {
	let s = line.trim();

	// Structure-only lines carry no transcription: a fence, a rule, a table's separator row.
	if (/^(```|~~~)/.test(s)) return [];
	if (/^([-*_])\1{2,}$/.test(s.replace(/\s/g, ""))) return [];
	if (/^\|?[\s:|-]*\|[\s:|-]*$/.test(s) && s.includes("|") && /-/.test(s)) return [];

	// A table row is N cells. Splitting them into lines is what lets order-insensitive recall score a
	// table against a linear ground truth at all -- a flattened row would otherwise be one long line
	// matching nothing. Reading order inside a table is not recoverable, and is not pretended to be.
	if (/^\|.*\|$/.test(s)) {
		return s.slice(1, -1).split("|").flatMap((cell) => markdownLine(cell));
	}

	s = s.replace(/^(>\s*)+/, "");                        // blockquote
	s = s.replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, ""); // ATX heading, both ends
	s = s.replace(/^([-+*]|\d+[.)])\s+/, "");             // list marker -- the space is required, so `->` survives
	s = s.replace(/^\[[ xX]\]\s*/, "");                   // GFM task box, after its marker

	s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");      // link/image -> its text
	s = s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
	s = s.replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1");
	s = s.replace(/(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g, "$1");
	s = s.replace(/`([^`]+)`/g, "$1");

	const out = legacyLine(s);
	return out.length > 0 ? [out] : [];
}

function normalizeLines(text: string, legacy: boolean): string[] {
	const lines = normalizeText(text).split("\n");
	return legacy
		? lines.map(legacyLine).filter((l) => l.length > 0)
		: lines.flatMap(markdownLine);
}

// ---------------------------------------------------------------------------- metrics

/** Levenshtein over characters or words, two-row DP (`bench.ts`). */
function levenshtein(a: ArrayLike<unknown>, b: ArrayLike<unknown>): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = new Uint32Array(b.length + 1);
	let curr = new Uint32Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

function similarity(a: string, b: string): number {
	const max = Math.max(a.length, b.length);
	return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

const LINE_MATCH_THRESHOLD = 0.6;

/** Order-insensitive line recall, greedy best-match (`bench.ts`). */
function lineRecall(truth: string[], hypothesis: string[]): { matched: number; total: number } {
	const used = new Set<number>();
	let matched = 0;
	for (const line of truth) {
		let bestIndex = -1;
		let best = 0;
		for (let i = 0; i < hypothesis.length; i++) {
			if (used.has(i)) continue;
			const s = similarity(line, hypothesis[i]);
			if (s > best) { best = s; bestIndex = i; }
		}
		if (bestIndex >= 0 && best >= LINE_MATCH_THRESHOLD) { used.add(bestIndex); matched++; }
	}
	return { matched, total: truth.length };
}

interface Score { cer: number; wer: number; recall: number; truthChars: number; truthLines: number; dropped: number }

function score(truthText: string, page: PageResult, legacy: boolean): Score {
	const truth = normalizeLines(truthText, legacy);
	const dropped = page.lines.filter((l) => l === null).length;
	const hypothesis = normalizeLines(page.lines.filter((l): l is string => l !== null).join("\n"), legacy);

	const truthJoined = truth.join("\n");
	const hypJoined = hypothesis.join("\n");
	const truthWords = truthJoined.split(/\s+/).filter(Boolean);
	const hypWords = hypJoined.split(/\s+/).filter(Boolean);
	const { matched, total } = lineRecall(truth, hypothesis);

	return {
		cer: truthJoined.length === 0 ? 0 : levenshtein(truthJoined, hypJoined) / truthJoined.length,
		wer: truthWords.length === 0 ? 0 : levenshtein(truthWords, hypWords) / truthWords.length,
		recall: total === 0 ? 1 : matched / total,
		truthChars: truthJoined.length,
		truthLines: total,
		dropped,
	};
}

/**
 * The two pages with no single correct reading order (`vision-ocr-quality` ticket 01): their CER is
 * layout noise. The aggregate still includes them so the number stays comparable with the shipped
 * 26.0 %, but a second aggregate without them is printed beside it.
 */
const RECALL_ONLY = new Set(["Obsidian_Sync_Plugin-a5bb70bc", "Quick_sheets-b5333acc"]);

// ---------------------------------------------------------------------------- runner

const pct = (value: number) => (100 * value).toFixed(1).padStart(5);

async function main() {
	const argv = process.argv.slice(2);
	const dir = argv.find((a) => !a.startsWith("--"));
	if (!dir) {
		console.error("Usage: node mdbench.cjs <corpusDir> [--legacy] [--backend=vision|cmd|dir] [--cmd=...] [--from=<dir>] [--dump=<dir>] [--json=out.json]");
		process.exit(1);
	}
	const legacy = argv.includes("--legacy");
	const kind = argv.find((a) => a.startsWith("--backend="))?.slice(10) ?? "vision";
	const cmd = argv.find((a) => a.startsWith("--cmd="))?.slice(6);
	const from = argv.find((a) => a.startsWith("--from="))?.slice(7);
	const dumpDir = argv.find((a) => a.startsWith("--dump="))?.slice(7);
	const jsonOut = argv.find((a) => a.startsWith("--json="))?.slice(7);

	const backend: Backend =
		kind === "cmd" ? cmdBackend(cmd ?? (() => { throw new Error("--backend=cmd needs --cmd='... {png} ...'"); })())
		: kind === "dir" ? dirBackend(from ?? (() => { throw new Error("--backend=dir needs --from=<dir>"); })())
		: visionBackend;

	const pages = readdirSync(dir)
		.filter((f) => f.endsWith(".rm"))
		.sort()
		.map((f) => ({ name: f.replace(/\.rm$/, ""), rm: join(dir, f), gt: join(dir, `${f.replace(/\.rm$/, "")}.gt.txt`) }))
		.filter((p) => existsSync(p.gt));

	if (pages.length === 0) {
		console.error(`No page in ${dir} has a .gt.txt beside it -- nothing to measure.`);
		process.exit(1);
	}

	const outDir = mkdtempSync(join(tmpdir(), "mdbench-"));
	try {
		const paths: string[] = [];
		for (const [i, page] of pages.entries()) {
			const prepared = perPointWidth(parseRmV6(new Uint8Array(readFileSync(page.rm))));
			const png = join(outDir, `${String(i).padStart(3, "0")}-${page.name}.png`);
			writeFileSync(png, encodeGrayscalePng(rasterizePage(prepared)));
			paths.push(png);
		}

		const started = Date.now();
		const results = await backend.run(paths, pages.map((p) => p.name));
		let msPerPage = (Date.now() - started) / pages.length;

		// The rescue pass (`vision-ocr-quality` §4.2) needs per-line geometry, so it runs for Vision
		// only. A text backend returns a transcript and nothing else -- which is also why "ink with no
		// text over it" is a Vision-specific repair and not a property of the corpus.
		if (backend.geometry) {
			const extra: { owner: number; path: string }[] = [];
			const rescueAt: number[][] = [];
			for (const [i, page] of pages.entries()) {
				const parsed = parseRmV6(new Uint8Array(readFileSync(page.rm)));
				const prepared = perPointWidth(parsed);
				const missed = uncoveredClusters(parsed, prepared, RESCUE_LINE_HEIGHT_PX, results[i]?.boxes);
				rescueAt[i] = missed.map((c) => clusterCenterY(prepared, c.bounds));
				missed.forEach((c, k) => {
					const raw: RmPage = { ...parsed, layers: [{ id: "rescue", name: null, strokes: c.strokes }] };
					const png = join(outDir, `r${String(i).padStart(3, "0")}-${String(k).padStart(3, "0")}.png`);
					writeFileSync(png, encodeGrayscalePng(rasterizePage(perPointWidth(raw), { paddingPx: CROP_PADDING_PX })));
					extra.push({ owner: i, path: png });
				});
			}
			const t = Date.now();
			const rescued = extra.length ? await backend.run(extra.map((e) => e.path), extra.map((e) => pages[e.owner].name)) : [];
			msPerPage += (Date.now() - t) / pages.length;

			let appended = 0;
			const seen = new Map<number, number>();
			extra.forEach((e, k) => {
				const target = results[e.owner];
				const nth = seen.get(e.owner) ?? 0;
				seen.set(e.owner, nth + 1);
				const cy = rescueAt[e.owner]?.[nth] ?? 0;
				for (const line of rescued[k]?.lines ?? []) {
					if (line === null) continue;
					const already = target.lines.some((l) => l !== null && similarity(normalizeLines(l, legacy)[0] ?? "", normalizeLines(line, legacy)[0] ?? "") >= LINE_MATCH_THRESHOLD);
					if (already) continue;
					let at = target.lines.length;
					for (let j = 0; j < (target.boxes?.length ?? 0); j++) {
						if (target.boxes![j].y + target.boxes![j].h / 2 < cy) { at = j; break; }
					}
					target.lines.splice(at, 0, line);
					target.boxes!.splice(at, 0, { x: 0, y: cy, w: 1, h: 0 });
					appended++;
				}
			});
			console.log(`    (rescue: ${extra.length} uncovered clusters, ${appended} new lines after dedup)`);
		}

		console.log(`\n=== ${backend.name}  ·  ${legacy ? "LEGACY (flat-text) scoring" : "Markdown-tolerant scoring"}  ·  ${msPerPage.toFixed(0)} ms/page`);
		console.log(`    ${"page".padEnd(44)} ${"CER%".padStart(6)} ${"WER%".padStart(6)} ${"recall%".padStart(8)}  dropped  err`);

		const report: Record<string, Score> = {};
		let charErrors = 0, chars = 0, matched = 0, lines = 0;
		let linCharErrors = 0, linChars = 0, linMatched = 0, linLines = 0;

		for (const [i, page] of pages.entries()) {
			const result = results[i] ?? { lines: [], error: "missing" };
			if (dumpDir) writeFileSync(join(dumpDir, `${backend.name.replace(/[^\w.-]/g, "_")}--${page.name}.txt`), result.lines.filter((l) => l !== null).join("\n"));
			const s = score(readFileSync(page.gt, "utf8"), result, legacy);
			report[page.name] = s;
			charErrors += s.cer * s.truthChars; chars += s.truthChars;
			matched += s.recall * s.truthLines; lines += s.truthLines;
			if (!RECALL_ONLY.has(page.name)) {
				linCharErrors += s.cer * s.truthChars; linChars += s.truthChars;
				linMatched += s.recall * s.truthLines; linLines += s.truthLines;
			}
			const flag = RECALL_ONLY.has(page.name) ? " (recall only)" : "";
			console.log(`    ${(page.name + flag).padEnd(44)} ${pct(s.cer)} ${pct(s.wer)} ${pct(s.recall).padStart(8)}  ${String(s.dropped).padStart(7)}  ${result.error ?? ""}`);
		}
		console.log(`    ${"TOTAL (all 10 pages)".padEnd(44)} ${pct(chars ? charErrors / chars : 0)} ${"".padStart(6)} ${pct(lines ? matched / lines : 1).padStart(8)}`);
		console.log(`    ${"TOTAL (8 linear pages)".padEnd(44)} ${pct(linChars ? linCharErrors / linChars : 0)} ${"".padStart(6)} ${pct(linLines ? linMatched / linLines : 1).padStart(8)}\n`);

		if (jsonOut) {
			writeFileSync(jsonOut, JSON.stringify({ backend: backend.name, legacy, msPerPage, pages: report }, null, 2));
			console.log(`report written to ${jsonOut}`);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
