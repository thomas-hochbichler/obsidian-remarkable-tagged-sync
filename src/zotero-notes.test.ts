import { describe, expect, it, vi } from "vitest";
import type { AddedPage, DigestPage } from "./digest-builder";
import { type ZoteroClient, ZoteroError, type ZoteroNote } from "./zotero-client";
import type { LinkedNote, ZoteroLink } from "./zotero-links";
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

function plan(pages: DigestPage[], options: { scope?: AddedPagesScope; link?: ZoteroLink; existing?: ZoteroNote[]; noteWasDeleted?: boolean } = {}) {
	return planNotes({ pages, scope: options.scope ?? "document", paperKey: "ITEM1", link: options.link ?? LINK, existing: options.existing ?? [], noteWasDeleted: options.noteWasDeleted });
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

});

/** The body this planner writes for one line after p. 12. */
const body = (line: string, title = "Added page after p. 12") => `<h1>${title}</h1>\n<p>${line}</p>`;

/** One of our notes as Zotero holds it now. */
function zoteroNote(note: string, overrides: Partial<ZoteroNote> = {}): ZoteroNote {
	return { key: "NOTE1", library: "user", source: "web", parentKey: "ITEM1", note, version: 7, ...overrides };
}

/** A link that remembers writing `written` as note NOTE1 under `parentKey`. */
function remembered(written: string, extra: Partial<LinkedNote> = {}): ZoteroLink {
	return { ...LINK, notes: { "nt-aaaaaa": { key: "NOTE1", parentKey: "ITEM1", written: { note: written }, ...extra } } };
}

const REF = { key: "NOTE1", version: 7, source: "web", library: "user" };
const nothing = { creates: [], patches: [], trashes: [] };

