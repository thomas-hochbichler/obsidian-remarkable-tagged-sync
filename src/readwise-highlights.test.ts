import { describe, expect, it } from "vitest";
import type { DigestHighlight, DigestNote, DigestPage } from "./digest-builder";
import { readwiseHighlights, type ReadableEntry, type ReadwiseEntry } from "./readwise-highlights";

const DOC = "0f1e2d3c-doc";
const PAGE = "6a7b8c9d-page";
const TARGET = { vault: "My Vault", pdf: `${DOC}.pdf` };

/** The link as Obsidian and Readwise read it, written out rather than borrowed from the code it checks. */
const link = (key: string, embedPage = 12) => `obsidian://open?vault=My%20Vault&file=${DOC}.pdf%23page%3D${embedPage}&highlight=${DOC}%2F${key.replace(":", "%3A")}`;

/** The entry as one that was read, failing the test where it is not. */
function read(entry: ReadwiseEntry | undefined): ReadableEntry {
	if (entry === undefined || entry.unread) throw new Error(`expected a read entry, got ${JSON.stringify(entry)}`);
	return entry;
}

function highlight(overrides: Partial<DigestHighlight> = {}): DigestHighlight {
	return {
		id: "hl-9f21c4",
		key: `${PAGE}:1a2b`,
		sentence: "The weather station at Cape Marrow was built in the spring.",
		rects: [],
		tool: "marker",
		marked: ["Cape Marrow"],
		color: null,
		notes: [],
		section: null,
		top: 0,
		...overrides,
	};
}

function note(overrides: Partial<DigestNote> = {}): DigestNote & { section: string | null } {
	return { id: "nt-4c8a17", key: `${PAGE}:3c4d`, anchor: { kind: "page" }, text: "check the date", region: null, rect: null, top: 0, section: null, ...overrides };
}

function page(overrides: Partial<DigestPage> = {}): DigestPage {
	return { pageLabel: "12", embedPage: 12, source: { index: 11, widthPt: 612, heightPt: 792 }, highlights: [], notes: [], ...overrides };
}

