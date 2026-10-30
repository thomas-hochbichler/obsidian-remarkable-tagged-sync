import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestHighlight, DigestPage } from "./digest-builder";
import {
	type AnnotationsCreated,
	type NewAnnotation,
	type NewNote,
	type NotesCreated,
	type RenderFile,
	type RenderState,
	type RenderUpload,
	type ZoteroAnnotation,
	type ZoteroAttachment,
	ZoteroError,
	type ZoteroClient,
	type ZoteroItem,
	type ZoteroLibrary,
	type ZoteroNote,
	type ZoteroRenders,
} from "./zotero-client";
import type { StoredZoteroLinks, ZoteroLink } from "./zotero-links";
import type { VaultNoteKeys } from "./zotero-note";
import { createZoteroPass, LIBRARY_OFF, type ZoteroPassDeps, type ZoteroQuestion, type ZoteroUnit, ZOTERO_GONE_LINE, ZOTERO_LIBRARY_OFF_LINE, zoteroPartialNotice, zoteroRenderNotice, zoteroSkipNotice, zoteroSkipReason, zoteroStorageFullNotice } from "./zotero-sync";

const ATTACHMENT_KEY = "ATT1";
const ITEM_KEY = "ITEM1";
const MD5 = "0f0e3fbc4e2bd4bd16b2ab4a45f4e8a5";

const ITEM: ZoteroItem = { key: ITEM_KEY, library: "user", title: "Best Practices für Prompting", creator: "Smith", year: "2024", citationKey: "smith2024prompting" };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: ATTACHMENT_KEY, library: "user", parentKey: ITEM_KEY, filename: "prompting.pdf", md5: MD5, title: "Full Text PDF", ours: false, ...overrides };
}

function highlight(overrides: Partial<DigestHighlight> = {}): DigestHighlight {
	return {
		id: "hl-9f21c4",
		sentence: "Die Techniken gelten für alle Modelle.",
		rects: [{ x: 72, y: 700, width: 228, height: 12 }],
		tool: "marker",
		marked: ["für alle Modelle"],
		color: null,
		notes: [],
		section: null,
		top: 80,
		...overrides,
	};
}

function page(overrides: Partial<DigestPage> = {}): DigestPage {
	return { pageLabel: "2", embedPage: 2, source: { index: 1, widthPt: 612, heightPt: 792 }, highlights: [highlight()], notes: [], ...overrides };
}

function unit(overrides: Partial<ZoteroUnit> = {}): ZoteroUnit {
	return { docId: "doc-1", visibleName: "Best Practices für Prompting", notePath: "Papers/Prompting.md", pages: [page()], covered: [1], md5: async () => MD5, ...overrides };
}

/** A client that answers everything the pass may ask, and records what it was asked. */
function client(overrides: Partial<ZoteroClient> = {}): ZoteroClient {
	return {
		status: async () => ({ web: true, local: false, summary: "" }),
		libraries: ["user"],
		libraryName: () => "your library",
		groups: async () => [],
		libraryId: async () => 1234567,
		username: async () => null,
		attachments: async () => [attachment()],
		attachment: async () => attachment(),
		parentItem: async () => ITEM,
		search: async () => [ITEM],
		itemsWithTag: async () => [],
		filePath: async () => null,
		fileBytes: async () => null,
		ownAnnotations: async () => [],
		createAnnotations: async (items): Promise<AnnotationsCreated> => ({ keys: items.map((_item, index) => `KEY${index}`), failures: [] }),
		patchAnnotation: async () => "written",
		renders: null,
		...overrides,
	} as ZoteroClient;
}

interface Harness {
	deps: ZoteroPassDeps;
	saved: () => StoredZoteroLinks;
	asked: ZoteroQuestion[];
}

function harness({ links: stored, ...overrides }: Partial<Omit<ZoteroPassDeps, "links">> & { links?: StoredZoteroLinks } = {}): Harness {
	let links: StoredZoteroLinks = stored ?? {};
	const asked: ZoteroQuestion[] = [];
	const deps: ZoteroPassDeps = {
		client: client(),
		links: () => links,
		saveLinks: async (next) => {
			links = next;
		},
		vaultNotes: () => [],
		webUserId: async () => "1234567",
		webReaderUser: async () => null,
		ask: async (question) => {
			asked.push(question);
			return question.candidates[0].attachment;
		},
		mayWriteBack: true,
		writeText: true,
		addRender: false,
		now: () => new Date("2026-09-11T09:00:00"),
		...overrides,
	};
	return { deps, saved: () => links, asked };
}

const linked = (overrides: Partial<ZoteroLink> = {}): StoredZoteroLinks => ({
	"doc-1": { attachmentKey: ATTACHMENT_KEY, library: "user", annotations: {}, ...overrides },
});

describe("what the pass does for one written note", () => {
	it("names the paper, links the web library and dates the write-back", async () => {
		const { deps } = harness({ links: linked() });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toBe(
			"Zotero: [Smith 2024 · Best Practices für Prompting](zotero://select/library/items/ITEM1)" +
				" · [web library](https://www.zotero.org/users/1234567/items/ITEM1) · highlights written back 2026-09-11",
		);
	});

	it("gives every written highlight its in-Zotero link", async () => {
		const { deps } = harness({ links: linked() });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.links).toEqual({ "hl-9f21c4": "zotero://open-pdf/library/items/ATT1?page=2&annotation=KEY0" });
	});

	it("writes a highlight the user deleted in Zotero again when they deleted the note as well", async () => {
		const forgotten = linked({ annotations: { "hl-9f21c4": { key: "GONE1", written: {}, deleted: true } } });
		const { deps } = harness({ links: forgotten });

		const kept = await createZoteroPass(deps).run(unit());
		const restarted = await createZoteroPass(deps).run(unit({ noteWasDeleted: true }));

		expect(kept.links).toEqual({});
		expect(restarted.links).toEqual({ "hl-9f21c4": "zotero://open-pdf/library/items/ATT1?page=2&annotation=KEY0" });
	});

	it("sends the quotes to zotero.org's reader where no desktop app is there to open them", async () => {
		const { deps } = harness({ links: linked(), webReaderUser: async () => "someone" });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.links).toEqual({ "hl-9f21c4": "https://www.zotero.org/someone/items/ITEM1/attachment/ATT1/reader" });
	});

	it("hands back the two frontmatter keys of the item, not of the attachment", async () => {
		const { deps } = harness({ links: linked() });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.keys).toEqual({ zoteroKey: ITEM_KEY, zoteroLibrary: null, citekey: "smith2024prompting" });
	});

	it("remembers what it wrote, so the next sync refreshes rather than duplicates", async () => {
		const { deps, saved } = harness({ links: linked() });

		await createZoteroPass(deps).run(unit());

		expect((saved()["doc-1"] as ZoteroLink).annotations["hl-9f21c4"].key).toBe("KEY0");
	});

	it("leaves out the web link for a vault that only talks to the desktop app", async () => {
		const { deps } = harness({ links: linked(), webUserId: async () => null });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).not.toContain("web library");
	});

	it("points at the vault's own note about the paper, and never at one of ours", async () => {
		const notes: VaultNoteKeys[] = [
			{ path: "Literature/@smith2024prompting.md", link: "@smith2024prompting", zoteroKey: ITEM_KEY, citekey: null },
			{ path: "Papers/Prompting.md", link: "Prompting", zoteroKey: ITEM_KEY, citekey: null },
		];
		const { deps } = harness({ links: linked(), vaultNotes: () => notes });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toContain("literature note: [[@smith2024prompting]]");
	});

	it("stands the attachment in for a standalone PDF that hangs under no item", async () => {
		const { deps } = harness({ links: linked(), client: client({ attachments: async () => [attachment({ parentKey: null })] }) });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.keys.zoteroKey).toBe(ATTACHMENT_KEY);
		expect(parts.line).toContain("[Full Text PDF](zotero://select/library/items/ATT1)");
	});
});

