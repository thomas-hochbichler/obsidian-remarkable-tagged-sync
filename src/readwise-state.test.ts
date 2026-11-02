import { describe, expect, it } from "vitest";
import type { ReadwiseEntry } from "./readwise-highlights";
import {
	bookIdOf,
	isPending,
	pendingDocuments,
	pendingItems,
	type ReadwiseBook,
	readwiseBook,
	readwiseCounts,
	type ReadwiseHighlight,
	type ReadwiseText,
	recordUnit,
	type RecordedUnit,
	type StoredReadwiseBooks,
	withBook,
} from "./readwise-state";

// Spec §4.2: what one unit write records for Readwise, no network. Every state row of spec §8 is one
// test here; what the push then does with it is ticket 19's.

const DOC = "0f1e2d3c-doc";
const PAGE = "6a7b8c9d-page";
const OTHER_PAGE = "9e8d7c6b-page";

function entry(key: string, text: string, overrides: Partial<ReadwiseEntry> = {}): ReadwiseEntry {
	return { key, text, location: 12, url: `obsidian://tagged-sync?highlight=${DOC}/${key}`, ...overrides } as ReadwiseEntry;
}

function unit(items: readonly ReadwiseEntry[], overrides: Partial<RecordedUnit> = {}): RecordedUnit {
	return { items, scope: "document", identity: { title: "Cape Marrow", author: "Ada Byrne" }, marginNotes: true, ...overrides };
}

/** The document's book after recording, failing the test where there is none. */
function bookAfter(books: StoredReadwiseBooks, docId = DOC) {
	const book = readwiseBook(books, docId);
	if (book === null) throw new Error(`expected a book for ${docId}, got ${JSON.stringify(books[docId])}`);
	return book;
}

const KEY = `${PAGE}:1a2b`;
const SENTENCE = "The **weather station** was built in the spring.";
const PUSHED: ReadwiseText = { text: SENTENCE, location: 12 };

/** A vault whose document already has its book in Readwise, holding `highlights`. */
function storedBook(highlights: Record<string, ReadwiseHighlight>, extra: Partial<ReadwiseBook> = {}): StoredReadwiseBooks {
	return { [DOC]: { title: "Cape Marrow", author: "Ada Byrne", bookId: 64836623, highlights, ...extra } };
}

