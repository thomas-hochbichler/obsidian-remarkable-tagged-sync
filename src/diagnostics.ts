import { describeOcrTally, type OcrTally } from "./ocr-tally";
import type { TextLayerTally } from "./text-layer";

export interface DiagnosticsInput {
	pluginVersion: string;
	obsidianVersion: string;
	platform: string;
	/** What the Apple Vision gate says here -- the single most common cause of "there is no text". */
	visionAvailability: string;
	backend: string;
	/**
	 * The Vision request revision the OS chose on the last run that transcribed anything, or null when
	 * that run did not use Vision.
	 * Deliberately never pinned -- a revision that is accepted and then returns nothing would hand out
	 * empty transcripts instead of an error -- so which one ran is a fact only the machine knows.
	 */
	visionRevision: number | null;
	/**
	 * Writing that came back with no words over it at any framing, on the last run that transcribed
	 * anything. There is no confidence to report -- Vision claims 1.000 over plain misreads -- so this
	 * is the one honest signal that a note is missing something.
	 */
	unreadableInkRegions: number;
	/**
	 * Pages the last sync kept the transcript of rather than reading again, out of the pages it wrote
	 * a transcript for (issue #117), or null before a sync has run under this feature.
	 *
	 * Here rather than in a notice: a skipped page is the feature working, and a line that fires on
	 * every successful sync is one people stop reading. But it is the first thing to check when
	 * someone reports "I edited a page and the transcript did not update", and this saves that
	 * exchange.
	 */
	reusedPageTranscriptions: { reused: number; total: number } | null;
	/**
	 * How the last sync's text layer went, or null before a sync has run under this feature. Not a
	 * notice either (spec §2.7): it answers "Cmd+F does not find my word" -- a page with no layer, or a
	 * word Vision could not place.
	 */
	textLayer: TextLayerTally | null;
	/** What the last sync or re-transcribe sent to the backend and got back, or null before one has run. */
	ocrTally: OcrTally | null;
	/**
	 * Active rows with an `ocrRetry`: documents whose digest lost transcriptions and that a later sync
	 * is to read again. Without it, notes that stayed unread after an update looked the same as notes
	 * nobody had tried to read at all.
	 */
	pendingOcrRetries: number;
	mappedTagCount: number;
	lastSyncAt: string | null;
	/** Raw text of the last failure, or null. Two error messages end with "see the developer console", which most users have never opened. */
	lastSyncError: string | null;
}

/**
 * The block behind "Copy diagnostics": the handful of facts almost every bug report needs, so a
 * reporter pastes them instead of being asked for them one at a time. With a reverse-engineered API
 * the raw error is often the whole diagnosis.
 *
 * Store-legal by construction -- this only builds a string. The user presses a button and pastes it;
 * nothing is ever sent anywhere, and there is no telemetry.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
	return [
		"Tagged Sync diagnostics",
		`Plugin: ${input.pluginVersion}`,
		`Obsidian: ${input.obsidianVersion}`,
		`Platform: ${input.platform}`,
		`Apple Vision: ${input.visionAvailability}`,
		`OCR backend: ${input.backend}`,
		...describeOcrTally(input.ocrTally),
		`Vision revision: ${input.visionRevision ?? "not run in the last transcription"}`,
		// Labelled, because only Apple Vision counts it: under any other backend it reads 0 whatever
		// happened, and a 0 under Ollama was once taken for "nothing went unread".
		`Unreadable ink regions (Apple Vision): ${input.unreadableInkRegions}`,
		`Reused page transcriptions: ${input.reusedPageTranscriptions === null ? "not measured yet" : `${input.reusedPageTranscriptions.reused} of ${input.reusedPageTranscriptions.total}`}`,
		`Text layer (last sync): ${input.textLayer === null ? "not measured yet" : `${input.textLayer.layered} of ${input.textLayer.pages} pages, ${input.textLayer.placed} words placed, ${input.textLayer.leftOut} left out`}`,
		`Documents waiting to be read again: ${input.pendingOcrRetries === 0 ? "none" : input.pendingOcrRetries}`,
		`Mapped tags: ${input.mappedTagCount}`,
		`Last sync: ${input.lastSyncAt ?? "never"}`,
		`Last error: ${input.lastSyncError ?? "none"}`,
	].join("\n");
}
