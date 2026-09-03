// The OCR half of the nightly (ticket 14 §1.4): fourteen reference pages through the real backend
// classes, scored as character error rate against the committed ground truth.
//
// This file is the library -- pure classification and evaluation, plus the page loader -- so the
// rules have unit tests; `ocr-main.ts` is the CLI entry the workflow runs. The measurement is of
// the *product*: the transcript scored is the string the plugin would write into a note (the
// backend classes apply `sanitizeTranscript` themselves), and the image sent is the shipped
// rasterizer's own output. No parallel request-building code exists here.

import { readFileSync, readdirSync } from "node:fs";
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
}

export const NIGHTLY_BACKENDS: NightlyBackendSpec[] = [
	{ key: "openrouter/anthropic/claude-sonnet-5", model: "anthropic/claude-sonnet-5" },
	{ key: "openrouter/openai/gpt-4o", model: "openai/gpt-4o" },
	{ key: "openrouter/google/gemini-2.5-flash", model: "google/gemini-2.5-flash" },
];

export interface ReferencePage {
	/** "01" … "14"; binds the page to its scene file by number prefix. */
	id: string;
	trait: string;
	body: string;
	/** Alternate reference renderings (ticket 14 §2 rule 10); CER is the minimum over body and these. */
	alternates: string[];
}

/** One measured page for one backend. */
export interface PageMeasurement {
	cer: number | null;
	structure: Record<string, string>;
	/** Set when the page could not be measured; mirrors ticket 14 §4.4 / §5.3. */
	problem?: "empty-output" | "abort" | "unavailable";
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
	const expected = Array.from({ length: 14 }, (_, i) => String(i + 1).padStart(2, "0")).join(",");
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
	const transient = httpStatuses.find((status) => status === 401 || status === 402 || status === 429 || status >= 500);
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
