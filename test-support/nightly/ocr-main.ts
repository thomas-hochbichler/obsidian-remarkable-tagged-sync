// CLI entry for the nightly's OCR half: `npm run nightly:ocr`.
//
// Reads the committed scenes and ground truth, sends each page through the real OpenAI-compatible
// adapter -- every model rides through OpenRouter on the one `OPENROUTER_API_KEY`, see
// `NIGHTLY_BACKENDS` -- and writes the part file the verdict job merges. A missing credential
// makes every backend `unknown`: reported, never invented. Transcripts of failing pages go into
// `nightly-parts/artifacts/` for the run's artifact upload; they never enter the part file.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSCRIPTION_PROMPT } from "../../src/llm-transcript";
import { OpenAiCompatOcrBackend } from "../../src/openai-compat-ocr-backend";
import { PROVIDERS } from "../../pro/ocr-providers";
import { parseRmV6 } from "../../src/rm-parser";
import { RENDER_VERSION } from "../../src/sync-engine";
import {
	type BackendRun,
	type BaselineEntry,
	NIGHTLY_BACKENDS,
	type NightlyBackendSpec,
	type PageEnvelope,
	loadBaseline,
	evaluateBackend,
	loadReferencePages,
	mergeBackendStatuses,
} from "./ocr";

const FIXTURES = join(process.cwd(), "test-fixtures", "ocr-reference");
const OUT_DIR = join(process.cwd(), "nightly-parts");

/**
 * States the envelope on the way out, and records what came back (spec §3.2).
 *
 * The adapter's own body is rewritten rather than rebuilt, so what the nightly measures stays exactly
 * what the plugin sends -- plus three fields the plugin has no reason to send and a measurement
 * cannot do without:
 *
 * - `provider.only` + `allow_fallbacks: false`: one pinned endpoint, or a 404. Unpinned, OpenRouter's
 *   routing alone moved a model's median CER by 1.40 points between two providers (spec §8.3).
 * - `reasoning.enabled: false`: `qwen3.6-35b-a3b` thinks by default -- measured 203 reasoning tokens
 *   of 354 on one page, and nearly half its cost. A model that thinks on some nights and not others
 *   is two measurements sharing a row.
 * - `usage.include`: the tokens and the upstream cost, which is the only place a night's true price
 *   and a silent change of image size are visible at all.
 *
 * `statuses` still collects every HTTP status for the §4.4 classification; `envelopes` collects one
 * entry per request, and the caller keeps the last -- a retried page is one measurement, and the
 * attempt that produced the transcript is the one that describes it.
 */
function pinningFetch(spec: NightlyBackendSpec, statuses: number[], envelopes: PageEnvelope[]): typeof fetch {
	return async (input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		body.provider = { only: [spec.provider], allow_fallbacks: false };
		body.reasoning = { enabled: false };
		body.usage = { include: true };
		const response = await fetch(input, { ...init, body: JSON.stringify(body) });
		statuses.push(response.status);
		// `clone()`, so the adapter still reads an unconsumed body. A non-JSON body is an error page:
		// the status already carries it and there is no envelope to record.
		try {
			const parsed = (await response.clone().json()) as {
				provider?: string;
				usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
			};
			if (parsed.usage) {
				envelopes.push({
					endpoint: spec.provider,
					servedBy: parsed.provider ?? null,
					promptTokens: parsed.usage.prompt_tokens ?? null,
					completionTokens: parsed.usage.completion_tokens ?? null,
					reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? null,
					cost: parsed.usage.cost ?? null,
				});
			}
		} catch {
			// Nothing to record.
		}
		return response;
	};
}

async function main() {
	const pages = loadReferencePages(join(FIXTURES, "pages"));
	const sceneFiles = readdirSync(join(FIXTURES, "scenes")).filter((name) => name.endsWith(".rm")).sort();
	const scenes = new Map(sceneFiles.map((name) => [name.slice(0, 2), parseRmV6(readFileSync(join(FIXTURES, "scenes", name)))]));
	const baseline = loadBaseline(join(process.cwd(), ".ocr-baseline.json"));
	const apiKey = process.env.OPENROUTER_API_KEY ?? "";

	mkdirSync(join(OUT_DIR, "artifacts"), { recursive: true });
	const backends: Record<string, BackendRun & { model?: string; endpoint?: string }> = {};

	for (const spec of NIGHTLY_BACKENDS) {
		if (apiKey === "") {
			backends[spec.key] = { status: "unknown", reason: "no credential (OPENROUTER_API_KEY)", pages: {}, medianCer: null };
			console.log(`${spec.key}: unknown -- no credential`);
			continue;
		}

		const outcomes = new Map<string, { text: string } | { failed: true; httpStatuses: number[] }>();
		const envelopes = new Map<string, PageEnvelope>();
		for (const page of pages) {
			const scene = scenes.get(page.id);
			if (!scene) throw new Error(`no scene for page ${page.id}`);
			const statuses: number[] = [];
			const seen: PageEnvelope[] = [];
			const backend = new OpenAiCompatOcrBackend({
				id: "openrouter",
				baseURL: PROVIDERS.openrouter.baseURL,
				model: spec.model,
				apiKey,
				fetchFn: pinningFetch(spec, statuses, seen),
			});
			const result = await backend.recognize([scene]);
			const pageResult = result.pages?.[0];
			if (pageResult?.status === "ok") outcomes.set(page.id, { text: pageResult.text });
			else outcomes.set(page.id, { failed: true, httpStatuses: statuses });
			const last = seen[seen.length - 1];
			if (last) envelopes.set(page.id, last);
		}

		const run = evaluateBackend(pages, outcomes, baseline[spec.key] ?? {});
		// Merged after scoring rather than passed into it: `evaluateBackend` decides what a page reads
		// as, which is the same question whatever it cost, and the library stays free of the transport.
		for (const [id, envelope] of envelopes) {
			const measurement = run.pages[id];
			if (measurement) measurement.envelope = envelope;
		}
		backends[spec.key] = { ...run, model: spec.model, endpoint: spec.provider };
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
		// The three fields the baseline's change discipline reads: a baseline may only be raised
		// when the model, the prompt or the image we send actually changed (ticket 14 §5.4).
		detail: {
			promptSha: createHash("sha256").update(TRANSCRIPTION_PROMPT).digest("hex").slice(0, 16),
			renderVersion: RENDER_VERSION,
			backends,
		},
	};
	writeFileSync(join(OUT_DIR, "ocr.json"), `${JSON.stringify(part, null, "\t")}\n`);
	console.log(`ocr part: ${part.status} -> nightly-parts/ocr.json`);
}

main().catch((error) => {
	// A crashed runner writes no part file, and the merge records `unknown -- job did not report`.
	console.error(error);
	process.exit(1);
});
