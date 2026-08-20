import { describe, expect, it } from "vitest";
import type { OcrBackend } from "./ocr-backend";
import { reTranscribeConfirmation, reTranscribeIsUseful } from "./re-transcribe-prompt";
import { UnavailableOcrBackend } from "./vision-ocr-backend";

// The two decisions in front of a run that rewrites every synced note. `re-transcribe.test.ts` is the
// other half: that the shipped command asks these and does what the answers say.

const backend = (id: string, metered = false): OcrBackend =>
	({ id, metered, recognize: async () => ({ status: "ok", pages: null, text: "", confidence: null }) }) as OcrBackend;

describe("reTranscribeIsUseful", () => {
	it("says no to transcription switched off, and to a backend this build does not have", () => {
		expect(reTranscribeIsUseful(backend("off"))).toBe(false);
		expect(reTranscribeIsUseful(new UnavailableOcrBackend("tesseract"))).toBe(false);
	});

	it("says yes to anything that can produce text", () => {
		expect(reTranscribeIsUseful(backend("vision"))).toBe(true);
		expect(reTranscribeIsUseful(backend("anthropic", true))).toBe(true);
	});

	it("asks the adapter, which is why an unavailable one named 'off' is refused twice over", () => {
		// The id check and the class check are not the same question: an `UnavailableOcrBackend` can
		// carry any id, including a metered provider's, and the id alone would let it through.
		expect(reTranscribeIsUseful(new UnavailableOcrBackend("anthropic"))).toBe(false);
	});
});

describe("reTranscribeConfirmation", () => {
	const free = { unitCount: 12, backendId: "vision", metered: false, timeCaveat: "" };

	it("names the count and the backend, so the answer is made against both", () => {
		const said = reTranscribeConfirmation(free);

		expect(said).toContain("Re-transcribe 12 synced note(s)");
		expect(said).toContain('"vision" backend');
		expect(said).toContain("This re-fetches each notebook from reMarkable.");
	});

	it("says nothing about money for a backend that spends none", () => {
		// A cost warning on a free backend teaches the reader to skip the one that means it.
		expect(reTranscribeConfirmation(free)).not.toMatch(/quota|API|money|cost/i);
	});

	it("adds the quota clause only where a page actually costs something", () => {
		expect(reTranscribeConfirmation({ ...free, metered: true })).toContain(
			"This re-fetches each notebook from reMarkable and re-sends every page to your OCR provider, using your API quota.",
		);
	});

	it("lets the backend add its own estimate, and puts it inside the sentence", () => {
		// Inside, not after: the full stop belongs to the whole clause, and an estimate appended past
		// it would read as a second, unfinished sentence.
		const said = reTranscribeConfirmation({ ...free, timeCaveat: " and takes about 50 minutes" });

		expect(said).toContain("This re-fetches each notebook from reMarkable and takes about 50 minutes.");
		expect(said.endsWith(".")).toBe(true);
	});

	it("reads as one sentence with both clauses, in cost-then-time order", () => {
		const said = reTranscribeConfirmation({ ...free, metered: true, timeCaveat: " and takes about 50 minutes" });

		expect(said).toContain(
			"This re-fetches each notebook from reMarkable and re-sends every page to your OCR provider, using your API quota and takes about 50 minutes.",
		);
	});

	it("states what changed about transcripts, because that is the fact that decides the answer", () => {
		// Notes synced before the improvements keep the transcript they earned until this command runs.
		// Without the sentence, the dialog only lists costs and the reason to say yes is missing.
		const said = reTranscribeConfirmation(free);

		expect(said).toContain("split by page");
		expect(said).toContain("read more accurately");
		expect(said).toContain("typed text is transcribed too");
	});
});
