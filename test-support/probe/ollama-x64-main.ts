// The transcription half of the Windows x64 probe (managed-llm-windows-x64 ticket 07, Stage 1):
// the fifteen committed reference pages through a locally spawned `ollama serve`, scored as
// character error rate, with the peak working set of the process tree sampled alongside.
//
// It is the public twin of the Mac-side bench that produced the Stage 0 reference figure, and it
// must stay one: the runner's number is only comparable to that one if the prompt, the render, the
// sampling and the scoring are identical. Shipped path throughout -- `OpenAiCompatOcrBackend` with
// Ollama's own `ProviderMeta`, so `deterministic: true` pins `temperature: 0` exactly as a sync does.
//
// **Transcripts are never written.** Rates, timings and provenance only; the corpus is handwriting.
//
// This is measurement scaffolding. Nothing in `src/` calls it, and no release depends on it.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSCRIPTION_PROMPT } from "../../src/llm-transcript";
import { LOCALHOST_PROVIDERS } from "../../src/localhost-providers";
import { OpenAiCompatOcrBackend } from "../../src/openai-compat-ocr-backend";
import { parseRmV6 } from "../../src/rm-parser";
import { RENDER_VERSION } from "../../src/sync-engine";
import { evaluateBackend, loadReferencePages } from "../nightly/ocr";

const ROOT = process.cwd();
const FIXTURES = join(ROOT, "test-fixtures", "ocr-reference");
const OUT = process.env.PROBE_OUT ?? join(ROOT, "probe-out");
const MODEL = process.env.PROBE_MODEL ?? "taggedsync-qwen2.5-vl-7b";
const BASE_URL = process.env.PROBE_BASE_URL ?? LOCALHOST_PROVIDERS.ollama.baseURL;
/** Where the run happened, verbatim, so no figure can lose its provenance. */
const MACHINE = process.env.PROBE_MACHINE ?? "unknown";

async function main() {
	const pages = loadReferencePages(join(FIXTURES, "pages"));
	const sceneFiles = readdirSync(join(FIXTURES, "scenes")).filter((n) => n.endsWith(".rm")).sort();
	const scenes = new Map(sceneFiles.map((n) => [n.slice(0, 2), parseRmV6(readFileSync(join(FIXTURES, "scenes", n)))]));
	mkdirSync(OUT, { recursive: true });

	const meta = LOCALHOST_PROVIDERS.ollama;
	const outcomes = new Map<string, { text: string } | { failed: true; httpStatuses: number[] }>();
	const timings: Record<string, number> = {};
	console.log(`${MODEL} via ${BASE_URL} · renderVersion ${RENDER_VERSION} · ${pages.length} pages · ${MACHINE}\n`);

	for (const page of pages) {
		const scene = scenes.get(page.id);
		if (!scene) throw new Error(`no scene for page ${page.id}`);
		const statuses: number[] = [];
		const backend = new OpenAiCompatOcrBackend({
			id: meta.id,
			baseURL: BASE_URL,
			model: MODEL,
			deterministic: meta.deterministic,
			fetchFn: async (input, init) => {
				const response = await fetch(input, init);
				statuses.push(response.status);
				return response;
			},
			sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		});
		const started = Date.now();
		const result = await backend.recognize([scene]);
		timings[page.id] = Date.now() - started;
		const read = result.pages?.[0];
		if (read?.status === "ok") outcomes.set(page.id, { text: read.text });
		else outcomes.set(page.id, { failed: true, httpStatuses: statuses });
		console.log(`${page.id} ${page.trait.padEnd(26)} ${(timings[page.id] / 1000).toFixed(1).padStart(6)} s  ${read?.status ?? "no page"}`);
	}

	const scored = evaluateBackend(pages, outcomes, {});
	console.log(`\nstatus ${scored.status}   median CER ${scored.medianCer === null ? "n/a" : (scored.medianCer * 100).toFixed(2) + " %"}`);
	for (const page of pages) {
		const m = scored.pages[page.id];
		console.log(`${page.id}  ${page.trait.padEnd(26)} ${m?.cer === null || m?.cer === undefined ? (m?.problem ?? "n/a") : (m.cer * 100).toFixed(2) + " %"}`);
	}

	const file = join(OUT, "ollama-x64-public-15.json");
	writeFileSync(file, JSON.stringify({
		measuredAt: new Date().toISOString(),
		backend: `ollama/${MODEL}`,
		route: BASE_URL,
		machine: MACHINE,
		promptSha: createHash("sha256").update(TRANSCRIPTION_PROMPT).digest("hex").slice(0, 16),
		renderVersion: RENDER_VERSION,
		medianCer: scored.medianCer,
		status: scored.status,
		pages: scored.pages,
		timings,
	}, null, "\t") + "\n");
	console.log(`\n-> ${file}`);
	// A page that never came back is a failed probe, not a low score: exit non-zero so the job says so.
	if (scored.status !== "pass") process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
