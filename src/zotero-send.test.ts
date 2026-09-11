import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "../test-stubs/fake-obsidian";
import type { ZoteroAttachment, ZoteroClient, ZoteroItem } from "./zotero-client";
import { linkFor, type StoredZoteroLinks } from "./zotero-links";
import {
	documentsOnTablet,
	pdfChoice,
	sendBytes,
	sendState,
	sendToTablet,
	sendTransport,
	tabletName,
	tagChoice,
	type SendDeps,
	type SendDocument,
	type SendTransport,
} from "./zotero-send";

const ITEM: ZoteroItem = { key: "ITEM1", title: "Best Practices für Prompting", creator: "Smith", year: "2024", citationKey: null };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: "ATT1", parentKey: "ITEM1", filename: "paper.pdf", md5: "2de21c18668a0faba572b4c7f7ecd1f5", title: "Full Text PDF", ...overrides };
}

describe("what the document is called on the tablet", () => {
	// The attachment's own title is "Full Text PDF" for most of a library, which is what every second
	// document would then be called in the file list.
	it("is the item's title, not the attachment's", () => {
		expect(tabletName(ITEM, attachment())).toBe("Best Practices für Prompting");
	});

	it("falls back to the attachment's filename, without the extension", () => {
		expect(tabletName(null, attachment())).toBe("paper");
	});

	it("falls back to the attachment key where there is no name at all", () => {
		expect(tabletName(null, attachment({ filename: null }))).toBe("ATT1");
		expect(tabletName({ ...ITEM, title: "   " }, attachment({ filename: "" }))).toBe("ATT1");
	});

	// The two characters the reMarkable's own file list will not take.
	it("replaces the characters a tablet filename cannot hold", () => {
		expect(tabletName({ ...ITEM, title: "Prompting: a/b testing" }, attachment())).toBe("Prompting- a-b testing");
	});

	it("cuts a very long title at 120 characters", () => {
		const long = "x".repeat(200);
		expect(tabletName({ ...ITEM, title: long }, attachment())).toHaveLength(120);
	});

	// A cut that lands inside a surrogate pair leaves half an emoji in the tablet's file list.
	it("cuts between characters, never through one", () => {
		const name = tabletName({ ...ITEM, title: "😀".repeat(200) }, attachment());
		expect([...name]).toHaveLength(120);
		expect(name).not.toContain("�");
	});

	// §2.4: "No key suffix." The tablet's file list is the reader's; what makes the document findable
	// again is the link in `data.json`.
	it("carries no key, no marker and nothing else of ours", () => {
		expect(tabletName(ITEM, attachment())).not.toContain("ATT1");
	});
});

describe("which PDF of an item is meant", () => {
	it("is the only one, where there is only one", () => {
		expect(pdfChoice([attachment()], "ITEM1")).toEqual({ kind: "use", attachment: attachment() });
	});

	// A preprint beside the published version. The one the reader annotates is the one the highlights
	// go back onto, and the two do not have the same pages.
	it("is a question where an item has two", () => {
		const second = attachment({ key: "ATT2", filename: "preprint.pdf" });
		expect(pdfChoice([attachment(), second], "ITEM1")).toEqual({ kind: "ask", options: [attachment(), second] });
	});

	it("is nothing for an item whose attachments are all somebody else's", () => {
		expect(pdfChoice([attachment({ parentKey: "OTHER" })], "ITEM1")).toEqual({ kind: "none" });
		expect(pdfChoice([], "ITEM1")).toEqual({ kind: "none" });
	});
});

describe("which tag the document is sent with", () => {
	it("asks nothing where the vault maps exactly one tag", () => {
		expect(tagChoice(["#papers"], null)).toEqual({ kind: "use", tag: "#papers" });
	});

	it("asks, and offers last time's answer first", () => {
		expect(tagChoice(["#read", "#papers"], "#read")).toEqual({ kind: "ask", options: ["#papers", "#read"], preferred: "#read" });
	});

	// A tag the user has since unmapped routes nowhere: offering it first would send the document with
	// a tag that brings it back to no folder at all.
	it("forgets last time's answer once that tag is no longer mapped", () => {
		expect(tagChoice(["#papers"], "#gone")).toEqual({ kind: "use", tag: "#papers" });
		expect(tagChoice(["#papers", "#read"], "#gone")).toEqual({ kind: "ask", options: ["#papers", "#read"], preferred: null });
	});

	// Not in the spec, and the one refusal this module adds: a document sent without a sync tag is one
	// the plugin never looks at again.
	it("has nothing to offer a vault that maps no tags at all", () => {
		expect(tagChoice([], "#read")).toEqual({ kind: "none" });
	});
});

describe("which route the send takes", () => {
	const route = (label: string): SendTransport => ({ label, putPdf: async () => ({ docId: "doc" }) });

	// Not about speed: the SSH route restarts the tablet's reading app, which closes whatever the
	// reader has open. The cloud costs them nothing.
	it("is the cloud wherever there is one, even with a paired tablet", () => {
		expect(sendTransport({ cloud: route("cloud"), ssh: route("ssh") })?.label).toBe("cloud");
	});

	it("is the tablet for a vault that has only that", () => {
		expect(sendTransport({ cloud: null, ssh: route("ssh") })?.label).toBe("ssh");
	});

	it("is nothing for a vault with neither", () => {
		expect(sendTransport({ cloud: null, ssh: null })).toBeNull();
	});
});

