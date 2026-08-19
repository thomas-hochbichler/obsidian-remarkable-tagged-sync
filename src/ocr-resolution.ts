// Which OCR backend a run actually gets, and what to say when it is not the one the user selected.
//
// Two money-safety rules live here and they point in opposite directions. `isGated` protects the
// seller: a paid backend must not run without a licence. `planUnconfiguredFallback` protects the
// buyer: a backend that cannot run must never be replaced by another one that charges per page.
//
// Both were in `main.ts` inside a `Plugin` subclass, which cannot be constructed without Obsidian.
// The measured consequence: deleting the licence gate outright, and flipping `requiresLicence` to
// false in the registry, each passed all 996 tests this repo had. Gaps G03 and G14.
//
// Everything here is a decision returned as a value -- no Notice is raised and no backend is built.
// That is what makes the decision assertable at all: the two fallbacks land on the same backend, so
// the sentence is the only thing that says which of them happened, and only one of the two is
// fixable by typing an API key.

import { gatedBackendMessage } from "./licence-messages";
import type { Entitlement } from "./licence-state";
import type { OcrBackend as OcrBackendId } from "./note-builder";

/** What this module needs to know about a registry entry, and nothing more. */
export interface BackendFacts {
	readonly label: string;
	readonly requiresLicence: boolean;
}

/** What a registry entry has to say about itself for the four questions below. */
export interface BackendListing {
	readonly id: string;
	readonly metered: boolean;
}

/**
 * Platform default backend (multi-provider spec §7): Apple Vision where it runs. Elsewhere Vision is
 * still offered but disabled, so defaulting to it would select an option the user cannot use and
 * cannot change away from without first understanding why. `off` is the honest default there: notes
 * still sync with the render, and nothing pretends text is coming.
 */
export function defaultOcrBackend(visionAvailable: boolean): OcrBackendId {
	return visionAvailable ? "vision" : "off";
}

/** The backends every build has. Neither transcribes over a network, and neither has settings. */
const BUILT_IN_BACKENDS: ReadonlySet<string> = new Set(["vision", "off"]);

/**
 * Whether this build has a backend beyond the built-in ones. Every string that offers the user a
 * different backend has to ask first: pointing someone at an API key on a screen that has no such
 * setting is worse than saying nothing. Counting entries would not do — `off` is an entry too.
 */
export function hasAlternativeBackends(entries: readonly BackendListing[]): boolean {
	return entries.some((entry) => !BUILT_IN_BACKENDS.has(entry.id));
}

/**
 * The two halves of that answer, for the one string that must tell them apart: does a backend send
 * pages to somebody else's server, and does one run on this machine?
 *
 * Split out because the OCR description used `hasAlternativeBackends()` to claim the network and an
 * API key were involved, and that was **already wrong in 1.1.0** (free-localhost-ocr spec §4.1): on a
 * supported Mac the managed local model registers, so a free user with nothing but Apple Vision and
 * an offline model was told their pages go to a provider with their own key. `metered` is the honest
 * predicate — it already means "costs money per page", which is only ever true of someone else's
 * server.
 */
export function hasCloudBackends(entries: readonly BackendListing[]): boolean {
	return entries.some((entry) => entry.metered);
}

export function hasOnDeviceBackends(entries: readonly BackendListing[]): boolean {
	return entries.some((entry) => !entry.metered && !BUILT_IN_BACKENDS.has(entry.id));
}

/**
 * What runs instead of the backend the user selected, and what to tell them.
 *
 * `use` is free local Apple Vision or nothing at all, and the absence of a third option is the rule
 * rather than an omission: falling back to another metered provider would start spending the user's
 * money on a backend they did not choose.
 */
export interface OcrFallback {
	readonly use: "vision" | "unavailable";
	/** Null on a background run, which must never interrupt with a popup (auto-sync spec §Failure). */
	readonly notice: string | null;
}

/**
 * Whether a backend present in this build is nonetheless not permitted to run.
 *
 * One line, and it is the line the whole paid tier rests on. It is a function rather than an
 * expression inside the resolver because inside the resolver nothing could reach it: removing it
 * entirely left all 996 tests green, and so did the first draft of the test file that was written
 * to catch exactly this.
 */
export function isGated(entry: BackendFacts, tier: Entitlement["tier"]): boolean {
	return entry.requiresLicence && tier === "free";
}

/**
 * A Pro backend without a licence. Same shape as {@link planUnconfiguredFallback} — free local Vision
 * where it runs, `unavailable` otherwise — but it says something different, because the reason is
 * different and only one of the two is fixable by typing a key.
 */
export function planGatedFallback(input: { label: string; visionAvailable: boolean; silent: boolean }): OcrFallback {
	const { label, visionAvailable, silent } = input;
	return {
		use: visionAvailable ? "vision" : "unavailable",
		notice: silent ? null : gatedBackendMessage(label, visionAvailable ? "Apple Vision" : null),
	};
}

/**
 * A backend that needs configuration it hasn't got: fall back to free local Vision on macOS, else
 * `unavailable` — never an auto-spend (spec §6). The notice is suppressed when `silent` (a
 * background auto-sync run), which must never interrupt with a popup (auto-sync spec §Failure);
 * the fallback itself still happens.
 */
export function planUnconfiguredFallback(input: {
	label: string;
	visionAvailable: boolean;
	silent: boolean;
}): OcrFallback {
	const { label, visionAvailable, silent } = input;
	if (!visionAvailable) return { use: "unavailable", notice: null };
	return {
		use: "vision",
		notice: silent ? null : `No API key set for ${label} — using Apple Vision (local) for this sync.`,
	};
}
