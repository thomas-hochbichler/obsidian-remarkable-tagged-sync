export interface DiagnosticsInput {
	pluginVersion: string;
	obsidianVersion: string;
	platform: string;
	/** What the Apple Vision gate says here -- the single most common cause of "there is no text". */
	visionAvailability: string;
	backend: string;
	/**
	 * The Vision request revision the OS chose on the last run, or null when Vision has not run here.
	 * Deliberately never pinned -- a revision that is accepted and then returns nothing would hand out
	 * empty transcripts instead of an error -- so which one ran is a fact only the machine knows.
	 */
	visionRevision: number | null;
	/**
	 * Writing that came back with no words over it at any framing, on the last sync. There is no
	 * confidence to report -- Vision claims 1.000 over plain misreads -- so this is the one honest
	 * signal that a note is missing something.
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
		`Vision revision: ${input.visionRevision ?? "not run here"}`,
		`Unreadable ink regions: ${input.unreadableInkRegions}`,
		`Reused page transcriptions: ${input.reusedPageTranscriptions === null ? "not measured yet" : `${input.reusedPageTranscriptions.reused} of ${input.reusedPageTranscriptions.total}`}`,
		`Mapped tags: ${input.mappedTagCount}`,
		`Last sync: ${input.lastSyncAt ?? "never"}`,
		`Last error: ${input.lastSyncError ?? "none"}`,
	].join("\n");
}
