import type { SyncProgress } from "./sync-engine";

/**
 * What the status item shows, decided before anything touches an element.
 *
 * It is the only thing on screen during a run, and every wrong answer here is a lie that stands
 * indefinitely: a bar left at full says the sync is still going, an icon stuck on the spinner says
 * the same, and a `mod-clickable` on a finished run offers to stop something that already ended.
 * Nothing else on screen will correct any of them.
 */

export type SyncStatusState = "busy" | "ok" | "failed" | "stopped" | "asleep";

/**
 * Lucide icon per state, rendered through `setIcon()` so it follows the theme rather than shipping a
 * glyph. `stopped` earns its own rather than borrowing one: a check would claim a run that finished
 * and a cross would claim one that broke, and a user-stopped run is neither.
 *
 * `asleep` earns one by the same argument. A background sync skipped because the tablet is in a
 * drawer is not a failure -- painting a cross for it every night is how a status bar stops being
 * read at all -- and it is not a success either, because nothing was synced.
 */
export const STATUS_ICONS: Record<SyncStatusState, string> = {
	busy: "refresh-cw",
	ok: "check",
	failed: "x",
	stopped: "square",
	asleep: "moon",
};

/** What a caller asks for. */
export interface StatusRequest {
	readonly state: SyncStatusState;
	readonly text: string;
	/**
	 * A percentage, or absent for the states that must not show one at all. Absent rather than 0:
	 * an empty bar is still a bar, and it claims a run that has done nothing yet.
	 */
	readonly bar?: number | null;
	/** The part that does not fit beside the item -- about 200px before it runs off the left. */
	readonly detail?: string;
	/**
	 * Separate from `text` because the two need opposite treatment: a name is of unbounded length and
	 * gets cut short (the tooltip repeats it in full), while `text` is a sentence with nowhere else to
	 * be read and must survive whole.
	 */
	readonly document?: string;
}

/** What the item shows, with every decision already made. */
export interface StatusView {
	readonly state: SyncStatusState;
	readonly icon: string;
	readonly spinning: boolean;
	readonly stoppable: boolean;
	readonly tooltip: string;
	readonly bar: number | null;
	readonly text: string;
	readonly document: string;
}

const STOP_OFFER = "Click to stop the sync";

/**
 * Whether the item is offering to stop is not the same question as whether a run is happening: a
 * stop already requested leaves the run going for a while yet, and a second click has nothing left
 * to ask for.
 */
export function statusView(request: StatusRequest, stopRequested: boolean): StatusView {
	const stoppable = request.state === "busy" && !stopRequested;
	return {
		state: request.state,
		icon: STATUS_ICONS[request.state],
		spinning: request.state === "busy",
		stoppable,
		// Filtered before joining: an absent detail would otherwise leave the tooltip opening on a
		// blank line, and an absent offer would leave it ending on one.
		tooltip: [request.detail, stoppable ? STOP_OFFER : ""].filter((part) => part).join("\n"),
		bar: request.bar ?? null,
		text: request.text,
		document: request.document ?? "",
	};
}

/** What one progress tick asks for. */
export function progressStatus(progress: SyncProgress, stopRequested: boolean, lastBar: number | null): StatusRequest {
	// A pending stop outranks the ticks: they would go on announcing work the user has already asked
	// to end. The bar is carried forward rather than emptied -- the work already done is not undone.
	if (stopRequested) return { state: "busy", text: "Tagged Sync: stopping…", bar: lastBar };
	if (progress.phase === "scanning") {
		// No bar: how much there is to do is precisely what is not known yet. The name beside the
		// counter is what separates a slow scan from a stuck one -- the counter itself can stand still
		// for a long time while several documents are open at once. The separator belongs to whichever
		// side is followed by the other, so it cannot dangle.
		const counted = `checking ${progress.checked} of ${progress.candidates}${progress.document ? " ·" : ""}`;
		return {
			state: "busy",
			// `candidates` is 0 until the enumeration comes back, and "checking 0 of 0" reads as a
			// finished run that found nothing.
			text: progress.candidates === 0 ? "Tagged Sync: scanning…" : counted,
			bar: null,
			document: progress.document,
			detail: progress.document,
		};
	}
	return {
		state: "busy",
		// The document's name alone, without the usual "Tagged Sync:" -- the icon says whose item this
		// is, and the prefix would cost the width the name needs.
		text: "",
		// Clamped because the pre-scan can under-count: past full, the plugin looks broken at exactly
		// the moment it is nearly done.
		bar: Math.min(100, (progress.done / progress.total) * 100),
		document: progress.document,
		detail: `${progress.document}\ntag: ${progress.tag} · page ${progress.unitDone} of ${progress.unitTotal} · ${progress.step}`,
	};
}

/**
 * What the item is left showing once a run ends. No bar in any of the three: one left sitting at full
 * claims the run is still happening, and it would sit there until the next sync.
 */
export function outcomeStatus(outcome: { readonly stopped: boolean; readonly notesWritten: number }): StatusRequest {
	if (outcome.stopped) return { state: "stopped", text: `Tagged Sync: stopped · ${outcome.notesWritten} note(s)` };
	// A count of zero would read as a failure; "up to date" is the same fact stated as the good news
	// it is.
	return {
		state: "ok",
		text: outcome.notesWritten > 0 ? `Tagged Sync: ${outcome.notesWritten} note(s)` : "Tagged Sync: up to date",
	};
}
