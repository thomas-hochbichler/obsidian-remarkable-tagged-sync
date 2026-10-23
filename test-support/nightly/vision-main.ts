// CLI entry for the nightly's Apple Vision half: `npm run nightly:vision`.
//
// Its own job, on a **pinned** `macos-26` runner, because Vision's model ships inside the OS and is
// not addressable from here: `macos-latest` rolls forward on GitHub's schedule and would move a
// published number with nothing changed in this repo. macOS runners are free and unlimited on public
// repositories, so the third measuring job costs nothing but wall clock.
//
// Nothing about the measurement differs from the cloud half: the same committed scenes, the same
// `rasterizePage` -> `encodeGrayscalePng` PNG, the same `evaluateBackend`, the same
// `.ocr-baseline.json` discipline. What differs is the provenance -- there is no model id, no prompt
// and no price, and instead the `VNRecognizeTextRequest` revision and the OS that chose it.
//
// The same reads then lay the text layer (searchable-pdf spec §7.4): each page's ground truth on
// tonight's Vision boxes, whose placed share is the nightly's layer figure, and Vision's own words.
// PDFKit must find every placed word in both, or the part is a catastrophe and the job goes red.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { Platform } from "obsidian";
import { placeWords, transcriptWords } from "../../src/layer-alignment";
import { renderPagesToPdf } from "../../src/pdf-renderer";
import { parseRmV6, type RmPage } from "../../src/rm-parser";
import { RENDER_VERSION } from "../../src/sync-engine";
import type { LayerLine } from "../../src/text-layer";
import { visionRunStats } from "../../src/vision-ocr-backend";
import { createVisionOcrBackend } from "../../src/vision-ocr-runtime";
import { checkWithPdfKit, printCheck } from "../text-layer/pdfkit-check";
import { type BackendRun, evaluateBackend, loadBaseline, loadReferencePages, mergeBackendStatuses, type ReferencePage } from "./ocr";
import { judgeTextLayer, type TextLayerCheck } from "./vision";

// The obsidian stub defaults to the least capable platform, where Vision is closed and nothing
// spawns. This runs on a Mac by construction -- the job pins the runner -- so say so.
Platform.isDesktop = true;
Platform.isMacOS = true;

const FIXTURES = join(process.cwd(), "test-fixtures", "ocr-reference");
const OUT_DIR = join(process.cwd(), "nightly-parts");

/** The one backend key Vision ever writes; the page id is appended for the baseline key. */
const BACKEND_KEY = "vision/apple";

