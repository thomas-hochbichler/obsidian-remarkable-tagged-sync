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

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { Platform } from "obsidian";
import { parseRmV6 } from "../../src/rm-parser";
import { RENDER_VERSION } from "../../src/sync-engine";
import { visionRunStats } from "../../src/vision-ocr-backend";
import { createVisionOcrBackend } from "../../src/vision-ocr-runtime";
import { type BackendRun, evaluateBackend, loadBaseline, loadReferencePages, mergeBackendStatuses } from "./ocr";

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

	console.log(`${BACKEND_KEY}: ${run.status}${run.reason ? ` -- ${run.reason}` : ""} (median CER ${run.medianCer === null ? "n/a" : `${(run.medianCer * 100).toFixed(1)} %`})`);

	const part = {
		status: mergeBackendStatuses({ [BACKEND_KEY]: run }),
		measuredAt: new Date().toISOString(),
		detail: {
			renderVersion: RENDER_VERSION,
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
}

main().catch((error) => {
	// A crashed runner writes no part file, and the merge records `unknown -- job did not report`.
	console.error(error);
	process.exit(1);
});
