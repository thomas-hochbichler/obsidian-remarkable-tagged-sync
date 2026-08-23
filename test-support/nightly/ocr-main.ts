// CLI entry for the nightly's OCR half: `npm run nightly:ocr`.
//
// Reads the committed scenes and ground truth, sends each page through the real OpenAI-compatible
// adapter -- every model rides through OpenRouter on the one `OPENROUTER_API_KEY`, see
// `NIGHTLY_BACKENDS` -- and writes the part file the verdict job merges. A missing credential
// makes every backend `unknown`: reported, never invented. Transcripts of failing pages go into
// `nightly-parts/artifacts/` for the run's artifact upload; they never enter the part file.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenAiCompatOcrBackend } from "../../src/openai-compat-ocr-backend";
import { PROVIDERS } from "../../pro/ocr-providers";
import { parseRmV6 } from "../../src/rm-parser";
import {
	type BackendRun,
	type BaselineEntry,
	NIGHTLY_BACKENDS,
	evaluateBackend,
	loadReferencePages,
	mergeBackendStatuses,
} from "./ocr";

const FIXTURES = join(process.cwd(), "test-fixtures", "ocr-reference");
const OUT_DIR = join(process.cwd(), "nightly-parts");

/** Wraps fetch so the §4.4 classification can see the HTTP statuses a failed page produced. */
function recordingFetch(statuses: number[]): typeof fetch {
	return async (input, init) => {
		const response = await fetch(input, init);
		statuses.push(response.status);
		return response;
	};
}

function loadBaseline(): Record<string, Record<string, BaselineEntry | undefined>> {
	const path = join(process.cwd(), ".ocr-baseline.json");
	if (!existsSync(path)) return {};
	const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: Record<string, { cer: number }> };
	const byBackend: Record<string, Record<string, BaselineEntry | undefined>> = {};
	for (const [key, entry] of Object.entries(raw.entries ?? {})) {
		const cut = key.lastIndexOf("/");
		(byBackend[key.slice(0, cut)] ??= {})[key.slice(cut + 1)] = { cer: entry.cer };
	}
	return byBackend;
}

async function main() {
	const pages = loadReferencePages(join(FIXTURES, "pages"));
	const sceneFiles = readdirSync(join(FIXTURES, "scenes")).filter((name) => name.endsWith(".rm")).sort();
	const scenes = new Map(sceneFiles.map((name) => [name.slice(0, 2), parseRmV6(readFileSync(join(FIXTURES, "scenes", name)))]));
	const baseline = loadBaseline();
	const apiKey = process.env.OPENROUTER_API_KEY ?? "";

	mkdirSync(join(OUT_DIR, "artifacts"), { recursive: true });
	const backends: Record<string, BackendRun> = {};

	for (const spec of NIGHTLY_BACKENDS) {
		if (apiKey === "") {
			backends[spec.key] = { status: "unknown", reason: "no credential (OPENROUTER_API_KEY)", pages: {}, medianCer: null };
			console.log(`${spec.key}: unknown -- no credential`);
			continue;
		}

		const outcomes = new Map<string, { text: string } | { failed: true; httpStatuses: number[] }>();
		for (const page of pages) {
			const scene = scenes.get(page.id);
			if (!scene) throw new Error(`no scene for page ${page.id}`);
			const statuses: number[] = [];
			const backend = new OpenAiCompatOcrBackend({
				id: "openrouter",
				baseURL: PROVIDERS.openrouter.baseURL,
				model: spec.model,
				apiKey,
				fetchFn: recordingFetch(statuses),
			});
			const result = await backend.recognize([scene]);
			const pageResult = result.pages?.[0];
			if (pageResult?.status === "ok") outcomes.set(page.id, { text: pageResult.text });
			else outcomes.set(page.id, { failed: true, httpStatuses: statuses });
		}

		const run = evaluateBackend(pages, outcomes, baseline[spec.key] ?? {});
		backends[spec.key] = run;
		console.log(`${spec.key}: ${run.status}${run.reason ? ` -- ${run.reason}` : ""} (median CER ${run.medianCer === null ? "n/a" : `${(run.medianCer * 100).toFixed(1)} %`})`);

		for (const page of pages) {
			const measurement = run.pages[page.id];
			const outcome = outcomes.get(page.id);
			if (measurement?.problem && outcome && "text" in outcome) {
				writeFileSync(join(OUT_DIR, "artifacts", `${spec.key.replace(/\//g, "-")}-${page.id}.txt`), outcome.text);
			}
		}
	}

	const part = {
		status: mergeBackendStatuses(backends),
		measuredAt: new Date().toISOString(),
		detail: { backends },
	};
	writeFileSync(join(OUT_DIR, "ocr.json"), `${JSON.stringify(part, null, "\t")}\n`);
	console.log(`ocr part: ${part.status} -> nightly-parts/ocr.json`);
}

main().catch((error) => {
	// A crashed runner writes no part file, and the merge records `unknown -- job did not report`.
	console.error(error);
	process.exit(1);
});
