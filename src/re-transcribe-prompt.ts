import type { OcrBackend } from "./ocr-backend";
import type { ReTranscribeNoteOutcome } from "./sync-engine";
import type { OcrBackendEntry } from "./ocr-registry";
import { UnavailableOcrBackend } from "./vision-ocr-backend";

/**
 * What the user is asked before every synced note in the vault is rewritten, and whether they are
 * offered the chance at all.
 *
 * Both questions are about a run that cannot be undone from inside the plugin: it re-fetches every
 * notebook from reMarkable, and it replaces each note's transcript with whatever comes back --
 * including with nothing, because `updateTranscript` removes the section for a blank result.
 */

/**
 * Whether "Re-transcribe all synced notes" belongs in the command palette.
 *
 * Two questions, because one of them cannot be answered by the object `create()` returned.
 *
 * The adapter says whether transcription is switched off, and whether this build has the selected
 * backend at all. It cannot say whether the backend can run *here*: Apple Vision builds a real
 * `VisionOcrBackend` on every desktop and only reports the gap from inside `recognize()`, one page at
 * a time and long after this check. So the entry is asked as well, through the same
 * `unavailableLabel()` the settings dropdown uses before it greys an option out.
 *
 * The `entry` is the resolved backend's, not the selected one's -- what matters is whether the run
 * that is about to start produces text, and a Pro backend that fell back to free local Vision runs as
 * Vision.
 *
 * **Why this is worth two questions rather than one.** The run re-fetches every notebook and rewrites
 * every synced note, and `updateTranscript` removes the whole Transcript section for a blank result.
 * A backend that cannot run here returns blanks for every page, so the command that promised to hide
 * itself would instead delete every transcript in the vault and report success. That was ticket 19,
 * reachable through a synced `data.json` on a Mac-plus-Windows vault.
 */
export function reTranscribeIsUseful(backend: OcrBackend, entry: OcrBackendEntry | null): boolean {
	if (backend.id === "off" || backend instanceof UnavailableOcrBackend) return false;
	return !entry?.unavailableLabel?.();
}

export interface ReTranscribeCost {
	readonly unitCount: number;
	readonly backendId: string;
	/** True only of a backend that spends money per page. Read off the resolved adapter, not the id. */
	readonly metered: boolean;
	/**
	 * The backend's own sentence, already a total rather than a rate -- "about 50 minutes" decides the
	 * answer where "about fifteen seconds a note" hands the user a multiplication. Empty where the
	 * backend has nothing to add; the core cannot compute it, since the figure is a rolling mean over
	 * the user's own pages inside the backend's opaque blob.
	 */
	readonly timeCaveat: string;
}

/**
 * The confirmation, in one paragraph.
 *
 * Transcription quality is stated because it is the fact that decides the answer: notes synced before
 * the improvements keep the transcript they earned until this command is run. The money clause is
 * conditional for the reason every warning is -- a cost warning on a free backend teaches the reader
 * to skip the one that means it.
 */
export function reTranscribeConfirmation(cost: ReTranscribeCost): string {
	const costCaveat = cost.metered ? " and re-sends every page to your OCR provider, using your API quota" : "";
	return (
		`Re-transcribe ${cost.unitCount} synced note(s) with the "${cost.backendId}" backend? ` +
		"Transcripts are now split by page, so you can tell which page a line came from. " +
		"Handwriting is also read more accurately than it used to be, and typed text is transcribed too. " +
		`This re-fetches each notebook from reMarkable${costCaveat}${cost.timeCaveat}. ` +
		// Last, after everything the decision is made on. The user this sentence is for is standing in
		// front of a dialog about to spend a whole vault's worth of pages to repair one note -- which
		// is exactly the moment the cheaper route is worth naming (selective-re-transcribe spec §9.1).
		'To repair a single note, use "Re-transcribe this note" instead.'
	);
}

/**
 * The two refusals a one-note run can reach before the device is ever asked (spec §6.3). Exported as
 * constants because the tests assert on the sentence a user reads, not on a code.
 */
export const NOTE_NOT_SYNCED_NOTICE = "This note isn't synced from reMarkable.";
export const NOTEBOOK_GONE_NOTICE = "The notebook for this note is no longer on your reMarkable.";

export interface ReTranscribeNoteQuestion {
	/** The note's own name. A warning about losing words has to say which words. */
	readonly noteName: string;
	/** The pages this run will send: the whole notebook for a notebook note, one for a tagged page. */
	readonly pageCount: number;
	readonly backendId: string;
	/** True only of a backend that spends money per page. Read off the resolved adapter, not the id. */
	readonly metered: boolean;
	/** The user has corrected this note inside the managed block; see `isBlockEdited`. */
	readonly handEdited: boolean;
}

/**
 * What one note's re-transcribe asks before it starts -- and `null` where it asks nothing, which is
 * the ordinary case: a free backend on a note nobody has touched simply runs.
 *
 * There is no standing confirmation here, unlike the whole-vault command, because that dialog's
 * justification is the size of the run and it does not survive the drop to one note. What earns a
 * dialog at N=1 is a different fact: the command says "this note" while the work is the whole
 * notebook. So the page count is the point -- a warning without a number is one users learn to click
 * through (spec §6.1).
 *
 * Both clauses in one dialog, never two in sequence: they are two facts about one decision.
 */
export function reTranscribeNoteConfirmation(question: ReTranscribeNoteQuestion): string | null {
	const clauses: string[] = [];
	// First, because it is the one that cannot be undone. The whole-vault command overwrites hand
	// edits without asking, covered by its own dialog; at N=1 the warning can name the note and say
	// what is lost, and that precision is the whole point of the command (spec §6.2).
	if (question.handEdited) {
		clauses.push(`You have corrected the transcript in "${question.noteName}" by hand. Re-transcribing replaces it, and those words cannot be brought back.`);
	}
	if (question.metered) {
		clauses.push(`This re-reads ${question.pageCount} page(s) of the notebook and sends them to the "${question.backendId}" backend, using your API quota.`);
	}
	return clauses.length === 0 ? null : clauses.join(" ");
}

/**
 * The one sentence each outcome earns, written here rather than in the engine because every other
 * user-facing string of this feature lives in this file (spec §5.5).
 *
 * `cancelled` has none: the user has just said no themselves, and reading it back to them is noise.
 * `emptied` is not an error -- the write succeeded and removed the section, which is what an empty
 * OCR result has always done. It is simply said out loud now, instead of being reported as success
 * over a note that just lost its text (spec §6.3).
 */
export function reTranscribeNoteNotice(outcome: ReTranscribeNoteOutcome, noteName: string): string | null {
	switch (outcome) {
		case "written":
			return `Re-transcribed "${noteName}".`;
		case "emptied":
			return "No text was found. The transcript has been removed.";
		case "not-on-device":
			return NOTEBOOK_GONE_NOTICE;
		case "pdf-digest":
			return "Margin notes on a PDF are kept as a digest, not as a transcript. Nothing was changed.";
		case "no-transcript-section":
			return "This note has no transcript section to write into.";
		case "stopped":
			return "Re-transcribe stopped. Nothing was changed.";
		case "cancelled":
			return null;
	}
}
