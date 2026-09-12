import { beforeEach, describe, expect, it, vi } from "vitest";
import { asApp, FakeApp, Platform, takeModals } from "../test-stubs/fake-obsidian";
import type { EventRef } from "obsidian";
import type { Entitlement } from "./licence-state";
import type { SyncIndexRow } from "./sync-engine";
import { DEFAULT_DATA, type TaggedSyncData } from "./settings-store";
import { type ZoteroAttachment, type ZoteroClient, ZoteroError, type ZoteroItem } from "./zotero-client";
import { linkFor, type StoredZoteroLinks, type ZoteroLink } from "./zotero-links";
import { SEND_COMMAND, type ZoteroHost } from "./zotero-plugin";
import { SEND_NEEDS_A_TAG, SEND_NEEDS_TRANSPORT, type SendDocument, type SendTransport } from "./zotero-send";
import {
	NO_COPY_OF_PDF,
	NO_PDF_IN_ZOTERO,
	SEND_NEEDS_A_CHOICE,
	sendTaggedPapers,
	severalPdfs,
	tagSendRoute,
	tagSendSkipNotice,
	tagSendTag,
	WAITING_FOR_A_SYNC_YOU_START,
} from "./zotero-tag-send";

const PRO: Entitlement = { tier: "pro", since: "2026-09-01T00:00:00.000Z", stale: false };
const NOW = "2026-09-12T09:00:00.000Z";

const PAPER: ZoteroItem = { key: "ITEM1", title: "Prompting", creator: "Smith", year: "2024", citationKey: null };
const SECOND: ZoteroItem = { key: "ITEM2", title: "Retrieval", creator: "Lee", year: "2025", citationKey: null };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: "ATT1", parentKey: "ITEM1", filename: "prompting.pdf", md5: null, title: "Full Text PDF", ...overrides };
}

function fakeClient(overrides: Partial<ZoteroClient> = {}): ZoteroClient {
	return {
		status: async () => ({ web: true, local: false, summary: "" }),
		libraryId: async () => 1234567,
		attachments: async () => [attachment()],
		attachment: async () => attachment(),
		parentItem: async () => PAPER,
		search: async () => [PAPER],
		itemsWithTag: async () => [PAPER],
		filePath: async () => null,
		fileBytes: async () => new Uint8Array([1, 2, 3]),
		ownAnnotations: async () => [],
		createAnnotations: vi.fn(async () => ({ keys: [], failures: [] })),
		patchAnnotation: vi.fn(async () => "written" as const),
		...overrides,
	} as ZoteroClient;
}

interface Harness {
	host: ZoteroHost;
	data: TaggedSyncData;
	client: ZoteroClient;
	sent: SendDocument[];
	reports: string[];
	saves: number;
}

function route(label: string, sent: SendDocument[]): SendTransport {
	return {
		label,
		putPdf: async (document) => {
			sent.push(document);
			return { docId: `doc-${sent.length}` };
		},
	};
}

function harness(
	options: {
		client?: ZoteroClient | null;
		tags?: Record<string, string>;
		cloud?: boolean;
		ssh?: boolean;
		data?: Partial<TaggedSyncData>;
		zotero?: Partial<TaggedSyncData["zotero"]>;
	} = {},
): Harness {
	const data: TaggedSyncData = {
		...structuredClone(DEFAULT_DATA),
		tagFolderMap: options.tags ?? { sync: "Target" },
		...options.data,
	};
	// The send tag is opt-in (empty by default); the harness opts in unless a test says otherwise.
	data.zotero = { ...data.zotero, apiKey: "key", sendTag: "to-remarkable", ...options.zotero };
	const sent: SendDocument[] = [];
	const reports: string[] = [];
	const client = options.client === undefined ? fakeClient() : options.client;
	const harnessed = { sent, reports, saves: 0, data, client } as Harness;
	harnessed.host = {
		app: asApp(new FakeApp()),
		data,
		entitlement: () => PRO,
		zoteroClient: () => client,
		save: async () => {
			harnessed.saves += 1;
		},
		now: () => new Date(NOW),
		sendRoutes: () => ({
			cloud: options.cloud === false ? null : route("reMarkable's cloud", sent),
			ssh: options.ssh === true ? route("your reMarkable", sent) : null,
		}),
		report: (_state, message) => reports.push(message),
		addCommand: () => undefined,
		registerEvent: (_ref: EventRef) => undefined,
	};
	return harnessed;
}

/** An index holding `docId` as a document the last sync saw. */
function indexWith(docId: string, status: "active" | "orphaned" = "active"): TaggedSyncData["syncIndex"] {
	const row: SyncIndexRow = { syncKey: `${docId}:sync`, docId, pageId: null, tag: "sync", entryHash: "h", pageHash: null, notePath: "Target/x.md", status, syncedAt: "2026-09-05T09:00:00.000Z" };
	return { rootHash: null, rows: { [`${docId}:sync`]: row } };
}