describe("an added-page note on a later sync (Zotero spec §3)", () => {
	it("refreshes the body under the version read when the text changed on the tablet", () => {
		const result = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		expect(result.patches).toEqual([{ blockId: "nt-aaaaaa", note: REF, fields: { note: body("neu") }, record: { key: "NOTE1", parentKey: "ITEM1", written: { note: body("neu") } } }]);
		expect(result.creates).toEqual([]);
	});

	it("asks nothing of Zotero when the page reads as it did", () => {
		const result = plan([addedPage("nt-aaaaaa", "gleich")], { link: remembered(body("gleich")), existing: [zoteroNote(body("gleich"))] });

		expect(result).toMatchObject(nothing);
	});

	it("retitles a page moved on the tablet", () => {
		const result = plan([addedPage("nt-aaaaaa", "gleich", { label: "14", nth: 2 })], { link: remembered(body("gleich")), existing: [zoteroNote(body("gleich"))] });

		expect(result.patches[0].fields).toEqual({ note: body("gleich", "Added page 2 after p. 14") });
	});

	it("never writes a note again that the user edited in Zotero, and remembers that it is theirs", () => {
		const result = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), existing: [zoteroNote(`${body("alt")}\n<p>meins</p>`)] });

		expect(result).toMatchObject(nothing);
		expect(result.records).toEqual([{ blockId: "nt-aaaaaa", record: { key: "NOTE1", parentKey: "ITEM1", written: { note: body("alt") }, userEdited: true } }]);
	});

	it("leaves a note it remembers as the user's alone, whatever the tablet says", () => {
		const result = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt"), { userEdited: true }), existing: [zoteroNote(body("alt"))] });

		expect(result).toEqual({ ...nothing, records: [] });
	});

	it("trashes the note of a page deleted on the tablet while it reads as we wrote it", () => {
		const result = plan([], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		expect(result.trashes).toEqual([{ blockId: "nt-aaaaaa", note: REF, record: { key: "NOTE1", parentKey: "ITEM1", written: { note: body("alt") }, deleted: true } }]);
	});

	it("trashes the note of a page whose text was erased on the tablet", () => {
		expect(plan([addedPage("nt-aaaaaa", "  ")], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] }).trashes).toHaveLength(1);
	});

	// Device check 2026-10-29: the desktop's note editor saved the note as soon as it was shown,
	// wrapped in a schema container, text untouched. Looking at a note is not editing it.
	const opened = (note: string) => `<div data-schema-version="9">${note}\n</div>`;

	it("takes a note the desktop editor only wrapped for untouched: trashed, refreshed, adopted", () => {
		const trash = plan([], { link: remembered(body("alt")), existing: [zoteroNote(opened(body("alt")))] });
		const refresh = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), existing: [zoteroNote(opened(body("alt")))] });
		const adopt = plan([addedPage("nt-aaaaaa", "alt")], { existing: [zoteroNote(opened(body("alt")))] });

		expect(trash.trashes).toHaveLength(1);
		expect(refresh.patches[0].fields).toEqual({ note: body("neu") });
		expect(adopt).toMatchObject({ ...nothing, records: [{ record: { key: "NOTE1", written: { note: body("alt") } } }] });
	});

	it("still sees an edit made inside the editor's wrapper", () => {
		const result = plan([], { link: remembered(body("alt")), existing: [zoteroNote(opened(`${body("alt")}\n<p>meins</p>`))] });

		expect(result.trashes).toEqual([]);
		expect(result.records[0].record.userEdited).toBe(true);
	});

	it("keeps the note of a deleted page that the user edited", () => {
		const result = plan([], { link: remembered(body("alt")), existing: [zoteroNote(`${body("alt")}\n<p>meins</p>`)] });

		expect(result.trashes).toEqual([]);
		expect(result.records[0].record.userEdited).toBe(true);
	});

	// A page-scoped unit speaks for its one page; "not in the digest" says nothing about another.
	it("trashes only for a page the unit speaks for", () => {
		const result = plan([addedPage("nt-other", "x")], { scope: { blockId: "nt-other" }, link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		expect(result.trashes).toEqual([]);
	});

	it("neither refreshes nor trashes a page whose handwriting could not be read this sync (P5)", () => {
		const result = plan([addedPage("nt-aaaaaa", "", { unread: true })], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		expect(result).toEqual({ ...nothing, records: [] });
	});

	it("records a note the user trashed or erased as deleted and never writes it again", () => {
		const gone = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")) });
		expect(gone).toMatchObject(nothing);
		expect(gone.records[0].record.deleted).toBe(true);

		const stillGone = plan([addedPage("nt-aaaaaa", "neuer")], { link: remembered(body("alt"), { deleted: true }) });
		expect(stillGone).toEqual({ ...nothing, records: [] });
	});

	it("records a deleted page's note that is gone from Zotero as deleted, with nothing to trash", () => {
		const result = plan([], { link: remembered(body("alt")) });

		expect(result.trashes).toEqual([]);
		expect(result.records[0].record.deleted).toBe(true);
	});

	it("writes a removed note again once the user deleted the vault note as well", () => {
		const trashedBefore = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt"), { deleted: true }), noteWasDeleted: true });
		const goneSince = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), noteWasDeleted: true });

		expect(trashedBefore.creates).toEqual([{ blockId: "nt-aaaaaa", note: { parentKey: "ITEM1", note: body("neu") } }]);
		expect(goneSince.creates).toHaveLength(1);
	});

	// A 1.9.x install saved the link without its `notes` (ticket 09 #3).
	it("adopts our note under the paper with the exact title this sync writes, and refreshes it", () => {
		const result = plan([addedPage("nt-aaaaaa", "neu")], { existing: [zoteroNote(body("alt"))] });

		expect(result.creates).toEqual([]);
		expect(result.patches).toEqual([{ blockId: "nt-aaaaaa", note: REF, fields: { note: body("neu") }, record: { key: "NOTE1", parentKey: "ITEM1", written: { note: body("neu") } } }]);
	});

	it("adopts no note under another title, and none another record already holds", () => {
		const otherTitle = plan([addedPage("nt-aaaaaa", "neu")], { existing: [zoteroNote(body("alt", "Added page 2 after p. 12"))] });
		const held: ZoteroLink = { ...LINK, notes: { "nt-held": { key: "NOTE1", parentKey: "ITEM1", written: { note: body("alt") }, userEdited: true } } };
		const heldByAnother = plan([addedPage("nt-aaaaaa", "neu")], { link: held, existing: [zoteroNote(body("alt"))] });

		expect(otherTitle.creates).toHaveLength(1);
		expect(heldByAnother.creates).toHaveLength(1);
	});

	it("moves an untouched note after the PDF to its new paper, together with a refresh", () => {
		const underOld = zoteroNote(body("alt"), { parentKey: "OLDPAPER" });
		const link: ZoteroLink = { ...LINK, notes: { "nt-aaaaaa": { key: "NOTE1", parentKey: "OLDPAPER", written: { note: body("alt") } } } };

		expect(plan([addedPage("nt-aaaaaa", "alt")], { link, existing: [underOld] }).patches[0].fields).toEqual({ parentKey: "ITEM1" });
		expect(plan([addedPage("nt-aaaaaa", "neu")], { link, existing: [underOld] }).patches[0].fields).toEqual({ note: body("neu"), parentKey: "ITEM1" });
		// A page this unit does not speak for still follows the PDF: a move is not about the page.
		expect(plan([], { scope: { blockId: "nt-other" }, link, existing: [underOld] }).patches[0]).toMatchObject({ fields: { parentKey: "ITEM1" }, record: { parentKey: "ITEM1" } });
	});

	it("leaves a note the user edited where it is when the PDF moves", () => {
		const link: ZoteroLink = { ...LINK, notes: { "nt-aaaaaa": { key: "NOTE1", parentKey: "OLDPAPER", written: { note: body("alt") } } } };
		const result = plan([addedPage("nt-aaaaaa", "alt")], { link, existing: [zoteroNote(`${body("alt")}<p>x</p>`, { parentKey: "OLDPAPER" })] });

		expect(result.patches).toEqual([]);
	});

	it("creates, patches and trashes nothing while *Your notes on PDFs* is off", () => {
		const link: ZoteroLink = { ...LINK, notes: { "nt-aaaaaa": { key: "NOTE1", parentKey: "OLDPAPER", written: { note: body("alt") } } } };

		expect(plan([], { scope: "none", link, existing: [zoteroNote(body("alt"), { parentKey: "OLDPAPER" })] })).toEqual({ ...nothing, records: [] });
	});
});

