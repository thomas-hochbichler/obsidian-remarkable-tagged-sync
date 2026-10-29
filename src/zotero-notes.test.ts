import { describe, expect, it, vi } from "vitest";
import type { AddedPage, DigestPage } from "./digest-builder";
import { type ZoteroClient, ZoteroError, type ZoteroNote } from "./zotero-client";
import type { ZoteroLink } from "./zotero-links";
import { type AddedPagesScope, executeNotes, planNotes } from "./zotero-notes";

const LINK: ZoteroLink = { attachmentKey: "ATT1", library: "user", annotations: {} };

/** A page added on the device, as the digest hands it out. */
function addedPage(blockId: string, text: string, added: Partial<AddedPage> = {}): DigestPage {
	return {
		pageLabel: null,
		embedPage: 13,
		source: null,
		highlights: [],
		notes: [{ id: blockId, anchor: { kind: "page" }, text, region: null, rect: null, top: 0, wholePage: true, section: null }],
		added: { relation: "after", label: "12", nth: null, ...added },
	};
}

function plan(pages: DigestPage[], options: { scope?: AddedPagesScope; link?: ZoteroLink; existing?: ZoteroNote[] } = {}) {
	return planNotes({ pages, scope: options.scope ?? "document", paperKey: "ITEM1", link: options.link ?? LINK, existing: options.existing ?? [] });
}

describe("the first sync of a page added on the tablet", () => {
	it("becomes one note under the paper, titled by the page it follows", () => {
		const { creates } = plan([addedPage("nt-aaaaaa", "Erste Zeile\nZweite Zeile")]);

		expect(creates).toEqual([{ blockId: "nt-aaaaaa", note: { parentKey: "ITEM1", note: "<h1>Added page after p. 12</h1>\n<p>Erste Zeile</p>\n<p>Zweite Zeile</p>" } }]);
	});

	it("numbers two added pages in a row after the same page, and names one before the first page", () => {
		const { creates } = plan([
			addedPage("nt-before", "Vorwort", { relation: "before", label: "1" }),
			addedPage("nt-first", "eins", { nth: 1 }),
			addedPage("nt-second", "zwei", { nth: 2 }),
		]);

		expect(creates.map((create) => create.note.note.split("\n")[0])).toEqual([
			"<h1>Added page before p. 1</h1>",
			"<h1>Added page 1 after p. 12</h1>",
			"<h1>Added page 2 after p. 12</h1>",
		]);
	});

	it("names the page by the label the vault note shows for it", () => {
		const { creates } = plan([addedPage("nt-aaaaaa", "notes", { label: "xii" })]);

		expect(creates[0].note.note).toMatch(/^<h1>Added page after p\. xii<\/h1>/);
	});

	// Sent exactly as both connections store it (ticket 08 #1): the desktop trims and strips control
	// characters, zotero.org keeps escaped text in plain <p> as it is. Anything else would read as an
	// edit by the user on the next sync.
	it("writes a body both connections store unchanged: escaped, no control characters, no outer whitespace", () => {
		const { creates } = plan([addedPage("nt-aaaaaa", "  a < b & c > d\u0007  \n\n\tzwei   Wörter\t")]);

		expect(creates[0].note.note).toBe("<h1>Added page after p. 12</h1>\n<p>a &lt; b &amp; c &gt; d</p>\n<p>zwei Wörter</p>");
	});

	it("writes nothing for a page with no text on it", () => {
		expect(plan([addedPage("nt-aaaaaa", "")]).creates).toEqual([]);
	});

	it("writes nothing for a page whose handwriting could not be read this sync", () => {
		expect(plan([addedPage("nt-aaaaaa", "typed only", { unread: true })]).creates).toEqual([]);
	});

	it("leaves the pages of the PDF itself to the annotations", () => {
		const sourcePage: DigestPage = { ...addedPage("nt-aaaaaa", "margin"), pageLabel: "3", source: { index: 2, widthPt: 612, heightPt: 792 }, added: undefined };
		expect(plan([sourcePage]).creates).toEqual([]);
	});

	it("writes only the one page a page-scoped unit speaks for, and nothing for a unit that speaks for none", () => {
		const pages = [addedPage("nt-mine", "mine"), addedPage("nt-other", "other")];

		expect(plan(pages, { scope: { blockId: "nt-mine" } }).creates.map((create) => create.blockId)).toEqual(["nt-mine"]);
		expect(plan(pages, { scope: "none" }).creates).toEqual([]);
	});

	it("does not write a page again that it already has a record for", () => {
		const link: ZoteroLink = { ...LINK, notes: { "nt-aaaaaa": { key: "NOTE1", parentKey: "ITEM1", written: { note: "<h1>Added page after p. 12</h1>" } } } };
		expect(plan([addedPage("nt-aaaaaa", "neu")], { link }).creates).toEqual([]);
	});

	// A 1.9.x install saved the link without its `notes`: the note is in Zotero and the record is gone.
	// Adopting it is ticket 12; until then a second copy is the one thing this must not make.
	it("does not write a second note where the paper already has ours under the same title", () => {
		const existing: ZoteroNote = { key: "NOTE1", library: "user", source: "web", parentKey: "ITEM1", note: "<h1>Added page after p. 12</h1>\n<p>alt</p>", version: 4 };
		expect(plan([addedPage("nt-aaaaaa", "neu")], { existing: [existing] }).creates).toEqual([]);
	});
});

describe("carrying out the plan", () => {
	const createNotes = (impl: ZoteroClient["createNotes"]) => ({ createNotes: vi.fn(impl) }) as unknown as ZoteroClient;
	const onePage = () => plan([addedPage("nt-aaaaaa", "eins")]);

	it("asks Zotero nothing when there is nothing to write", async () => {
		const client = createNotes(async () => ({ created: [], failures: [] }));

		expect(await executeNotes(client, LINK, { creates: [] })).toEqual({ notes: {}, written: 0, total: 0, failures: [] });
		expect(client.createNotes).not.toHaveBeenCalled();
	});

	// Ticket 26, as for the annotations: nothing after a refused write can land either.
	it("gives up on a library that refuses writes, so the pass can name it", async () => {
		const client = createNotes(async () => {
			throw new ZoteroError("read-only", "Zotero refused to write into that library.");
		});

		await expect(executeNotes(client, LINK, onePage())).rejects.toMatchObject({ reason: "read-only" });
	});

	it("names any other failure and remembers nothing it cannot know landed", async () => {
		const client = createNotes(async () => {
			throw new ZoteroError("unreachable", "The Zotero desktop app is not running.");
		});

		const result = await executeNotes(client, LINK, onePage());

		expect(result).toMatchObject({ notes: {}, written: 0, total: 1 });
		expect(result.failures).toHaveLength(1);
	});
});