/** A link sent an hour before the harness's clock. */
const linked = (docId: string, attachmentKey = "ATT1", sentAt = "2026-09-12T08:00:00.000Z"): StoredZoteroLinks => ({
	[docId]: { attachmentKey, library: "user", sentAt, sentMd5: "old", annotations: {} },
});

beforeEach(() => {
	// `sentMd5` is hashed on this machine, and the hash is desktop-only like Send itself.
	Platform.isDesktop = true;
	takeModals();
});

describe("which route a tagged paper takes", () => {
	const cloud = route("cloud", []);
	const ssh = route("ssh", []);

	it("takes the cloud in any run", () => {
		expect(tagSendRoute({ cloud, ssh }, false)).toEqual({ kind: "use", transport: cloud });
		expect(tagSendRoute({ cloud, ssh: null }, false)).toEqual({ kind: "use", transport: cloud });
	});

	// The SSH route restarts the tablet's reading app. In a run nobody started, that is a page
	// closing under the reader for no reason they can see.
	it("takes the tablet only in a sync the user started", () => {
		expect(tagSendRoute({ cloud: null, ssh }, true)).toEqual({ kind: "use", transport: ssh });
		expect(tagSendRoute({ cloud: null, ssh }, false)).toEqual({ kind: "later" });
	});

	it("has no route for a vault with neither", () => {
		expect(tagSendRoute({ cloud: null, ssh: null }, true)).toEqual({ kind: "none" });
	});
});

describe("which sync tag a tagged paper gets", () => {
	it("is the one mapped tag, whatever the settings say", () => {
		expect(tagSendTag(["#papers"], "#gone", "#other")).toEqual({ kind: "use", tag: "#papers" });
	});

	it("is the setting's choice among several, then the last manual send's", () => {
		expect(tagSendTag(["#a", "#b"], "#b", "#a")).toEqual({ kind: "use", tag: "#b" });
		expect(tagSendTag(["#a", "#b"], null, "#a")).toEqual({ kind: "use", tag: "#a" });
		expect(tagSendTag(["#a", "#b"], "#gone", "#a")).toEqual({ kind: "use", tag: "#a" });
	});

	// A document sent under the wrong tag lands in the wrong folder for good.
	it("does not guess between several with no preference left", () => {
		expect(tagSendTag(["#a", "#b"], null, null)).toEqual({ kind: "none", reason: SEND_NEEDS_A_CHOICE });
		expect(tagSendTag(["#a", "#b"], "#gone", "#gone")).toEqual({ kind: "none", reason: SEND_NEEDS_A_CHOICE });
	});

	it("has nothing for a vault that maps no tag", () => {
		expect(tagSendTag([], "#a", "#a")).toEqual({ kind: "none", reason: SEND_NEEDS_A_TAG });
	});
});

