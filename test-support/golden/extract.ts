// The render-golden extractor (ticket 12): one plain-text golden per fixture, four sections --
// `## scene`, `## pdf`, `## text layer`, `## raster` -- because those are the four things the
// render cluster deterministically produces from one `.rm` page, and 02c's sabotages spread over
// all four. Three normalisations make the pdf section stable and readable:
//
// - every coordinate is pushed through the CTM into page space, so pdf-lib rephrasing a placement
//   never diffs while ink actually moving always does;
// - 1 decimal for page geometry (0.1 pt ~ 0.035 mm, under what a reader sees, over float noise),
//   2 for widths and type sizes, integers for device px and for colours (0-255, never floats);
// - a path line prints kind counts, box, first and last point, and `sig=`, an 8-hex sha256 over
//   exactly the rounded trace it would print -- the readable part is the box, the signature is
//   what notices a point moving in the middle of a stroke, and it can never flip on noise the
//   display would hide.

import { createHash } from "node:crypto";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { inkBounds, rasterizePage } from "../../src/page-rasterizer";
import { notebookPageFrame, renderPagesToPdf, resolveDeviceCanvas } from "../../src/pdf-renderer";
import type { RmPage } from "../../src/rm-parser";
import { sceneTextPage } from "../../src/scene-text";
import { RENDER_VERSION } from "../../src/sync-engine";

const pt = (n: number) => (Object.is(n, -0) ? "0.0" : n.toFixed(1));
const size2 = (n: number) => n.toFixed(2);
const px = (n: number) => String(Math.round(n));
const color = (c: { red?: number; green?: number; blue?: number } | number[] | null) => {
	if (c === null) return "-";
	const [r, g, b] = Array.isArray(c) ? c : [c.red ?? 0, c.green ?? 0, c.blue ?? 0];
	return [r, g, b].map((v) => Math.round(v * 255)).join(",");
};

// --- the scene section ---------------------------------------------------------------------------

function range(values: number[]): string {
	if (values.length === 0) return "-";
	return `${px(Math.min(...values))}..${px(Math.max(...values))}`;
}

function runLength(values: string[]): string {
	if (values.length === 0) return "-";
	const parts: string[] = [];
	let current = values[0];
	let count = 0;
	for (const value of values) {
		if (value === current) count++;
		else {
			parts.push(`${current}x${count}`);
			current = value;
			count = 1;
		}
	}
	parts.push(`${current}x${count}`);
	return parts.join(" ");
}

function sceneSection(page: RmPage): string[] {
	const lines = ["## scene", `formatVersion ${page.formatVersion}`];
	lines.push(page.paperSize ? `paperSize ${page.paperSize.width}x${page.paperSize.height}` : "paperSize -");
	lines.push(`layers ${page.layers.length}`);
	page.layers.forEach((layer, i) => {
		const anchor = layer.anchor ? `${layer.anchor.anchorId}@${pt(layer.anchor.originX)}` : "-";
		const ids = layer.strokes.length === 0 ? "-" : `${layer.strokes[0].id}..${layer.strokes[layer.strokes.length - 1].id}`;
		lines.push(
			`  layer ${i} name=${layer.name === null ? "null" : JSON.stringify(layer.name)} visible=${layer.visible ?? "-"} anchor=${anchor} placement=${layer.placement ?? "-"} strokes=${layer.strokes.length} ids=${ids}`,
		);
		if (layer.strokes.length > 0) {
			const stamps = layer.strokes.map((stroke) => stroke.timestamp);
			const ordered = [...stamps].every((stamp, j) => j === 0 || stamps[j - 1] <= stamp);
			lines.push(`    timestamps ${runLength(stamps)} ${ordered ? "ascending" : "unordered"}`);
		}
		layer.strokes.forEach((stroke, j) => {
			const rgba = stroke.colorRgba ? `${stroke.colorRgba.r},${stroke.colorRgba.g},${stroke.colorRgba.b}` : "-";
			lines.push(
				`    stroke ${j} pen=${stroke.penType} color=${stroke.color} brush=${size2(stroke.brushSize)} rgba=${rgba} points=${stroke.points.length} x=${range(stroke.points.map((p) => p.x))} y=${range(stroke.points.map((p) => p.y))} width=${range(stroke.points.map((p) => p.width))}`,
			);
		});
	});
	const highlights = page.highlights ?? [];
	lines.push(`highlights ${highlights.length}`);
	highlights.forEach((highlight, i) => {
		lines.push(`  highlight ${i} color=${highlight.color} rects=${highlight.rects.length} text=${JSON.stringify(highlight.text)}`);
	});
	lines.push(`images ${(page.images ?? []).length}`);
	if (page.text) {
		lines.push(
			`text pos=${px(page.text.posX)},${px(page.text.posY)} width=${px(page.text.width)} runs=${page.text.runs.length} styles=${page.text.styles.size}`,
		);
		page.text.runs.forEach((run, i) => lines.push(`  run ${i} deleted=${run.deleted} text=${JSON.stringify(run.text)}`));
	} else {
		lines.push("text -");
	}
	return lines;
}