describe("what this attachment already is on the tablet", () => {
	const link = (attachmentKey: string) => ({ attachmentKey, library: "user" as const, annotations: {} });
	const links: StoredZoteroLinks = { "doc-1": link("ATT1"), "doc-2": link("ATT2"), "doc-3": link("ATT1") };

	it("is nothing at all for an attachment nobody has sent", () => {
		expect(sendState(links, "ATT9", new Set(["doc-1"]))).toEqual({ present: [], vanished: [] });
	});

	// §2.5: the user is asked, and *Send another copy* is a second document with its own mapping.
	it("names the document that is still there, so the user can be asked", () => {
		expect(sendState(links, "ATT1", new Set(["doc-1", "doc-2"]))).toEqual({ present: ["doc-1"], vanished: ["doc-3"] });
	});

	// A document deleted on the tablet leaves a link pointing at nothing, and a send is the only moment
	// anything is in a position to notice.
	it("reports a mapping whose document is gone as one to replace", () => {
		expect(sendState(links, "ATT1", new Set())).toEqual({ present: [], vanished: ["doc-1", "doc-3"] });
	});

	// An entry a newer build wrote, which this one cannot read, is not this attachment's -- and it is
	// left exactly where it is (see `zotero-links.ts`).
	it("passes over an entry this build cannot read", () => {
		expect(sendState({ "doc-x": "not a link" }, "ATT1", new Set(["doc-x"]))).toEqual({ present: [], vanished: [] });
	});
});

describe("where the PDF's bytes come from", () => {
	const client = (overrides: Partial<ZoteroClient> = {}) =>
		({ filePath: async () => null, fileBytes: async () => null, ...overrides }) as unknown as ZoteroClient;

	function deps(overrides: Partial<SendDeps> = {}): SendDeps {
		return {
			client: client(),
			transport: { label: "cloud", putPdf: async () => ({ docId: "doc-1" }) },
			readFile: async () => null,
			pickFile: async () => null,
			now: () => new Date("2026-09-11T10:00:00.000Z"),
			...overrides,
		};
	}

	// The library is already on this disk: a read beats a round trip, and it works for a vault whose
	// storage was never synced to zotero.org at all.
	it("is the file on this machine, where Zotero knows where that is", () => {
		const local = new Uint8Array([1, 2, 3]);
		const read = vi.fn(async () => local);
		return expect(
			sendBytes(deps({ client: client({ filePath: async () => "/Zotero/storage/ABC/paper.pdf" }), readFile: read }), attachment()),
		).resolves.toEqual({ bytes: local, source: "file" });
	});

	// A path Zotero still remembers for a file that has been moved or deleted since. The download is
	// the answer, not an error.
	it("is the download where the path Zotero gave no longer holds a file", async () => {
		const downloaded = new Uint8Array([4, 5]);
		const result = await sendBytes(
			deps({ client: client({ filePath: async () => "/gone/paper.pdf", fileBytes: async () => downloaded }) }),
			attachment(),
		);
		expect(result).toEqual({ bytes: downloaded, source: "download" });
	});

	// A linked file, or a library whose storage is not synced: Zotero knows of the PDF and has no copy
	// to hand over. The dialog is the last resort because it is the only one that costs attention.
	it("is the file dialog where neither connection can hand the PDF over", async () => {
		const picked = new Uint8Array([6]);
		expect(await sendBytes(deps({ pickFile: async () => picked }), attachment())).toEqual({ bytes: picked, source: "picked" });
	});

	it("is nothing at all when the user closes that dialog", async () => {
		expect(await sendBytes(deps(), attachment())).toBeNull();
	});
});