describe("a paper tagged in Zotero, at the start of a sync", () => {
	it("goes to the tablet through the same pipeline as Send, and the link is recorded", async () => {
		const h = harness();
		const notices = await sendTaggedPapers(h.host, false);

		expect(h.sent).toEqual([{ visibleName: "Prompting", bytes: new Uint8Array([1, 2, 3]), folder: "Zotero", tag: "sync" }]);
		const link = linkFor(h.data.zoteroLinks, "doc-1") as ZoteroLink;
		expect(link.attachmentKey).toBe("ATT1");
		expect(link.sentAt).toBe(NOW);
		expect(link.sentMd5).toMatch(/^[0-9a-f]{32}$/);
		expect(h.saves).toBe(1);
		expect(h.reports).toEqual(['Tagged Sync: sending "Prompting" to reMarkable\'s cloud…']);
		expect(notices).toEqual(['1 Zotero paper is on your reMarkable, tagged sync: "Prompting".']);
	});

	it("names every paper it sent in one sentence", async () => {
		const h = harness({
			client: fakeClient({
				itemsWithTag: async () => [PAPER, SECOND],
				attachments: async () => [attachment(), attachment({ key: "ATT2", parentKey: "ITEM2", filename: "retrieval.pdf" })],
			}),
		});
		const notices = await sendTaggedPapers(h.host, false);

		expect(h.sent.map((document) => document.visibleName)).toEqual(["Prompting", "Retrieval"]);
		expect(notices).toEqual(['2 Zotero papers are on your reMarkable, tagged sync: "Prompting", "Retrieval".']);
	});

	// Nothing is written to Zotero by this step: the tag is the user's, and removing it would be the
	// first write to an item we only ever read.
	it("writes nothing into Zotero, and leaves the tag where it found it", async () => {
		const h = harness();
		await sendTaggedPapers(h.host, false);

		expect(h.client.createAnnotations).not.toHaveBeenCalled();
		expect(h.client.patchAnnotation).not.toHaveBeenCalled();
	});

	// Idempotence comes from the link store (§2.5), not from Zotero: the tag staying on a paper sent
	// last week is the normal state, not a complaint.
	it("skips a paper that is already on the tablet, in silence", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9"), syncIndex: indexWith("doc-9") } });
		const notices = await sendTaggedPapers(h.host, false);

		expect(h.sent).toEqual([]);
		expect(notices).toEqual([]);
		expect(h.data.zoteroLinks).toEqual(linked("doc-9"));
	});

	// The live bug of 2026-09-12: the sync right after a send listed a root the cloud had not updated
	// yet, so the document had no row, `lastSyncAt` had moved past `sentAt`, and every run sent again.
	it("does not send a paper again while no sync has listed its document yet", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9"), syncIndex: { rootHash: null, rows: {} }, lastSyncAt: "2026-09-12T08:30:00.000Z" } });
		const notices = await sendTaggedPapers(h.host, true);

		expect(h.sent).toEqual([]);
		expect(notices).toEqual([]);
		expect(h.data.zoteroLinks).toEqual(linked("doc-9"));
	});

	// Deleted on the tablet before any listing caught it: after a day the link is let go, and the
	// paper comes back. Without this it would stay "present" for good.
	it("sends a paper again whose document no listing has found in a day", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9", "ATT1", "2026-09-10T09:00:00.000Z"), syncIndex: { rootHash: null, rows: {} } } });
		await sendTaggedPapers(h.host, true);

		expect(h.sent).toHaveLength(1);
		expect(Object.keys(h.data.zoteroLinks)).toEqual(["doc-1"]);
	});

	it("sends a paper whose document has vanished from the tablet again, and replaces the mapping", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9"), syncIndex: indexWith("doc-9", "orphaned"), lastSyncAt: "2026-09-10T09:00:00.000Z" } });
		await sendTaggedPapers(h.host, false);

		expect(h.sent).toHaveLength(1);
		expect(Object.keys(h.data.zoteroLinks)).toEqual(["doc-1"]);
	});

	// The one question Send asks about a paper. Nobody is there to answer it, so it is a skip with
	// the command's name, and no picker is opened.
	it("skips a paper with two PDFs, names it, and opens no dialog", async () => {
		const h = harness({ client: fakeClient({ attachments: async () => [attachment(), attachment({ key: "ATT2", filename: "preprint.pdf" })] }) });
		const notices = await sendTaggedPapers(h.host, true);

		expect(h.sent).toEqual([]);
		expect(takeModals()).toEqual([]);
		expect(notices).toEqual([tagSendSkipNotice("Prompting", severalPdfs(2))]);
		expect(notices[0]).toContain(SEND_COMMAND);
	});

	it("skips a paper that has no PDF in Zotero", async () => {
		const h = harness({ client: fakeClient({ attachments: async () => [] }) });
		expect(await sendTaggedPapers(h.host, true)).toEqual([tagSendSkipNotice("Prompting", NO_PDF_IN_ZOTERO)]);
		expect(h.sent).toEqual([]);
	});

	// Send's third path opens a file dialog. This step may not, so the paper stays behind and is named.
	it("skips a paper Zotero has no copy of, rather than asking for the file", async () => {
		const h = harness({ client: fakeClient({ filePath: async () => null, fileBytes: async () => null }) });
		const notices = await sendTaggedPapers(h.host, true);

		expect(h.sent).toEqual([]);
		expect(takeModals()).toEqual([]);
		expect(notices).toEqual([tagSendSkipNotice("Prompting", NO_COPY_OF_PDF)]);
		expect(h.data.zoteroLinks).toEqual({});
	});

	it("keeps sending the others when one paper's upload fails", async () => {
		const sent: SendDocument[] = [];
		const failing: SendTransport = {
			label: "reMarkable's cloud",
			putPdf: async (document) => {
				if (document.visibleName === "Prompting") throw new Error("generation mismatch");
				sent.push(document);
				return { docId: "doc-ok" };
			},
		};
		const h = harness({
			client: fakeClient({
				itemsWithTag: async () => [PAPER, SECOND],
				attachments: async () => [attachment(), attachment({ key: "ATT2", parentKey: "ITEM2", filename: "retrieval.pdf" })],
			}),
		});
		h.host = { ...h.host, sendRoutes: () => ({ cloud: failing, ssh: null }) };
		const notices = await sendTaggedPapers(h.host, false);

		expect(sent.map((document) => document.visibleName)).toEqual(["Retrieval"]);
		expect(notices).toEqual(['1 Zotero paper is on your reMarkable, tagged sync: "Retrieval".', tagSendSkipNotice("Prompting", "generation mismatch")]);
	});
});

