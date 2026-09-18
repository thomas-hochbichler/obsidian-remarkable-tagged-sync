import { describe, expect, it } from "vitest";
import { renderDigest, type DigestHighlight, type DigestNote, type DigestPage } from "./digest-builder";
import { applyFrontmatter } from "./frontmatter";
import { buildNoteContent, type NoteFields } from "./note-builder";
import type { ZoteroItem } from "./zotero-client";
import type { ZoteroLink } from "./zotero-links";
import { findLiteratureNote, formatLocalDate, itemLabel, openPdfUrl, webReaderUrl, zoteroCalloutLine, zoteroDigestLinks, type ZoteroNoteInfo } from "./zotero-note";

const ITEM: ZoteroItem = { key: "KX7Q2R4M", library: "user", title: "Best Practices für Prompting", creator: "Smith", year: "2024", citationKey: "smith2024prompting" };

function info(overrides: Partial<ZoteroNoteInfo> = {}): ZoteroNoteInfo {
	return {
		item: ITEM,
		webUserId: "1234567",
		writeBack: { kind: "written", date: "2026-09-11", written: 4, total: 4 },
		literatureNote: "@smith2024prompting",
		...overrides,
	};
}

describe("how the item is named in the note", () => {
	it("is the first creator, the year and the title", () => {
		expect(itemLabel(ITEM)).toBe("Smith 2024 · Best Practices für Prompting");
	});

	// A webpage saved without an author is not "Unknown 2024" -- it is its title.
	it("drops the parts Zotero does not have rather than filling them in", () => {
		expect(itemLabel({ ...ITEM, creator: null })).toBe("2024 · Best Practices für Prompting");
		expect(itemLabel({ ...ITEM, year: null })).toBe("Smith · Best Practices für Prompting");
		expect(itemLabel({ ...ITEM, creator: null, year: null })).toBe("Best Practices für Prompting");
	});

	it("falls back to the key for an item with no title at all", () => {
		expect(itemLabel({ ...ITEM, title: "  ", creator: null, year: null })).toBe("KX7Q2R4M");
		expect(itemLabel({ ...ITEM, title: "" })).toBe("Smith 2024");
	});

	// ⚠️ `[Preprint]`, `[in press]`, `[Dataset]` -- Zotero titles carry brackets routinely, and one of
	// them closes the link label early and leaves the URL standing in the note as text.
	it("escapes the brackets a Zotero title carries", () => {
		expect(zoteroCalloutLine(info({ item: { ...ITEM, title: "Prompting [Preprint]" } }))).toContain("[Smith 2024 · Prompting \\[Preprint\\]](zotero://select/");
	});
});

describe("the Zotero line of the ownership callout", () => {
	it("is the line of the §4 sample", () => {
		expect(zoteroCalloutLine(info())).toBe(
			"Zotero: [Smith 2024 · Best Practices für Prompting](zotero://select/library/items/KX7Q2R4M)" +
				" · [web library](https://www.zotero.org/users/1234567/items/KX7Q2R4M)" +
				" · highlights written back 2026-09-11" +
				" · literature note: [[@smith2024prompting]]",
		);
	});

	// The desktop-only user has no zotero.org account to link into: the URL would be a guess at a
	// number we were never told, and it would 404 on the one person who owns the library.
	it("offers no web link where the web connection is not configured", () => {
		const line = zoteroCalloutLine(info({ webUserId: null }));
		expect(line).not.toContain("web library");
		expect(line).toContain("](zotero://select/library/items/KX7Q2R4M) · highlights written back");
	});

	it("says why nothing was written back, where nothing was", () => {
		expect(zoteroCalloutLine(info({ writeBack: { kind: "not-written", reason: "Zotero could not be reached" } }))).toContain(
			"· not written back: Zotero could not be reached ·",
		);
	});

	// A sentence that stays true for a reader who never buys Pro: it says where the highlights are
	// before it says what would put them in Zotero.
	it("says where the highlights are for a vault that has the free half", () => {
		expect(zoteroCalloutLine(info({ writeBack: { kind: "free" } }))).toContain(
			"· highlights stay in the vault — writing them into Zotero is Tagged Sync Pro ·",
		);
	});

	// The note is where the reader finds out that the paper in front of them is missing eighteen of
	// their own marks -- the status line is gone by the time they open it.
	it("names both numbers for a run that was cut short", () => {
		expect(zoteroCalloutLine(info({ writeBack: { kind: "written", date: "2026-09-11", written: 12, total: 30 } }))).toContain(
			"· 12 of 30 highlights written back 2026-09-11 ·",
		);
	});

	it("says nothing about a literature note where the vault has none", () => {
		expect(zoteroCalloutLine(info({ literatureNote: null }))).not.toContain("literature note");
	});
});

