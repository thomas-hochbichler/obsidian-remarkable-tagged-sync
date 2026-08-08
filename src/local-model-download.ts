// What the downloader decides (managed-local-llm-ocr spec §5.3), with no filesystem and no network
// underneath it.
//
// Every rule here is one the plugin gets exactly one chance at over 5.5 GB: a resume that appends to
// the wrong offset, a range the server quietly ignored, a second hash mismatch that a restart forgets
// about. Each is a pure function so it can be tested in a millisecond instead of in an hour.

import { RUNTIME_ARTEFACTS, totalDownloadBytes } from "./local-model-artefacts";
import type { LocalModelPlatform } from "./local-model-store";

/** Where a download has to start, given what a previous attempt left behind. */
export type ResumePlan = { kind: "fresh" } | { kind: "resume"; offset: number } | { kind: "complete" };

/**
 * Reads the `.part` size and decides where to pick up.
 *
 * A part longer than the pinned size is discarded rather than trusted: it cannot be a prefix of the
 * file we asked for, and appending to it only moves the discovery to the final hash, 5.5 GB later.
 */
export function planResume(partBytes: number, totalBytes: number): ResumePlan {
	if (partBytes <= 0 || partBytes > totalBytes) return { kind: "fresh" };
	if (partBytes === totalBytes) return { kind: "complete" };
	return { kind: "resume", offset: partBytes };
}

/** What the server's answer to a `Range` request means for the bytes already on disk. */
export type RangePlan = { kind: "append"; from: number } | { kind: "restart" } | { kind: "error"; status: number };

/**
 * The 206 rule, and it is the sharpest edge in the whole downloader.
 *
 * A `206 Partial Content` means the range was honoured and the body continues where the part stopped.
 * A **`200` means the range was ignored** and the body starts at byte zero -- HuggingFace redirects to
 * a signed CDN URL, which is where that happens in practice. Appending a 200 to an existing part
 * splices two beginnings together, and nothing notices until the final hash, after the whole file.
 * So a 200 truncates the part and restarts rather than appending.
 */
export function planRangeResponse(status: number, requestedOffset: number): RangePlan {
	if (status === 206) return { kind: "append", from: requestedOffset };
	if (status === 200) return { kind: "restart" };
	return { kind: "error", status };
}

/**
 * Room for the archive to sit beside what `tar` unpacks out of it.
 *
 * The archive is deleted once extraction succeeds, but both exist while it runs, so the peak is what
 * has to be free. Doubling the archive is generous by construction -- the unpacked runtime measures
 * slightly *less* than the compressed asset on Windows -- and being generous about 12 MB inside a
 * 5.5 GB check costs nothing.
 */
function extractionHeadroom(platform: LocalModelPlatform): number {
	return RUNTIME_ARTEFACTS[platform].bytes;
}

/**
 * Free bytes needed before a download may start.
 *
 * **Nothing is subtracted for a model already on disk.** An update lands beside its predecessor
 * (§5.1), so both occupy the volume at once -- and the free figure the OS reports already counts the
 * old one as used. Discounting it would be assuming we may delete it first, which §5.3 forbids
 * precisely because a complete model of a superseded version is the fallback if the new one fails.
 */
export function requiredFreeBytes(platform: LocalModelPlatform): number {
	return totalDownloadBytes(platform) + extractionHeadroom(platform);
}

/** How many bytes short the volume is, or 0 when there is room. */
export function freeSpaceShortfall(requiredBytes: number, freeBytes: number): number {
	return Math.max(0, requiredBytes - freeBytes);
}

/**
 * Bytes as the card quotes them: GB with one decimal, MB whole.
 *
 * Decimal units, not binary -- these numbers sit next to a disk's advertised capacity and a browser's
 * download figure, and both are decimal. A tenth of a megabyte is false precision on a number nobody
 * acts on, while a tenth of a gigabyte is the difference between freeing enough space and not.
 */
export function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * The out-of-disk line. It names the shortfall because a bare "not enough space" only sends the user
 * looking for the number nobody gave them -- and the figure only exists because §5.3 checks free
 * space *before* starting rather than discovering it at 90 %.
 */
export function shortfallMessage(shortfallBytes: number): string {
	return `Free ${formatBytes(shortfallBytes)} and press Resume.`;
}

/** What to do about a hash that did or did not match. */
export type VerificationOutcome = "verified" | "retry" | "corrupt";

/**
 * On mismatch: discard and download once more from zero, because the likeliest cause is a resume the
 * server mishandled. A **second** mismatch is terminal with no further automatic attempt -- the
 * evidence is that these bytes are not the published ones, and a third attempt is 5.5 GB spent on
 * hope.
 */
export function verificationOutcome(hashMatched: boolean, alreadyMismatchedOnce: boolean): VerificationOutcome {
	if (hashMatched) return "verified";
	return alreadyMismatchedOnce ? "corrupt" : "retry";
}

/** One model directory found beside the pinned one, described by what it holds. */
export interface ModelDirectory {
	name: string;
	hasPart: boolean;
	/** True when both model files are present at full length -- a set that would still transcribe. */
	complete: boolean;
}

/**
 * What to do with the directories a previous plugin version left behind.
 *
 * > Silent deletion is only for what is provably useless. Anything that ever worked costs a button
 * > press.
 *
 * A partial of an unpinned version is provably useless: this build has no URL that could finish it.
 * A *complete* model of a superseded version still transcribes, and it is the fallback if the new
 * download fails -- so it is named and sized and offered, never removed underneath the user.
 */
export function planCleanup(directories: ModelDirectory[], pinnedName: string): { deleteSilently: string[]; offerToDelete: string[] } {
	const deleteSilently: string[] = [];
	const offerToDelete: string[] = [];
	for (const directory of directories) {
		if (directory.name === pinnedName) continue;
		if (directory.complete) offerToDelete.push(directory.name);
		else if (directory.hasPart) deleteSilently.push(directory.name);
	}
	return { deleteSilently, offerToDelete };
}
