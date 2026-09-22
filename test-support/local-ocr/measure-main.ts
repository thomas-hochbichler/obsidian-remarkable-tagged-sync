// `npm run measure:local -- <generation>` -- one model generation over the fifteen public reference
// pages, through the shipped runtime, exactly as `local-ocr-backend.ts` would run it: the plugin's
// own downloaded files, `pageArgs()`'s own argv, the generation's own context pin and tall-page
// splitting, the identical PNG every other backend is given, and the nightly's own scorer.
//
// macOS on Apple silicon only, because that is the platform the figure describes and `/usr/bin/time
// -l` is where the peak memory comes from. Writes `docs/ocr-local/<generation>.json` -- rates and
// provenance, never a transcript -- and `local-figures.test.ts` is what keeps that file honest.
//
// The model files are hashed before anything runs. A figure for files that are not the pinned ones
// is a figure for a different model, and the gate would refuse it anyway; better to refuse here,
// before two minutes of GPU time.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { MODEL_GENERATIONS, RUNTIME_RELEASE } from "../../src/local-model-artefacts";
import { localModelPaths } from "../../src/local-model-store";
import { pageArgs } from "../../src/local-ocr-runtime";
import { sanitizeTranscript, splitAtTypedText } from "../../src/llm-transcript";
import { rasterizePage } from "../../src/page-rasterizer";
import { encodeGrayscalePng } from "../../src/png-encoder";
import { parseRmV6 } from "../../src/rm-parser";
import { RENDER_VERSION } from "../../src/sync-engine";
import { evaluateBackend, loadReferencePages } from "../nightly/ocr";
import { type LocalFigure, promptSha } from "./figures";

const FIXTURES = join(process.cwd(), "test-fixtures", "ocr-reference");
const OUT_DIR = join(process.cwd(), "docs", "ocr-local");

function sha256(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
	});
}

interface Run { stdout: string; stderr: string; code: number | null; ms: number }

function runPage(executable: string, args: string[]): Promise<Run> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/time", ["-l", executable, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }, (error, stdout, stderr) => {
			const ms = Date.now() - started;
			if (!error) return resolve({ stdout, stderr, code: 0, ms });
			const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
			if (typeof code === "string") return reject(new Error(`${code}: ${error.message}`));
			resolve({ stdout, stderr, code: typeof code === "number" ? code : null, ms });
		});
	});
}

const peakRssBytes = (stderr: string): number | null => {
	const m = /(\d+)\s+maximum resident set size/.exec(stderr);
	return m ? Number(m[1]) : null;
};

