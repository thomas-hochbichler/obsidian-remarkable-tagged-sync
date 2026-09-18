import { beforeEach, describe, expect, it, vi } from "vitest";
import { asApp, FakeApp, Platform, takeModals } from "../test-stubs/fake-obsidian";
import type { EventRef } from "obsidian";
import type { Entitlement } from "./licence-state";
import { DEFAULT_DATA, type TaggedSyncData } from "./settings-store";
import { type ZoteroAttachment, type ZoteroClient, ZoteroError, type ZoteroItem } from "./zotero-client";
import { linkFor, type StoredZoteroLinks, type ZoteroLink } from "./zotero-links";
import { SEND_COMMAND, type ZoteroHost } from "./zotero-plugin";
import { zoteroSkipReason } from "./zotero-sync";
import { SEND_NEEDS_TRANSPORT, type SendDocument, type SendTransport } from "./zotero-send";
import { NO_COPY_OF_PDF, NO_PDF_IN_ZOTERO, NO_SEND_TAG, nothingToSend, sendTaggedPapers, severalPdfs, tagSendRoute, tagSendSkipNotice } from "./zotero-tag-send";

const PRO: Entitlement = { tier: "pro", since: "2026-09-01T00:00:00.000Z", stale: false };
const NOW = "2026-09-12T09:00:00.000Z";

const PAPER: ZoteroItem = { key: "ITEM1", library: "user", title: "Prompting", creator: "Smith", year: "2024", citationKey: null };
const SECOND: ZoteroItem = { key: "ITEM2", library: "user", title: "Retrieval", creator: "Lee", year: "2025", citationKey: null };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: "ATT1", library: "user", parentKey: "ITEM1", filename: "prompting.pdf", md5: null, title: "Full Text PDF", ...overrides };
}