describe("matching a document nobody has linked", () => {
	it("links it silently when one attachment has exactly these bytes, and says so in the note", async () => {
		const { deps, saved, asked } = harness();

		const parts = await createZoteroPass(deps).run(unit());

		expect(asked).toEqual([]);
		expect((saved()["doc-1"] as ZoteroLink).attachmentKey).toBe(ATTACHMENT_KEY);
		expect(parts.line).toContain("matched by file hash");
	});

	it("asks once when the same file hangs under two items, and remembers the answer", async () => {
		const twin = attachment({ key: "ATT2", parentKey: "ITEM2" });
		const { deps, saved, asked } = harness({ client: client({ attachments: async () => [attachment(), twin] }) });

		await createZoteroPass(deps).run(unit());

		expect(asked[0].evidence).toBe("hash");
		expect(asked[0].candidates.map((candidate) => candidate.attachment.key)).toEqual([ATTACHMENT_KEY, "ATT2"]);
		expect((saved()["doc-1"] as ZoteroLink).attachmentKey).toBe(ATTACHMENT_KEY);
	});

	it("does not claim the answer as its own: a link the user chose says nothing about a hash", async () => {
		const twin = attachment({ key: "ATT2", parentKey: "ITEM2" });
		const { deps } = harness({ client: client({ attachments: async () => [attachment(), twin] }) });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).not.toContain("matched by file hash");
	});

	it("remembers a picker the user closed, so the question is asked once and not every sync", async () => {
		const twin = attachment({ key: "ATT2", parentKey: "ITEM2" });
		const { deps, saved } = harness({ client: client({ attachments: async () => [attachment(), twin] }), ask: async () => null });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toBeNull();
		expect(saved()["doc-1"]).toEqual({ declined: true });
	});

	it("never asks in a background run, and never records a refusal the user did not make", async () => {
		const twin = attachment({ key: "ATT2", parentKey: "ITEM2" });
		const { deps, saved } = harness({ client: client({ attachments: async () => [attachment(), twin] }), ask: undefined });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toBeNull();
		expect(saved()).toEqual({});
	});

	it("asks nothing again about a document that was already declined, and reads no bytes for it", async () => {
		const md5 = vi.fn(async () => MD5);
		const { deps, asked } = harness({ links: { "doc-1": { declined: true } } });

		const parts = await createZoteroPass(deps).run(unit({ md5 }));

		expect(parts.line).toBeNull();
		expect(asked).toEqual([]);
		expect(md5).not.toHaveBeenCalled();
	});

	it("never hashes a document it is already linked to", async () => {
		const md5 = vi.fn(async () => MD5);
		const { deps } = harness({ links: linked() });

		await createZoteroPass(deps).run(unit({ md5 }));

		expect(md5).not.toHaveBeenCalled();
	});

	it("leaves a note with no Zotero part alone, and takes the key off it", async () => {
		const { deps } = harness({ client: client({ attachments: async () => [] }) });

		const parts = await createZoteroPass(deps).run(unit({ md5: async () => null }));

		expect(parts).toEqual({ line: null, links: {}, keys: { zoteroKey: null, zoteroLibrary: null, citekey: null }, notices: [] });
	});

	it("reads the library once however many notes the run writes", async () => {
		const attachments = vi.fn(async () => [attachment()]);
		const { deps } = harness({ links: linked(), client: client({ attachments }) });
		const pass = createZoteroPass(deps);

		await pass.run(unit());
		await pass.run(unit({ docId: "doc-2", notePath: "Papers/Other.md" }));

		expect(attachments).toHaveBeenCalledTimes(1);
	});
});

describe("in a vault that has the free half", () => {
	// Spec §5: the note names the paper and keeps its keys; nothing write-shaped reaches Zotero -- not
	// even the listing of our own annotations, which is the request that needs a write-capable key.
	it("names the paper, writes nothing, and says where the highlights are", async () => {
		const ownAnnotations = vi.fn(async (): Promise<ZoteroAnnotation[]> => []);
		const createAnnotations = vi.fn(async (): Promise<AnnotationsCreated> => ({ keys: [], failures: [] }));
		const { deps, saved } = harness({ links: linked(), client: client({ ownAnnotations, createAnnotations }), mayWriteBack: false });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toContain("highlights stay in the vault — writing them into Zotero is Tagged Sync Pro");
		expect(parts.keys).toEqual({ zoteroKey: ITEM_KEY, zoteroLibrary: null, citekey: "smith2024prompting" });
		expect(parts.links).toEqual({});
		expect(parts.notices).toEqual([]);
		expect(ownAnnotations).not.toHaveBeenCalled();
		expect(createAnnotations).not.toHaveBeenCalled();
		expect((saved()["doc-1"] as ZoteroLink).annotations).toEqual({});
	});
});