async function main() {
	const pages = loadReferencePages(join(FIXTURES, "pages"));
	const sceneFiles = readdirSync(join(FIXTURES, "scenes")).filter((name) => name.endsWith(".rm")).sort();
	const scenes = new Map(sceneFiles.map((name) => [name.slice(0, 2), parseRmV6(readFileSync(join(FIXTURES, "scenes", name)))]));
	const baseline = loadBaseline(join(process.cwd(), ".ocr-baseline.json"));
	mkdirSync(OUT_DIR, { recursive: true });

	const ordered = pages.map((page) => {
		const scene = scenes.get(page.id);
		if (!scene) throw new Error(`no scene for page ${page.id}`);
		return scene;
	});

	// One call over the whole set, which is how a sync reads a notebook: batched per process, the
	// process count capped. Per-page CER is unaffected -- Vision reads each image on its own.
	const started = Date.now();
	const result = await createVisionOcrBackend().recognize(ordered);
	const ms = Date.now() - started;

	let run: BackendRun;
	if (result.pages === null) {
		// No per-page results at all: Vision could not run here. Not evidence that anything is broken
		// -- a sandboxed or TCC-blocked runner looks exactly like this -- so it is `unknown`, the same
		// as a provider that could not answer tonight.
		run = { status: "unknown", reason: `vision ${result.status} on this runner`, pages: {}, medianCer: null };
	} else {
		const outcomes = new Map<string, { text: string } | { failed: true; httpStatuses: number[] }>();
		pages.forEach((page, index) => {
			const read = result.pages?.[index];
			if (read?.status === "ok") outcomes.set(page.id, { text: read.text });
			// No HTTP anywhere in this path, so there is no status to classify by: an empty list
			// reads as "network error", which is the honest shape of "it came back with nothing".
			else outcomes.set(page.id, { failed: true, httpStatuses: [] });
		});
		run = evaluateBackend(pages, outcomes, baseline[BACKEND_KEY] ?? {});
	}

	// A check that fails or cannot run turns the job red, after the part is written: the CER measured
	// above stays in the verdict either way.
	let textLayer: TextLayerCheck | undefined;
	let layerFailed = false;
	if (result.pages !== null) {
		try {
			textLayer = await checkTextLayer(pages, ordered, result.pages.map((page) => (page.status === "ok" ? (page.layer ?? []) : [])));
			const judged = judgeTextLayer(run, textLayer);
			layerFailed = judged !== run;
			run = judged;
		} catch (error) {
			console.error(error);
			layerFailed = true;
			// Not evidence the layer is broken -- PDFKit or osascript could not answer here -- so `unknown`,
			// as Vision itself not running is. A catastrophe the CER found stays one.
			if (run.status !== "catastrophe") run = { ...run, status: "unknown", reason: "text layer check did not run" };
		}
	}

	console.log(`${BACKEND_KEY}: ${run.status}${run.reason ? ` -- ${run.reason}` : ""} (median CER ${run.medianCer === null ? "n/a" : `${(run.medianCer * 100).toFixed(1)} %`})`);

	const part = {
		status: mergeBackendStatuses({ [BACKEND_KEY]: run }),
		measuredAt: new Date().toISOString(),
		detail: {
			renderVersion: RENDER_VERSION,
			...(textLayer === undefined ? {} : { textLayer }),
			backends: {
				[BACKEND_KEY]: {
					...run,
					// The provenance a Vision row needs instead of a model id (spec §3.3). The revision is
					// the OS's choice and deliberately never pinned by the plugin, so a macOS upgrade can
					// move this number with nothing changed here -- which is exactly why it is recorded
					// beside every measurement rather than assumed.
					visionRevision: visionRunStats.revision,
					unreadableInkRegions: visionRunStats.unreadableInkRegions,
					macos: `darwin ${release()}`,
					totalMs: ms,
				},
			},
		},
	};
	writeFileSync(join(OUT_DIR, "vision.json"), `${JSON.stringify(part, null, "\t")}\n`);
	console.log(`vision part: ${part.status} -> nightly-parts/vision.json`);
	if (layerFailed) process.exit(1);
}

/**
 * Lays both layers over the reference render and checks them with PDFKit. The layered PDFs go to
 * `nightly-parts/text-layer/`, kept as a run artifact for whoever debugs a red night.
 */
async function checkTextLayer(pages: ReferencePage[], scenes: RmPage[], reads: LayerLine[][]): Promise<TextLayerCheck> {
	const dir = join(OUT_DIR, "text-layer");
	mkdirSync(dir, { recursive: true });
	const render = await renderPagesToPdf(scenes);
	const truths = reads.map((lines, index) => placeWords(pages[index].body, lines));
	const truth = await checkWithPdfKit(render, scenes, truths, join(dir, "reference-ground-truth.pdf"));
	const own = await checkWithPdfKit(render, scenes, reads, join(dir, "reference.pdf"));
	const pageId = (page: number) => pages[page].id;
	printCheck("ground truth", truth, pageId);
	printCheck("Vision's words", own, pageId);
	const visionWords = reads.flat().flatMap((line) => line.words);
	return {
		groundTruth: { words: pages.reduce((sum, page) => sum + transcriptWords(page.body).length, 0), placed: truth.words, found: truth.found, onBox: truth.onBox },
		vision: { words: visionWords.length, ownBoxes: visionWords.filter((word) => word.box !== null).length, placed: own.words, found: own.found, onBox: own.onBox },
	};
}

main().catch((error) => {
	// A crashed runner writes no part file, and the merge records `unknown -- job did not report`.
	console.error(error);
	process.exit(1);
});
