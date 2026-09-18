import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestHighlight, DigestPage } from "./digest-builder";
import { type AnnotationsCreated, type NewAnnotation, type ZoteroAnnotation, type ZoteroAttachment, ZoteroError, type ZoteroClient, type ZoteroItem, type ZoteroLibrary } from "./zotero-client";
import type { StoredZoteroLinks, ZoteroLink } from "./zotero-links";
import type { VaultNoteKeys } from "./zotero-note";
import { createZoteroPass, LIBRARY_OFF, type ZoteroPassDeps, type ZoteroQuestion, type ZoteroUnit, ZOTERO_GONE_LINE, ZOTERO_LIBRARY_OFF_LINE, zoteroPartialNotice, zoteroSkipNotice, zoteroSkipReason } from "./zotero-sync";

const ATTACHMENT_KEY = "ATT1";
const ITEM_KEY = "ITEM1";
const MD5 = "0f0e3fbc4e2bd4bd16b2ab4a45f4e8a5";

const ITEM: ZoteroItem = { key: ITEM_KEY, library: "user", title: "Best Practices für Prompting", creator: "Smith", year: "2024", citationKey: "smith2024prompting" };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: ATTACHMENT_KEY, library: "user", parentKey: ITEM_KEY, filename: "prompting.pdf", md5: MD5, title: "Full Text PDF", ...overrides };
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

		expect(parts.notices).toEqual(['Zotero: 0 of 1 highlights written for "Best Practices für Prompting", retry on next sync.']);
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
		expect(zoteroPartialNotice("Paper", 3, 7)).toBe('Zotero: 3 of 7 highlights written for "Paper", retry on next sync.');
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