describe("the vault's own note about the paper", () => {
	const NOTES = [
		{ path: "Literature/@smith2024prompting.md", link: "@smith2024prompting", zoteroKey: "KX7Q2R4M", citekey: "smith2024prompting" },
		{ path: "Inbox/Unrelated.md", link: "Unrelated", zoteroKey: null, citekey: null },
	];

	it("is the note carrying this item's key", () => {
		expect(findLiteratureNote(NOTES, ITEM, new Set())).toBe("@smith2024prompting");
	});

	it("is found by the citekey where the note carries no item key", () => {
		const byCitekey = [{ path: "Literature/Smith.md", link: "Smith", zoteroKey: null, citekey: "smith2024prompting" }];
		expect(findLiteratureNote(byCitekey, ITEM, new Set())).toBe("Smith");
	});

	// ⚠️ Every note *we* write now carries `zotero-key` too. Without the exclusion a document synced
	// under two mapped tags finds its own twin -- or itself -- and prints "literature note: [[…]]"
	// pointing at a note this plugin generates and rewrites.
	it("is never one of the notes this sync just wrote", () => {
		const ours = [{ path: "reMarkable/Paper.md", link: "Paper", zoteroKey: "KX7Q2R4M", citekey: null }];
		expect(findLiteratureNote(ours, ITEM, new Set(["reMarkable/Paper.md"]))).toBeNull();
	});

	// Obsidian's cache hands its files over in whatever order it has them in; the line must not change
	// from one sync to the next because of that.
	it("picks the same one of several matches every time", () => {
		const many = [
			{ path: "z-later.md", link: "z-later", zoteroKey: "KX7Q2R4M", citekey: null },
			{ path: "a-first.md", link: "a-first", zoteroKey: "KX7Q2R4M", citekey: null },
		];
		expect(findLiteratureNote(many, ITEM, new Set())).toBe("a-first");
		expect(findLiteratureNote([...many].reverse(), ITEM, new Set())).toBe("a-first");
	});

	// ⚠️ An item with no citekey and a note with no citekey are both null, and `null === null` would
	// make every keyless note in the vault the literature note of every keyless item.
	it("never takes two missing citekeys for a match", () => {
		const keyless = [{ path: "Inbox/Nothing.md", link: "Nothing", zoteroKey: null, citekey: null }];
		expect(findLiteratureNote(keyless, { ...ITEM, citationKey: null }, new Set())).toBeNull();
	});

	it("finds nothing in a vault that has nothing", () => {
		expect(findLiteratureNote([], ITEM, new Set())).toBeNull();
	});
});

