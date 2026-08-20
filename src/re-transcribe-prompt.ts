import type { OcrBackend } from "./ocr-backend";
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
		`This re-fetches each notebook from reMarkable${costCaveat}${cost.timeCaveat}.`
	);
}
