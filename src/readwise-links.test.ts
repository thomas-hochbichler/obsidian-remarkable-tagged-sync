import { describe, expect, it } from "vitest";
import { deletedBookOf, readwiseBookUrl } from "./readwise-links";

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

describe("deletedBookOf", () => {
	const book = { title: "Cape Marrow", category: "articles", bookId: 4711, highlights: {} };

	it("is the note's document when its book was deleted in Readwise", () => {
		const rows = { a: row({ pageId: PAGE, notePath: "Notes/Page 3.md" }) };
		expect(deletedBookOf(rows, { [DOC]: { ...book, deleted: true } }, "Notes/Page 3.md")).toBe(DOC);
	});

	it.each([
		["a note the plugin never synced", { [DOC]: { ...book, deleted: true } }, "Elsewhere.md"],
		["a document never pushed", {}, "Papers/Cape Marrow.md"],
		["a book still in Readwise", { [DOC]: book }, "Papers/Cape Marrow.md"],
		["a book this build cannot read", { [DOC]: "not a book" }, "Papers/Cape Marrow.md"],
	])("is none for %s", (_, books, notePath) => {
		expect(deletedBookOf({ a: row() }, books, notePath)).toBeNull();
	});
});