describe("recordUnit", () => {
	it("wants the new text of a mark changed on the tablet, in the same record", () => {
		const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901 } }), DOC, unit([entry(KEY, "The **weather station at Cape Marrow** was built in the spring.")]));

		expect(bookAfter(books).highlights[KEY]).toEqual({ pushed: PUSHED, id: 901, want: { text: "The **weather station at Cape Marrow** was built in the spring.", location: 12 } });
	});

	it("wants nothing for a mark that is what Readwise holds", () => {
		const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901 } }), DOC, unit([entry(KEY, SENTENCE)]));

		expect(bookAfter(books).highlights[KEY]).toEqual({ pushed: PUSHED, id: 901 });
	});

	it("counts a moved page or an added note as a change, the whole text compared", () => {
		const moved = recordUnit(storedBook({ [KEY]: { pushed: PUSHED } }), DOC, unit([entry(KEY, SENTENCE, { location: 13 })]));
		const noted = recordUnit(storedBook({ [KEY]: { pushed: PUSHED } }), DOC, unit([entry(KEY, SENTENCE, { note: "1962?" })]));

		expect(bookAfter(moved).highlights[KEY].want).toEqual({ text: SENTENCE, location: 13 });
		expect(bookAfter(noted).highlights[KEY].want).toEqual({ text: SENTENCE, note: "1962?", location: 12 });
	});

	it("wants a mark erased on the tablet deleted, also one edited in Readwise", () => {
		const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901 } }), DOC, unit([]));

		expect(bookAfter(books).highlights[KEY]).toEqual({ pushed: PUSHED, id: 901, want: null });
	});

	it("drops a mark erased before its first push landed: nothing reaches Readwise", () => {
		const books = recordUnit(storedBook({ [KEY]: { want: PUSHED } }), DOC, unit([]));

		expect(bookAfter(books).highlights).toEqual({});
	});

	describe("what a unit speaks for", () => {
		const OTHER_KEY = `${OTHER_PAGE}:7f80`;
		const twoPages = () => storedBook({ [KEY]: { pushed: PUSHED }, [OTHER_KEY]: { pushed: { text: "Elsewhere.", location: 30 } } });

		it("is the one page of a page-tag unit: a mark of another page is not erased by it", () => {
			const books = recordUnit(twoPages(), DOC, unit([], { scope: { pageId: PAGE } }));

			expect(bookAfter(books).highlights[KEY].want).toBeNull();
			expect(bookAfter(books).highlights[OTHER_KEY]).toEqual({ pushed: { text: "Elsewhere.", location: 30 } });
		});

		it("is nothing for a digest that failed to build", () => {
			const books = recordUnit(twoPages(), DOC, unit([], { scope: "none" }));

			expect(bookAfter(books).highlights).toEqual(bookAfter(twoPages()).highlights);
		});

		// Spec §4.2, review 2 A2: also the pages that no longer exist on the tablet.
		it("is every record of the book for a whole-document unit, so a page deleted on the tablet takes its highlights with it", () => {
			const books = recordUnit(twoPages(), DOC, unit([entry(KEY, SENTENCE)]));

			expect(bookAfter(books).highlights[OTHER_KEY].want).toBeNull();
			expect(bookAfter(books).highlights[KEY]).toEqual({ pushed: PUSHED });
		});

		it("deletes a page added on the tablet and then erased", () => {
			const ADDED = "added-page:page";
			const books = recordUnit(storedBook({ [ADDED]: { pushed: { text: "first line", location: 12 }, margin: true } }), DOC, unit([]));

			expect(bookAfter(books).highlights[ADDED].want).toBeNull();
		});

		// Spec §4.2: a document tag and a page tag each read the same margin note, and an LLM may read it
		// differently per unit; the later unit's reading wins, the rest of the book is left as the first unit recorded it.
		it("lets the later of two units of one document win on their page, and leaves the other pages to the first", () => {
			const whole = recordUnit(twoPages(), DOC, unit([entry(KEY, SENTENCE, { note: "1962?" }), entry(OTHER_KEY, "Elsewhere, again.", { location: 30 })]));
			const books = recordUnit(whole, DOC, unit([entry(KEY, SENTENCE, { note: "1963?" })], { scope: { pageId: PAGE } }));

			expect(bookAfter(books).highlights[KEY].want).toEqual({ text: SENTENCE, note: "1963?", location: 12 });
			expect(bookAfter(books).highlights[OTHER_KEY].want).toEqual({ text: "Elsewhere, again.", location: 30 });
		});
	});

	// Research 03 §3.1: an adjusted selection can come back under a new CRDT id.
	it("deletes a passage re-selected under a new key and creates it under that key", () => {
		const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901 } }), DOC, unit([entry(`${PAGE}:3c4d`, SENTENCE)]));

		expect(bookAfter(books).highlights).toEqual({ [KEY]: { pushed: PUSHED, id: 901, want: null }, [`${PAGE}:3c4d`]: { want: PUSHED } });
	});

	// Research 03 §3.3: an EPUB re-laid out keeps the key and moves other words under it.
	it("overwrites a highlight of an EPUB re-laid out, the same key now holding other text", () => {
		const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901 } }), DOC, unit([entry(KEY, "spring. The **station** opened", { location: 14 })]));

		expect(bookAfter(books).highlights[KEY]).toEqual({ pushed: PUSHED, id: 901, want: { text: "spring. The **station** opened", location: 14 } });
	});

	// Spec §11 P12: what could not be read says nothing about what the tablet holds.
	describe("an unread transcription", () => {
		const NOTE_KEY = `${PAGE}:3c4d`;

		it("leaves its own record as it is, neither pushed nor deleted, and records the entry beside it", () => {
			const stored = storedBook({ [NOTE_KEY]: { pushed: { text: "check the date", location: 12 }, margin: true } });
			const books = recordUnit(stored, DOC, unit([{ key: NOTE_KEY, unread: true, margin: true, location: 12, url: "" }, entry(KEY, SENTENCE)]));

			expect(bookAfter(books).highlights).toEqual({ [NOTE_KEY]: { pushed: { text: "check the date", location: 12 }, margin: true }, [KEY]: { want: PUSHED } });
		});

		it("creates nothing for an entry never read", () => {
			const books = recordUnit({}, DOC, unit([{ key: NOTE_KEY, unread: true, margin: true, location: 12, url: "" }, entry(KEY, SENTENCE)]));

			expect(Object.keys(bookAfter(books).highlights)).toEqual([KEY]);
		});

		it("keeps the note Readwise holds for a highlight whose nested note could not be read, the text compared as usual", () => {
			const stored = storedBook({ [KEY]: { pushed: { ...PUSHED, note: "check the date\n\n1962?" } } });

			const unchanged = recordUnit(stored, DOC, unit([entry(KEY, SENTENCE, { note: "1962?", noteUnread: true })]));
			const moved = recordUnit(stored, DOC, unit([entry(KEY, SENTENCE, { noteUnread: true, location: 13 })]));

			expect(bookAfter(unchanged).highlights[KEY]).toEqual({ pushed: { ...PUSHED, note: "check the date\n\n1962?" } });
			expect(bookAfter(moved).highlights[KEY].want).toEqual({ ...PUSHED, note: "check the date\n\n1962?", location: 13 });
		});

		it("keeps a pending note rather than voiding it against the older one Readwise holds", () => {
			const stored = storedBook({ [KEY]: { pushed: { ...PUSHED, note: "1962?" }, want: { ...PUSHED, note: "1963?" } } });

			const books = recordUnit(stored, DOC, unit([entry(KEY, SENTENCE, { noteUnread: true })]));

			expect(bookAfter(books).highlights[KEY].want).toEqual({ ...PUSHED, note: "1963?" });
		});
	});

	// Spec §11 P20: flipping a vault setting must not delete every standalone note in Readwise.
	describe("margin notes switched off", () => {
		const NOTE_KEY = `${PAGE}:3c4d`;
		const stored = () =>
			storedBook({
				[KEY]: { pushed: { ...PUSHED, note: "1962?" } },
				[NOTE_KEY]: { pushed: { text: "check the date", location: 12 }, margin: true },
				["added-page:page"]: { pushed: { text: "first line", location: 12 }, margin: true },
			});

		it("leaves the notes and added pages in Readwise as they are, and each highlight its note", () => {
			const books = recordUnit(stored(), DOC, unit([entry(KEY, SENTENCE)], { marginNotes: false }));

			expect(bookAfter(books).highlights).toEqual(bookAfter(stored()).highlights);
		});

		it("ignores a note or an added page handed to it all the same", () => {
			const books = recordUnit(stored(), DOC, unit([entry(KEY, SENTENCE), entry(NOTE_KEY, "check the year", { margin: true })], { marginNotes: false }));

			expect(bookAfter(books).highlights).toEqual(bookAfter(stored()).highlights);
		});

		it("still records a highlight's own change, with the note it had", () => {
			const books = recordUnit(stored(), DOC, unit([entry(KEY, SENTENCE, { location: 13 })], { marginNotes: false }));

			expect(bookAfter(books).highlights[KEY].want).toEqual({ ...PUSHED, note: "1962?", location: 13 });
		});

		it("records what changed meanwhile once they are on again", () => {
			const off = recordUnit(stored(), DOC, unit([entry(KEY, SENTENCE)], { marginNotes: false }));

			const books = recordUnit(off, DOC, unit([entry(KEY, SENTENCE, { note: "1963?" }), entry(NOTE_KEY, "check the date", { margin: true })]));

			expect(bookAfter(books).highlights).toEqual({
				[KEY]: { pushed: { ...PUSHED, note: "1962?" }, want: { ...PUSHED, note: "1963?" } },
				[NOTE_KEY]: { pushed: { text: "check the date", location: 12 }, margin: true },
				["added-page:page"]: { pushed: { text: "first line", location: 12 }, margin: true, want: null },
			});
		});
	});

	// Spec §11 P13: retried when it changes on the tablet, not on every sync.
	describe("an item Readwise refused", () => {
		it("stays set aside while the tablet shows what was refused", () => {
			const books = recordUnit(storedBook({ [KEY]: { want: PUSHED, rejected: PUSHED } }), DOC, unit([entry(KEY, SENTENCE)]));

			expect(bookAfter(books).highlights[KEY]).toEqual({ want: PUSHED, rejected: PUSHED });
		});

		it("is wanted again once it changes on the tablet", () => {
			const books = recordUnit(storedBook({ [KEY]: { want: PUSHED, rejected: PUSHED } }), DOC, unit([entry(KEY, "Shorter.")]));

			expect(bookAfter(books).highlights[KEY]).toEqual({ want: { text: "Shorter.", location: 12 }, rejected: PUSHED });
		});
	});

	// Ticket 14 #2: a book deleted in Readwise stays deleted.
	it("records nothing into a book deleted in Readwise", () => {
		const stored = storedBook({ [KEY]: { pushed: PUSHED } }, { deleted: true });

		expect(recordUnit(stored, DOC, unit([entry(KEY, "Changed."), entry(`${PAGE}:3c4d`, "New.")]))).toEqual(stored);
	});

	// Spec §1.2, §11 P6, P9, P21: title and author are the book's key in Readwise, so they never change.
	describe("the book's name", () => {
		it("stays the one it was first recorded under when the document is renamed on the tablet or matched to Zotero later", () => {
			const books = recordUnit(storedBook({}), DOC, unit([entry(KEY, SENTENCE)], { identity: { title: "A Paper on Cape Marrow", author: "Ada Byrne, Ben Cole" } }));

			expect([bookAfter(books).title, bookAfter(books).author]).toEqual(["Cape Marrow", "Ada Byrne"]);
		});

		it("is not taken before the document has a mark to record", () => {
			expect(recordUnit({}, DOC, unit([]))).toEqual({});
		});

		it("gets a number when another document of this vault already has the same title and author", () => {
			const books = recordUnit({ "doc-0": { title: "Notes", highlights: {} }, "doc-9": { title: "Notes (2)", highlights: {} } }, DOC, unit([entry(KEY, SENTENCE)], { identity: { title: "Notes" } }));

			expect(bookAfter(books).title).toBe("Notes (3)");
		});

		// They still exist in Readwise, and sharing the key would put this document's highlights into the deleted book.
		it("counts a book deleted in Readwise as taken", () => {
			const books = recordUnit({ "doc-0": { title: "Notes", deleted: true, highlights: {} } }, DOC, unit([entry(KEY, SENTENCE)], { identity: { title: "Notes" } }));

			expect(bookAfter(books).title).toBe("Notes (2)");
		});

		// Spec §11 P9: never sent blank -- Readwise fails the whole call on a blank field (ticket 10).
		it("is Untitled for a document with no name on the tablet", () => {
			expect(bookAfter(recordUnit({}, DOC, unit([entry(KEY, SENTENCE)], { identity: { title: "  " } }))).title).toBe("Untitled");
		});

		it("needs no number for the same title under another author", () => {
			const books = recordUnit({ "doc-0": { title: "Notes", author: "Ben Cole", highlights: {} } }, DOC, unit([entry(KEY, SENTENCE)], { identity: { title: "Notes" } }));

			expect(bookAfter(books).title).toBe("Notes");
		});

		it("is cut to Readwise's limits, ending in an ellipsis, the number kept after the cut", () => {
			const title = "T".repeat(600);
			const alone = bookAfter(recordUnit({}, DOC, unit([entry(KEY, SENTENCE)], { identity: { title, author: "A".repeat(1100) } })));
			const second = bookAfter(recordUnit({ "doc-0": { title: alone.title, author: alone.author, highlights: {} } }, DOC, unit([entry(KEY, SENTENCE)], { identity: { title, author: "A".repeat(1100) } })));

			expect([alone.title.length, alone.title.at(-1), alone.author?.length, alone.author?.at(-1)]).toEqual([511, "…", 1024, "…"]);
			expect([second.title.length, second.title.slice(-5)]).toEqual([511, "… (2)"]);
		});
	});

	// `data.json` is shared between installs and versions (spec §3).
	describe("what this build cannot read", () => {
		it("leaves another document's unreadable book exactly where it is", () => {
			const books = recordUnit({ "doc-0": "written by a newer build", "doc-1": { highlights: [] } }, DOC, unit([entry(KEY, SENTENCE)]));

			expect([books["doc-0"], books["doc-1"]]).toEqual(["written by a newer build", { highlights: [] }]);
		});

		it("keeps what the push and a newer build wrote on this document's book", () => {
			const shown = { title: "Smith 2019, the good one", owed: true };
			const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901 } }, { shown, colour: "yellow" } as Partial<ReadwiseBook>), DOC, unit([entry(KEY, "Changed.")]));

			expect(books[DOC]).toMatchObject({ bookId: 64836623, shown, colour: "yellow" });
		});

		// A new title beside the old book's id would open a second book in Readwise (spec §1.2).
		it("records nothing into this document's book when it cannot read it", () => {
			const stored = { [DOC]: { bookId: 64836623, deleted: true, highlights: {} } };

			expect(recordUnit(stored, DOC, unit([entry(KEY, SENTENCE)]))).toEqual(stored);
		});

		it("drops a field it knows but cannot read, rather than writing it back beside the one it read", () => {
			const books = recordUnit(storedBook({}, { author: "" } as Partial<ReadwiseBook>), DOC, unit([entry(KEY, SENTENCE)], { identity: { title: "Cape Marrow" } }));

			expect(books[DOC]).not.toHaveProperty("author");
		});

		it("keeps a record it cannot read beside the ones it records", () => {
			const books = recordUnit(storedBook({ "old:1": "written by a newer build" } as unknown as Record<string, ReadwiseHighlight>), DOC, unit([entry(KEY, SENTENCE)]));

			expect(books[DOC]).toMatchObject({ highlights: { "old:1": "written by a newer build", [KEY]: { want: PUSHED } } });
		});

		it("reads a book field by field, what it cannot read left out", () => {
			expect(readwiseBook({ [DOC]: { title: "Cape Marrow", shown: { title: 7, author: "Ben Cole", owed: "yes" }, highlights: "junk" } }, DOC)).toEqual({
				title: "Cape Marrow",
				shown: { author: "Ben Cole" },
				highlights: {},
			});
		});
	});

	describe("the tablet back to what Readwise holds", () => {
		it("voids a pending change", () => {
			const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901, want: { text: "Changed.", location: 12 } } }), DOC, unit([entry(KEY, SENTENCE)]));

			expect(bookAfter(books).highlights[KEY]).toEqual({ pushed: PUSHED, id: 901 });
		});

		it("voids a pending delete", () => {
			const books = recordUnit(storedBook({ [KEY]: { pushed: PUSHED, id: 901, want: null } }), DOC, unit([entry(KEY, SENTENCE)]));

			expect(bookAfter(books).highlights[KEY]).toEqual({ pushed: PUSHED, id: 901 });
		});
	});

	it("gives a new document its book, named once, with every mark waiting to be pushed", () => {
		const books = recordUnit({}, DOC, unit([entry(`${PAGE}:1a2b`, "The **weather station** was built in the spring.")]));

		expect(bookAfter(books)).toEqual({
			title: "Cape Marrow",
			author: "Ada Byrne",
			highlights: { [`${PAGE}:1a2b`]: { want: { text: "The **weather station** was built in the spring.", location: 12 } } },
		});
	});
});