describe("with *Write text to Zotero* off", () => {
	// Zotero spec §5: nothing created, patched or trashed -- highlights and added pages alike -- and
	// what is already in Zotero stays, links included.
	// A new highlight to create and the note of a page deleted on the tablet to trash: with the switch
	// on, both are written -- which is what makes "nothing sent" with it off mean something.
	const GONE_BODY = "<h1>Added page after p. 3</h1>";
	const pending = () => {
		const writes = {
			createAnnotations: vi.fn(async (): Promise<AnnotationsCreated> => ({ keys: ["NEW1"], failures: [] })),
			patchAnnotation: vi.fn(async () => "written" as const),
			trashAnnotation: vi.fn(async () => "written" as const),
			createNotes: vi.fn(async (): Promise<NotesCreated> => ({ created: [], failures: [] })),
			patchNote: vi.fn(async () => "written" as const),
		};
		const ownNotes = async (): Promise<ZoteroNote[]> => [{ key: "NOTE1", library: "user", source: "web", parentKey: ITEM_KEY, note: GONE_BODY, version: 3 }];
		const stored = linked({ notes: { "nt-gone": { key: "NOTE1", parentKey: ITEM_KEY, written: { note: GONE_BODY } } } });
		return { writes, stored, zotero: client({ ...writes, ownNotes, notesAccess: async () => true }) };
	};
	const callCounts = (writes: Record<string, { mock: { calls: unknown[] } }>) => Object.values(writes).map((call) => call.mock.calls.length);

	it("writes the pending highlight and trashes the gone page's note while on", async () => {
		const { writes, stored, zotero } = pending();
		const { deps } = harness({ links: stored, client: zotero });

		await createZoteroPass(deps).run(unit({ addedPages: "document" }));

		expect(callCounts(writes)).toEqual([1, 0, 1, 0, 0]);
	});

	it("sends no write for them while off, leaves the stored link alone, and says the switch is off", async () => {
		const { writes, stored, zotero } = pending();
		const { deps, saved } = harness({ links: stored, client: zotero, writeText: false });

		const parts = await createZoteroPass(deps).run(unit({ addedPages: "document" }));

		expect(callCounts(writes)).toEqual([0, 0, 0, 0, 0]);
		expect(parts.line).toBe(
			"Zotero: [Smith 2024 · Best Practices für Prompting](zotero://select/library/items/ITEM1)" +
				" · [web library](https://www.zotero.org/users/1234567/items/ITEM1) · writing text to Zotero is switched off",
		);
		expect(parts.notices).toEqual([]);
		expect(saved()).toEqual(stored);
	});

	it("keeps the in-Zotero link of a highlight written before it was switched off", async () => {
		const { deps } = harness({ links: linked({ annotations: { "hl-9f21c4": { key: "OLD1", written: {} } } }), writeText: false });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.links).toEqual({ "hl-9f21c4": "zotero://open-pdf/library/items/ATT1?page=2&annotation=OLD1" });
	});

	it("still says a free vault's highlights are Pro", async () => {
		const { deps } = harness({ links: linked(), mayWriteBack: false, writeText: false });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toContain("highlights stay in the vault — writing them into Zotero is Tagged Sync Pro");
	});
});

describe("when Zotero says no", () => {
	it("keeps the note's own identity and says in one clause why its marks are not there yet", async () => {
		const ownAnnotations = async (): Promise<ZoteroAnnotation[]> => {
			throw new ZoteroError("unreachable", "Zotero did not answer.");
		};
		const { deps } = harness({ links: linked(), client: client({ ownAnnotations }) });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toContain("not written back: Zotero could not be reached");
		expect(parts.keys.zoteroKey).toBe(ITEM_KEY);
		expect(parts.notices).toEqual(['Zotero: "Best Practices für Prompting" was not written back — Zotero could not be reached. The next sync tries again.']);
	});

	it("reports a half-written run in both numbers, and keeps the keys it did get", async () => {
		const createAnnotations = async (): Promise<AnnotationsCreated> => ({ keys: [null], failures: ["Zotero refused one annotation."] });
		const { deps } = harness({ links: linked(), client: client({ createAnnotations }) });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.notices).toEqual(['Zotero: 0 of 1 highlights and notes written for "Best Practices für Prompting", retry on next sync.']);
		expect(parts.line).toContain("0 of 1 highlights written back 2026-09-11");
	});

	it("keeps the note and drops the Zotero part when the attachment is gone from the library", async () => {
		const { deps } = harness({ links: linked(), client: client({ attachments: async () => [] }) });

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts.line).toBe(ZOTERO_GONE_LINE);
		expect(parts.links).toEqual({});
		// Absent, not null: the user may put the item back, and the key is the only record of what it was.
		expect(parts.keys).toEqual({});
	});

	it("never throws, whatever the library does, and leaves the note's keys where they are", async () => {
		const { deps } = harness({
			client: client({
				attachments: async () => {
					throw new Error("the socket closed");
				},
			}),
		});

		const parts = await createZoteroPass(deps).run(unit());

		expect(parts).toEqual({ line: null, links: {}, keys: {}, notices: ['Zotero: "Best Practices für Prompting" was not written back — the socket closed. The next sync tries again.'] });
	});
});