// --- the pdf section: a small content-stream interpreter -----------------------------------------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: Matrix): Matrix => [
	a[0] * b[0] + a[1] * b[2],
	a[0] * b[1] + a[1] * b[3],
	a[2] * b[0] + a[3] * b[2],
	a[2] * b[1] + a[3] * b[3],
	a[4] * b[0] + a[5] * b[2] + b[4],
	a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: Matrix, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
/** The CTM's isotropic-ish scale, for line widths: the mean of the two axis lengths. */
const scaleOf = (m: Matrix) => (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;

interface Token {
	kind: "number" | "name" | "string" | "operator" | "arrayOpen" | "arrayClose";
	value: string;
}

function tokenize(stream: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < stream.length) {
		const ch = stream[i];
		if (/\s/.test(ch)) i++;
		else if (ch === "%") while (i < stream.length && stream[i] !== "\n") i++;
		else if (ch === "/") {
			let j = i + 1;
			while (j < stream.length && /[^\s/()<>[\]{}%]/.test(stream[j])) j++;
			tokens.push({ kind: "name", value: stream.slice(i + 1, j) });
			i = j;
		} else if (ch === "(") {
			let j = i + 1;
			let depth = 1;
			let text = "";
			while (j < stream.length && depth > 0) {
				const c = stream[j];
				if (c === "\\") {
					const next = stream[j + 1];
					if (next >= "0" && next <= "7") {
						let oct = "";
						let k = j + 1;
						while (k < stream.length && oct.length < 3 && stream[k] >= "0" && stream[k] <= "7") oct += stream[k++];
						text += String.fromCharCode(parseInt(oct, 8));
						j = k;
					} else {
						text += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
						j += 2;
					}
				} else if (c === "(") {
					depth++;
					text += c;
					j++;
				} else if (c === ")") {
					depth--;
					if (depth > 0) text += c;
					j++;
				} else {
					text += c;
					j++;
				}
			}
			tokens.push({ kind: "string", value: text });
			i = j;
		} else if (ch === "<" && stream[i + 1] !== "<") {
			const j = stream.indexOf(">", i);
			const hex = stream.slice(i + 1, j).replace(/\s/g, "");
			let text = "";
			for (let k = 0; k + 1 < hex.length + 1; k += 2) text += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
			tokens.push({ kind: "string", value: text });
			i = j + 1;
		} else if (ch === "[") {
			tokens.push({ kind: "arrayOpen", value: "[" });
			i++;
		} else if (ch === "]") {
			tokens.push({ kind: "arrayClose", value: "]" });
			i++;
		} else if (ch === "<" && stream[i + 1] === "<") {
			i += 2; // dictionaries only appear in inline images, which this renderer never emits
		} else if (ch === ">" && stream[i + 1] === ">") {
			i += 2;
		} else if (/[-+.\d]/.test(ch)) {
			let j = i + 1;
			while (j < stream.length && /[.\d\-+eE]/.test(stream[j])) j++;
			tokens.push({ kind: "number", value: stream.slice(i, j) });
			i = j;
		} else {
			let j = i;
			while (j < stream.length && /[^\s/()<>[\]{}%]/.test(stream[j])) j++;
			tokens.push({ kind: "operator", value: stream.slice(i, j) });
			i = j === i ? i + 1 : j;
		}
	}
	return tokens;
}

interface GraphicsState {
	ctm: Matrix;
	strokeColor: number[] | null;
	fillColor: number[] | null;
	lineWidth: number;
	cap: string;
	join: string;
	alpha: number;
	blend: string;
	fontName: string;
	fontSize: number;
}

interface PageResources {
	fonts: Map<string, string>;
	extGStates: Map<string, { alpha: number; blend: string }>;
}