describe("carrying out the plan", () => {
	const createNotes = (impl: ZoteroClient["createNotes"]) => ({ createNotes: vi.fn(impl) }) as unknown as ZoteroClient;
	const onePage = () => plan([addedPage("nt-aaaaaa", "eins")]);

	it("asks Zotero nothing when there is nothing to write", async () => {
		const client = createNotes(async () => ({ created: [], failures: [] }));

		expect(await executeNotes(client, LINK, plan([]))).toEqual({ notes: {}, written: 0, total: 0, failures: [] });
		expect(client.createNotes).not.toHaveBeenCalled();
	});

	/** A client whose trash and patch answer as given, recording the calls. */
	const writer = (trash: "written" | "conflict", patch: "written" | "conflict") =>
		({ trashAnnotation: vi.fn(async () => trash), patchNote: vi.fn(async () => patch) }) as unknown as ZoteroClient;

	it("trashes and refreshes, and remembers each as it landed", async () => {
		const client = writer("written", "written");
		const trash = plan([], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });
		const refresh = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		expect((await executeNotes(client, remembered(body("alt")), trash)).notes["nt-aaaaaa"]).toMatchObject({ deleted: true });
		expect(await executeNotes(client, remembered(body("alt")), refresh)).toMatchObject({ written: 1, total: 1, notes: { "nt-aaaaaa": { written: { note: body("neu") } } } });
		expect(client.trashAnnotation).toHaveBeenCalledWith(REF);
		expect(client.patchNote).toHaveBeenCalledWith(REF, { note: body("neu") });
	});

	// A 412 is the user editing it between our read and our write (Zotero spec §3).
	it("hands a note over to the user when the refresh comes back 412", async () => {
		const refresh = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		const result = await executeNotes(writer("written", "conflict"), remembered(body("alt")), refresh);

		expect(result).toMatchObject({ written: 0, total: 1 });
		expect(result.notes["nt-aaaaaa"]).toEqual({ key: "NOTE1", parentKey: "ITEM1", written: { note: body("alt") }, userEdited: true });
	});

	it("hands an adopted note over to the user on a 412, with no earlier record to keep", async () => {
		const adopt = plan([addedPage("nt-aaaaaa", "neu")], { existing: [zoteroNote(body("alt"))] });

		const result = await executeNotes(writer("written", "conflict"), LINK, adopt);

		expect(result.notes["nt-aaaaaa"]).toEqual({ key: "NOTE1", parentKey: "ITEM1", written: { note: body("neu") }, userEdited: true });
	});

	it("remembers nothing new when the trash comes back 412, so the next sync sees the edit", async () => {
		const trash = plan([], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		const result = await executeNotes(writer("conflict", "written"), remembered(body("alt")), trash);

		expect(result.notes).toEqual(remembered(body("alt")).notes);
	});

	it("stores the records that change without a request", async () => {
		const edited = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), existing: [zoteroNote(`${body("alt")}<p>x</p>`)] });

		expect((await executeNotes(writer("written", "written"), remembered(body("alt")), edited)).notes["nt-aaaaaa"].userEdited).toBe(true);
	});

	it("gives up on a library that refuses a refresh, and counts what landed before any other failure", async () => {
		const refresh = plan([addedPage("nt-aaaaaa", "neu")], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });
		const refusing = { patchNote: vi.fn(async () => Promise.reject(new ZoteroError("read-only", "no"))) } as unknown as ZoteroClient;
		const failing = { trashAnnotation: vi.fn(async () => Promise.reject(new ZoteroError("server", "boom"))) } as unknown as ZoteroClient;
		const trash = plan([], { link: remembered(body("alt")), existing: [zoteroNote(body("alt"))] });

		await expect(executeNotes(refusing, remembered(body("alt")), refresh)).rejects.toMatchObject({ reason: "read-only" });
		expect(await executeNotes(failing, remembered(body("alt")), trash)).toMatchObject({ written: 0, total: 1, failures: ["boom"] });
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
