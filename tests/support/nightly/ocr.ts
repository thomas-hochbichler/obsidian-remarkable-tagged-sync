// The OCR half of the nightly (ticket 14 §1.4): fourteen reference pages through the real backend
// classes, scored as character error rate against the committed ground truth.
//
// This file is the library -- pure classification and evaluation, plus the page loader -- so the
// rules have unit tests; `ocr-main.ts` is the CLI entry the workflow runs. The measurement is of
// the *product*: the transcript scored is the string the plugin would write into a note (the
// backend classes apply `sanitizeTranscript` themselves), and the image sent is the shipped
// rasterizer's own output. No parallel request-building code exists here.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { characterErrorRate, normalizeForCer, structureObservation } from "../cer";

/**
 * What the nightly measures, pinned here because the plugin no longer ships a default model
 * anywhere -- a shipped default was a promise with an expiry date (the dead `gemini-2.0-flash`
 * shipped for ten weeks). The baseline key carries the whole route, so changing an entry can never
 * silently inherit the old numbers.
 *
 * **Every model rides through OpenRouter, on one credential** (user decision, 2026-08-23). Four
 * provider accounts with four spend caps were the alternative; what that bought was live coverage
 * of the *direct* endpoints' envelopes, and that mattered less than it did when ticket 14 was
 * charted: the founding failure -- a dead model id shipped as a default -- can no longer recur,
 * because no default ships. The direct adapters keep their replay and unit coverage, and the
 * contract half (unbuilt, waiting on the throwaway account) is where live envelope checks belong.
 * A direct entry can be added here later; the runner keys the baseline by the full route, so the
 * two paths never share a number.
 */
export interface NightlyBackendSpec {
	/** Baseline key prefix and display name; the page id is appended for the full baseline key. */
	key: string;
	/** The model id as the carrying provider names it. */
	model: string;
	/**
	 * The OpenRouter **endpoint tag** to pin -- provider and serving precision in one string, e.g.
	 * `deepinfra/fp8`. Sent as `provider.only` with `allow_fallbacks: false`, so a route that cannot
	 * serve it answers 404 rather than quietly serving something else: a request that succeeded was
	 * served by exactly this endpoint, which is why the tag can be recorded as provenance even though
	 * the response body does not echo it.
	 *
	 * Not optional, and not merely `quantizations`. Measured 2026-09-09 on this corpus
	 * (`.scratch/local-ocr-accuracy/spec.md` §8.3): two providers of *one* model, same prompt and same
	 * PNG, differ by **1.40 points of median CER** -- nearly the whole 1.60 %-2.53 % spread the
	 * published table shows between different models. The cause is not precision (fp4 against fp8, fed
	 * provably identical image tokens, is indistinguishable); it is that providers resize the image
	 * differently. Unpinned, a router's choice can move a published row further than changing the model.
	 */
	provider: string;
}

/**
 * The three incumbents keep their `key`, and therefore their baselines and their place in the
 * published series, even though pinning the endpoint changes what is measured. The alternative --
 * folding the endpoint into the key -- would fork seventeen nights of history the accuracy page
 * cites. The endpoint travels as data instead: it is on every page's envelope from now on, so a
 * future change is visible in the series rather than hidden in it, and §3.2's change discipline
 * treats a routing change as a fourth honest reason a baseline may move.
 */