function readResources(doc: PDFDocument, pageDict: PDFDict): PageResources {
	const fonts = new Map<string, string>();
	const extGStates = new Map<string, { alpha: number; blend: string }>();
	const resolve = (value: unknown): unknown => (value instanceof PDFRef ? doc.context.lookup(value) : value);
	const resources = resolve(pageDict.get(PDFName.of("Resources")));
	if (!(resources instanceof PDFDict)) return { fonts, extGStates };

	const fontDict = resolve(resources.get(PDFName.of("Font")));
	if (fontDict instanceof PDFDict) {
		for (const [key, value] of fontDict.entries()) {
			const font = resolve(value);
			const base = font instanceof PDFDict ? font.get(PDFName.of("BaseFont")) : undefined;
			// pdf-lib suffixes embedded resource names with a random number; strip it or every run diffs.
			fonts.set(key.decodeText(), String(base instanceof PDFName ? base.decodeText() : "?").replace(/-\d+$/, ""));
		}
	}
	const gsDict = resolve(resources.get(PDFName.of("ExtGState")));
	if (gsDict instanceof PDFDict) {
		for (const [key, value] of gsDict.entries()) {
			const gs = resolve(value);
			if (!(gs instanceof PDFDict)) continue;
			const ca = gs.get(PDFName.of("ca")) ?? gs.get(PDFName.of("CA"));
			const bm = gs.get(PDFName.of("BM"));
			extGStates.set(key.decodeText(), {
				alpha: ca === undefined ? 1 : Number(String(ca)),
				blend: bm instanceof PDFName ? bm.decodeText() : "Normal",
			});
		}
	}
	return { fonts, extGStates };
}

function pageContent(doc: PDFDocument, pageIndex: number): { text: string; resources: PageResources } {
	const page = doc.getPage(pageIndex);
	const contents = page.node.Contents();
	const refs: PDFRef[] = [];
	if (contents instanceof PDFRef) refs.push(contents);
	else if (contents instanceof PDFArray) for (const entry of contents.asArray()) if (entry instanceof PDFRef) refs.push(entry);
	let text = "";
	for (const ref of refs) {
		const stream = doc.context.lookup(ref);
		if (stream instanceof PDFRawStream) text += `${new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())}\n`;
	}
	return { text, resources: readResources(doc, page.node) };
}