function fakeClient(overrides: Partial<ZoteroClient> = {}): ZoteroClient {
	return {
		status: async () => ({ web: true, local: false, summary: "" }),
		libraries: ["user"],
		libraryName: () => "your library",
		groups: async () => [],
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
	data.zotero = { ...data.zotero, useWeb: true, apiKey: "key", sendTag: "to-remarkable", ...options.zotero };
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

/** A link sent an hour before the harness's clock, no listing has found yet unless `listing` says so. */
const linked = (docId: string, attachmentKey = "ATT1", sentAt = "2026-09-12T08:00:00.000Z", listing: { seenAt?: string; goneAt?: string } = {}): StoredZoteroLinks => ({
	[docId]: { attachmentKey, library: "user", sentAt, sentMd5: "old", annotations: {}, ...listing },
});
/** A link whose document the last listing found. */
const SEEN = { seenAt: "2026-09-12T08:30:00.000Z" };
/** A link whose document a listing found once and the last one missed: deleted on the tablet. */
const GONE = { seenAt: "2026-09-11T09:00:00.000Z", goneAt: "2026-09-12T08:30:00.000Z" };

beforeEach(() => {
	// `sentMd5` is hashed on this machine, and the hash is desktop-only like Send itself.
	Platform.isDesktop = true;
	takeModals();
});

describe("which route a tagged paper takes", () => {
	const cloud = route("cloud", []);
	const ssh = route("ssh", []);

	// Same order as Send (§2.4): the cloud when it is connected, the tablet over SSH otherwise. The
	// command always has a person at the keyboard, so the SSH restart is never sprung on a reader.
	it("takes the cloud first, then the tablet over SSH", () => {
		expect(tagSendRoute({ cloud, ssh })).toBe(cloud);
		expect(tagSendRoute({ cloud, ssh: null })).toBe(cloud);
		expect(tagSendRoute({ cloud: null, ssh })).toBe(ssh);
	});

	it("has no route for a vault with neither", () => {
		expect(tagSendRoute({ cloud: null, ssh: null })).toBeNull();
	});
});

describe("a paper tagged in Zotero, when the command runs", () => {
	// No sync tag on the document (decided 2026-09-13), like Send: a tag put on here would be one the
	// user never chose. The notice says what is left to do instead.
	it("goes to the tablet through the same pipeline as Send, untagged, and the link is recorded", async () => {
		const h = harness();
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(h.sent).toEqual([{ visibleName: "Prompting", bytes: new Uint8Array([1, 2, 3]), folder: "Zotero" }]);
		const link = linkFor(h.data.zoteroLinks, "doc-1") as ZoteroLink;
		expect(link.attachmentKey).toBe("ATT1");
		expect(link.sentAt).toBe(NOW);
		expect(link.sentMd5).toMatch(/^[0-9a-f]{32}$/);
		expect(h.saves).toBe(1);
		expect(h.reports).toEqual(['Tagged Sync: sending "Prompting" to reMarkable\'s cloud…']);
		expect(notices).toEqual(['Sent 1 Zotero paper to your reMarkable: "Prompting". It has no sync tag yet — add one on the tablet when you want it back.']);
	});

	// Ticket 26: a paper tagged in a group is fetched from the group and linked into it.
	it("sends a paper tagged in a group from the group", async () => {
		const GROUP = { group: 4711 };
		const fileBytes = vi.fn(async () => new Uint8Array([1]));
		const h = harness({ client: fakeClient({ itemsWithTag: async () => [{ ...PAPER, library: GROUP }], attachments: async () => [attachment(), attachment({ library: GROUP })], fileBytes }) });
		await sendTaggedPapers(h.host, h.client);

		expect(fileBytes).toHaveBeenCalledWith("ATT1", GROUP);
		expect(h.sent).toHaveLength(1);
		expect(linkFor(h.data.zoteroLinks, "doc-1")?.library).toEqual(GROUP);
	});

	it("names every paper it sent in one sentence", async () => {
		const h = harness({
			client: fakeClient({
				itemsWithTag: async () => [PAPER, SECOND],
				attachments: async () => [attachment(), attachment({ key: "ATT2", parentKey: "ITEM2", filename: "retrieval.pdf" })],
			}),
		});
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(h.sent.map((document) => document.visibleName)).toEqual(["Prompting", "Retrieval"]);
		expect(notices).toEqual(['Sent 2 Zotero papers to your reMarkable: "Prompting", "Retrieval". They have no sync tag yet — add one on the tablet when you want them back.']);
	});

	// Nothing is written to Zotero by this step: the tag is the user's, and removing it would be the
	// first write to an item we only ever read.
	it("writes nothing into Zotero, and leaves the tag where it found it", async () => {
		const h = harness();
		await sendTaggedPapers(h.host, h.client);

		expect(h.client.createAnnotations).not.toHaveBeenCalled();
		expect(h.client.patchAnnotation).not.toHaveBeenCalled();
	});

	// Idempotence comes from the link store (§2.5), not from Zotero: the tag staying on a paper sent
	// last week is the normal state, not a complaint.
	it("skips a paper that is already on the tablet, and says so once", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9", "ATT1", undefined, SEEN) } });
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(h.sent).toEqual([]);
		expect(notices).toEqual([nothingToSend(1, "to-remarkable")]);
		expect(notices).toEqual(["Zotero: the paper tagged to-remarkable is on your reMarkable already."]);
		expect(h.data.zoteroLinks).toEqual(linked("doc-9", "ATT1", undefined, SEEN));
	});

	it("counts the papers that are on the tablet already, in one sentence", async () => {
		const h = harness({
			client: fakeClient({ itemsWithTag: async () => [PAPER, SECOND], attachments: async () => [attachment(), attachment({ key: "ATT2", parentKey: "ITEM2" })] }),
			data: { zoteroLinks: { ...linked("doc-8", "ATT1", undefined, SEEN), ...linked("doc-9", "ATT2", undefined, SEEN) } },
		});

		expect(await sendTaggedPapers(h.host, h.client)).toEqual(["Zotero: all 2 papers tagged to-remarkable are on your reMarkable already."]);
		expect(h.sent).toEqual([]);
	});

	// The live bug of 2026-09-12: the sync right after a send listed a root the cloud had not updated
	// yet, so no listing had the document, `lastSyncAt` had moved past `sentAt`, and every run sent again.
	it("does not send a paper again while no sync has listed its document yet", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9"), lastSyncAt: "2026-09-12T08:30:00.000Z" } });
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(h.sent).toEqual([]);
		expect(notices).toEqual([nothingToSend(1, "to-remarkable")]);
		expect(h.data.zoteroLinks).toEqual(linked("doc-9"));
	});

	// Deleted on the tablet before any listing caught it: after a day the link is let go, and the
	// paper comes back. Without this it would stay "present" for good.
	it("sends a paper again whose document no listing has found in a day", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9", "ATT1", "2026-09-10T09:00:00.000Z") } });
		await sendTaggedPapers(h.host, h.client);

		expect(h.sent).toHaveLength(1);
		expect(Object.keys(h.data.zoteroLinks)).toEqual(["doc-1"]);
	});

	// Deleted on the tablet: the last listing missed a document an earlier one had found. Back on the
	// next sync, not a day later (asked in the desk test of 2026-09-13).
	it("sends a paper whose document has vanished from the tablet again, and replaces the mapping", async () => {
		const h = harness({ data: { zoteroLinks: linked("doc-9", "ATT1", undefined, GONE), lastSyncAt: "2026-09-10T09:00:00.000Z" } });
		await sendTaggedPapers(h.host, h.client);

		expect(h.sent).toHaveLength(1);
		expect(Object.keys(h.data.zoteroLinks)).toEqual(["doc-1"]);
	});

	// The one question Send asks about a paper. Nobody is there to answer it, so it is a skip with
	// the command's name, and no picker is opened.
	it("skips a paper with two PDFs, names it, and opens no dialog", async () => {
		const h = harness({ client: fakeClient({ attachments: async () => [attachment(), attachment({ key: "ATT2", filename: "preprint.pdf" })] }) });
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(h.sent).toEqual([]);
		expect(takeModals()).toEqual([]);
		expect(notices).toEqual([tagSendSkipNotice("Prompting", severalPdfs(2))]);
		expect(notices[0]).toContain(SEND_COMMAND);
	});

	it("skips a paper that has no PDF in Zotero", async () => {
		const h = harness({ client: fakeClient({ attachments: async () => [] }) });
		expect(await sendTaggedPapers(h.host, h.client)).toEqual([tagSendSkipNotice("Prompting", NO_PDF_IN_ZOTERO)]);
		expect(h.sent).toEqual([]);
	});

	// Send's third path opens a file dialog. This step may not, so the paper stays behind and is named.
	it("skips a paper Zotero has no copy of, rather than asking for the file", async () => {
		const h = harness({ client: fakeClient({ filePath: async () => null, fileBytes: async () => null }) });
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(h.sent).toEqual([]);
		expect(takeModals()).toEqual([]);
		expect(notices).toEqual([tagSendSkipNotice("Prompting", NO_COPY_OF_PDF)]);
		expect(h.data.zoteroLinks).toEqual({});
	});

	it("counts the papers in the notice when the whole command stands down", async () => {
		const h = harness({ cloud: false, client: fakeClient({ itemsWithTag: async () => [PAPER, SECOND] }) });

		expect(await sendTaggedPapers(h.host, h.client)).toEqual([`Zotero: 2 papers tagged to-remarkable not sent. ${SEND_NEEDS_TRANSPORT}`]);
	});

	// The same fallbacks as Send: the folder setting left blank means the default folder, and a paper
	// with no title is named by its key -- in the notice as well as on the tablet.
	it("falls back to the default folder and the item key where the setting and the title are blank", async () => {
		const h = harness({
			zotero: { folder: "   " },
			client: fakeClient({
				itemsWithTag: async () => [{ ...PAPER, title: "  " }, SECOND],
				attachments: async () => [attachment(), attachment({ key: "ATT1B" }), attachment({ key: "ATT2", parentKey: "ITEM2", filename: "retrieval.pdf" })],
			}),
		});
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(h.sent.map((document) => document.folder)).toEqual(["Zotero"]);
		expect(notices).toContain(tagSendSkipNotice("ITEM1", severalPdfs(2)));
	});

	it("names a paper whose upload failed with something that is not an Error", async () => {
		const h = harness();
		h.host = {
			...h.host,
			sendRoutes: () => ({
				cloud: {
					label: "reMarkable's cloud",
					putPdf: async () => {
						throw "the socket closed";
					},
				},
				ssh: null,
			}),
		};

		expect(await sendTaggedPapers(h.host, h.client)).toEqual([tagSendSkipNotice("Prompting", "the socket closed")]);
	});

	// Whatever went up before Zotero stopped answering stays sent and said; the rest waits for the next press.
	it("says the command did not finish when Zotero fails after the listing", async () => {
		const down = new ZoteroError("unreachable", "gone");
		const h = harness({
			client: fakeClient({
				attachments: async () => {
					throw down;
				},
			}),
		});

		expect(await sendTaggedPapers(h.host, h.client)).toEqual([`Zotero: papers tagged to-remarkable were not all sent — ${zoteroSkipReason(down)}.`]);
		expect(h.sent).toEqual([]);
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
		const notices = await sendTaggedPapers(h.host, h.client);

		expect(sent.map((document) => document.visibleName)).toEqual(["Retrieval"]);
		expect(notices).toEqual(['Sent 1 Zotero paper to your reMarkable: "Retrieval". It has no sync tag yet — add one on the tablet when you want it back.', tagSendSkipNotice("Prompting", "generation mismatch")]);
	});
});

