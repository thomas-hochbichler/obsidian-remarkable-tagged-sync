import { describe, expect, it } from "vitest";
import { digestId } from "./digest-builder";
import { linkedNote, readwiseBookUrl } from "./readwise-links";

const DOC = "0f1e2d3c-doc";
const PAGE = "6a7b8c9d-page";

interface Row {
	readonly docId: string;
	readonly pageId: string | null;
	readonly notePath: string;
	readonly status: string;
}

function row(overrides: Partial<Row> = {}): Row {
	return { docId: DOC, pageId: null, notePath: "Papers/Cape Marrow.md", status: "active", ...overrides };
}

/** A vault holding exactly the notes listed, each carrying exactly the blocks listed for it. */
function carrying(blocks: Record<string, readonly string[]>): (notePath: string) => readonly string[] | null {
	return (notePath) => blocks[notePath] ?? null;
}

describe("linkedNote", () => {
	it("opens the whole-document note at the highlight's block", () => {
		const block = digestId("hl", PAGE, "1a2b");
		expect(linkedNote({ a: row() }, `${DOC}/${PAGE}:1a2b`, carrying({ "Papers/Cape Marrow.md": [block] }))).toEqual({
			notePath: "Papers/Cape Marrow.md",
			block,
		});
	});

	it("opens the page note at a margin note's block when the document has no whole-document note", () => {
		const block = digestId("nt", PAGE, "3c4d");
		const rows = { a: row({ pageId: PAGE, notePath: "Notes/Page 3.md" }), b: row({ pageId: "other-page", notePath: "Notes/Page 4.md" }) };
		expect(linkedNote(rows, `${DOC}/${PAGE}:3c4d`, carrying({ "Notes/Page 3.md": [block] }))).toEqual({ notePath: "Notes/Page 3.md", block });
	});

	it("prefers the whole-document note when the page has a note of its own too", () => {
		const block = digestId("hl", PAGE, "1a2b");
		const rows = { a: row({ pageId: PAGE, notePath: "Notes/Page 3.md" }), b: row() };
		const vault = carrying({ "Notes/Page 3.md": [block], "Papers/Cape Marrow.md": [block] });
		expect(linkedNote(rows, `${DOC}/${PAGE}:1a2b`, vault)).toEqual({ notePath: "Papers/Cape Marrow.md", block });
	});

	it("falls through to the page note when only that one still carries the block", () => {
		const block = digestId("hl", PAGE, "1a2b");
		const rows = { a: row(), b: row({ pageId: PAGE, notePath: "Notes/Page 3.md" }) };
		expect(linkedNote(rows, `${DOC}/${PAGE}:1a2b`, carrying({ "Notes/Page 3.md": [block] }))).toEqual({ notePath: "Notes/Page 3.md", block });
	});

	it("opens the note at its top when no note carries the block any more", () => {
		expect(linkedNote({ a: row() }, `${DOC}/${PAGE}:1a2b`, carrying({ "Papers/Cape Marrow.md": [] }))).toEqual({
			notePath: "Papers/Cape Marrow.md",
			block: null,
		});
	});

	it("passes over a note deleted by hand", () => {
		const rows = { a: row(), b: row({ pageId: PAGE, notePath: "Notes/Page 3.md" }) };
		expect(linkedNote(rows, `${DOC}/${PAGE}:1a2b`, carrying({ "Notes/Page 3.md": [] }))).toEqual({ notePath: "Notes/Page 3.md", block: null });
		expect(linkedNote({ a: row() }, `${DOC}/${PAGE}:1a2b`, carrying({}))).toBeNull();
	});

	it("opens nothing when the document has no active note left", () => {
		const rows = { a: row({ status: "deleted" }), b: row({ docId: "another-doc", notePath: "Other.md" }) };
		expect(linkedNote(rows, `${DOC}/${PAGE}:1a2b`, carrying({ "Papers/Cape Marrow.md": [], "Other.md": [] }))).toBeNull();
	});

	it.each(["", DOC, `${DOC}/`, `${DOC}/${PAGE}`, `${DOC}/${PAGE}:`, `${DOC}/:1a2b`, `/${PAGE}:1a2b`])("opens nothing for the malformed value %j", (value) => {
		expect(linkedNote({ a: row({ docId: "", pageId: "" }), b: row() }, value, () => [])).toBeNull();
	});

	it("takes the page id before the key's first colon, so a CRDT id with a colon still finds its block", () => {
		const block = digestId("hl", PAGE, "1a:2b");
		const rows = { a: row({ pageId: PAGE, notePath: "Notes/Page 3.md" }) };
		expect(linkedNote(rows, `${DOC}/${PAGE}:1a:2b`, carrying({ "Notes/Page 3.md": [block] }))).toEqual({ notePath: "Notes/Page 3.md", block });
	});

	it("opens a page added on the tablet at its page block", () => {
		const block = digestId("nt", PAGE, "page");
		expect(linkedNote({ a: row() }, `${DOC}/${PAGE}:page`, carrying({ "Papers/Cape Marrow.md": [block] }))).toEqual({
			notePath: "Papers/Cape Marrow.md",
			block,
		});
	});
});

describe("readwiseBookUrl", () => {
	const book = { title: "Cape Marrow", category: "articles", highlights: {} };

	it("is the review page of the note's book in Readwise", () => {
		const rows = { a: row({ pageId: PAGE, notePath: "Notes/Page 3.md" }) };
		expect(readwiseBookUrl(rows, { [DOC]: { ...book, bookId: 4711 } }, "Notes/Page 3.md")).toBe("https://readwise.io/bookreview/4711");
	});

	it.each([
		["a note the plugin never synced", { [DOC]: { ...book, bookId: 4711 } }, "Elsewhere.md"],
		["a document never pushed", {}, "Papers/Cape Marrow.md"],
		["a book whose id is not known yet", { [DOC]: book }, "Papers/Cape Marrow.md"],
		["a book deleted in Readwise", { [DOC]: { ...book, bookId: 4711, deleted: true } }, "Papers/Cape Marrow.md"],
	])("is none for %s", (_, books, notePath) => {
		expect(readwiseBookUrl({ a: row() }, books, notePath)).toBeNull();
	});
});