describe("readwiseHighlights", () => {
	describe("a highlight", () => {
		it("becomes its sentence with the marked words in bold, on the page it is printed on, linking back to its entry", () => {
			expect(readwiseHighlights([page({ highlights: [highlight()] })], DOC, null, TARGET)).toEqual([
				{
					key: `${PAGE}:1a2b`,
					text: "The weather station at **Cape Marrow** was built in the spring.",
					location: 12,
					url: link(`${PAGE}:1a2b`),
				},
			]);
		});

		// Ticket 27: Obsidian's own `open`, because a phone has no plugin to answer anything else.
		describe("its link", () => {
			const urlOf = (pages: DigestPage[], target = TARGET) => readwiseHighlights(pages, DOC, null, target)[0].url;

			it("opens the page of the render it sits on, which is not the page printed on it", () => {
				expect(urlOf([page({ pageLabel: "12", embedPage: 3, highlights: [highlight()] })])).toBe(link(`${PAGE}:1a2b`, 3));
			});

			it("opens a page-tag unit's own render, whose one page is page 1", () => {
				const url = urlOf([page({ embedPage: 1, highlights: [highlight()] })], { vault: "My Vault", pdf: `${DOC}-${PAGE}.pdf` });

				expect(url).toBe(`obsidian://open?vault=My%20Vault&file=${DOC}-${PAGE}.pdf%23page%3D1&highlight=${DOC}%2F${PAGE}%3A1a2b`);
			});

			it("carries a vault name of any characters in one piece", () => {
				const url = urlOf([page({ highlights: [highlight()] })], { vault: "Ü & #1?", pdf: `${DOC}.pdf` });

				expect(new globalThis.URL(url).searchParams.get("vault")).toBe("Ü & #1?");
			});

			// Readwise files highlights by this link: two on one page must not share one.
			it("differs for two highlights on one page", () => {
				const entries = readwiseHighlights([page({ highlights: [highlight(), highlight({ key: `${PAGE}:9f9f` })] })], DOC, null, TARGET);

				expect(entries[0].url).not.toBe(entries[1].url);
			});
		});

		const entryOf = (overrides: Partial<DigestHighlight>) => readwiseHighlights([page({ highlights: [highlight(overrides)] })], DOC, null, TARGET)[0];
		const textOf = (overrides: Partial<DigestHighlight>) => read(entryOf(overrides)).text;

		it("bolds two runs apart", () => {
			expect(textOf({ marked: ["weather station", "the spring"] })).toBe("The **weather station** at Cape Marrow was built in **the spring**.");
		});

		// The device keeps every version of a selection the reader adjusted, so one passage arrives as
		// overlapping runs -- one bold stretch, never `**…****…**`.
		it("bolds overlapping runs as one stretch", () => {
			expect(textOf({ marked: ["station at Cape", "at Cape Marrow was", "Marrow"] })).toBe("The weather **station at Cape Marrow was** built in the spring.");
		});

		it("leaves out a run it cannot find in the sentence and bolds the rest", () => {
			expect(textOf({ marked: ["Cape Marrow", "Kap Marrow"] })).toBe("The weather station at **Cape Marrow** was built in the spring.");
		});

		it("sends the plain sentence when no run is found", () => {
			expect(textOf({ marked: ["Kap Marrow"] })).toBe("The weather station at Cape Marrow was built in the spring.");
			expect(textOf({ marked: [] })).toBe("The weather station at Cape Marrow was built in the spring.");
		});

		it("carries the margin notes written at it as its note, joined by a blank line", () => {
			const notes = [note({ text: "check the date" }), note({ key: `${PAGE}:5e6f`, text: "1962?" })];

			expect(read(entryOf({ notes })).note).toBe("check the date\n\n1962?");
		});

		it("carries no note when nothing was written at it", () => {
			expect(entryOf({ notes: [] })).not.toHaveProperty("note");
		});

		// Spec §11 P12: an unread note says nothing about what the tablet holds, so the recorder keeps
		// the note Readwise has rather than pushing the readable half as the whole of it.
		it("says when a note written at it could not be read, beside the one that could", () => {
			const entry = read(entryOf({ notes: [note({ text: "" }), note({ key: `${PAGE}:5e6f`, text: "1962?" })] }));

			expect(entry.note).toBe("1962?");
			expect(entry.noteUnread).toBe(true);
		});

		it("says so with no note at all when its only note could not be read", () => {
			const entry = read(entryOf({ notes: [note({ text: "" })] }));

			expect(entry).not.toHaveProperty("note");
			expect(entry.noteUnread).toBe(true);
		});

		// No text layer and no text recorded on the device this sync: nothing says the mark is gone.
		it("is unread, with no text, when its sentence is empty", () => {
			expect(entryOf({ sentence: "", marked: [] })).toEqual({ key: `${PAGE}:1a2b`, unread: true, location: 12, url: link(`${PAGE}:1a2b`) });
		});
	});

	describe("a margin note of its own", () => {
		it("becomes its transcript, with no note", () => {
			expect(readwiseHighlights([page({ notes: [note()] })], DOC, null, TARGET)).toEqual([
				{ key: `${PAGE}:3c4d`, text: "check the date", margin: true, location: 12, url: link(`${PAGE}:3c4d`) },
			]);
		});

		// Spec §11 P12: the exemption is per item, never per page -- the readable note beside it is
		// pushed as usual.
		it("is unread when it could not be transcribed, and the readable note beside it is not", () => {
			const entries = readwiseHighlights([page({ notes: [note({ text: "" }), note({ key: `${PAGE}:5e6f`, text: "1962?" })] })], DOC, null, TARGET);

			expect(entries).toEqual([
				{ key: `${PAGE}:3c4d`, unread: true, margin: true, location: 12, url: link(`${PAGE}:3c4d`) },
				{ key: `${PAGE}:5e6f`, text: "1962?", margin: true, location: 12, url: link(`${PAGE}:5e6f`) },
			]);
		});
	});

	describe("a page added on the tablet", () => {
		const ADDED = "added-page";

		function added(text: string, overrides: Partial<DigestPage> = {}): DigestPage {
			return page({
				pageLabel: null,
				embedPage: 13,
				source: null,
				notes: [note({ key: `${ADDED}:page`, text, wholePage: true })],
				added: { relation: "after", label: "12", sourceIndex: 11, nth: null },
				...overrides,
			});
		}

		it("becomes its transcript, line breaks kept, on the page it follows", () => {
			expect(readwiseHighlights([added("first line\nsecond line")], DOC, null, TARGET)).toEqual([
				{ key: `${ADDED}:page`, text: "first line\nsecond line", margin: true, location: 12, url: link(`${ADDED}:page`, 13) },
			]);
		});

		// Typed text may stand in for handwriting that was not read (#247): the entry is then less than the page.
		it("is unread when its handwriting could not be read, whatever text stands in for it", () => {
			const entries = readwiseHighlights([added("typed text", { added: { relation: "after", label: "12", sourceIndex: 11, nth: null, unread: true } })], DOC, null, TARGET);

			expect(entries).toEqual([{ key: `${ADDED}:page`, unread: true, margin: true, location: 12, url: link(`${ADDED}:page`, 13) }]);
		});

		// Read, and nothing legible on it: there is nothing to push, and nothing says to keep an older reading.
		it("gives nothing when it was read and holds no text", () => {
			expect(readwiseHighlights([added("")], DOC, null, TARGET)).toEqual([]);
		});
	});

	// Spec §11 P8: from the document, never from the unit. A page-tag unit embeds its one page as page 1,
	// so anything unit-relative would flip between the two units of one document and re-push forever.
	describe("the page number", () => {
		const locationOf = (pages: DigestPage[], pageOrder: readonly string[] | null = null) => readwiseHighlights(pages, DOC, pageOrder, TARGET).map((entry) => entry.location);

		it("is the printed label where that is a number", () => {
			// Source index 2: a label that were ignored would give 3.
			expect(locationOf([page({ pageLabel: "12", embedPage: 3, source: { index: 2, widthPt: 612, heightPt: 792 }, highlights: [highlight()] })])).toEqual([12]);
		});

		it("is the page's place in the PDF where the printed label is no number", () => {
			expect(locationOf([page({ pageLabel: "xii", source: { index: 11, widthPt: 612, heightPt: 792 }, highlights: [highlight()] })])).toEqual([12]);
			expect(locationOf([page({ pageLabel: "0", source: { index: 4, widthPt: 612, heightPt: 792 }, highlights: [highlight()] })])).toEqual([5]);
		});

		// The pipeline never builds such a page -- a label that is no number came from a text layer, which
		// places the page -- but the type allows it, and Readwise wants a page number of 1 or more.
		it("is 1 for a page that gives neither a number nor a place in the PDF", () => {
			expect(locationOf([page({ pageLabel: null, source: null, highlights: [highlight()] })])).toEqual([1]);
		});

		it("is the same for a PDF page in its whole-document unit and in its page-tag unit", () => {
			const whole = page({ pageLabel: "xii", embedPage: 12, highlights: [highlight()] });
			const tagged = page({ pageLabel: "xii", embedPage: 1, highlights: [highlight()] });

			expect(locationOf([tagged])).toEqual(locationOf([whole]));
		});

		describe("of a page added on the tablet", () => {
			const addedAt = (place: NonNullable<DigestPage["added"]>) =>
				locationOf([page({ pageLabel: null, embedPage: 13, source: null, notes: [note({ key: "added:page", text: "words", wholePage: true })], added: place })]);

			it("is that of the page it follows, by its printed label", () => {
				expect(addedAt({ relation: "after", label: "12", sourceIndex: 2, nth: null })).toEqual([12]);
			});

			it("is that of the page it follows, by its place in the PDF where the label is roman", () => {
				expect(addedAt({ relation: "after", label: "iv", sourceIndex: 3, nth: 2 })).toEqual([4]);
			});

			it("is 1 ahead of the document's first page", () => {
				expect(addedAt({ relation: "before", label: "xii", sourceIndex: 11, nth: null })).toEqual([1]);
			});
		});

		// A typed page's label is its embed ordinal (`typedTextSource`), and its source index is its place
		// in the unit: 3 and 2 in the whole notebook, 1 and 0 in the page-tag unit of the same page.
		it("is a typed page's place in the document's page order, the same in its whole-document and its page-tag unit", () => {
			const order = ["handwritten", "other", PAGE];
			const whole = page({ pageLabel: "3", embedPage: 3, source: { index: 2, widthPt: 400, heightPt: 600 }, highlights: [highlight()], notes: [note()] });
			const tagged = page({ pageLabel: "1", embedPage: 1, source: { index: 0, widthPt: 400, heightPt: 600 }, highlights: [highlight()], notes: [note()] });

			expect(locationOf([whole], order)).toEqual([3, 3]);
			expect(locationOf([tagged], order)).toEqual([3, 3]);
		});
	});

	// Spec §11 P9: Readwise refuses a text or note over 8,191 characters, and a refused item is set
	// aside until it changes. The limit is the final text's, bold marks included.
	describe("a text over Readwise's limit", () => {
		const LIMIT = 8191;
		/** 10,889 characters of distinct words, so every run is found exactly where it is meant to be. */
		const LONG = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
		const words = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `w${from + i}`).join(" ");

		it("is cut to the limit, ending in an ellipsis", () => {
			const text = read(readwiseHighlights([page({ highlights: [highlight({ sentence: LONG, marked: [] })] })], DOC, null, TARGET)[0]).text;

			// At the limit, less a space the cut may have landed after.
			expect(text.length).toBeLessThanOrEqual(LIMIT);
			expect(text.length).toBeGreaterThan(LIMIT - 2);
			expect(text.endsWith("…")).toBe(true);
			expect(LONG.startsWith(text.slice(0, -1))).toBe(true);
		});

		it("is cut, bold marks counted, closing a run the cut goes through and dropping one past it", () => {
			// w10–w12 well before the cut, w1540–w1560 across it (w1550 sits at about 8,190), w1700 past it.
			const marked = [words(10, 12), words(1540, 1560), "w1700"];

			const text = read(readwiseHighlights([page({ highlights: [highlight({ sentence: LONG, marked })] })], DOC, null, TARGET)[0]).text;

			expect(text.length).toBeLessThanOrEqual(LIMIT);
			expect(text.startsWith(`w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 **${words(10, 12)}** w13`)).toBe(true);
			expect(text).toMatch(/ \*\*w1540 w1541 [^*]+\*\*…$/);
			expect(text.match(/\*\*/g)).toHaveLength(4);
			expect(text).not.toContain("w1700");
		});

		it("cuts a margin note's and an added page's text as well, and a highlight's note", () => {
			const long = "x".repeat(LIMIT + 50);
			const entries = readwiseHighlights(
				[
					page({ highlights: [highlight({ notes: [note({ text: long })] })], notes: [note({ key: `${PAGE}:5e6f`, text: long })] }),
					page({ pageLabel: null, source: null, notes: [note({ key: "added:page", text: long, wholePage: true })], added: { relation: "after", label: "12", sourceIndex: 11, nth: null } }),
				],
				DOC,
				null,
				TARGET,
			).map(read);

			// The highlight's note, the margin note's text, the added page's text.
			expect(entries.map((entry) => entry.note ?? entry.text).map((text) => [text.length, text.at(-1)])).toEqual([
				[LIMIT, "…"],
				[LIMIT, "…"],
				[LIMIT, "…"],
			]);
		});

		it("is left whole at exactly the limit", () => {
			const text = "y".repeat(LIMIT);

			expect(read(readwiseHighlights([page({ notes: [note({ text })] })], DOC, null, TARGET)[0]).text).toBe(text);
		});
	});
});
