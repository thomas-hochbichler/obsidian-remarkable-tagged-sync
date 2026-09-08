import { describe, expect, it } from "vitest";
import type { OcrBackend } from "./ocr-backend";
import type { OcrBackendEntry } from "./ocr-registry";
import { reTranscribeConfirmation, reTranscribeIsUseful, reTranscribeNoteConfirmation, reTranscribeNoteNotice } from "./re-transcribe-prompt";
import type { ReTranscribeNoteOutcome } from "./sync-engine";
import { UnavailableOcrBackend } from "./vision-ocr-backend";

// The two decisions in front of a run that rewrites every synced note. `re-transcribe.test.ts` is the
// other half: that the shipped command asks these and does what the answers say.

const backend = (id: string, metered = false): OcrBackend =>
	({ id, metered, fingerprint: "test-backend", recognize: async () => ({ status: "ok", pages: null, text: "", confidence: null }) }) as OcrBackend;

/** A registry entry that either declares a gap on this machine, or does not. */
const entry = (id: string, unavailable: string | null = null): OcrBackendEntry =>
	({ id, label: id, unavailableLabel: () => unavailable }) as OcrBackendEntry;

/** An entry for a backend that can never be unavailable, so it omits the hook entirely. */
const plainEntry = (id: string): OcrBackendEntry => ({ id, label: id }) as OcrBackendEntry;

describe("reTranscribeIsUseful", () => {
	it("says no to transcription switched off, and to a backend this build does not have", () => {
		expect(reTranscribeIsUseful(backend("off"), plainEntry("off"))).toBe(false);
		expect(reTranscribeIsUseful(new UnavailableOcrBackend("tesseract"), null)).toBe(false);
	});

	it("says yes to anything that can produce text here", () => {
		expect(reTranscribeIsUseful(backend("vision"), entry("vision", null))).toBe(true);
		expect(reTranscribeIsUseful(backend("anthropic", true), plainEntry("anthropic"))).toBe(true);
	});

	it("asks the adapter, which is why an unavailable one named 'off' is refused twice over", () => {
		// The id check and the class check are not the same question: an `UnavailableOcrBackend` can
		// carry any id, including a metered provider's, and the id alone would let it through.
		expect(reTranscribeIsUseful(new UnavailableOcrBackend("anthropic"), plainEntry("anthropic"))).toBe(false);
	});

	it("says no to a backend that builds an adapter here and still cannot run", () => {
		// Ticket 19, and the reason the entry is asked at all. Apple Vision off macOS builds a real
		// adapter on every desktop and only answers `unavailable` from inside `recognize()`, one page
		// at a time -- so the adapter alone cannot tell this apart from a working backend.
		expect(reTranscribeIsUseful(backend("vision"), entry("vision", "Apple Vision — macOS only"))).toBe(false);
	});

	it("says no to a backend whose setup is not finished, for the same reason", () => {
		// The managed local model before its download completes. Same shape, different sentence -- and
		// the entry is the only thing that knows either of them.
		expect(reTranscribeIsUseful(backend("local"), entry("local", "Local model — not ready"))).toBe(false);
	});

	it("does not require an entry to declare the hook at all", () => {
		// Most backends can never be unavailable and omit `unavailableLabel` entirely. A missing hook
		// is not a gap.
		expect(reTranscribeIsUseful(backend("ollama"), plainEntry("ollama"))).toBe(true);
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

	it("points at the one-note command, since that is the cheaper route to the same repair", () => {
		// The route stays; only the wording of its dialog changes. This sentence reaches the user this
		// whole effort exists for -- one bad transcript -- at the moment they are about to pay for the
		// whole vault to fix it.
		const said = reTranscribeConfirmation(free);

		expect(said).toContain('use "Re-transcribe this note" instead');
		expect(said.endsWith('use "Re-transcribe this note" instead.')).toBe(true);
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

// The one-note command's own strings. `re-transcribe.test.ts` is the other half: that the shipped
// command assembles these and shows them.

describe("reTranscribeNoteConfirmation", () => {
	const clean = { noteName: "Meeting 12.3", pageCount: 47, backendId: "anthropic", metered: false, handEdited: false };

	it("asks nothing where there is nothing to ask", () => {
		// The ordinary case, and the reason there is no standing confirmation: a free backend on a note
		// nobody has touched has no fact to put in front of the user, and a dialog with nothing in it
		// is what teaches people to click through the ones that mean something.
		expect(reTranscribeNoteConfirmation(clean)).toBeNull();
	});

	it("carries the page count where a page costs money", () => {
		const said = reTranscribeNoteConfirmation({ ...clean, metered: true })!;

		expect(said).toContain("47 page(s)");
		expect(said).toContain("API quota");
		// The command says "this note"; the work is the whole notebook. Without the number that gap is
		// invisible.
		expect(said).not.toContain("by hand");
	});

	it("names the note and what is lost where the block was edited by hand", () => {
		const said = reTranscribeNoteConfirmation({ ...clean, handEdited: true })!;

		expect(said).toContain('"Meeting 12.3"');
		expect(said).toContain("cannot be brought back");
		// A free backend spends nothing, and a cost warning here would teach the reader to skip the one
		// that means it.
		expect(said).not.toMatch(/quota|API/i);
	});

	it("puts both facts in one dialog, the one that cannot be undone first", () => {
		// Two dialogs in sequence would be two decisions about one run, and the second would be
		// answered without being read.
		const said = reTranscribeNoteConfirmation({ ...clean, metered: true, handEdited: true })!;

		expect(said).toContain("by hand");
		expect(said).toContain("API quota");
		expect(said.indexOf("by hand")).toBeLessThan(said.indexOf("API quota"));
	});
});

describe("reTranscribeNoteNotice", () => {
	const outcomes: ReTranscribeNoteOutcome[] = ["written", "emptied", "not-on-device", "pdf-digest", "no-transcript-section", "stopped"];

	it("gives every outcome that says anything its own sentence", () => {
		// Six outcomes, six distinct sentences. Two outcomes sharing one would tell a user whose PDF
		// was refused the same thing as one whose notebook is gone.
		const said = outcomes.map((outcome) => reTranscribeNoteNotice(outcome, "Meeting 12.3"));

		expect(said.every((sentence) => sentence !== null && sentence !== "")).toBe(true);
		expect(new Set(said).size).toBe(outcomes.length);
		expect(reTranscribeNoteNotice("written", "Meeting 12.3")).toBe('Re-transcribed "Meeting 12.3".');
		// The deletion an empty result performs, said out loud rather than reported as plain success.
		expect(reTranscribeNoteNotice("emptied", "Meeting 12.3")).toContain("has been removed");
	});

	it("says nothing back to a user who has just said no", () => {
		expect(reTranscribeNoteNotice("cancelled", "Meeting 12.3")).toBeNull();
	});
});