export const NIGHTLY_BACKENDS: NightlyBackendSpec[] = [
	// Incumbents. Each had several routes to be picked from: Sonnet six (Anthropic, Azure, Bedrock,
	// Vertex), 4o two, Flash six. First-party in each case, so the pin also drops the resellers.
	{ key: "openrouter/anthropic/claude-sonnet-5", model: "anthropic/claude-sonnet-5", provider: "anthropic" },
	{ key: "openrouter/openai/gpt-4o", model: "openai/gpt-4o", provider: "openai" },
	{ key: "openrouter/google/gemini-2.5-flash", model: "google/gemini-2.5-flash", provider: "google-ai-studio" },
	// Added 2026-09-09 (spec §2.1): the three cloud models chosen for what their accuracy costs.
	{ key: "openrouter/google/gemini-3.1-flash-lite", model: "google/gemini-3.1-flash-lite", provider: "google-ai-studio" },
	{ key: "openrouter/qwen/qwen3-vl-235b-a22b-instruct", model: "qwen/qwen3-vl-235b-a22b-instruct", provider: "deepinfra/fp8" },
	// `chutes/fp4` rather than DeepInfra: both of DeepInfra's gemma routes have refused this workload
	// within one day -- fp4 rate-limits every image request ("temporarily rate-limited upstream"; text
	// goes through), and fp8 answered `404 No allowed providers` on the first pinned night while still
	// being listed among the model's endpoints. Chutes completed all fifteen pages twice. Nothing is
	// lost by taking fp4 here: fed provably identical image tokens, fp4 against fp8 is six ties, three
	// and four over thirteen pages -- indistinguishable but for one page (spec §8.3).
	{ key: "openrouter/google/gemma-4-31b-it", model: "google/gemma-4-31b-it", provider: "chutes/fp4" },
	// Open weights, hosted (spec §2.2): the 32 and 64 GB tiers, measured through the same corpus so a
	// reader can compare the model they could run against the ones they would rent. Neither is what a
	// laptop runs -- `qwen3-vl-8b` has no 4-bit route at all -- so both are upper bounds, and §3.4
	// step 2 still owes the local pair that says by how much.
	{ key: "openrouter/qwen/qwen3-vl-8b-instruct", model: "qwen/qwen3-vl-8b-instruct", provider: "parasail/bf16" },
	{ key: "openrouter/qwen/qwen3.6-35b-a3b", model: "qwen/qwen3.6-35b-a3b", provider: "darkbloom/fp4" },
];

export interface ReferencePage {
	/** "01" … "14"; binds the page to its scene file by number prefix. */
	id: string;
	trait: string;
	body: string;
	/** Alternate reference renderings (ticket 14 §2 rule 10); CER is the minimum over body and these. */
	alternates: string[];
}

/**
 * What one page's request asked for and was billed, read back off the response (spec §3.2).
 *
 * Recorded because all three of these move the CER and none of them used to be written down. The
 * `endpoint` is the tag we pinned rather than one the response carries -- OpenRouter echoes only the
 * provider's display name -- and `allow_fallbacks: false` is what makes that honest: any other route
 * would have been a 404, not a substitution.
 *
 * `promptTokens` is the cheapest drift detector on the page: a night where a backend's prompt tokens
 * move is a night where the model was shown a different image, and it costs nothing to notice.
 */
export interface PageEnvelope {
	endpoint: string;
	servedBy: string | null;
	promptTokens: number | null;
	completionTokens: number | null;
	/** Non-zero means the model thought before answering, which we asked it not to. */
	reasoningTokens: number | null;
	cost: number | null;
}

/** One measured page for one backend. */
export interface PageMeasurement {
	cer: number | null;
	structure: Record<string, string>;
	/** Set when the page could not be measured; mirrors ticket 14 §4.4 / §5.3. */
	problem?: "empty-output" | "abort" | "unavailable";
	/** Absent for a page whose request never returned a usable body, and for every night before 2026-09-09. */
	envelope?: PageEnvelope;
}

export type BackendStatus = "pass" | "degraded" | "unknown" | "catastrophe";

export interface BackendRun {
	status: BackendStatus;
	/** Why, when status is not pass -- one line, never a transcript. */
	reason?: string;
	pages: Record<string, PageMeasurement>;
	medianCer: number | null;
}

export interface BaselineEntry {
	cer: number;
	/** max-min over the nights the baseline was computed from; absent on a hand-built test entry. */
	spread?: number;
}

/**
 * Reads the committed ground-truth pages. Rejects an empty body -- the CER denominator must be
 * positive -- and requires the fourteen ids to be exactly 01…14 so a page cannot fall out silently.
 */
/**
 * How many pages the committed set has. Named rather than inline so adding one is a single edit, and
 * checked rather than counted: a page whose file went missing must fail the run, not shrink the set.
 */
export const REFERENCE_PAGES = 15;

/**
 * `.ocr-baseline.json` regrouped by backend: `{ "openrouter/openai/gpt-4o": { "05": { cer, spread } } }`.
 *
 * Lives here rather than beside one CLI because two of them read it now -- the cloud half and the
 * Apple Vision half, which runs on a different runner and shares the same discipline. An absent file
 * is an empty baseline, which is what a first night has.
 */