describe("the link a quote carries once it is in Zotero", () => {
	function page(overrides: Partial<DigestPage> = {}): DigestPage {
		return { pageLabel: "2", embedPage: 2, source: { index: 1, widthPt: 612, heightPt: 792 }, highlights: [], notes: [], ...overrides };
	}

	function highlight(id: string): DigestHighlight {
		return { id, sentence: "Ein Satz.", rects: [{ x: 1, y: 2, width: 3, height: 4 }], tool: "marker", marked: [], color: null, notes: [], section: "Prinzipien", top: 10 };
	}

	function link(overrides: Partial<ZoteroLink> = {}): ZoteroLink {
		return { attachmentKey: "A9B3C1DE", library: "user", annotations: { "hl-9f21c4": { key: "Q1H4T7K2", written: {} } }, ...overrides };
	}

	// The physical sheet, 1-based: Zotero's reader counts pages, not labels. The label beside it in the
	// note is the document's own printed number, and the two disagreeing is correct.
	it("opens the reader on the annotation's own physical page", () => {
		expect(openPdfUrl("A9B3C1DE", 1, "Q1H4T7K2")).toBe("zotero://open-pdf/library/items/A9B3C1DE?page=2&annotation=Q1H4T7K2");
	});

	it("is offered for every highlight that reached Zotero", () => {
		expect(zoteroDigestLinks(link(), [page({ highlights: [highlight("hl-9f21c4")] })])).toEqual({
			"hl-9f21c4": "zotero://open-pdf/library/items/A9B3C1DE?page=2&annotation=Q1H4T7K2",
		});
	});

	// A vault whose one reader is zotero.org's: on Windows a `zotero://` link is a dialog offering the
	// Microsoft Store. The web reader's URL takes no page and no annotation (tried 2026-09-18), and
	// the personal library hangs under the username -- `/users/<id>/…/reader` is a 404.
	it("opens zotero.org's reader instead where the vault has no desktop app", () => {
		const web = { username: "someone", itemKey: "KX7Q2R4M" };
		expect(zoteroDigestLinks(link(), [page({ highlights: [highlight("hl-9f21c4")] })], web)).toEqual({
			"hl-9f21c4": "https://www.zotero.org/someone/items/KX7Q2R4M/attachment/A9B3C1DE/reader",
		});
	});

	it("opens a standalone PDF as its own item in the web reader", () => {
		expect(webReaderUrl({ username: "someone", itemKey: "A9B3C1DE" }, "A9B3C1DE", "user")).toBe("https://www.zotero.org/someone/items/A9B3C1DE/reader");
	});

	it("is not offered for a highlight that has not been written back", () => {
		expect(zoteroDigestLinks(link({ annotations: {} }), [page({ highlights: [highlight("hl-9f21c4")] })])).toEqual({});
	});

	// We remember it as deleted and never create it again (§3.3), so the link would open the reader on
	// nothing at all.
	it("is not offered for an annotation the user deleted in Zotero", () => {
		const deleted = link({ annotations: { "hl-9f21c4": { key: "Q1H4T7K2", written: {}, deleted: true } } });
		expect(zoteroDigestLinks(deleted, [page({ highlights: [highlight("hl-9f21c4")] })])).toEqual({});
	});

	// The page has no place in the source document, so neither has the entry -- and write-back skipped
	// it for the same reason.
	it("is not offered on a page the reader added on the device", () => {
		expect(zoteroDigestLinks(link(), [page({ source: null, highlights: [highlight("hl-9f21c4")] })])).toEqual({});
	});

	// §4: handwriting callouts get no Zotero link. The sticky exists in Zotero, but what a reader would
	// follow the link for -- their own hand -- is in the vault's PDF the entry already points at.
	it("is not offered for a margin note", () => {
		const note: DigestNote & { section: string | null } = {
			id: "nt-4c8a17",
			anchor: { kind: "page" },
			text: "eine Randnotiz",
			region: null,
			rect: null,
			top: 5,
			section: null,
		};
		const withNote = link({ annotations: { "nt-4c8a17": { key: "STICKY01", written: {} } } });
		expect(zoteroDigestLinks(withNote, [page({ notes: [note] })])).toEqual({});
	});
});

describe("a local calendar date", () => {
	it("is the day the sync happened where the reader is sitting", () => {
		expect(formatLocalDate(new Date(2026, 8, 11, 0, 30))).toBe("2026-09-11");
	});
});