function pdfSection(doc: PDFDocument): string[] {
	const lines = ["## pdf", `pages ${doc.getPageCount()}`];
	for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex++) {
		const { width, height } = doc.getPage(pageIndex).getSize();
		lines.push(`page ${pageIndex + 1} size=${pt(width)}x${pt(height)}`);
		const { text, resources } = pageContent(doc, pageIndex);
		const tokens = tokenize(text);

		const stack: GraphicsState[] = [];
		let gs: GraphicsState = { ctm: IDENTITY, strokeColor: null, fillColor: null, lineWidth: 1, cap: "butt", join: "miter", alpha: 1, blend: "Normal", fontName: "?", fontSize: 0 };
		let textMatrix: Matrix = IDENTITY;
		let lineMatrix: Matrix = IDENTITY;
		// The path under construction: kind counts, the rounded trace, and its printable points.
		let kinds: Record<string, number> = {};
		let trace: string[] = [];
		let points: { x: number; y: number }[] = [];
		const operands: string[] = [];
		const caps = ["butt", "round", "square"];
		const joins = ["miter", "round", "bevel"];

		const moveTo = (x: number, y: number, kind: string, raw: number[][]) => {
			kinds[kind] = (kinds[kind] ?? 0) + 1;
			const mapped = raw.map(([px_, py]) => apply(gs.ctm, px_, py));
			trace.push(`${kind}:${mapped.map((p) => `${pt(p.x)},${pt(p.y)}`).join(";")}`);
			points.push(...mapped);
		};
		const state = () => {
			const parts: string[] = [];
			if (gs.alpha !== 1) parts.push(`alpha=${gs.alpha}`);
			if (gs.blend !== "Normal") parts.push(`blend=${gs.blend}`);
			return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
		};
		const emitPath = (op: string) => {
			if (points.length === 0) {
				kinds = {};
				trace = [];
				return;
			}
			const xs = points.map((p) => p.x);
			const ys = points.map((p) => p.y);
			const kindText = Object.entries(kinds).map(([k, n]) => `${k}${n}`).join("");
			const sig = createHash("sha256").update(trace.join(" ")).digest("hex").slice(0, 8);
			const paint: string[] = [];
			if (op.toLowerCase().includes("s")) paint.push(`stroke=${color(gs.strokeColor)} w=${size2(gs.lineWidth * scaleOf(gs.ctm))} cap=${gs.cap} join=${gs.join}`);
			if (/[fb]/i.test(op)) paint.push(`fill=${color(gs.fillColor)}`);
			lines.push(
				`  path ${op} ${paint.join(" ")}${state()} ${kindText} box=[${pt(Math.min(...xs))},${pt(Math.min(...ys))} ${pt(Math.max(...xs))},${pt(Math.max(...ys))}] from=(${pt(points[0].x)},${pt(points[0].y)}) to=(${pt(points[points.length - 1].x)},${pt(points[points.length - 1].y)}) sig=${sig}`,
			);
			kinds = {};
			trace = [];
			points = [];
		};

		let cursor: [number, number] = [0, 0];
		for (const token of tokens) {
			if (token.kind !== "operator") {
				if (token.kind === "number" || token.kind === "string" || token.kind === "name") operands.push(token.value);
				continue;
			}
			const nums = operands.map(Number);
			switch (token.value) {
				case "q":
					stack.push({ ...gs });
					break;
				case "Q":
					gs = stack.pop() ?? gs;
					break;
				case "cm":
					gs.ctm = multiply([nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]], gs.ctm);
					break;
				case "w":
					gs.lineWidth = nums[0];
					break;
				case "J":
					gs.cap = caps[nums[0]] ?? String(nums[0]);
					break;
				case "j":
					gs.join = joins[nums[0]] ?? String(nums[0]);
					break;
				case "gs": {
					const ext = resources.extGStates.get(operands[operands.length - 1]);
					if (ext) {
						gs.alpha = ext.alpha;
						gs.blend = ext.blend;
					}
					break;
				}
				case "RG":
					gs.strokeColor = nums.slice(0, 3);
					break;
				case "rg":
					gs.fillColor = nums.slice(0, 3);
					break;
				case "G":
					gs.strokeColor = [nums[0], nums[0], nums[0]];
					break;
				case "g":
					gs.fillColor = [nums[0], nums[0], nums[0]];
					break;
				case "m":
					cursor = [nums[0], nums[1]];
					moveTo(nums[0], nums[1], "m", [[nums[0], nums[1]]]);
					break;
				case "l":
					cursor = [nums[0], nums[1]];
					moveTo(nums[0], nums[1], "l", [[nums[0], nums[1]]]);
					break;
				case "c":
					cursor = [nums[4], nums[5]];
					moveTo(nums[4], nums[5], "c", [
						[nums[0], nums[1]],
						[nums[2], nums[3]],
						[nums[4], nums[5]],
					]);
					break;
				case "v":
				case "y":
					cursor = [nums[2], nums[3]];
					moveTo(nums[2], nums[3], "c", [
						[nums[0], nums[1]],
						[nums[2], nums[3]],
					]);
					break;
				case "h":
					kinds.h = (kinds.h ?? 0) + 1;
					trace.push("h");
					break;
				case "re":
					moveTo(nums[0], nums[1], "re", [
						[nums[0], nums[1]],
						[nums[0] + nums[2], nums[1] + nums[3]],
					]);
					break;
				case "S":
				case "s":
				case "f":
				case "F":
				case "f*":
				case "B":
				case "B*":
				case "b":
				case "b*":
					emitPath(token.value);
					break;
				case "n":
					kinds = {};
					trace = [];
					points = [];
					break;
				case "BT":
					textMatrix = IDENTITY;
					lineMatrix = IDENTITY;
					break;
				case "Tf":
					gs.fontName = resources.fonts.get(operands[operands.length - 2]) ?? operands[operands.length - 2] ?? "?";
					gs.fontSize = nums[nums.length - 1];
					break;
				case "Td":
					lineMatrix = multiply([1, 0, 0, 1, nums[0], nums[1]], lineMatrix);
					textMatrix = lineMatrix;
					break;
				case "TD":
					lineMatrix = multiply([1, 0, 0, 1, nums[0], nums[1]], lineMatrix);
					textMatrix = lineMatrix;
					break;
				case "Tm":
					lineMatrix = [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
					textMatrix = lineMatrix;
					break;
				case "Tj": {
					const at = apply(gs.ctm, textMatrix[4], textMatrix[5]);
					const drawn = operands[operands.length - 1] ?? "";
					lines.push(
						`  text ${JSON.stringify(drawn)} at=(${pt(at.x)},${pt(at.y)}) size=${size2(gs.fontSize * scaleOf(gs.ctm))} font=${gs.fontName} fill=${color(gs.fillColor)}${state()}`,
					);
					break;
				}
				case "Do": {
					const at = apply(gs.ctm, 0, 0);
					const far = apply(gs.ctm, 1, 1);
					lines.push(
						`  xobject ${operands[operands.length - 1].replace(/-\d+$/, "")} box=[${pt(Math.min(at.x, far.x))},${pt(Math.min(at.y, far.y))} ${pt(Math.max(at.x, far.x))},${pt(Math.max(at.y, far.y))}]${state()}`,
					);
					break;
				}
				default:
					break;
			}
			operands.length = 0;
		}
		void cursor;
	}
	return lines;
}