export function loadBaseline(path: string): Record<string, Record<string, BaselineEntry | undefined>> {
	if (!existsSync(path)) return {};
	const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: Record<string, { cer: number; spread?: number }> };
	const byBackend: Record<string, Record<string, BaselineEntry | undefined>> = {};
	for (const [key, entry] of Object.entries(raw.entries ?? {})) {
		const cut = key.lastIndexOf("/");
		(byBackend[key.slice(0, cut)] ??= {})[key.slice(cut + 1)] = { cer: entry.cer, spread: entry.spread };
	}
	return byBackend;
}

export function loadReferencePages(dir: string): ReferencePage[] {
	const files = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
	const pages = files.map((name) => {
		const raw = readFileSync(join(dir, name), "utf8");
		const close = raw.indexOf("\n---", 3);
		if (!raw.startsWith("---") || close === -1) throw new Error(`${name}: no frontmatter block`);
		const front = raw.slice(3, close);
		const body = raw.slice(raw.indexOf("\n", close + 1) + 1).trim();
		if (body === "") throw new Error(`${name}: empty reference body`);
		const id = /(^|\n)id:\s*"?(\d\d)"?/.exec(front)?.[2];
		const trait = /(^|\n)trait:\s*(\S+)/.exec(front)?.[2];
		if (!id || !trait) throw new Error(`${name}: frontmatter must carry id and trait`);
		const alternates: string[] = [];
		// A literal block may contain blank lines (they carry no indent), so the block runs over
		// indented lines and bare newlines both, and ends at the first unindented non-empty line.
		const accept = /(^|\n)accept:\s*\|\n((?:[ \t]+.*\n|\n)*)/.exec(front);
		if (accept) alternates.push(accept[2].replace(/^[ \t]{2}/gm, "").trim());
		return { id, trait, body, alternates };
	});
	const ids = pages.map((page) => page.id).join(",");
	const expected = Array.from({ length: REFERENCE_PAGES }, (_, i) => String(i + 1).padStart(2, "0")).join(",");
	if (ids !== expected) throw new Error(`reference pages are ${ids || "(none)"}, expected ${expected}`);
	return pages;
}

/**
 * Ticket 14 §4.4: which HTTP outcomes mean "our request or their envelope broke" (catastrophe) and
 * which mean "the provider could not answer tonight" (unknown, never blocking on its own).
 */
export function classifyFailure(httpStatuses: number[]): { problem: "abort" | "unavailable"; reason: string } {
	const aborting = httpStatuses.find((status) => status === 400);
	if (aborting !== undefined) return { problem: "abort", reason: "HTTP 400 -- our request shape was rejected" };
	// 404 joined this list on 2026-09-09, the first night the endpoints were pinned. OpenRouter answers
	// a pinned endpoint it cannot currently route to with `404 No allowed providers are available`, and
	// that is capacity, not a broken request: `deepinfra/fp8` was listed among the model's endpoints
	// before and after the night it refused. Without it here a 404 fell through to "network error",
	// the most misleading label available -- nothing about the network was wrong. A tag that is simply
	// wrong answers 404 too and is *not* distinguishable from here; it does not need to be, because a
	// backend that never measures is caught by the second clock (§5.2, three nights) rather than by
	// calling one night's outage a catastrophe.
	const transient = httpStatuses.find((status) => status === 401 || status === 402 || status === 404 || status === 429 || status >= 500);
	if (transient !== undefined) return { problem: "unavailable", reason: `HTTP ${transient}` };
	// No HTTP status recorded at all: the fetch itself failed, or a 200 body would not parse. The
	// first is transient; the second is an envelope change. Without a status we cannot tell them
	// apart from here, so the caller passes parse failures in as 400-equivalent; the rest is network.
	return { problem: "unavailable", reason: "network error" };
}

/**
 * Scores one backend's fourteen page outcomes (ticket 14 §5.3). `baseline` maps page id to its
 * baseline entry; an absent entry means the key has no baseline yet, and per §5.2 such a page is
 * `degraded` at worst -- a new model cannot block a release on the night it is added. The empty
 * and abort catastrophes are absolute and need no baseline.
 */
