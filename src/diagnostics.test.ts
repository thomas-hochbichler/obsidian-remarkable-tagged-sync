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
	ocrTally: null,
	pendingOcrRetries: 0,
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
		expect(text).toContain("Unreadable ink regions (Apple Vision): 0");
		expect(text).toContain("Reused page transcriptions: 0 of 0");
	});

	/**
	 * A reporter's margin notes stayed unread after an update that was meant to read them, and the
	 * block said only "Last transcription: none since Obsidian started". Whether any document was
	 * waiting for another try at all was in nothing they could paste.
	 */
	it("counts the documents waiting to be read again", () => {
		expect(buildDiagnostics(BASE)).toContain("Documents waiting to be read again: none");
		expect(buildDiagnostics({ ...BASE, pendingOcrRetries: 2 })).toContain("Documents waiting to be read again: 2");
	});

	/** The first question behind "I edited a page and the transcript did not update" (issue #117). */
	it("reports how much of the transcription the per-page store answered", () => {
		expect(buildDiagnostics({ ...BASE, reusedPageTranscriptions: { reused: 99, total: 100 } })).toContain("Reused page transcriptions: 99 of 100");
	});

	/** The revision is the OS's choice, never ours -- so "which one ran" is a fact only the machine has. */
	it("says Vision did not run in the last transcription rather than printing a null revision", () => {
		expect(buildDiagnostics({ ...BASE, visionRevision: null })).toContain("Vision revision: not run in the last transcription");
	});

	/**
	 * The report that asked for these: every margin note "could not be transcribed", under `Last error:
	 * none`. The model and the empty count would each have named the cause on the first message.
	 */
	it("names the model the last run read with and what came back, by kind", () => {
		const text = buildDiagnostics({
			...BASE,
			backend: "ollama",
			ocrTally: {
				backend: "ollama",
				model: "qwen2.5vl:7b",
				pages: { read: 12, empty: 1, failed: 0, unavailable: 0 },
				notes: { read: 0, empty: 5, failed: 2, unavailable: 0 },
				warnings: ["The server at http://localhost:11434/v1 answered 500 — 1 page not transcribed."],
			},
		});
		expect(text).toContain("Last transcription: ollama, model qwen2.5vl:7b");
		expect(text).toContain("Pages: 12 read, 1 empty, 0 failed");
		expect(text).toContain("Margin notes: 0 read, 5 empty, 2 failed");
		expect(text).toContain("- The server at http://localhost:11434/v1 answered 500");
	});

	it("says no transcription has run yet rather than printing zeros for one", () => {
		const text = buildDiagnostics(BASE);
		expect(text).toContain("Last transcription: none since Obsidian started");
		expect(text).not.toContain("Margin notes:");
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