// --- the text-layer and raster sections ----------------------------------------------------------

function textLayerSection(page: RmPage): string[] {
	const lines = ["## text layer"];
	const device = resolveDeviceCanvas([page]);
	const frame = notebookPageFrame(page, device);
	const text = sceneTextPage(page, frame, "1");
	if (text === null) {
		lines.push("none");
		return lines;
	}
	lines.push(`page 1 ${pt(text.width)}x${pt(text.height)} lines=${text.lines.length}`);
	for (const line of text.lines) {
		lines.push(`  line at=(${pt(line.x)},${pt(line.y)}) w=${pt(line.width)} h=${size2(line.height)} ${JSON.stringify(line.text)}`);
	}
	return lines;
}

const MAP_COLUMNS = 48;
const DENSITY = " -+=#@";

function rasterSection(page: RmPage): string[] {
	const lines = ["## raster"];
	const bounds = inkBounds(page);
	lines.push(bounds ? `inkBounds origin=${px(bounds.minX)},${px(bounds.minY)} size=${px(bounds.width)}x${px(bounds.height)}` : "inkBounds -");
	if (!bounds) return lines;
	const raster = rasterizePage(page);
	let dark = 0;
	for (const value of raster.pixels) if (value === 0) dark++;
	lines.push(`image ${raster.width}x${raster.height} dark=${dark} (${((dark / (raster.width * raster.height)) * 100).toFixed(2)}%)`);
	lines.push(`pixels sha256=${createHash("sha256").update(raster.pixels).digest("hex").slice(0, 16)}`);

	const cellW = raster.width / MAP_COLUMNS;
	const cellH = cellW * 2;
	const rows = Math.max(1, Math.ceil(raster.height / cellH));
	lines.push(`map ${MAP_COLUMNS}x${rows} cell=${(cellW).toFixed(1)}x${cellH.toFixed(1)}px`);
	const rendered: string[] = [];
	for (let row = 0; row < rows; row++) {
		let line = "";
		for (let col = 0; col < MAP_COLUMNS; col++) {
			const x0 = Math.floor(col * cellW);
			const x1 = Math.min(raster.width, Math.ceil((col + 1) * cellW));
			const y0 = Math.floor(row * cellH);
			const y1 = Math.min(raster.height, Math.ceil((row + 1) * cellH));
			let cellDark = 0;
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (raster.pixels[y * raster.width + x] === 0) cellDark++;
			const share = cellDark / Math.max(1, (x1 - x0) * (y1 - y0));
			const bucket = share === 0 ? 0 : Math.min(DENSITY.length - 1, 1 + Math.floor(share * (DENSITY.length - 1)));
			line += DENSITY[bucket];
		}
		rendered.push(`  |${line}|`);
	}
	// Collapse runs of blank rows: the shape stays readable and the file stays short.
	const blank = `  |${" ".repeat(MAP_COLUMNS)}|`;
	let i = 0;
	while (i < rendered.length) {
		if (rendered[i] === blank) {
			let j = i;
			while (j < rendered.length && rendered[j] === blank) j++;
			if (j - i >= 3) lines.push(`  ... (${j - i} blank rows)`);
			else for (let k = i; k < j; k++) lines.push(blank);
			i = j;
		} else {
			lines.push(rendered[i]);
			i++;
		}
	}
	return lines;
}

// --- the golden ----------------------------------------------------------------------------------