async function main() {
	if (process.platform !== "darwin") throw new Error("measure:local runs on macOS only -- it measures the shipped Apple silicon path");
	const wanted = process.argv[2];
	const generation = MODEL_GENERATIONS.find((g) => g.dir === wanted);
	if (!generation) throw new Error(`usage: npm run measure:local -- <${MODEL_GENERATIONS.map((g) => g.dir).join("|")}>`);
	const paths = localModelPaths("darwin", { home: homedir(), pluginId: "remarkable-tagged-sync", modelDir: generation.dir, join });

	const pinned = (fileName: string) => generation.artefacts.find((a) => a.fileName === fileName)?.sha256;
	console.log(`hashing ${paths.modelDir} ...`);
	const [modelSha256, mmprojSha256] = await Promise.all([sha256(paths.modelFile), sha256(paths.mmprojFile)]);
	if (modelSha256 !== pinned("model.gguf")) throw new Error(`${paths.modelFile} is not the pinned ${generation.label} (sha256 ${modelSha256})`);
	if (mmprojSha256 !== pinned("mmproj.gguf")) throw new Error(`${paths.mmprojFile} is not the pinned projector (sha256 ${mmprojSha256})`);

	const pages = loadReferencePages(join(FIXTURES, "pages"));
	const sceneFiles = readdirSync(join(FIXTURES, "scenes")).filter((n) => n.endsWith(".rm")).sort();
	const scenes = new Map(sceneFiles.map((n) => [n.slice(0, 2), parseRmV6(readFileSync(join(FIXTURES, "scenes", n)))]));
	const tmp = mkdtempSync(join(tmpdir(), "measure-local-"));
	const measuredAt = new Date().toISOString();

	console.log(`${generation.label} · llama.cpp ${RUNTIME_RELEASE} · renderVersion ${RENDER_VERSION} · prompt ${promptSha()} · ${pages.length} pages\n`);
	const outcomes = new Map<string, { text: string } | { failed: true; httpStatuses: number[] }>();
	const timings: Record<string, { ms: number; peakRssBytes: number | null }> = {};
	for (const page of pages) {
		const scene = scenes.get(page.id);
		if (!scene) throw new Error(`no scene for page ${page.id}`);
		const read: string[] = [];
		let ms = 0;
		let peak = 0;
		let failed = false;
		const parts = splitAtTypedText(scene, { splitTall: generation.splitsTallPages });
		for (const [at, part] of parts.entries()) {
			if (part.kind === "typed") {
				read.push(part.text);
				continue;
			}
			const imageFile = join(tmp, `${page.id}-${at}.png`);
			writeFileSync(imageFile, encodeGrayscalePng(rasterizePage(part.scene)));
			const run = await runPage(paths.runtimeExecutable, pageArgs(paths, imageFile, generation));
			ms += run.ms;
			peak = Math.max(peak, peakRssBytes(run.stderr) ?? 0);
			if (run.code !== 0) { failed = true; break; }
			const piece = sanitizeTranscript(run.stdout).trim();
			if (piece !== "") read.push(piece);
		}
		outcomes.set(page.id, failed ? { failed: true, httpStatuses: [] } : { text: read.join("\n\n") });
		timings[page.id] = { ms, peakRssBytes: peak || null };
		console.log(`${page.id} ${page.trait.padEnd(26)} ${(ms / 1000).toFixed(1).padStart(6)} s  ${peak ? (peak / 1024 ** 3).toFixed(2) + " GB" : "  ?   "}${parts.length > 1 ? `  ${parts.length} pieces` : ""}`);
	}

	const result = evaluateBackend(pages, outcomes, {});
	console.log(`\nstatus ${result.status}   median CER ${result.medianCer === null ? "n/a" : (result.medianCer * 100).toFixed(2) + " %"}\n`);
	for (const page of pages) {
		const m = result.pages[page.id];
		console.log(`${page.id} ${page.trait.padEnd(26)} ${m?.cer === null || m?.cer === undefined ? (m?.problem ?? "n/a") : (m.cer * 100).toFixed(2) + " %"}`);
	}

	const figure: LocalFigure = {
		schema: 1,
		measuredAt,
		generation: generation.dir,
		label: generation.label,
		modelSha256,
		mmprojSha256,
		runtime: RUNTIME_RELEASE,
		machine: {
			cpu: cpus()[0]?.model ?? "unknown",
			memoryGb: Math.round(totalmem() / 1024 ** 3),
			os: `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()}`,
			// Beside the version, never inside it: `os` is rendered verbatim into the published
			// `served_by` line by `scripts/ocr-series.mjs`. The build is what separates a seed from a
			// shipped OS -- both report the same product version -- and that is what decides whether a
			// measurement may be published at all.
			osBuild: execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim(),
		},
		promptSha: promptSha(),
		renderVersion: RENDER_VERSION,
		contextTokens: generation.contextTokens,
		splitsTallPages: generation.splitsTallPages,
		status: result.status,
		medianCer: result.medianCer,
		pages: Object.fromEntries(pages.map((page) => [page.id, { ...result.pages[page.id], ...timings[page.id] }])),
	};
	mkdirSync(OUT_DIR, { recursive: true });
	const out = join(OUT_DIR, `${generation.dir}.json`);
	writeFileSync(out, `${JSON.stringify(figure, null, "\t")}\n`);
	console.log(`\n-> ${out}`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