describe("pages added on the tablet (#246)", () => {
	const BLOCK = "nt-4c8a17";
	const BODY = "<h1>Added page after p. 12</h1>\n<p>Meine Gedanken</p>";

	function addedPage(text = "Meine Gedanken"): DigestPage {
		return {
			pageLabel: null,
			embedPage: 13,
			source: null,
			highlights: [],
			notes: [{ id: BLOCK, anchor: { kind: "page" }, text, region: null, rect: null, top: 0, wholePage: true, section: null }],
			added: { relation: "after", label: "12", nth: null },
		};
	}

	const withAdded = (overrides: Partial<ZoteroUnit> = {}) => unit({ pages: [page(), addedPage()], addedPages: "document", ...overrides });

	/** Records the notes it is asked to create, and stores each body as sent. */
	function notesClient(overrides: Partial<ZoteroClient> = {}) {
		const createNotes = vi.fn(async (items: NewNote[], _library: ZoteroLibrary): Promise<NotesCreated> => ({
			created: items.map((item, index) => ({ key: `NOTE${index}`, note: item.note })),
			failures: [],
		}));
		const ownNotes = vi.fn(async (): Promise<ZoteroNote[]> => []);
		return { createNotes, ownNotes, client: client({ createNotes, ownNotes, notesAccess: async () => true, ...overrides }) };
	}

	it("writes each added page as a note under the paper and remembers the body Zotero stored", async () => {
		const { createNotes, ownNotes, client: zotero } = notesClient();
		const { deps, saved } = harness({ links: linked(), client: zotero });

		const parts = await createZoteroPass(deps).run(withAdded());

		expect(ownNotes).toHaveBeenCalledWith(ITEM_KEY, "user");
		expect(createNotes).toHaveBeenCalledWith([{ parentKey: ITEM_KEY, note: BODY }], "user");
		expect((saved()["doc-1"] as ZoteroLink).notes).toEqual({ [BLOCK]: { key: "NOTE0", parentKey: ITEM_KEY, written: { note: BODY } } });
		expect((saved()["doc-1"] as ZoteroLink).annotations["hl-9f21c4"].key).toBe("KEY0");
		expect(parts.line).toContain("· highlights written back 2026-09-11");
		expect(parts.notices).toEqual([]);
	});

	it("writes the notes of a group's paper into the group", async () => {
		const GROUP = { group: 4711 };
		const { createNotes, client: zotero } = notesClient({
			libraries: ["user", GROUP],
			attachments: async () => [attachment({ library: GROUP })],
			notesAccess: async () => false,
		});
		const { deps } = harness({ links: { "doc-1": { attachmentKey: ATTACHMENT_KEY, library: GROUP, annotations: {} } }, client: zotero });

		await createZoteroPass(deps).run(withAdded());

		expect(createNotes.mock.calls[0][1]).toEqual(GROUP);
	});

	it("asks Zotero nothing about notes for a document with no added page", async () => {
		const { createNotes, ownNotes, client: zotero } = notesClient();
		const notesAccess = vi.fn(async () => true);
		const { deps } = harness({ links: linked(), client: { ...zotero, notesAccess } });

		await createZoteroPass(deps).run(unit({ addedPages: "document" }));

		expect([ownNotes, createNotes, notesAccess].map((call) => call.mock.calls.length)).toEqual([0, 0, 0]);
	});

	it("writes nothing for a page while *Your notes on PDFs* is off", async () => {
		const { createNotes, client: zotero } = notesClient();
		const { deps } = harness({ links: linked(), client: zotero });

		const parts = await createZoteroPass(deps).run(withAdded({ addedPages: "none" }));

		expect(createNotes).not.toHaveBeenCalled();
		expect(parts.line).not.toContain("added pages");
	});

	it("writes no note for a PDF with no parent item, says why, and still writes the highlights", async () => {
		const { createNotes, client: zotero } = notesClient({ attachments: async () => [attachment({ parentKey: null })] });
		const { deps, saved } = harness({ links: linked(), client: zotero });

		const parts = await createZoteroPass(deps).run(withAdded());

		expect(createNotes).not.toHaveBeenCalled();
		expect(parts.line).toContain("highlights written back 2026-09-11 · added pages not written back: this PDF has no parent item in Zotero");
		expect((saved()["doc-1"] as ZoteroLink).annotations["hl-9f21c4"].key).toBe("KEY0");
	});

	it("writes no note with a zotero.org key that has no notes access, says why, and tells the user what to change", async () => {
		const { createNotes, client: zotero } = notesClient({ notesAccess: async () => false });
		const { deps } = harness({ links: linked(), client: zotero });

		const parts = await createZoteroPass(deps).run(withAdded());

		expect(createNotes).not.toHaveBeenCalled();
		expect(parts.line).toContain("· added pages not written back: the API key has no notes access");
		expect(parts.notices).toEqual([
			'Zotero: the pages you added to "Best Practices für Prompting" were not written back — your zotero.org API key has no notes access. Allow it for the same key under zotero.org → Settings → Security; no new key is needed.',
		]);
	});

	it("counts the notes with the highlights when not all of them landed", async () => {
		const { client: zotero } = notesClient({ createNotes: async () => ({ created: [null], failures: ["Parent item not found"] }) });
		const { deps } = harness({ links: linked(), client: zotero });

		const parts = await createZoteroPass(deps).run(withAdded());

		expect(parts.line).toContain("1 of 2 highlights written back 2026-09-11");
		expect(parts.notices).toEqual(['Zotero: 1 of 2 highlights and notes written for "Best Practices für Prompting", retry on next sync.']);
	});

	it("keeps the highlights it wrote when writing the notes fails, and says why in its own clause", async () => {
		const { client: zotero } = notesClient({
			ownNotes: async () => {
				throw new ZoteroError("unreachable", "Zotero did not answer.");
			},
		});
		const { deps, saved } = harness({ links: linked(), client: zotero });

		const parts = await createZoteroPass(deps).run(withAdded());

		expect(parts.line).toContain("highlights written back 2026-09-11 · added pages not written back: Zotero could not be reached");
		expect(parts.notices).toEqual([zoteroSkipNotice("Best Practices für Prompting", "Zotero could not be reached")]);
		expect((saved()["doc-1"] as ZoteroLink).annotations["hl-9f21c4"].key).toBe("KEY0");
	});

	it("writes nothing for an added page in a free vault", async () => {
		const { createNotes, ownNotes, client: zotero } = notesClient();
		const { deps } = harness({ links: linked(), client: zotero, mayWriteBack: false });

		await createZoteroPass(deps).run(withAdded());

		expect([ownNotes, createNotes].map((call) => call.mock.calls.length)).toEqual([0, 0]);
	});

	describe("on a later sync (ticket 12)", () => {
		const NOTE: ZoteroNote = { key: "NOTE1", library: "user", source: "web", parentKey: ITEM_KEY, note: BODY, version: 3 };
		const withNote = (parentKey = ITEM_KEY, extra: object = {}) => linked({ notes: { [BLOCK]: { key: "NOTE1", parentKey, written: { note: BODY }, ...extra } } });

		it("trashes the note of the one added page deleted on the tablet, though nothing is left to write", async () => {
			const trashAnnotation = vi.fn(async () => "written" as const);
			const { client: zotero } = notesClient({ ownNotes: async () => [NOTE], trashAnnotation });
			const { deps, saved } = harness({ links: withNote(), client: zotero });

			const parts = await createZoteroPass(deps).run(unit({ addedPages: "document" }));

			expect(trashAnnotation).toHaveBeenCalledWith({ key: "NOTE1", version: 3, source: "web", library: "user" });
			expect((saved()["doc-1"] as ZoteroLink).notes?.[BLOCK].deleted).toBe(true);
			expect(parts.notices).toEqual([]);
		});

		it("leaves the notes alone while *Your notes on PDFs* is off, and asks Zotero nothing about them", async () => {
			const { ownNotes, client: zotero } = notesClient();
			const { deps } = harness({ links: withNote(), client: zotero });

			await createZoteroPass(deps).run(unit({ addedPages: "none" }));

			expect(ownNotes).not.toHaveBeenCalled();
		});

		it("freezes the notes while the paper is in Zotero's trash (P4)", async () => {
			const { ownNotes, client: zotero } = notesClient({ parentItem: async () => ({ ...ITEM, trashed: true }) });
			const { deps } = harness({ links: withNote(), client: zotero });

			const parts = await createZoteroPass(deps).run(unit({ addedPages: "document" }));

			expect(ownNotes).not.toHaveBeenCalled();
			expect(parts.line).not.toContain("added pages");
		});

		it("reads the paper the PDF hung under before, and moves our note from there", async () => {
			const patchNote = vi.fn(async () => "written" as const);
			const ownNotes = vi.fn(async (paperKey: string): Promise<ZoteroNote[]> => (paperKey === "OLDPAPER" ? [{ ...NOTE, parentKey: "OLDPAPER" }] : []));
			const { client: zotero } = notesClient({ ownNotes, patchNote });
			const { deps, saved } = harness({ links: withNote("OLDPAPER"), client: zotero });

			await createZoteroPass(deps).run(withAdded());

			expect(ownNotes.mock.calls.map((call) => call[0])).toEqual([ITEM_KEY, "OLDPAPER"]);
			expect(patchNote).toHaveBeenCalledWith({ key: "NOTE1", version: 3, source: "web", library: "user" }, { parentKey: ITEM_KEY });
			expect((saved()["doc-1"] as ZoteroLink).notes?.[BLOCK].parentKey).toBe(ITEM_KEY);
		});

		it("takes a former paper that is gone for one with no notes of ours left", async () => {
			const ownNotes = vi.fn(async (paperKey: string): Promise<ZoteroNote[]> => {
				if (paperKey === "OLDPAPER") throw new ZoteroError("not-found", "gone");
				return [];
			});
			const { createNotes, client: zotero } = notesClient({ ownNotes });
			const { deps, saved } = harness({ links: withNote("OLDPAPER"), client: zotero });

			const parts = await createZoteroPass(deps).run(withAdded());

			expect((saved()["doc-1"] as ZoteroLink).notes?.[BLOCK].deleted).toBe(true);
			expect(createNotes).not.toHaveBeenCalled();
			expect(parts.notices).toEqual([]);
		});

		it("says why when the former paper cannot be read, and changes no note", async () => {
			const ownNotes = vi.fn(async (paperKey: string): Promise<ZoteroNote[]> => {
				if (paperKey === "OLDPAPER") throw new ZoteroError("unreachable", "Zotero did not answer.");
				return [];
			});
			const { client: zotero } = notesClient({ ownNotes });
			const { deps, saved } = harness({ links: withNote("OLDPAPER"), client: zotero });

			const parts = await createZoteroPass(deps).run(withAdded());

			expect(parts.line).toContain("added pages not written back: Zotero could not be reached");
			expect((saved()["doc-1"] as ZoteroLink).notes?.[BLOCK]).toEqual({ key: "NOTE1", parentKey: "OLDPAPER", written: { note: BODY } });
		});

		it("writes a removed note again when the vault note was deleted as well", async () => {
			const { createNotes, client: zotero } = notesClient();
			const { deps } = harness({ links: withNote(ITEM_KEY, { deleted: true }), client: zotero });

			await createZoteroPass(deps).run(withAdded({ noteWasDeleted: true }));

			expect(createNotes).toHaveBeenCalledWith([{ parentKey: ITEM_KEY, note: BODY }], "user");
		});

		it("asks nothing about a document whose notes are all the user's or gone", async () => {
			const { ownNotes, client: zotero } = notesClient();
			const { deps } = harness({ links: withNote(ITEM_KEY, { userEdited: true }), client: zotero });

			await createZoteroPass(deps).run(unit({ addedPages: "document" }));

			expect(ownNotes).not.toHaveBeenCalled();
		});
	});
});

