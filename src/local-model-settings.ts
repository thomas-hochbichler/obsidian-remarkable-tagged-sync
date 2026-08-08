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
export const ENOUGH_PAGES_TO_MEASURE = 10;

/** Pages the estimate is quoted for, which is the notebook length the map measured against. */
const NOTEBOOK_PAGES = 40;

export interface LocalModelSettings {
	/** Whether the user has agreed to let the model run during a background sync (§7.5). */
	backgroundConsent: boolean;
	/** The last {@link ENOUGH_PAGES_TO_MEASURE} page durations, oldest first. */
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
	blob.recentPageMs = recent.slice(-ENOUGH_PAGES_TO_MEASURE);
}

export function setBackgroundConsent(blob: BackendSettings, consented: boolean): void {
	blob.backgroundConsent = consented;
}

/**
 * This machine's own seconds per page, or null while the derived figure still stands.
 *
 * Null rather than a figure over three pages: a number the card presents as measured has to be one,
 * and the whole point of the sequence in §7.3 is that the derived number is provisional **by
 * construction** rather than by disclaimer.
 *
 * **The middle page, not the mean.** §7.3 chose a mean over ten pages on the grounds that ten is
 * "large enough that one slow page does not set the number" -- and the release gate then falsified
 * the premise: the first pass after a download had *three* pages at 392-600 s while the system
 * indexed the new files, against 14.97 s on every later pass. The window that first fills is exactly
 * that contaminated pass, so a mean would retire the honest derived figure in favour of ~160 s/page
 * and present it as this machine's. The median keeps §7.3's intent with §7.3's own window, and
 * nothing here has to recognise an outlier or invent a threshold for one.
 */
export function typicalPageSeconds(blob: BackendSettings): number | null {
	const { recentPageMs } = readLocalModelSettings(blob);
	if (recentPageMs.length < ENOUGH_PAGES_TO_MEASURE) return null;
	const sorted = [...recentPageMs].sort((a, b) => a - b);
	const middle = sorted.length / 2;
	const medianMs = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[Math.floor(middle)];
	return Math.round(medianMs / 1000);
}

/**
 * A span of seconds at the resolution somebody can act on -- never a precision nobody asked for.
 *
 * The step widens with the number, because so does the error: this is one page out of ten of the
 * user's own extrapolated over a job, and "about 55 minutes" claims a sharpness it does not have while
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
 * What the pages right after a download do, which no derived figure describes.
 *
 * The release gate measured three pages at 392-600 s immediately after the 5.5 GB landed -- the
 * operating system indexing the new files while each fresh process mmaps the model -- against
 * 14.97 s/page on two later passes over the same ten pages. It is not a defect and there is nothing
 * to fix in the code, so the only honest place for it is the sentence it contradicts.
 *
 * Deliberately no magnitude: the measurement is one machine on macOS, and quoting "ten minutes a
 * page" on a Windows line where nobody has watched it would be inventing the number this spec's §14
 * exists to refuse. The mechanism is what both platforms share.
 */
export const FIRST_PAGES_CAVEAT =
	"The first pages after a download run far slower than this while your system indexes the new files; it settles by itself.";

/**
 * The Speed row: a derived figure that this machine overwrites (§7.3 states 9a → 9b).
 *
 * **Neither platform's pre-run figure is this user's figure.** Windows is derived from research and
 * may never be quoted as measured (map constraint 5); macOS's 14.9 s came from an M2 Max, which the
 * map fixes as the *top* of the target range rather than the middle of it. Both say so.
 *
 * The caveat rides with the derived figure and leaves with it. What makes that honest is
 * {@link typicalPageSeconds} taking the middle page rather than the mean: the number that replaces
 * the caveat is a settled page even when the window it came from is the first pass after a download.
 */
export function estimateLine(platform: LocalModelPlatform, blob: BackendSettings): string {
	const measured = typicalPageSeconds(blob);
	if (measured !== null) {
		return `${measured} seconds a page on this machine — ${humanDuration(measured * NOTEBOOK_PAGES)} for a ${NOTEBOOK_PAGES}-page notebook.`;
	}
	if (platform === "darwin") {
		return `About 15 seconds a page on a fast Mac — roughly 10 minutes for a ${NOTEBOOK_PAGES}-page notebook. ${FIRST_PAGES_CAVEAT}`;
	}
	return (
		`An estimated 2½ to 4 minutes a page — 1½ to 3 hours for a ${NOTEBOOK_PAGES}-page notebook. ` +
		`Estimated, never measured on Windows hardware. ${FIRST_PAGES_CAVEAT}`
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
	const measured = typicalPageSeconds(blob);
	if (measured === null || unitCount <= 0) return null;
	return ` and takes ${humanDuration(measured * unitCount)} on this machine`;
}