describe("when the whole step stands down", () => {
	// Opt-in: *Sync now* has meant "read the tablet, write the vault" since the plugin existed, and
	// a sync that puts something on the tablet is something the user has to have asked for.
	it("does nothing in a vault that has never named a send tag", async () => {
		const itemsWithTag = vi.fn(async () => [PAPER]);
		const h = harness({ client: fakeClient({ itemsWithTag }), zotero: { sendTag: DEFAULT_DATA.zotero.sendTag } });

		expect(DEFAULT_DATA.zotero.sendTag).toBe("");
		expect(await sendTaggedPapers(h.host, true)).toEqual([]);
		expect(itemsWithTag).not.toHaveBeenCalled();
	});

	it("does nothing, and asks Zotero nothing, with the send tag emptied", async () => {
		const itemsWithTag = vi.fn(async () => [PAPER]);
		const h = harness({ client: fakeClient({ itemsWithTag }), zotero: { sendTag: "  " } });

		expect(await sendTaggedPapers(h.host, true)).toEqual([]);
		expect(itemsWithTag).not.toHaveBeenCalled();
	});

	it("does nothing for a vault with no Zotero client", async () => {
		const h = harness({ client: null });
		expect(await sendTaggedPapers(h.host, true)).toEqual([]);
	});

	// A vault with the tag on nothing gets no notice about routes or tags it has not set up.
	it("says nothing when no paper carries the tag, whatever else is missing", async () => {
		const h = harness({ client: fakeClient({ itemsWithTag: async () => [] }), tags: {}, cloud: false });
		expect(await sendTaggedPapers(h.host, true)).toEqual([]);
	});

	it("asks Zotero for the tag the setting names", async () => {
		const itemsWithTag = vi.fn(async () => []);
		const h = harness({ client: fakeClient({ itemsWithTag }), zotero: { sendTag: "lesen" } });
		await sendTaggedPapers(h.host, true);

		expect(itemsWithTag).toHaveBeenCalledWith("lesen");
	});

	it("sends nothing from a vault that maps no tag, and says why", async () => {
		const h = harness({ tags: {} });
		const notices = await sendTaggedPapers(h.host, true);

		expect(h.sent).toEqual([]);
		expect(notices).toEqual([`Zotero: 1 paper tagged to-remarkable not sent. ${SEND_NEEDS_A_TAG}`]);
	});

	it("uses the setting's sync tag where the vault maps several", async () => {
		const h = harness({ tags: { "#a": "A", "#b": "B" }, zotero: { sendSyncTag: "#b", lastTag: "#a" } });
		await sendTaggedPapers(h.host, true);

		expect(h.sent[0].tag).toBe("#b");
	});

	it("falls back to the last manual send's tag until the setting is made", async () => {
		const h = harness({ tags: { "#a": "A", "#b": "B" }, zotero: { lastTag: "#a" } });
		await sendTaggedPapers(h.host, true);

		expect(h.sent[0].tag).toBe("#a");
	});

	it("sends nothing between several tags with no preference, and points at the setting", async () => {
		const h = harness({ tags: { "#a": "A", "#b": "B" } });
		const notices = await sendTaggedPapers(h.host, true);

		expect(h.sent).toEqual([]);
		expect(notices).toEqual([`Zotero: 1 paper tagged to-remarkable not sent. ${SEND_NEEDS_A_CHOICE}`]);
	});

	it("sends nothing from a vault with no route to a tablet, and says so", async () => {
		const h = harness({ cloud: false });
		expect(await sendTaggedPapers(h.host, true)).toEqual([`Zotero: 1 paper tagged to-remarkable not sent. ${SEND_NEEDS_TRANSPORT}`]);
	});

	it("holds an SSH-only send for a sync the user starts, and names the paper", async () => {
		const h = harness({ cloud: false, ssh: true });

		expect(await sendTaggedPapers(h.host, false)).toEqual([tagSendSkipNotice("Prompting", WAITING_FOR_A_SYNC_YOU_START)]);
		expect(h.sent).toEqual([]);

		expect(await sendTaggedPapers(h.host, true)).toEqual(['1 Zotero paper is on your reMarkable, tagged sync: "Prompting".']);
		expect(h.reports.at(-1)).toBe('Tagged Sync: sending "Prompting" to your reMarkable…');
	});

	// The §3.4.2 wording: which document, why, and that the next sync tries again.
	it("says in Zotero's own words why nothing was sent when Zotero does not answer", async () => {
		const h = harness({
			client: fakeClient({
				itemsWithTag: async () => {
					throw new ZoteroError("unauthorized", "401");
				},
			}),
		});

		expect(await sendTaggedPapers(h.host, true)).toEqual(["Zotero: papers tagged to-remarkable were not sent — Zotero rejected the API key. The next sync tries again."]);
		expect(h.sent).toEqual([]);
	});
});