describe("when the whole command stands down", () => {
	// The setting is prefilled, so an empty one is the user's doing; the command says where to name one
	// rather than looking for nothing and saying nothing.
	it("says where to name a tag when the setting was emptied, and asks Zotero nothing", async () => {
		const itemsWithTag = vi.fn(async () => [PAPER]);
		const h = harness({ client: fakeClient({ itemsWithTag }), zotero: { sendTag: "  " } });

		expect(await sendTaggedPapers(h.host, h.client)).toEqual([NO_SEND_TAG]);
		expect(itemsWithTag).not.toHaveBeenCalled();
	});

	it("starts with the tag the setting suggests", () => {
		expect(DEFAULT_DATA.zotero.sendTag).toBe("to-remarkable");
	});

	// Somebody pressed the command: an empty library answer is a sentence, not silence, and it comes
	// before any complaint about routes.
	it("says that no paper carries the tag, before anything about routes", async () => {
		const h = harness({ client: fakeClient({ itemsWithTag: async () => [] }), tags: {}, cloud: false });
		expect(await sendTaggedPapers(h.host, h.client)).toEqual(["Zotero: no paper carries the tag to-remarkable."]);
	});

	it("asks Zotero for the tag the setting names", async () => {
		const itemsWithTag = vi.fn(async () => []);
		const h = harness({ client: fakeClient({ itemsWithTag }), zotero: { sendTag: "lesen" } });
		await sendTaggedPapers(h.host, h.client);

		expect(itemsWithTag).toHaveBeenCalledWith("lesen");
	});

	// Nothing here puts a tag on, so the vault's tag mapping is none of this step's business: the paper
	// goes up, and syncing back starts when the reader tags it on the tablet.
	it("sends in a vault that maps no tag, since the tag is the reader's to put on", async () => {
		const h = harness({ tags: {} });
		await sendTaggedPapers(h.host, h.client);

		expect(h.sent.map((document) => document.visibleName)).toEqual(["Prompting"]);
	});

	it("sends nothing from a vault with no route to a tablet, and says so", async () => {
		const h = harness({ cloud: false });
		expect(await sendTaggedPapers(h.host, h.client)).toEqual([`Zotero: 1 paper tagged to-remarkable not sent. ${SEND_NEEDS_TRANSPORT}`]);
	});

	// The SSH route restarts the tablet's reading app (§2.4). Fine in a command: the person pressing
	// it is the person holding the tablet, and the SSH setting's sentence told them.
	it("sends over SSH when the cloud is not connected, in the same press", async () => {
		const h = harness({ cloud: false, ssh: true });

		expect(await sendTaggedPapers(h.host, h.client)).toEqual(['Sent 1 Zotero paper to your reMarkable: "Prompting". It has no sync tag yet — add one on the tablet when you want it back.']);
		expect(h.reports.at(-1)).toBe('Tagged Sync: sending "Prompting" to your reMarkable…');
	});

	// The §3.4.2 wording: which tag, and why, in Zotero's words.
	it("says in Zotero's own words why nothing was sent when Zotero does not answer", async () => {
		const h = harness({
			client: fakeClient({
				itemsWithTag: async () => {
					throw new ZoteroError("unauthorized", "401");
				},
			}),
		});

		expect(await sendTaggedPapers(h.host, h.client)).toEqual(["Zotero: papers tagged to-remarkable were not sent — Zotero rejected the API key."]);
		expect(h.sent).toEqual([]);
	});
});