export function evaluateBackend(
	pages: ReferencePage[],
	outcomes: Map<string, { text: string } | { failed: true; httpStatuses: number[] }>,
	baseline: Record<string, BaselineEntry | undefined>,
): BackendRun {
	const measurements: Record<string, PageMeasurement> = {};
	let worst: BackendStatus = "pass";
	let reason: string | undefined;
	const raise = (status: BackendStatus, why: string) => {
		const order: BackendStatus[] = ["pass", "degraded", "unknown", "catastrophe"];
		if (order.indexOf(status) > order.indexOf(worst)) {
			worst = status;
			reason = why;
		}
	};

	for (const page of pages) {
		const outcome = outcomes.get(page.id);
		if (outcome === undefined || "failed" in outcome) {
			const { problem, reason: why } = outcome ? classifyFailure(outcome.httpStatuses) : { problem: "unavailable" as const, reason: "no outcome" };
			measurements[page.id] = { cer: null, structure: {}, problem };
			raise(problem === "abort" ? "catastrophe" : "unknown", `page ${page.id}: ${why}`);
			continue;
		}

		const refLength = [...normalizeForCer(page.body)].length;
		const hypLength = [...normalizeForCer(outcome.text)].length;
		if (hypLength < refLength * 0.1) {
			// Empty or nearly-empty output is the shape of total failure -- a refusal, a truncation, a
			// silent auth problem -- and the user's note silently loses its content (ticket 07 band 1).
			measurements[page.id] = { cer: null, structure: {}, problem: "empty-output" };
			raise("catastrophe", `page ${page.id}: empty output (${hypLength} of ${refLength} code points)`);
			continue;
		}

		const cer = characterErrorRate(page.body, outcome.text, page.alternates);
		const structure = structureObservation(page.body, outcome.text);
		measurements[page.id] = { cer, structure };

		const entry = baseline[page.id];
		if (entry === undefined) continue;
		// Both floors read the spread the baseline recorded (§5.3, §6.1): a 48-character page that swings
		// 20 pp between nights is not a catastrophe on the night it swings, and its own history says so.
		const noise = 2 * (entry.spread ?? 0);
		if (cer > 2 * entry.cer && cer - entry.cer >= Math.max(0.05, noise)) {
			raise("catastrophe", `page ${page.id}: CER ${(cer * 100).toFixed(1)} % against baseline ${(entry.cer * 100).toFixed(1)} %`);
		} else if (cer > entry.cer + Math.max(0.02, noise)) {
			raise("degraded", `page ${page.id}: CER ${(cer * 100).toFixed(1)} % above baseline`);
		}
	}

	const measured = Object.values(measurements)
		.map((m) => m.cer)
		.filter((cer): cer is number => cer !== null)
		.sort((a, b) => a - b);
	const medianCer = measured.length === 0 ? null : measured[Math.floor((measured.length - 1) / 2)];

	// The aggregate rule: a uniform degradation trips no single page, so the median gets its own
	// tighter floor -- affordable precisely because it is a median of fourteen.
	const baselineCers = pages.map((page) => baseline[page.id]?.cer).filter((cer): cer is number => cer !== undefined).sort((a, b) => a - b);
	if (medianCer !== null && baselineCers.length === pages.length) {
		const baselineMedian = baselineCers[Math.floor((baselineCers.length - 1) / 2)];
		if (medianCer > 2 * baselineMedian && medianCer - baselineMedian >= 0.025) {
			raise("catastrophe", `median CER ${(medianCer * 100).toFixed(1)} % against baseline median ${(baselineMedian * 100).toFixed(1)} %`);
		}
	}

	return { status: worst, reason, pages: measurements, medianCer };
}

/** Part status is the worst backend status; the detail keeps every backend visible. */
export function mergeBackendStatuses(runs: Record<string, BackendRun>): BackendStatus {
	const order: BackendStatus[] = ["pass", "degraded", "unknown", "catastrophe"];
	return Object.values(runs).reduce<BackendStatus>(
		(worst, run) => (order.indexOf(run.status) > order.indexOf(worst) ? run.status : worst),
		"pass",
	);
}
