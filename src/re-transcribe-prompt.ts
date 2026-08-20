import type { OcrBackend } from "./ocr-backend";
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
 * **Known hole, characterised in `re-transcribe.test.ts` and filed as ticket 19.** Feature C20 says
 * the command is hidden for a backend that produces no text, and names "Off, or Vision on
 * Windows/Linux". Only the first is true here: `vision.create()` hands back a real `VisionOcrBackend`
 * on every desktop and only its `recognize()` answers `unavailable`, mid-run, long after this check.
 * Asking the *entry* whether it has an `unavailableLabel()` -- which is what the settings dropdown
 * already asks -- would close it, and that is a product decision rather than a move.
 *
 * Moved unchanged so the characterisation still describes it. C20.4 is the row that says so.
 */
export function reTranscribeIsUseful(backend: OcrBackend): boolean {
	return !(backend.id === "off" || backend instanceof UnavailableOcrBackend);
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
		`This re-fetches each notebook from reMarkable${costCaveat}${cost.timeCaveat}.`
	);
}