describe("what a failure is called", () => {
	it("has a sentence for every way Zotero can say no", () => {
		const reasons = (["unreachable", "not-enabled", "denied", "unauthorized", "rate-limited", "not-found", "read-only", "server"] as const).map((reason) =>
			zoteroSkipReason(new ZoteroError(reason, "raw")),
		);

		expect(reasons.every((reason) => reason !== "raw" && reason.length > 0)).toBe(true);
		expect(new Set(reasons).size).toBe(reasons.length);
	});

	it("keeps the message of anything that is not a Zotero failure at all", () => {
		expect(zoteroSkipReason("EPIPE")).toBe("EPIPE");
	});

	it("names the document in both sentences the run raises", () => {
		expect(zoteroSkipNotice("Paper", "Zotero could not be reached")).toContain('"Paper"');
		expect(zoteroPartialNotice("Paper", 3, 7)).toBe('Zotero: 3 of 7 highlights and notes written for "Paper", retry on next sync.');
	});
});

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("group libraries (ticket 26)", () => {
	const GROUP = { group: 4711 };
	const grouped = (overrides: Partial<ZoteroAttachment> = {}) => attachment({ library: GROUP, ...overrides });
	const twoLibraries = (overrides: Partial<ZoteroClient> = {}) =>
		client({ libraries: ["user", GROUP], libraryName: (library) => (library === "user" ? "your library" : "Lab reading group"), ...overrides });

	// The same PDF in the personal library and in a group is not a silent match: it is the one
	// question of §2.3, and the answers are told apart by nothing but the library.
	it("asks, naming the library beside each candidate, when the same file is in the personal library and in a group", async () => {
		const { deps, asked, saved } = harness({ client: twoLibraries({ attachments: async () => [attachment(), grouped()] }) });
		await createZoteroPass(deps).run(unit());
		expect(asked[0].candidates.map((candidate) => candidate.library)).toEqual(["your library", "Lab reading group"]);
		expect((saved()["doc-1"] as ZoteroLink).library).toBe("user");
	});

	it("names no library while only the personal one is read", async () => {
		const twin = attachment({ key: "ATT2", parentKey: "ITEM2" });
		const { deps, asked } = harness({ client: client({ attachments: async () => [attachment(), twin] }) });
		await createZoteroPass(deps).run(unit());
		expect(asked[0].candidates.map((candidate) => candidate.library)).toEqual([undefined, undefined]);
	});

	it("links a group's paper into the group, in every link the note carries", async () => {
		const { deps, saved } = harness({ client: twoLibraries({ attachments: async () => [grouped()], parentItem: async () => ({ ...ITEM, library: GROUP }) }) });
		const parts = await createZoteroPass(deps).run(unit());
		expect((saved()["doc-1"] as ZoteroLink).library).toEqual(GROUP);
		expect(parts.line).toContain("](zotero://select/groups/4711/items/ITEM1)");
		expect(parts.line).toContain("[web library](https://www.zotero.org/groups/4711/items/ITEM1)");
		expect(parts.links).toEqual({ "hl-9f21c4": "zotero://open-pdf/groups/4711/items/ATT1?page=2&annotation=KEY0" });
		expect(parts.keys).toEqual({ zoteroKey: ITEM_KEY, zoteroLibrary: "4711", citekey: "smith2024prompting" });
	});

	// A read-only membership answers 403 on the write. The note names the group, and nothing is
	// retried into the personal library instead.
	it("writes into the group and nowhere else, and names the group it may only read", async () => {
		const createAnnotations = vi.fn(async (_items: NewAnnotation[], _library: ZoteroLibrary): Promise<AnnotationsCreated> => {
			throw new ZoteroError("read-only", "Zotero refused to write into that library.");
		});
		const { deps } = harness({
			links: { "doc-1": { attachmentKey: ATTACHMENT_KEY, library: GROUP, annotations: {} } },
			client: twoLibraries({ attachments: async () => [grouped()], createAnnotations }),
		});
		const parts = await createZoteroPass(deps).run(unit());
		expect(createAnnotations).toHaveBeenCalledTimes(1);
		expect(createAnnotations.mock.calls[0][1]).toEqual(GROUP);
		expect(parts.line).toContain("not written back: no write access to Lab reading group");
		expect(parts.notices).toEqual([zoteroSkipNotice("Best Practices für Prompting", "no write access to Lab reading group")]);
	});

	// Over zotero.org the thing without write access is the key, and the fix is on the key's page.
	it("names the API key when zotero.org refused the write", async () => {
		const createAnnotations = vi.fn(async (): Promise<AnnotationsCreated> => {
			throw new ZoteroError("read-only", "Zotero refused to write into that library.", "web");
		});
		const { deps } = harness({ links: linked(), client: client({ createAnnotations }) });
		const parts = await createZoteroPass(deps).run(unit());
		const reason = "the API key has no write access to your library (allow it under zotero.org → Settings → Security)";
		expect(parts.line).toContain(`not written back: ${reason}`);
		expect(parts.notices).toEqual([zoteroSkipNotice("Best Practices für Prompting", reason)]);
	});

	// Unticked in the settings: the link stays for the day it is ticked again, and meanwhile nothing
	// is read for it -- "gone" would be the wrong word for a library that is merely off.
	it("leaves a link into a group that was switched off alone, and says so", async () => {
		const attachments = vi.fn(async () => [attachment()]);
		const { deps, saved } = harness({ links: { "doc-1": { attachmentKey: ATTACHMENT_KEY, library: GROUP, annotations: {} } }, client: client({ attachments }) });
		const parts = await createZoteroPass(deps).run(unit());
		expect(parts).toEqual({ line: ZOTERO_LIBRARY_OFF_LINE, links: {}, keys: {}, notices: [zoteroSkipNotice("Best Practices für Prompting", LIBRARY_OFF)] });
		expect(attachments).not.toHaveBeenCalled();
		expect((saved()["doc-1"] as ZoteroLink).library).toEqual(GROUP);
	});
});

