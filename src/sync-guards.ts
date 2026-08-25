/**
 * What has to be true before a long job starts, and what the user is told when it is not.
 *
 * Both long jobs -- `Sync now` and `Re-transcribe synced notes` -- write the one sync index, so the
 * rule that matters here is that only one of them runs at a time. Two runs on one index is not a
 * confusing screen; it is two writers interleaving rows, and the loser's notes strand in the vault
 * with no row describing them.
 *
 * The order of the two refusals is a decision, not an accident: someone who is not connected is told
 * that even while a run is in flight, because "a sync is already running" would send them looking for
 * a run they cannot see while the thing actually stopping them is the missing device token.
 *
 * What this module cannot do is hold the lock. `running` is a snapshot, and a caller that acts on it
 * after an `await` has read something that stopped being true -- so the taking of the lock lives in
 * `claimRun` in `main.ts`, one synchronous step, and this only decides and words the refusal.
 */

export const NOT_CONNECTED_NOTICE = "Connect to reMarkable first.";
export const ALREADY_RUNNING_NOTICE = "A sync is already running.";
export const NOTHING_SYNCED_NOTICE = "No synced notes to re-transcribe yet.";

export interface RunConditions {
	/** The source is configured -- a stored device token, or a paired tablet. */
	readonly connected: boolean;
	/**
	 * What to say when it is not, in the words of whichever source is selected.
	 *
	 * Carried rather than assumed, because "Connect to reMarkable first." sends someone whose vault
	 * syncs from the tablet hunting for a one-time code they will never need. Defaulted to the cloud's
	 * sentence so a caller that predates two sources still reads correctly.
	 */
	readonly connectNotice?: string;
	/** A sync or a re-transcribe holds the lock right now. */
	readonly running: boolean;
	/** The selected backend is one only a licence unlocks, so its state is worth re-reading first. */
	readonly backendRequiresLicence: boolean;
}

export type Preflight =
	| { readonly start: false; readonly notice: string }
	/**
	 * `refreshLicence` is not a second gate: the answer never refuses the run. A lapsed licence falls
	 * back to a free backend inside `resolveOcrBackend` with a message, which is the one behaviour a
	 * buyer whose card expired mid-notebook can act on.
	 */
	| { readonly start: true; readonly refreshLicence: boolean };

export function preflightRun(conditions: RunConditions): Preflight {
	if (!conditions.connected) return { start: false, notice: conditions.connectNotice ?? NOT_CONNECTED_NOTICE };
	if (conditions.running) return { start: false, notice: ALREADY_RUNNING_NOTICE };
	return { start: true, refreshLicence: conditions.backendRequiresLicence };
}

/**
 * How many notes a re-transcribe would rewrite. Only `active` rows count: a row goes `orphaned` when
 * its note is no longer in the vault, and re-transcribing one would write the deleted note straight
 * back. `orphanRow` in the engine names that exclusion as part of what orphaning is for.
 *
 * Zero is what turns the command into a sentence instead of a confirmation dialog -- and the number
 * itself is what that dialog quotes, so it is the same count either way.
 */
export function reTranscribableUnits(rows: Record<string, { status: string }>): number {
	return Object.values(rows).filter((row) => row.status === "active").length;
}