describe("sending", () => {
	beforeEach(() => {
		Platform.isDesktop = true;
	});

	const bytes = new Uint8Array([37, 80, 68, 70]);

	function deps(transport: SendTransport, overrides: Partial<SendDeps> = {}): SendDeps {
		return {
			client: { filePath: async () => null, fileBytes: async () => bytes } as unknown as ZoteroClient,
			transport,
			readFile: async () => null,
			pickFile: async () => null,
			now: () => new Date("2026-09-11T10:00:00.000Z"),
			...overrides,
		};
	}

	it("hands the transport the name, the folder and the tag", async () => {
		const sent: SendDocument[] = [];
		const transport: SendTransport = {
			label: "cloud",
			putPdf: async (document) => {
				sent.push(document);
				return { docId: "doc-1" };
			},
		};

		await sendToTablet(deps(transport), { attachment: attachment(), item: ITEM, folder: "Zotero", tag: "#papers", links: {} });

		expect(sent).toEqual([{ visibleName: "Best Practices für Prompting", bytes, folder: "Zotero", tag: "#papers" }]);
	});

	// The link is the claim "this document on the tablet is that Zotero item", and `sentMd5` is the
	// hash of the bytes that actually went up -- Zotero's own `md5` is null for a linked file and
	// describes its copy rather than the tablet's.
	it("writes the link only after the upload, with what was sent and when", async () => {
		const result = await sendToTablet(deps({ label: "cloud", putPdf: async () => ({ docId: "doc-1" }) }), {
			attachment: attachment(),
			item: ITEM,
			folder: "Zotero",
			tag: "#papers",
			links: {},
		});

		expect(linkFor(result?.links ?? {}, "doc-1")).toEqual({
			attachmentKey: "ATT1",
			library: "user",
			sentAt: "2026-09-11T10:00:00.000Z",
			sentMd5: "bfa4b10a76324b166cfdad5e02a63730",
			annotations: {},
		});
	});

	it("writes no link at all when the upload throws", async () => {
		const transport: SendTransport = {
			label: "cloud",
			putPdf: async () => {
				throw new Error("the cloud said no");
			},
		};
		await expect(sendToTablet(deps(transport), { attachment: attachment(), item: ITEM, folder: "Zotero", tag: "#papers", links: {} })).rejects.toThrow(
			"the cloud said no",
		);
	});

	it("does nothing at all when the user closes the file dialog", async () => {
		const putPdf = vi.fn();
		const never = deps({ label: "cloud", putPdf }, { client: { filePath: async () => null, fileBytes: async () => null } as unknown as ZoteroClient });
		expect(await sendToTablet(never, { attachment: attachment(), item: ITEM, folder: "Zotero", tag: "#papers", links: {} })).toBeNull();
		expect(putPdf).not.toHaveBeenCalled();
	});

	// §2.5, the vanished branch: the stale links go and exactly one is left, whatever the user had
	// deleted on the tablet since.
	it("replaces the mappings of documents that are no longer on the tablet", async () => {
		const links: StoredZoteroLinks = {
			"old-1": { attachmentKey: "ATT1", library: "user", annotations: {} },
			"old-2": { attachmentKey: "ATT1", library: "user", annotations: {} },
			keep: { attachmentKey: "ATT9", library: "user", annotations: {} },
		};

		const result = await sendToTablet(deps({ label: "cloud", putPdf: async () => ({ docId: "doc-1" }) }), {
			attachment: attachment(),
			item: ITEM,
			folder: "Zotero",
			tag: "#papers",
			links,
			replacing: ["old-1", "old-2"],
		});

		expect(Object.keys(result?.links ?? {}).sort()).toEqual(["doc-1", "keep"]);
	});

	// *Send another copy* (§2.5): a second document with its own mapping, and the first one keeps
	// everything it has -- including the annotations already written back for it.
	it("leaves the first copy's mapping alone when a second is sent", async () => {
		const links: StoredZoteroLinks = { "doc-1": { attachmentKey: "ATT1", library: "user", annotations: { "hl-1": { key: "ANN1", written: {} } } } };

		const result = await sendToTablet(deps({ label: "cloud", putPdf: async () => ({ docId: "doc-2" }) }), {
			attachment: attachment(),
			item: ITEM,
			folder: "Zotero",
			tag: "#papers",
			links,
		});

		expect(linkFor(result?.links ?? {}, "doc-1")?.annotations["hl-1"]?.key).toBe("ANN1");
		expect(linkFor(result?.links ?? {}, "doc-2")?.attachmentKey).toBe("ATT1");
	});
});

describe("what is still on the tablet", () => {
	const link = { attachmentKey: "ATT1", library: "user" as const, annotations: {} };

	it("counts a document the last sync saw", () => {
		const rows = [{ docId: "doc-1", status: "active" as const }];

		expect([...documentsOnTablet(rows, { "doc-1": link }, "2026-09-11T09:00:00.000Z")]).toEqual(["doc-1"]);
	});

	it("does not count one whose row was orphaned -- that is a document that left the device", () => {
		const rows = [{ docId: "doc-1", status: "orphaned" as const }];

		expect(documentsOnTablet(rows, { "doc-1": link }, "2026-09-11T09:00:00.000Z").has("doc-1")).toBe(false);
	});

	// Otherwise a second Send before the first has ever synced reads as "it vanished": the link would
	// be dropped, and two documents on the tablet would share one mapping between them.
	it("counts one sent since the last sync, which has had no chance to appear yet", () => {
		const sent = { ...link, sentAt: "2026-09-11T10:00:00.000Z" };

		expect(documentsOnTablet([], { "doc-1": sent }, "2026-09-11T09:00:00.000Z").has("doc-1")).toBe(true);
	});

	it("counts one sent into a vault that has never completed a sync at all", () => {
		const sent = { ...link, sentAt: "2026-09-11T10:00:00.000Z" };

		expect(documentsOnTablet([], { "doc-1": sent }, null).has("doc-1")).toBe(true);
	});

	it("does not count one that was sent, synced past, and never turned up", () => {
		const sent = { ...link, sentAt: "2026-09-01T10:00:00.000Z" };

		expect(documentsOnTablet([], { "doc-1": sent }, "2026-09-11T09:00:00.000Z").has("doc-1")).toBe(false);
	});
});