describe("the render as a Zotero attachment (#180, Zotero spec §4)", () => {
	const BYTES = new Uint8Array([37, 80, 68, 70]);

	/** A whole-document unit whose render hashes to `md5`, counting how often it is hashed. */
	function whole(md5 = "md5-a"): ZoteroUnit & { hashed: () => number } {
		let hashed = 0;
		return {
			...unit(),
			render: {
				bytes: BYTES,
				md5: () => {
					hashed++;
					return md5;
				},
			},
			hashed: () => hashed,
		};
	}

	/** The render in Zotero as we left it: under the paper, holding what we uploaded last. */
	function live(overrides: Partial<RenderState> = {}): RenderState {
		return { key: "REN1", parentKey: ITEM_KEY, title: "Annotated PDF", filename: "annotated_prompting.pdf", md5: "md5-a", trashed: false, annotated: false, ...overrides };
	}

	function renders(overrides: Partial<ZoteroRenders> = {}) {
		return {
			create: vi.fn(async (_parentKey: string, _filename: string) => "REN1"),
			upload: vi.fn(async (_key: string, _file: RenderFile, _holds: string | null): Promise<RenderUpload> => "uploaded"),
			state: vi.fn(async (_key: string): Promise<RenderState | null> => live()),
			find: vi.fn(async (_parentKey: string): Promise<RenderState | null> => null),
			...overrides,
		};
	}

	const on = (r: ZoteroRenders, overrides: Partial<Omit<ZoteroPassDeps, "links">> & { links?: StoredZoteroLinks } = {}) =>
		harness({ links: linked(), client: client({ renders: r }), addRender: true, ...overrides });

	const renderOf = (links: StoredZoteroLinks) => (links["doc-1"] as ZoteroLink).render;
	const RECORDED = { key: "REN1", parentKey: ITEM_KEY, md5: "md5-a" };

	it("creates the attachment under the paper, uploads the render and links it from the line", async () => {
		const r = renders();
		const { deps, saved } = on(r);

		const parts = await createZoteroPass(deps).run(whole());

		expect(r.create).toHaveBeenCalledWith(ITEM_KEY, "annotated_prompting.pdf");
		expect(r.upload).toHaveBeenCalledWith("REN1", { bytes: BYTES, md5: "md5-a", filename: "annotated_prompting.pdf" }, null);
		expect(renderOf(saved())).toEqual(RECORDED);
		expect(parts.line).toContain("· highlights written back 2026-09-11 · [render in Zotero](zotero://open-pdf/library/items/REN1)");
	});

	// Two document tags are two units of one document in one run; an unchanged document synced again
	// is the same render. Either way one attachment, one upload.
	it("uploads once for two units of the same render", async () => {
		const r = renders();
		const pass = createZoteroPass(on(r).deps);

		await pass.run(whole());
		const second = await pass.run(whole());

		expect(r.create).toHaveBeenCalledTimes(1);
		expect(r.upload).toHaveBeenCalledTimes(1);
		expect(second.line).toContain("[render in Zotero](zotero://open-pdf/library/items/REN1)");
	});

	it("replaces the file when the render changed, naming the MD5 it replaces", async () => {
		const r = renders();
		const { deps, saved } = on(r, { links: linked({ render: RECORDED }) });

		await createZoteroPass(deps).run(whole("md5-b"));

		expect(r.create).not.toHaveBeenCalled();
		expect(r.upload).toHaveBeenCalledWith("REN1", expect.objectContaining({ md5: "md5-b" }), "md5-a");
		expect(renderOf(saved())).toEqual({ ...RECORDED, md5: "md5-b" });
	});

	it("names the file after the document where the PDF has no filename in Zotero", async () => {
		const r = renders();
		const { deps } = on(r, { client: client({ renders: r, attachments: async () => [attachment({ filename: null })] }) });

		await createZoteroPass(deps).run(whole());

		expect(r.create).toHaveBeenCalledWith(ITEM_KEY, "annotated_Best Practices für Prompting.pdf");
	});

	it("opens zotero.org's reader on the render in a vault without the desktop app", async () => {
		const { deps } = on(renders(), { webReaderUser: async () => "vodaza36" });

		const parts = await createZoteroPass(deps).run(whole());

		expect(parts.line).toContain("[render in Zotero](https://www.zotero.org/vodaza36/items/ITEM1/attachment/REN1/reader)");
	});

	it("says to tag the whole document on a page note, and uploads nothing", async () => {
		const r = renders();

		const parts = await createZoteroPass(on(r).deps).run(unit());

		expect(parts.line).toContain("· render not added: tag the whole document");
		expect(r.create).not.toHaveBeenCalled();
	});

	it("links a page note to the render its document tag added", async () => {
		const parts = await createZoteroPass(on(renders(), { links: linked({ render: RECORDED }) }).deps).run(unit());

		expect(parts.line).toContain("[render in Zotero](zotero://open-pdf/library/items/REN1)");
	});

	it("says why without a zotero.org connection", async () => {
		const { deps } = harness({ links: linked(), addRender: true });

		const parts = await createZoteroPass(deps).run(whole());

		expect(parts.line).toContain("· render not added: needs a zotero.org connection");
	});

	it("says why for a paper in a group library", async () => {
		const GROUP = { group: 4711 };
		const r = renders();
		const { deps } = on(r, {
			links: { "doc-1": { attachmentKey: ATTACHMENT_KEY, library: GROUP, annotations: {} } },
			client: client({ renders: r, libraries: ["user", GROUP], attachments: async () => [attachment({ library: GROUP })], parentItem: async () => ({ ...ITEM, library: GROUP }) }),
		});

		const parts = await createZoteroPass(deps).run(whole());

		expect(parts.line).toContain("· render not added: group library");
		expect(r.create).not.toHaveBeenCalled();
	});

	it("says why for a PDF with no parent item", async () => {
		const r = renders();
		const { deps } = on(r, { client: client({ renders: r, attachments: async () => [attachment({ parentKey: null })] }) });

		const parts = await createZoteroPass(deps).run(whole());

		expect(parts.line).toContain("· render not added: this PDF has no parent item in Zotero");
		expect(r.create).not.toHaveBeenCalled();
	});

	it("says the Zotero Storage is full, and fills the same attachment once there is room", async () => {
		const upload = vi.fn(async (_key: string, _file: RenderFile, _holds: string | null): Promise<RenderUpload> => "quota");
		// An attachment with no file yet may name none either: then it gets ours.
		const r = renders({ upload, state: vi.fn(async () => live({ md5: null, filename: null })) });
		const { deps, saved } = on(r);

		const full = await createZoteroPass(deps).run(whole());
		upload.mockResolvedValue("uploaded");
		await createZoteroPass(deps).run(whole());

		expect(full.line).toContain("· render not added: your Zotero Storage is full");
		expect(full.notices).toEqual([zoteroStorageFullNotice("Best Practices für Prompting")]);
		expect(r.create).toHaveBeenCalledTimes(1);
		expect(upload).toHaveBeenLastCalledWith("REN1", expect.objectContaining({ filename: "annotated_prompting.pdf" }), null);
		expect(renderOf(saved())).toEqual(RECORDED);
	});

	it("keeps the highlights and says why when the upload fails", async () => {
		const r = renders({
			upload: vi.fn(async (): Promise<RenderUpload> => {
				throw new ZoteroError("unreachable", "offline");
			}),
		});

		const parts = await createZoteroPass(on(r).deps).run(whole());

		expect(parts.line).toContain("· highlights written back 2026-09-11 · render not added: Zotero could not be reached");
		expect(parts.notices).toEqual([zoteroRenderNotice("Best Practices für Prompting", "Zotero could not be reached")]);
	});

	// A 409/412 between the read and the upload: the next sync reads the attachment again.
	it("records nothing new when the file changed underneath the upload", async () => {
		const r = renders({ upload: vi.fn(async (): Promise<RenderUpload> => "changed") });
		const { deps, saved } = on(r, { links: linked({ render: RECORDED }) });

		await createZoteroPass(deps).run(whole("md5-b"));

		expect(renderOf(saved())).toEqual(RECORDED);
	});

	it("uploads with Write text to Zotero switched off: that switch is not the render's", async () => {
		const r = renders();

		const parts = await createZoteroPass(on(r, { writeText: false }).deps).run(whole());

		expect(r.upload).toHaveBeenCalledTimes(1);
		expect(parts.line).toContain("writing text to Zotero is switched off · [render in Zotero]");
	});

	it("neither hashes nor uploads while the switch is off, and says nothing about a render", async () => {
		const r = renders();
		const document = whole();

		const parts = await createZoteroPass(on(r, { addRender: false }).deps).run(document);

		expect(document.hashed()).toBe(0);
		expect(r.create).not.toHaveBeenCalled();
		expect(parts.line).not.toContain("render");
	});

	it("uploads nothing from a free vault, and still links the render a Pro licence added", async () => {
		const r = renders();

		const parts = await createZoteroPass(on(r, { mayWriteBack: false, links: linked({ render: RECORDED }) }).deps).run(whole("md5-b"));

		expect(r.upload).not.toHaveBeenCalled();
		expect(parts.line).toContain("[render in Zotero](zotero://open-pdf/library/items/REN1)");
	});

	describe("what the user did to it in Zotero (ticket 16)", () => {
		it("keeps the file name the user gave it when replacing the bytes", async () => {
			const r = renders({ state: vi.fn(async () => live({ title: "My copy", filename: "mine.pdf" })) });

			await createZoteroPass(on(r, { links: linked({ render: RECORDED }) }).deps).run(whole("md5-b"));

			expect(r.upload).toHaveBeenCalledWith("REN1", { bytes: BYTES, md5: "md5-b", filename: "mine.pdf" }, "md5-a");
		});

		it("leaves a render with the user's annotations, says so, and stops asking", async () => {
			const r = renders({ state: vi.fn(async () => live({ annotated: true })) });
			const { deps, saved } = on(r, { links: linked({ render: RECORDED }) });

			const parts = await createZoteroPass(deps).run(whole("md5-b"));
			await createZoteroPass(deps).run(whole("md5-c"));

			expect(r.upload).not.toHaveBeenCalled();
			expect(r.state).toHaveBeenCalledTimes(1);
			expect(renderOf(saved())).toEqual({ ...RECORDED, theirs: "annotated" });
			expect(parts.line).toContain("· [render in Zotero](zotero://open-pdf/library/items/REN1) not updated: it has your annotations");
		});

		it("leaves a render whose file the user changed", async () => {
			const r = renders({ state: vi.fn(async () => live({ md5: "rotated" })) });
			const { deps, saved } = on(r, { links: linked({ render: RECORDED }) });

			const parts = await createZoteroPass(deps).run(whole("md5-b"));

			expect(r.upload).not.toHaveBeenCalled();
			expect(renderOf(saved())).toEqual({ ...RECORDED, theirs: "changed" });
			expect(parts.line).toContain("· [render in Zotero](zotero://open-pdf/library/items/REN1) not updated: you changed its file");
		});

		it("leaves a moved render where it is and puts no new one under the paper", async () => {
			const r = renders({ state: vi.fn(async () => live({ parentKey: "OTHER" })) });
			const { deps, saved } = on(r, { links: linked({ render: RECORDED }) });

			const parts = await createZoteroPass(deps).run(whole("md5-b"));

			expect(r.create).not.toHaveBeenCalled();
			expect(renderOf(saved())).toEqual({ ...RECORDED, theirs: "moved" });
			expect(parts.line).toContain("· render not updated: you moved it in Zotero");
		});

		it("never recreates a trashed render, and never trashes one itself", async () => {
			const trashAnnotation = vi.fn();
			const r = renders({ state: vi.fn(async () => null) });
			const { deps, saved } = on(r, { links: linked({ render: RECORDED }), client: client({ renders: r, trashAnnotation }) });

			const parts = await createZoteroPass(deps).run(whole("md5-b"));
			await createZoteroPass(deps).run(whole("md5-c"));

			expect(r.create).not.toHaveBeenCalled();
			expect(r.upload).not.toHaveBeenCalled();
			expect(trashAnnotation).not.toHaveBeenCalled();
			expect(renderOf(saved())).toEqual({ ...RECORDED, theirs: "trashed" });
			expect(parts.line).toContain("· render not added again: you deleted it in Zotero");
		});

		it("still says what the user did on a page note and with the switch off", async () => {
			const links = linked({ render: { ...RECORDED, theirs: "trashed" } });

			expect((await createZoteroPass(on(renders(), { links }).deps).run(unit())).line).toContain("render not added again: you deleted it in Zotero");
			expect((await createZoteroPass(on(renders(), { links, addRender: false }).deps).run(whole())).line).toContain("render not added again: you deleted it in Zotero");
		});

		it("starts over with a new render once the vault note was deleted", async () => {
			const r = renders({ create: vi.fn(async () => "REN2"), state: vi.fn(async () => null) });
			const { deps, saved } = on(r, { links: linked({ render: { ...RECORDED, theirs: "trashed" } }) });

			const parts = await createZoteroPass(deps).run({ ...whole("md5-b"), noteWasDeleted: true });

			expect(r.find).not.toHaveBeenCalled();
			expect(r.upload).toHaveBeenCalledWith("REN2", expect.anything(), null);
			expect(renderOf(saved())).toEqual({ key: "REN2", parentKey: ITEM_KEY, md5: "md5-b" });
			expect(parts.line).toContain("· [render in Zotero](zotero://open-pdf/library/items/REN2)");
		});

		// Found in the device check of 2026-10-30: annotated in Zotero, then trashed there. The record said
		// "annotated" and nothing ever looked again.
		it("starts over after a render the user annotated was trashed later, once the vault note was deleted", async () => {
			const r = renders({ create: vi.fn(async () => "REN2"), state: vi.fn(async () => null) });
			const { deps, saved } = on(r, { links: linked({ render: { ...RECORDED, theirs: "annotated" } }) });

			await createZoteroPass(deps).run({ ...whole("md5-a"), noteWasDeleted: true });

			expect(r.state).toHaveBeenCalledWith("REN1");
			expect(r.upload).toHaveBeenCalledWith("REN2", expect.anything(), null);
			expect(renderOf(saved())).toEqual({ key: "REN2", parentKey: ITEM_KEY, md5: "md5-a" });
		});

		// Their file is still under the paper: a second render beside it would undo what they did.
		it("keeps a render that still carries the user's annotations when the vault note was deleted", async () => {
			const r = renders({ state: vi.fn(async () => live({ annotated: true })) });
			const { deps, saved } = on(r, { links: linked({ render: { ...RECORDED, theirs: "annotated" } }) });

			const parts = await createZoteroPass(deps).run({ ...whole("md5-b"), noteWasDeleted: true });

			expect(r.create).not.toHaveBeenCalled();
			expect(r.upload).not.toHaveBeenCalled();
			expect(renderOf(saved())).toEqual({ ...RECORDED, theirs: "annotated" });
			expect(parts.line).toContain("not updated: it has your annotations");
		});

		it("re-finds its render under the paper when data.json lost the record, and creates none", async () => {
			const r = renders({ find: vi.fn(async () => live({ key: "REN9", md5: "older" })) });
			const { deps, saved } = on(r);

			await createZoteroPass(deps).run(whole("md5-b"));

			expect(r.find).toHaveBeenCalledWith(ITEM_KEY);
			expect(r.create).not.toHaveBeenCalled();
			expect(r.upload).toHaveBeenCalledWith("REN9", expect.objectContaining({ md5: "md5-b" }), "older");
			expect(renderOf(saved())).toEqual({ key: "REN9", parentKey: ITEM_KEY, md5: "md5-b" });
		});

		it("leaves a re-found render the user trashed in the trash", async () => {
			const r = renders({ find: vi.fn(async () => live({ key: "REN9", trashed: true })) });
			const { deps, saved } = on(r);

			await createZoteroPass(deps).run(whole());

			expect(r.create).not.toHaveBeenCalled();
			expect(r.upload).not.toHaveBeenCalled();
			expect(renderOf(saved())).toEqual({ key: "REN9", parentKey: ITEM_KEY, theirs: "trashed" });
		});

		it("records a re-found render that already holds these bytes without sending them", async () => {
			const r = renders({ find: vi.fn(async () => live({ key: "REN9" })) });
			const { deps, saved } = on(r);

			const parts = await createZoteroPass(deps).run(whole());

			expect(r.upload).not.toHaveBeenCalled();
			expect(renderOf(saved())).toEqual({ key: "REN9", parentKey: ITEM_KEY, md5: "md5-a" });
			expect(parts.line).toContain("[render in Zotero](zotero://open-pdf/library/items/REN9)");
		});
	});
});
