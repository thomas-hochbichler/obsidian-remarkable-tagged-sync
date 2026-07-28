export interface DiagnosticsInput {
	pluginVersion: string;
	obsidianVersion: string;
	platform: string;
	/** What the Apple Vision gate says here -- the single most common cause of "there is no text". */
	visionAvailability: string;
	backend: string;
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
		`Mapped tags: ${input.mappedTagCount}`,
		`Last sync: ${input.lastSyncAt ?? "never"}`,
		`Last error: ${input.lastSyncError ?? "none"}`,
	].join("\n");
}
