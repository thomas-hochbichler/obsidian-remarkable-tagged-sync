import { describe, expect, it } from "vitest";
import { buildDiagnostics } from "./diagnostics";

const BASE = {
	pluginVersion: "1.0.0",
	obsidianVersion: "1.5.0",
	platform: "macOS",
	visionAvailability: "available",
	backend: "vision",
	visionRevision: 3,
	unreadableInkRegions: 0,
	reusedPageTranscriptions: { reused: 0, total: 0 },
	mappedTagCount: 1,
	lastSyncAt: "2026-07-24T09:00:00.000Z",
	lastSyncError: null,
};

describe("buildDiagnostics", () => {
	it("carries every fact a bug report otherwise has to be asked for", () => {
		const text = buildDiagnostics(BASE);
		expect(text).toContain("Plugin: 1.0.0");
		expect(text).toContain("Obsidian: 1.5.0");
		expect(text).toContain("Platform: macOS");
		expect(text).toContain("Apple Vision: available");
		expect(text).toContain("OCR backend: vision");
		expect(text).toContain("Mapped tags: 1");
		expect(text).toContain("Vision revision: 3");
		expect(text).toContain("Unreadable ink regions: 0");
		expect(text).toContain("Reused page transcriptions: 0 of 0");
	});

	/** The first question behind "I edited a page and the transcript did not update" (issue #117). */
	it("reports how much of the transcription the per-page store answered", () => {
		expect(buildDiagnostics({ ...BASE, reusedPageTranscriptions: { reused: 99, total: 100 } })).toContain("Reused page transcriptions: 99 of 100");
	});

	/** The revision is the OS's choice, never ours -- so "which one ran" is a fact only the machine has. */
	it("says Vision has not run here rather than printing a null revision", () => {
		expect(buildDiagnostics({ ...BASE, visionRevision: null })).toContain("Vision revision: not run here");
	});

	it("includes the raw last error, which is often the whole diagnosis", () => {
		expect(buildDiagnostics({ ...BASE, lastSyncError: "TypeError: Failed to fetch" })).toContain("Last error: TypeError: Failed to fetch");
	});

	it("says so plainly when there is nothing to report, rather than printing null", () => {
		const text = buildDiagnostics({ ...BASE, lastSyncAt: null, lastSyncError: null, reusedPageTranscriptions: null });
		expect(text).toContain("Last sync: never");
		expect(text).toContain("Last error: none");
		expect(text).toContain("Reused page transcriptions: not measured yet");
		expect(text).not.toContain("null");
	});
});
