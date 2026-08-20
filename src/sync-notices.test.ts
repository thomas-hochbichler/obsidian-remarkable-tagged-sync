import { describe, expect, it } from "vitest";
import {
	LONG_NOTICE_MS,
	outcomeNotice,
	type PartialOutcome,
	partialOutcomeNotices,
	platformGapNotice,
	SHORT_NOTICE_MS,
} from "./sync-notices";

// The sentences, without a vault. `status-and-notices.test.ts` is the other half: that the shipped
// sync asks for these and raises what it gets.

const NOTHING_SKIPPED: PartialOutcome = {
	failedOcrUnits: 0,
	editedNotesSkipped: 0,
	documentsSkipped: 0,
	relaidDocuments: 0,
	shrunkNotes: 0,
};

const only = (field: keyof PartialOutcome, count: number) =>
	partialOutcomeNotices({ ...NOTHING_SKIPPED, [field]: count }).map((notice) => notice.message);

describe("partialOutcomeNotices", () => {
	it("says nothing when nothing was skipped", () => {
		// An empty list, so the caller has nothing to raise -- rather than five empty strings it has
		// to filter.
		expect(partialOutcomeNotices(NOTHING_SKIPPED)).toEqual([]);
	});

	it("says each outcome in its own words, singular and plural", () => {
		// Five nouns that inflect five different ways. Each was a console.warn under a notice
		// announcing plain success, which is what this module exists to undo.
		expect(only("failedOcrUnits", 1)[0]).toContain("1 note synced without a transcript");
		expect(only("failedOcrUnits", 2)[0]).toContain("2 notes synced without a transcript");

		expect(only("editedNotesSkipped", 1)[0]).toContain("1 note was not updated");
		expect(only("editedNotesSkipped", 2)[0]).toContain("2 notes were not updated");

		expect(only("documentsSkipped", 1)[0]).toContain("1 notebook was skipped");
		expect(only("documentsSkipped", 3)[0]).toContain("3 notebooks were skipped");

		expect(only("relaidDocuments", 1)[0]).toContain("1 book has been laid out again");
		expect(only("relaidDocuments", 2)[0]).toContain("2 books have been laid out again");

		expect(only("shrunkNotes", 1)[0]).toContain("1 note has fewer highlights");
		expect(only("shrunkNotes", 4)[0]).toContain("4 notes have fewer highlights");
	});

	it("tells the user what to do about each one, not only that it happened", () => {
		// The difference between a report and a notification. Each sentence names either the thing
		// that is still fine, or where to look.
		expect(only("failedOcrUnits", 1)[0]).toContain("The handwriting render is still there");
		expect(only("editedNotesSkipped", 1)[0]).toContain("Undo the change to resume syncing");
		expect(only("documentsSkipped", 1)[0]).toContain("see the developer console");
		expect(only("relaidDocuments", 1)[0]).toContain("Press Copy diagnostics in settings to see which");
		expect(only("shrunkNotes", 1)[0]).toContain("restore from a backup if you need them");
	});

	it("keeps its order and gives each notice time to be read", () => {
		// Notices stack and the last one raised sits on top, so the order decides which one somebody
		// standing up from their desk actually reads -- and the last two are the ones nothing else
		// will ever flag. The timeouts matter because Obsidian's default notice is gone in five
		// seconds and four of these ask the user to go and do something.
		const all = partialOutcomeNotices({
			failedOcrUnits: 1,
			editedNotesSkipped: 1,
			documentsSkipped: 1,
			relaidDocuments: 1,
			shrunkNotes: 1,
		});

		expect(all.map((notice) => notice.message.slice(0, 16))).toEqual([
			"1 note synced wi",
			"1 note was not u",
			"1 notebook was s",
			"1 book has been ",
			"1 note has fewer",
		]);
		expect(all.map((notice) => notice.timeout)).toEqual([
			LONG_NOTICE_MS,
			LONG_NOTICE_MS,
			SHORT_NOTICE_MS,
			LONG_NOTICE_MS,
			LONG_NOTICE_MS,
		]);
	});

	it("leaves out the ones that did not happen", () => {
		expect(partialOutcomeNotices({ ...NOTHING_SKIPPED, shrunkNotes: 2 })).toHaveLength(1);
	});
});

describe("outcomeNotice", () => {
	it("says what the run did, and stays quiet only where a background run must", () => {
		expect(outcomeNotice({ stopped: true, notesWritten: 2, background: false })).toBe(
			"Sync stopped. 2 note(s) written; the rest will sync next time.",
		);
		// The reassurance is the point: a user who stops a run wants to know they did not break it.
		expect(outcomeNotice({ stopped: true, notesWritten: 0, background: false })).toBe(
			"Sync stopped before any note was written. Nothing was lost.",
		);
		expect(outcomeNotice({ stopped: false, notesWritten: 3, background: false })).toBe("Synced 3 note(s).");
		expect(outcomeNotice({ stopped: false, notesWritten: 0, background: false })).toBe("Already up to date.");
		// The one a background run must never raise: it would fire every interval, forever, to report
		// that nothing happened.
		expect(outcomeNotice({ stopped: false, notesWritten: 0, background: true })).toBeNull();
	});

	it("still announces notes a background run wrote", () => {
		// That is the good news auto-sync exists for, and the one thing worth interrupting for.
		expect(outcomeNotice({ stopped: false, notesWritten: 1, background: true })).toBe("Synced 1 note(s).");
	});
});

describe("platformGapNotice", () => {
	const hit = { unavailableUnits: 1, alreadyShown: false, alternativesExist: false };

	it("offers another backend only where this build has one", () => {
		// Naming a setting this build does not have is the failure the sentence exists to avoid: it
		// would send the user looking for a dropdown entry that is not there.
		expect(platformGapNotice(hit)).toBe(
			"Text transcription needs macOS 13 or later. On this system, notes sync with the handwriting render only.",
		);
		expect(platformGapNotice({ ...hit, alternativesExist: true })).toContain(
			"Choose another OCR backend in settings to transcribe here.",
		);
	});

	it("promises nothing about a fix", () => {
		// A promise here would be a debt, and the platform gap is not this plugin's to close.
		expect(platformGapNotice({ ...hit, alternativesExist: true })).not.toMatch(/will|soon|future|coming/i);
	});

	it("answers null once it has been shown, and when there was nothing to report", () => {
		expect(platformGapNotice({ ...hit, alreadyShown: true })).toBeNull();
		expect(platformGapNotice({ ...hit, unavailableUnits: 0 })).toBeNull();
	});
});