// What the push (19), the Connection line (20) and *Open in Readwise* (21) read back.
describe("reading the state", () => {
	const REFUSED: ReadwiseHighlight = { want: PUSHED, rejected: PUSHED };
	const books: StoredReadwiseBooks = {
		"doc-a": { title: "A", bookId: 11, highlights: { k1: { pushed: PUSHED }, k2: { pushed: PUSHED, want: null }, k3: REFUSED } },
		"doc-b": { title: "B", highlights: { k1: { want: PUSHED } } },
		"doc-c": { title: "C", bookId: 13, highlights: { k1: { pushed: PUSHED } } },
		"doc-d": { title: "D", bookId: 14, deleted: true, highlights: { k1: { pushed: PUSHED, want: PUSHED } } },
		"doc-e": { title: "E", highlights: { k1: REFUSED, k2: { ...REFUSED, pushed: PUSHED } } },
		"doc-x": "unreadable",
	};

	it("knows what is pending: a text or a delete, never what Readwise refused unchanged", () => {
		expect([isPending({ want: PUSHED }), isPending({ pushed: PUSHED, want: null }), isPending({ pushed: PUSHED }), isPending(REFUSED), isPending({ ...REFUSED, want: { text: "Shorter.", location: 12 } })]).toEqual([
			true,
			true,
			false,
			false,
			true,
		]);
	});

	it("lists the documents waiting to be pushed, none of them in a deleted book", () => {
		expect(pendingDocuments(books)).toEqual(["doc-a", "doc-b"]);
	});

	// Spec §2.1: from the state, never from Readwise; set-aside items count as neither pushed nor waiting.
	it("counts the books and highlights pushed, and the items set aside, for the Connection line", () => {
		expect(readwiseCounts(books)).toEqual({ books: 2, highlights: 3, setAside: 3 });
	});

	it("gives a book's records waiting to be pushed", () => {
		expect(pendingItems(bookAfter(books, "doc-a"))).toEqual([["k2", { pushed: PUSHED, want: null }]]);
	});

	// The push (19) writes its results back through this, so it must keep what `readwiseBook` leaves out.
	it("writes a book back with what this build cannot read kept, and a known field it could not read dropped", () => {
		const stored = { [DOC]: { title: "Cape Marrow", author: "", colour: "yellow", highlights: { "old:1": "written by a newer build", [KEY]: { want: PUSHED } } } };

		const books = withBook(stored, DOC, { ...bookAfter(stored), bookId: 64836623, highlights: { [KEY]: { pushed: PUSHED } } });

		expect(books[DOC]).toEqual({ title: "Cape Marrow", colour: "yellow", bookId: 64836623, highlights: { "old:1": "written by a newer build", [KEY]: { pushed: PUSHED } } });
	});

	it("gives a document's book id, none for a book deleted in Readwise or never matched", () => {
		expect(["doc-a", "doc-b", "doc-d", "doc-x", "doc-z"].map((docId) => bookIdOf(books, docId))).toEqual([11, undefined, undefined, undefined, undefined]);
	});
});