// The whole of §4 in one string. Every part of it is tested on its own above; this is the one test
// that says they go together in that order, and it is the shape a reader of the spec can check.
describe("the note of spec §4", () => {
	it("renders the sample", () => {
		const highlight: DigestHighlight = {
			id: "hl-9f21c4",
			sentence: "Die Techniken … gelten für alle aktuellen Claude-Modelle, …",
			rects: [{ x: 72, y: 700, width: 228, height: 12 }],
			tool: "marker",
			marked: ["für alle aktuellen Claude-Modelle,"],
			color: null,
			notes: [],
			section: "Allgemeine Prinzipien",
			top: 80,
		};
		const embedPath = "Best Practices für Prompting.pdf";
		const pages: DigestPage[] = [{ pageLabel: "2", embedPage: 2, source: { index: 1, widthPt: 612, heightPt: 792 }, highlights: [highlight], notes: [] }];
		const link: ZoteroLink = { attachmentKey: "A9B3C1DE", library: "user", annotations: { "hl-9f21c4": { key: "Q1H4T7K2", written: {} } } };

		const fields: NoteFields = {
			docId: "doc-1",
			pageId: null,
			pageIndex: null,
			tag: "papers",
			source: "Best Practices für Prompting",
			embedPath,
			highlights: [],
			transcript: "",
			digest: renderDigest(embedPath, pages, zoteroDigestLinks(link, pages)),
			zoteroLine: zoteroCalloutLine(info()),
		};

		const body = buildNoteContent(fields, null);

		expect(body).toBe(
			"> [!info]- Generated by Tagged Sync — do not edit\n" +
				"> Every sync rewrites this note. Keep your own thoughts in a separate note and link back to this one.\n" +
				"> Zotero: [Smith 2024 · Best Practices für Prompting](zotero://select/library/items/KX7Q2R4M) · [web library](https://www.zotero.org/users/1234567/items/KX7Q2R4M) · highlights written back 2026-09-11 · literature note: [[@smith2024prompting]]\n" +
				"\n" +
				"![[Best Practices für Prompting.pdf]]\n" +
				"\n" +
				"## Digest\n" +
				"\n" +
				"### Allgemeine Prinzipien\n" +
				"\n" +
				"Die Techniken … gelten ==für alle aktuellen Claude-Modelle,== … · [[Best Practices für Prompting.pdf#page=2|p. 2]] · [in Zotero](zotero://open-pdf/library/items/A9B3C1DE?page=2&annotation=Q1H4T7K2)\n" +
				"^hl-9f21c4\n" +
				"<!-- tagged-sync:end -->\n",
		);
	});

	// The sample's own frontmatter block is abridged -- it shows the two keys §4 is about, and the
	// same toggle writes the `remarkable-*` keys above them. What is checked here is that these two
	// are in it, in that order; `frontmatter.test.ts` owns the rest of the block.
	it("carries the sample's two keys, in its order", () => {
		const { content } = applyFrontmatter("body\n", { ...FRONTMATTER, zoteroKey: "KX7Q2R4M", citekey: "smith2024prompting" }, []);
		expect(content).toContain("zotero-key: KX7Q2R4M\ncitekey: smith2024prompting\n---\n");
	});
});

describe("a link nobody was asked about", () => {
	// §2.3's "note says: matched by file hash". The note is the only place a reader can find out that
	// the plugin linked their document to something in their library on its own.
	it("says so in the line, before what happened to the highlights", () => {
		expect(zoteroCalloutLine(info({ matchedByHash: true }))).toContain("· matched by file hash · highlights written back");
	});

	it("says nothing at all about a link that was asked about or sent", () => {
		expect(zoteroCalloutLine(info({ matchedByHash: false }))).not.toContain("matched by file hash");
		expect(zoteroCalloutLine(info())).not.toContain("matched by file hash");
	});
});

const FRONTMATTER = {
	tags: [],
	modified: null,
	synced: "2026-09-11T09:10",
	folder: null,
	type: "pdf" as const,
	pages: 1,
	page: null,
	pinned: false,
	uuid: "aaaa0002-0000-0000-0000-000000000000",
	noteId: "n0000001",
};

describe("an item in a group library (ticket 26)", () => {
	const GROUPED = { ...ITEM, library: { group: 4711 } };

	it("links into the group in Zotero and on the web", () => {
		const line = zoteroCalloutLine(info({ item: GROUPED }));
		expect(line).toContain("](zotero://select/groups/4711/items/KX7Q2R4M)");
		expect(line).toContain("[web library](https://www.zotero.org/groups/4711/items/KX7Q2R4M)");
	});

	it("opens the reader on the group's copy of the PDF", () => {
		expect(openPdfUrl("A9B3C1DE", 1, "Q1H4T7K2", { group: 4711 })).toBe("zotero://open-pdf/groups/4711/items/A9B3C1DE?page=2&annotation=Q1H4T7K2");
	});

	it("opens the web reader on the group's copy of the PDF", () => {
		expect(webReaderUrl({ username: "someone", itemKey: "KX7Q2R4M" }, "A9B3C1DE", { group: 4711 })).toBe(
			"https://www.zotero.org/groups/4711/items/KX7Q2R4M/attachment/A9B3C1DE/reader",
		);
	});
});