export interface GoldenTarget {
	name: string;
	page: RmPage;
	/** Where the page came from, recorded in the header: a fixture path, or "synthetic". */
	source: string;
}

export async function renderGolden(target: GoldenTarget): Promise<string> {
	const doc = await PDFDocument.load(await renderPagesToPdf([target.page]));
	const lines = [
		`# golden ${target.name}`,
		`# render-version ${RENDER_VERSION}`,
		`# fixture ${target.source}`,
		"",
		...sceneSection(target.page),
		"",
		...pdfSection(doc),
		"",
		...textLayerSection(target.page),
		"",
		...rasterSection(target.page),
	];
	return `${lines.join("\n")}\n`;
}

/** The version a committed golden was generated at, from its own header. */
export function goldenRenderVersion(golden: string): number | null {
	const match = /^# render-version (\d+)$/m.exec(golden);
	return match ? Number(match[1]) : null;
}

const DRAWN_SECTIONS = ["## pdf", "## text layer", "## raster"];

function sections(golden: string): Map<string, string> {
	const map = new Map<string, string>();
	const parts = golden.split(/^(?=## )/m);
	for (const part of parts.slice(1)) map.set(part.slice(0, part.indexOf("\n")), part);
	return map;
}

export interface GoldenDiff {
	changedSections: string[];
	/** True when anything a user can see changed -- pdf, text layer or raster. */
	drawnChanged: boolean;
	message: string;
}

/** The per-section diagnosis of ticket 12: "the parser changed" and "the page changed" are never the same message. */
export function diagnoseGoldenChange(name: string, was: string, now: string): GoldenDiff | null {
	if (was === now) return null;
	const oldSections = sections(was);
	const newSections = sections(now);
	const changed = [...new Set([...oldSections.keys(), ...newSections.keys()])].filter(
		(key) => oldSections.get(key) !== newSections.get(key),
	);
	const messages: string[] = [`render golden changed: ${name}`];
	for (const section of changed) {
		messages.push(`  ${section}`);
		const oldLines = (oldSections.get(section) ?? "").split("\n").slice(1);
		const newLines = (newSections.get(section) ?? "").split("\n").slice(1);
		if (section === "## pdf") {
			const oldOps = oldLines.filter((line) => line.startsWith("  path") || line.startsWith("  text") || line.startsWith("  xobject"));
			const newOps = newLines.filter((line) => line.startsWith("  path") || line.startsWith("  text") || line.startsWith("  xobject"));
			if (oldOps.length !== newOps.length) {
				messages.push(`    operation count ${oldOps.length} -> ${newOps.length}: an operation was added or dropped`);
			} else {
				const changedPairs = oldOps.map((line, i) => [line, newOps[i]] as const).filter(([a, b]) => a !== b);
				messages.push(`    ${changedPairs.length} of ${oldOps.length} operations differ`);
				const deltas = new Set(
					changedPairs.map(([a, b]) => {
						const from = /from=\((-?[\d.]+),(-?[\d.]+)\)/;
						const ma = from.exec(a);
						const mb = from.exec(b);
						if (!ma || !mb) return "?";
						return `(${(Number(mb[1]) - Number(ma[1])).toFixed(1)}, ${(Number(mb[2]) - Number(ma[2])).toFixed(1)})`;
					}),
				);
				if (deltas.size === 1 && !deltas.has("?") && !deltas.has("(0.0, 0.0)")) {
					messages.push(`    all of them moved by ${[...deltas][0]} pt`);
				}
				if (changedPairs.length > 0) {
					messages.push(`      was ${changedPairs[0][0].trim()}`);
					messages.push(`      now ${changedPairs[0][1].trim()}`);
				}
			}
		} else {
			const firstChanged = oldLines.findIndex((line, i) => line !== newLines[i]);
			if (firstChanged >= 0) {
				messages.push(`      was ${(oldLines[firstChanged] ?? "").trim()}`);
				messages.push(`      now ${(newLines[firstChanged] ?? "").trim()}`);
			}
		}
	}
	const drawnChanged = changed.some((section) => DRAWN_SECTIONS.includes(section));
	messages.push(
		drawnChanged
			? `\n  This changes what a user sees. Accept with: npm run goldens:update (refuses while RENDER_VERSION is still ${RENDER_VERSION})`
			: "\n  Scene only -- no drawn output changed. Accept with: npm run goldens:update",
	);
	return { changedSections: changed, drawnChanged, message: messages.join("\n") };
}
