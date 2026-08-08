// The local backend's own slice of `data.json` (managed-local-llm-ocr spec §5.5, §7.3, §7.7).
//
// Two things live here and nothing else: the background-sync consent flag, and a rolling window of
// how long this machine actually takes per page. **The model's own state is never stored here** --
// that is derived from disk on every load (§5.5), because a remembered "ready" is exactly what would
// hide a model somebody deleted from underneath the plugin.
//
// Every function takes the opaque blob and writes through it, so the plugin's next `saveData` carries
// the change. That is deliberate: the registry hands a backend its blob but no way to save, and a
// sync persists at every checkpoint anyway.

import type { BackendSettings } from "./ocr-registry";
import type { LocalModelPlatform } from "./local-model-store";

/**
 * How many measured pages before this machine's own figure replaces the derived one.
 *
 * One short notebook. Small enough to retire the derived figure quickly, large enough that a single
 * slow page -- a dense diagram, a machine that was busy -- does not set the number the card quotes.
 */
export const ENOUGH_PAGES_FOR_MEAN = 10;

/** Pages the estimate is quoted for, which is the notebook length the map measured against. */
const NOTEBOOK_PAGES = 40;

export interface LocalModelSettings {
	/** Whether the user has agreed to let the model run during a background sync (§7.5). */
	backgroundConsent: boolean;
	/** The last {@link ENOUGH_PAGES_FOR_MEAN} page durations, oldest first. */
	recentPageMs: number[];
}

/** Reads the blob defensively: it is opaque to the core and outlives any shape this build expects. */
export function readLocalModelSettings(blob: BackendSettings): LocalModelSettings {
	const raw = blob.recentPageMs;
	const recentPageMs = Array.isArray(raw) ? raw.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0) : [];
	return { backgroundConsent: blob.backgroundConsent === true, recentPageMs };
}

/** Records one page's wall-clock time, discarding the window's oldest entry. */
export function recordPageDuration(blob: BackendSettings, durationMs: number): void {
	if (!Number.isFinite(durationMs) || durationMs <= 0) return;
	const recent = [...readLocalModelSettings(blob).recentPageMs, durationMs];
	blob.recentPageMs = recent.slice(-ENOUGH_PAGES_FOR_MEAN);
}

export function setBackgroundConsent(blob: BackendSettings, consented: boolean): void {
	blob.backgroundConsent = consented;
}

/**
 * This machine's own seconds per page, or null while the derived figure still stands.
 *
 * Null rather than a mean over three pages: a figure the card presents as measured has to be one,
 * and the whole point of the sequence in §7.3 is that the derived number is provisional **by
 * construction** rather than by disclaimer.
 */
export function meanPageSeconds(blob: BackendSettings): number | null {
	const { recentPageMs } = readLocalModelSettings(blob);
	if (recentPageMs.length < ENOUGH_PAGES_FOR_MEAN) return null;
	const meanMs = recentPageMs.reduce((sum, value) => sum + value, 0) / recentPageMs.length;
	return Math.round(meanMs / 1000);
}

/**
 * A span of seconds at the resolution somebody can act on -- never a precision nobody asked for.
 *
 * The step widens with the number, because so does the error: this is a mean over ten of the user's
 * own pages extrapolated over a job, and "about 55 minutes" claims a sharpness it does not have while
 * "about 50 minutes" answers the only question being asked, which is whether to start it now.
 */
export function humanDuration(seconds: number): string {
	if (seconds < 90) return "about a minute";
	const minutes = seconds / 60;
	if (minutes < 90) {
		const step = minutes < 30 ? 5 : 10;
		return `about ${Math.round(minutes / step) * step || step} minutes`;
	}
	const hours = Math.round((minutes / 60) * 2) / 2;
	return `about ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/**
 * The Speed row: a derived figure that this machine overwrites (§7.3 states 9a → 9b).
 *
 * **Neither platform's pre-run figure is this user's figure.** Windows is derived from research and
 * may never be quoted as measured (map constraint 5); macOS's 14.9 s came from an M2 Max, which the
 * map fixes as the *top* of the target range rather than the middle of it. Both say so.
 */
export function estimateLine(platform: LocalModelPlatform, blob: BackendSettings): string {
	const measured = meanPageSeconds(blob);
	if (measured !== null) {
		return `${measured} seconds a page on this machine — ${humanDuration(measured * NOTEBOOK_PAGES)} for a ${NOTEBOOK_PAGES}-page notebook.`;
	}
	if (platform === "darwin") {
		return `About 15 seconds a page on a fast Mac — roughly 10 minutes for a ${NOTEBOOK_PAGES}-page notebook.`;
	}
	return (
		`An estimated 2½ to 4 minutes a page — 1½ to 3 hours for a ${NOTEBOOK_PAGES}-page notebook. ` +
		"Estimated, never measured on Windows hardware."
	);
}

/**
 * The sentence this backend adds to the re-transcribe confirmation (§7.7).
 *
 * `main.ts` appends a *cost* caveat for a metered backend and says nothing about time, because Vision
 * runs at 400 ms a page. At 14.9 s a page the time is the fact that decides the answer -- and this
 * backend is also the only way back from an `unavailable` unit (§8.1), so the command is one people
 * will actually reach for.
 *
 * Null until this machine has been measured: an invented total is worse than no total, and the
 * derived per-page bracket multiplied by 214 notes would read as a promise rather than a guess.
 */
export function reTranscribeCaveat(blob: BackendSettings, unitCount: number): string | null {
	const measured = meanPageSeconds(blob);
	if (measured === null || unitCount <= 0) return null;
	return ` and takes ${humanDuration(measured * unitCount)} on this machine`;
}
