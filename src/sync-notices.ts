/**
 * Every sentence a finished sync raises.
 *
 * The engine tests each of these *conditions*; none of them tested the sentence. That is the whole
 * risk here: a sync that quietly skipped six notes and one that did everything look identical from
 * outside if the announcing code stops working, because the announcement is the only place the
 * difference exists. Each of these used to be a `console.warn` under a notice reporting plain
 * success, which is the failure mode this module was written out of.
 */

/** Long enough to read a sentence that asks the user to go and do something. Obsidian's default is 5 s. */
export const LONG_NOTICE_MS = 15_000;
/** For the one that only says where to look. */
export const SHORT_NOTICE_MS = 10_000;

export interface NoticeText {
	readonly message: string;
	readonly timeout: number;
}

export interface PartialOutcome {
	readonly failedOcrUnits: number;
	readonly editedNotesSkipped: number;
	readonly documentsSkipped: number;
	readonly relaidDocuments: number;
	readonly shrunkNotes: number;
}

/**
 * The ways a sync finishes "successfully" while quietly not doing what the user expected.
 *
 * The order is not cosmetic. Notices stack and the last one raised sits on top, so whichever goes
 * last is the one someone standing up from their desk actually reads -- and the last two are the
 * ones nothing else will ever flag.
 */
export function partialOutcomeNotices(result: PartialOutcome): NoticeText[] {
	const notices: NoticeText[] = [];
	// A failed transcription used to leave an empty "## Transcript" and a notice announcing plain
	// success, so the note looked synced and simply had no text.
	if (result.failedOcrUnits > 0) {
		notices.push({
			message:
				`${result.failedOcrUnits} ${result.failedOcrUnits === 1 ? "note" : "notes"} synced without a transcript because transcription failed. ` +
				"The handwriting render is still there. Press Copy diagnostics in settings if it keeps happening.",
			timeout: LONG_NOTICE_MS,
		});
	}
	if (result.editedNotesSkipped > 0) {
		notices.push({
			message:
				`${result.editedNotesSkipped} ${result.editedNotesSkipped === 1 ? "note was" : "notes were"} not updated because they were edited. ` +
				"Tagged Sync only rewrites notes it wrote itself. " +
				"Undo the change to resume syncing, and keep your own text in a separate note.",
			timeout: LONG_NOTICE_MS,
		});
	}
	if (result.documentsSkipped > 0) {
		notices.push({
			message: `${result.documentsSkipped} ${result.documentsSkipped === 1 ? "notebook was" : "notebooks were"} skipped — see the developer console for details.`,
			timeout: SHORT_NOTICE_MS,
		});
	}
	// A book whose font changed keeps every mark and moves the text under them, so the quotes go on
	// looking perfectly plausible while describing other sentences. Nothing else will ever flag it.
	if (result.relaidDocuments > 0) {
		notices.push({
			message:
				`${result.relaidDocuments} ${result.relaidDocuments === 1 ? "book has" : "books have"} been laid out again on the tablet since their notes were written — a font, size or margin change does that. ` +
				"Marks made before it stay where they were while the text moves, so their quotes may no longer be the sentences you marked. " +
				"Press Copy diagnostics in settings to see which.",
			timeout: LONG_NOTICE_MS,
		});
	}
	// The device lost the highlights, not the sync — but the vault is where the user might still have
	// a copy, and only for as long as they know to look.
	if (result.shrunkNotes > 0) {
		notices.push({
			message:
				`${result.shrunkNotes} ${result.shrunkNotes === 1 ? "note has" : "notes have"} fewer highlights than the last sync wrote. ` +
				"The device no longer has them, and notes mirror the device. " +
				"Press Copy diagnostics in settings to see which, and restore from a backup if you need them.",
			timeout: LONG_NOTICE_MS,
		});
	}
	return notices;
}

/**
 * What the run itself says it did.
 *
 * A background run still announces notes it wrote -- that is the good news auto-sync exists for --
 * but never announces having found nothing, or it would fire every interval, forever, to report that
 * nothing happened.
 */
export function outcomeNotice(outcome: {
	readonly stopped: boolean;
	readonly notesWritten: number;
	readonly background: boolean;
}): string | null {
	if (outcome.stopped) {
		return outcome.notesWritten > 0
			? `Sync stopped. ${outcome.notesWritten} note(s) written; the rest will sync next time.`
			: "Sync stopped before any note was written. Nothing was lost.";
	}
	if (outcome.notesWritten > 0) return `Synced ${outcome.notesWritten} note(s).`;
	return outcome.background ? null : "Already up to date.";
}

export interface PlatformGap {
	readonly unavailableUnits: number;
	/** Persisted, so the promise survives a restart. */
	readonly alreadyShown: boolean;
	/** Whether this build has anything to point the user at. */
	readonly alternativesExist: boolean;
}

/**
 * The one-time explanation of what this platform cannot transcribe (multi-provider spec §6.2).
 *
 * It states the limit and promises nothing: pointing at an API key setting this build does not have
 * is worse than silence, and a promise of a future fix would be a debt. The clause at the end is
 * therefore conditional on the build actually having somewhere to send the user.
 *
 * Returns null rather than deciding to stay quiet itself, because the "once" half is persistence and
 * that belongs to whoever owns `data.json` -- a flag kept in memory would say it again every morning.
 */
export function platformGapNotice(gap: PlatformGap): string | null {
	if (gap.unavailableUnits === 0 || gap.alreadyShown) return null;
	return (
		"Text transcription needs macOS 13 or later. On this system, notes sync with the handwriting render only." +
		(gap.alternativesExist ? " Choose another OCR backend in settings to transcribe here." : "")
	);
}
