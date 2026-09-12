import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { asApp, type Command, FakeApp, noticeLog, takeModals, takeSettings, TFile } from "../test-stubs/fake-obsidian";
import type { EventRef } from "obsidian";
import { entitlementOf, NO_LICENCE, type Entitlement } from "./licence-state";
import { NOTE_NOT_SYNCED_NOTICE } from "./re-transcribe-prompt";
import type { SyncIndexRow } from "./sync-engine";
import { DEFAULT_DATA, type TaggedSyncData } from "./settings-store";
import type { ZoteroAttachment, ZoteroClient, ZoteroItem } from "./zotero-client";
import { linkFor } from "./zotero-links";
import { registerZoteroCommands, SEND_COMMAND, sendZoteroPdf, zoteroKeyedNotes, zoteroPassFor, type ZoteroHost } from "./zotero-plugin";
import { PICK_THE_FILE, SEND_NEEDS_A_TAG, SEND_NEEDS_TRANSPORT, type SendDocument, type SendTransport } from "./zotero-send";

const PRO: Entitlement = { tier: "pro", since: "2026-09-01T00:00:00.000Z", stale: false };
const FREE = entitlementOf(NO_LICENCE, new Date("2026-09-11T09:00:00.000Z"));

const ITEM: ZoteroItem = { key: "ITEM1", title: "Prompting", creator: "Smith", year: "2024", citationKey: null };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: "ATT1", parentKey: "ITEM1", filename: "prompting.pdf", md5: null, title: "Full Text PDF", ...overrides };
}

function fakeClient(overrides: Partial<ZoteroClient> = {}): ZoteroClient {
	return {
		status: async () => ({ web: true, local: false, summary: "" }),
		libraryId: async () => 1234567,
		attachments: async () => [attachment()],
		attachment: async () => attachment(),
		parentItem: async () => ITEM,
		search: async () => [ITEM],
		filePath: async () => null,
		fileBytes: async () => new Uint8Array([1, 2, 3]),
		ownAnnotations: async () => [],
		createAnnotations: async () => ({ keys: [], failures: [] }),
		patchAnnotation: async () => "written",
		...overrides,
	} as ZoteroClient;
}

interface Harness {
	host: ZoteroHost;
	data: TaggedSyncData;
	app: FakeApp;
	commands: Command[];
	events: EventRef[];
	sent: SendDocument[];
	reports: string[];
	saves: number;
}

function harness(
	options: {
		entitlement?: Entitlement;
		client?: ZoteroClient | null;
		tags?: Record<string, string>;
		transport?: SendTransport | null;
		data?: Partial<TaggedSyncData>;
	} = {},
): Harness {
	const app = new FakeApp();
	const data: TaggedSyncData = { ...structuredClone(DEFAULT_DATA), tagFolderMap: options.tags ?? { sync: "Target" }, ...options.data };
	const commands: Command[] = [];
	const events: EventRef[] = [];
	const sent: SendDocument[] = [];
	const reports: string[] = [];
	const harnessed = { commands, events, sent, reports, saves: 0, app, data } as Harness;
	const cloud: SendTransport = options.transport ?? {
		label: "reMarkable's cloud",
		putPdf: async (document) => {
			sent.push(document);
			return { docId: `doc-${sent.length}` };
		},
	};
	harnessed.host = {
		app: asApp(app),
		data,
		entitlement: () => options.entitlement ?? PRO,
		zoteroClient: () => (options.client === undefined ? fakeClient() : options.client),
		save: async () => {
			harnessed.saves += 1;
		},
		now: () => new Date("2026-09-11T09:00:00.000Z"),
		sendRoutes: () => ({ cloud: options.transport === null ? null : cloud, ssh: null }),
		report: (_state, message) => reports.push(message),
		addCommand: (command) => commands.push(command),
		registerEvent: (ref) => events.push(ref),
	};
	return harnessed;
}

/** An index holding one synced document, `doc-9`, whose note is at `notePath`. */
function syncedAs(notePath: string): TaggedSyncData["syncIndex"] {
	const row: SyncIndexRow = {
		syncKey: "doc-9:sync",
		docId: "doc-9",
		pageId: null,
		tag: "sync",
		entryHash: "hash-1",
		pageHash: null,
		notePath,
		status: "active",
		syncedAt: "2026-09-05T09:00:00.000Z",
	};
	return { rootHash: null, rows: { "doc-9:sync": row } };
}

/** Presses the button of the row whose name (or whose button's label) is `name`. */
function press(name?: string, rows = takeSettings()): void {
	if (name === undefined) {
		rows.find((setting) => setting.buttons.length > 0)?.buttons[0].click();
		return;
	}
	const named = rows.find((setting) => setting.name === name);
	if (named !== undefined) {
		named.buttons[0].click();
		return;
	}
	// By label, because a row can carry several buttons -- the re-send question has Cancel beside it.
	rows.flatMap((setting) => setting.buttons).find((button) => button.text === name)?.click();
}

/** Types into the send dialog's search field and lets the debounce run. */
async function search(text: string): Promise<void> {
	takeSettings().flatMap((setting) => setting.texts)[0].type(text);
	await vi.advanceTimersByTimeAsync(400);
}

/** The palette command by id. */
const command = (harnessed: Harness, id: string): Command => harnessed.commands.find((entry) => entry.id === `zotero-${id}`)!;

/** Runs the whole send: open, search, choose the paper, and let the upload settle. */
async function sendThrough(harnessed: Harness): Promise<void> {
	const done = sendZoteroPdf(harnessed.host);
	await vi.advanceTimersByTimeAsync(1);
	await search("smith");
	press("Smith 2024 · Prompting");
	await done;
}

const notices = (): string[] => noticeLog.splice(0, noticeLog.length).map((notice) => notice.message);

beforeEach(() => {
	// `sentMd5` is the hash of the bytes that went up, and hashing is desktop-only -- see `file-md5.ts`.
	Platform.isDesktop = true;
	vi.useFakeTimers();
	takeSettings();
	takeModals();
	notices();
});

describe("what a vault gets registered", () => {
	it("registers the two commands and the context action", () => {
		const harnessed = harness();

		registerZoteroCommands(harnessed.host);

		expect(harnessed.commands.map((entry) => entry.id)).toEqual(["zotero-send", "zotero-link"]);
		expect(harnessed.events).toHaveLength(1);
	});

	// §5: Send and the link are the free half, so a free vault's palette has them too.
	it("registers the same for a free vault", () => {
		const harnessed = harness({ entitlement: FREE });

		registerZoteroCommands(harnessed.host);

		expect(harnessed.commands.map((entry) => entry.id)).toEqual(["zotero-send", "zotero-link"]);
		expect(harnessed.events).toHaveLength(1);
	});

	// Registered on nothing but the plugin loading: a user who has not pasted a key yet is told what
	// to do by the command rather than finding nothing.
	it("registers them for a vault that has configured no connection", () => {
		const harnessed = harness({ client: null });

		registerZoteroCommands(harnessed.host);

		expect(harnessed.commands).toHaveLength(2);
	});

	it("runs Send from the palette", async () => {
		const harnessed = harness({ transport: null });
		registerZoteroCommands(harnessed.host);

		command(harnessed, "send").callback!();
		await vi.advanceTimersByTimeAsync(1);

		expect(notices()).toEqual([SEND_NEEDS_TRANSPORT]);
	});

	it("offers Link to Zotero item… on a Markdown note and nowhere else", () => {
		const harnessed = harness();
		registerZoteroCommands(harnessed.host);
		const link = command(harnessed, "link");

		expect(link.checkCallback!(true)).toBe(false);
		harnessed.app.workspace.activeFile = harnessed.app.vault.seed("Target/Paper.md");
		expect(link.checkCallback!(true)).toBe(true);
		harnessed.app.workspace.activeFile = harnessed.app.vault.seed("Target/scan.pdf");
		expect(link.checkCallback!(true)).toBe(false);
	});
});

describe("what Send refuses before it opens anything", () => {
	it("says why there is no Zotero, rather than opening a dialog over nothing", async () => {
		await sendZoteroPdf(harness({ client: null }).host);

		expect(notices()[0]).toContain("Connect Zotero first");
		expect(takeModals()).toEqual([]);
	});

	it("refuses a vault with no route to a tablet", async () => {
		await sendZoteroPdf(harness({ transport: null }).host);

		expect(notices()).toEqual([SEND_NEEDS_TRANSPORT]);
	});

	// Not in the spec, and the one refusal this feature adds: a document sent without a sync tag is
	// annotated and never looked at again.
	it("refuses a vault that maps no tag at all", async () => {
		await sendZoteroPdf(harness({ tags: {} }).host);

		expect(notices()).toEqual([SEND_NEEDS_A_TAG]);
	});
});

describe("sending a paper", () => {
	it("puts it in the tablet folder, tagged, and records the link", async () => {
		const harnessed = harness();

		await sendThrough(harnessed);

		expect(harnessed.sent).toEqual([{ visibleName: "Prompting", bytes: new Uint8Array([1, 2, 3]), folder: "Zotero", tag: "sync" }]);
		expect(linkFor(harnessed.data.zoteroLinks, "doc-1")?.attachmentKey).toBe("ATT1");
		expect(harnessed.data.zotero.lastTag).toBe("sync");
		expect(harnessed.saves).toBe(1);
		expect(notices()[0]).toContain("is on your reMarkable, tagged sync");
	});

	it("falls back to the default folder when the setting was emptied", async () => {
		const harnessed = harness({ data: { zotero: { ...DEFAULT_DATA.zotero, folder: "  " } } });

		await sendThrough(harnessed);

		expect(harnessed.sent[0].folder).toBe("Zotero");
	});

	it("says what went wrong rather than failing silently", async () => {
		const harnessed = harness({
			transport: {
				label: "reMarkable's cloud",
				putPdf: async () => {
					throw new Error("the tablet refused it");
				},
			},
		});

		await sendThrough(harnessed);

		expect(notices()[0]).toContain("the tablet refused it");
	});

	// The third path of §2.4: Zotero has no copy to hand over, so the user is asked for the file. A
	// dialog they close is an answer, and the send stops without a failure.
	it("asks for the file when neither connection can produce it, and stops when that is closed", async () => {
		const input = { type: "", accept: "", onchange: null as (() => void) | null, oncancel: null as (() => void) | null, files: null, click: () => input.oncancel?.() };
		vi.stubGlobal("document", { createElement: () => input });
		const harnessed = harness({ client: fakeClient({ fileBytes: async () => null }) });

		await sendThrough(harnessed);

		expect(notices()).toContain(PICK_THE_FILE);
		expect(harnessed.sent).toEqual([]);
		expect(harnessed.reports).toContain("Tagged Sync: nothing sent");
		vi.unstubAllGlobals();
	});

	it("says what went wrong even when what went wrong was not an Error", async () => {
		const harnessed = harness({
			transport: {
				label: "reMarkable's cloud",
				// eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberate: a rejected promise carrying a string is what a reverse-engineered API produces.
				putPdf: async () => Promise.reject("upload rejected"),
			},
		});

		await sendThrough(harnessed);

		expect(notices()[0]).toContain("upload rejected");
	});

	it("writes nothing when the dialog is closed", async () => {
		const harnessed = harness();
		const done = sendZoteroPdf(harnessed.host);
		await vi.advanceTimersByTimeAsync(1);
		takeModals()[0].close();
		await done;

		expect(harnessed.sent).toEqual([]);
		expect(harnessed.saves).toBe(0);
	});
});

describe("a paper that is already on the tablet (§2.5)", () => {
	/** A vault that sent this attachment before, and whose last sync saw the document. */
	function alreadySent(): Harness {
		return harness({
			data: {
				zoteroLinks: { "doc-9": { attachmentKey: "ATT1", library: "user", sentAt: "2026-09-01T09:00:00.000Z", annotations: {} } },
				syncIndex: syncedAs("Target/Prompting.md"),
				lastSyncAt: "2026-09-05T09:00:00.000Z",
			},
		});
	}

	it("asks before adding a second copy, and adds nothing when the answer is no", async () => {
		const harnessed = alreadySent();

		const done = sendZoteroPdf(harnessed.host);
		await vi.advanceTimersByTimeAsync(1);
		await search("smith");
		press("Smith 2024 · Prompting");
		await vi.advanceTimersByTimeAsync(1);
		const rows = takeSettings();
		expect(rows.some((row) => row.buttons.some((button) => button.text === "Send another copy"))).toBe(true);
		press("Cancel", rows);
		await done;

		expect(harnessed.sent).toEqual([]);
	});

	// A second document with its own mapping. Nothing already on the tablet is touched -- that is the
	// promise of §1.2, and the first copy's write-back history survives it.
	it("adds a second document with its own mapping when the answer is yes", async () => {
		const harnessed = alreadySent();

		const done = sendZoteroPdf(harnessed.host);
		await vi.advanceTimersByTimeAsync(1);
		await search("smith");
		press("Smith 2024 · Prompting");
		await vi.advanceTimersByTimeAsync(1);
		press("Send another copy");
		await done;

		expect(harnessed.sent).toHaveLength(1);
		expect(Object.keys(harnessed.data.zoteroLinks).sort()).toEqual(["doc-1", "doc-9"]);
	});

	it("replaces the mapping of a document that is no longer on the tablet, without asking", async () => {
		const harnessed = harness({
			data: {
				zoteroLinks: { "doc-9": { attachmentKey: "ATT1", library: "user", sentAt: "2026-09-01T09:00:00.000Z", annotations: {} } },
				lastSyncAt: "2026-09-05T09:00:00.000Z",
			},
		});

		await sendThrough(harnessed);

		expect(Object.keys(harnessed.data.zoteroLinks)).toEqual(["doc-1"]);
	});
});

describe("the context action on a note that names its paper", () => {
	/** Fires the `file-menu` handler over `file` and returns the titles it offered. */
	function menuFor(harnessed: Harness, file: TFile): { titles: string[]; click: (title: string) => void } {
		const items: { title: string; onClick: () => void }[] = [];
		const menu = {
			addItem: (build: (item: unknown) => void) => {
				const item = { title: "", setTitle(title: string) { item.title = title; return item; }, setIcon: () => item, onClick(handler: () => void) { items.push({ title: item.title, onClick: handler }); return item; } };
				build(item);
			},
		};
		harnessed.app.workspace.trigger("file-menu", menu, file);
		return { titles: items.map((item) => item.title), click: (title) => items.find((item) => item.title === title)?.onClick() };
	}

	function noteWith(harnessed: Harness, frontmatter: Record<string, unknown> | null): TFile {
		const file = harnessed.app.vault.seed("Target/Prompting.md");
		if (frontmatter !== null) harnessed.app.metadataCache.frontmatter.set(file.path, frontmatter);
		return file;
	}

	it("offers Send on a note carrying zotero-key, and on nothing else", () => {
		const harnessed = harness();
		registerZoteroCommands(harnessed.host);

		expect(menuFor(harnessed, noteWith(harnessed, { "zotero-key": "ITEM1" })).titles).toEqual([SEND_COMMAND]);
		expect(menuFor(harnessed, noteWith(harnessed, { "zotero-key": 7 })).titles).toEqual([]);
		expect(menuFor(harnessed, noteWith(harnessed, null)).titles).toEqual([]);
		// A right-click on a folder reaches the same handler, and a folder has no frontmatter to read.
		expect(menuFor(harnessed, harnessed.app.vault.getAbstractFileByPath("Target") as TFile).titles).toEqual([]);
	});

	it("sends that paper's only PDF without asking which paper", async () => {
		const harnessed = harness();
		registerZoteroCommands(harnessed.host);

		menuFor(harnessed, noteWith(harnessed, { "zotero-key": "ITEM1" })).click(SEND_COMMAND);
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(10);

		expect(harnessed.sent).toHaveLength(1);
		expect(takeSettings()).toEqual([]);
	});

	it("says so when the item has left the library", async () => {
		const harnessed = harness({ client: fakeClient({ parentItem: async () => null }) });

		await sendZoteroPdf(harnessed.host, "ITEM1");

		expect(notices()[0]).toContain("no longer in your library");
	});

	it("says so when the item has no PDF", async () => {
		const harnessed = harness({ client: fakeClient({ attachments: async () => [] }) });

		await sendZoteroPdf(harnessed.host, "ITEM1");

		expect(notices()[0]).toContain("no PDF attachment");
	});

	it("asks which PDF where the paper has two, and sends the one chosen", async () => {
		const second = attachment({ key: "ATT2", filename: "preprint.pdf" });
		const harnessed = harness({ client: fakeClient({ attachments: async () => [attachment(), second] }) });

		const done = sendZoteroPdf(harnessed.host, "ITEM1");
		await vi.advanceTimersByTimeAsync(1);
		const rows = takeSettings();
		expect(rows.map((row) => row.desc)).toContain("preprint.pdf");
		press(undefined, rows);
		await done;

		expect(harnessed.sent).toHaveLength(1);
	});

	it("sends nothing when that question is closed", async () => {
		const second = attachment({ key: "ATT2", filename: "preprint.pdf" });
		const harnessed = harness({ client: fakeClient({ attachments: async () => [attachment(), second] }) });

		const done = sendZoteroPdf(harnessed.host, "ITEM1");
		await vi.advanceTimersByTimeAsync(1);
		takeModals()[0].close();
		await done;

		expect(harnessed.sent).toEqual([]);
	});
});

describe("Link to Zotero item…", () => {
	const SYNCED = syncedAs("Target/Paper.md");

	/** Runs the command over the note on screen and answers the search dialog. */
	async function link(harnessed: Harness, path = "Target/Paper.md"): Promise<void> {
		registerZoteroCommands(harnessed.host);
		harnessed.app.workspace.activeFile = harnessed.app.vault.seed(path);
		command(harnessed, "link").checkCallback!(false);
		await vi.advanceTimersByTimeAsync(1);
		// A note the plugin did not write never opens a dialog, and this helper is used for that too.
		if (takeModals().length === 0) return;
		await search("smith");
		press("Smith 2024 · Prompting");
		await vi.advanceTimersByTimeAsync(1);
	}

	it("refuses a note this plugin did not write", async () => {
		const harnessed = harness();

		await link(harnessed, "Elsewhere/Own note.md");

		expect(notices()).toEqual([NOTE_NOT_SYNCED_NOTICE]);
	});

	it("writes the link the user chose", async () => {
		const harnessed = harness({ data: { syncIndex: SYNCED } });

		await link(harnessed);

		expect(linkFor(harnessed.data.zoteroLinks, "doc-9")?.attachmentKey).toBe("ATT1");
		expect(harnessed.saves).toBe(1);
	});

	// Re-pointed at a different file, the annotation keys describe somebody else's pages.
	it("keeps what was written back only when the link still points at the same attachment", async () => {
		const written = { "hl-1": { key: "ANN1", written: {} } };
		const same = harness({ data: { syncIndex: SYNCED, zoteroLinks: { "doc-9": { attachmentKey: "ATT1", library: "user", annotations: written } } } });
		await link(same);
		expect(linkFor(same.data.zoteroLinks, "doc-9")?.annotations).toEqual(written);

		const other = harness({ data: { syncIndex: SYNCED, zoteroLinks: { "doc-9": { attachmentKey: "OLD", library: "user", annotations: written } } } });
		await link(other);
		expect(linkFor(other.data.zoteroLinks, "doc-9")?.annotations).toEqual({});
	});

	it("writes nothing when the dialog is closed", async () => {
		const harnessed = harness({ data: { syncIndex: SYNCED } });
		registerZoteroCommands(harnessed.host);
		harnessed.app.workspace.activeFile = harnessed.app.vault.seed("Target/Paper.md");
		command(harnessed, "link").checkCallback!(false);
		await vi.advanceTimersByTimeAsync(1);
		takeModals()[0].close();
		await vi.advanceTimersByTimeAsync(1);

		expect(harnessed.data.zoteroLinks).toEqual({});
	});

	it("says why there is no Zotero rather than opening a search over nothing", async () => {
		const harnessed = harness({ client: null, data: { syncIndex: SYNCED } });
		registerZoteroCommands(harnessed.host);
		harnessed.app.workspace.activeFile = harnessed.app.vault.seed("Target/Paper.md");
		command(harnessed, "link").checkCallback!(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(notices()[0]).toContain("Connect Zotero first");
		expect(takeModals()).toEqual([]);
	});
});

describe("the vault's own notes about papers", () => {
	it("takes the notes carrying a Zotero key, and never one of ours", () => {
		const app = new FakeApp();
		const literature = app.vault.seed("Literature/@smith2024.md");
		const ours = app.vault.seed("Target/Prompting.md");
		app.vault.seed("Other/Plain.md");
		app.metadataCache.frontmatter.set(literature.path, { "zotero-key": "ITEM1", citekey: "smith2024" });
		app.metadataCache.frontmatter.set(ours.path, { "zotero-key": "ITEM1", "remarkable-note-id": "n1" });

		expect(zoteroKeyedNotes(asApp(app))).toEqual([{ path: "Literature/@smith2024.md", link: "@smith2024", zoteroKey: "ITEM1", citekey: "smith2024" }]);
	});

	// Either key on its own is enough to find the paper: ZotLit writes both, a hand-written note often
	// carries only the citekey, and §4 looks a literature note up by either.
	it("takes a note carrying only one of the two keys", () => {
		const app = new FakeApp();
		app.metadataCache.frontmatter.set(app.vault.seed("Literature/A.md").path, { "zotero-key": "ITEM1" });
		app.metadataCache.frontmatter.set(app.vault.seed("Literature/B.md").path, { citekey: "smith2024" });
		// Frontmatter of its own, and nothing in it that names a paper.
		app.metadataCache.frontmatter.set(app.vault.seed("Notes/C.md").path, { tags: ["reading"] });

		expect(zoteroKeyedNotes(asApp(app)).map((note) => note.path)).toEqual(["Literature/A.md", "Literature/B.md"]);
	});
});

describe("the run's Zotero half", () => {
	const LINKED_DOC = { zoteroLinks: { "doc-9": { attachmentKey: "ATT1", library: "user", annotations: {} } } };

	/** Runs the pass over one already-linked document, the way the engine does after writing its note. */
	const runOver = (harnessed: Harness, interactive = true) =>
		zoteroPassFor(harnessed.host, interactive)!.run({
			docId: "doc-9",
			visibleName: "Prompting",
			notePath: "Target/Prompting.md",
			pages: [],
			md5: async () => null,
		});

	it("is absent for a vault with no Zotero", () => {
		expect(zoteroPassFor(harness({ client: null }).host, true)).toBeUndefined();
	});

	it("reads this vault's links, its notes and its user id, and writes back into the same data", async () => {
		const harnessed = harness({ data: { ...LINKED_DOC, zotero: { ...DEFAULT_DATA.zotero, apiKey: "key" } } });
		const literature = harnessed.app.vault.seed("Literature/@smith2024.md");
		harnessed.app.metadataCache.frontmatter.set(literature.path, { "zotero-key": "ITEM1" });

		const parts = await runOver(harnessed);

		expect(parts.line).toContain("[web library](https://www.zotero.org/users/1234567/items/ITEM1)");
		expect(parts.line).toContain("literature note: [[@smith2024]]");
		expect(parts.line).toContain("written back 2026-09-11");
		expect(harnessed.saves).toBe(1);
	});

	// The write-back half of §5, pinned where the licence is read into the pass: a free vault's pass
	// links and names the paper and never calls a write. The capability walk in `pro-capabilities`
	// drives the connection half; this is the other one.
	it("writes nothing into Zotero for a free vault, and says so in the note", async () => {
		const createAnnotations = vi.fn(async () => ({ keys: [], failures: [] }));
		const harnessed = harness({
			entitlement: FREE,
			client: fakeClient({ createAnnotations }),
			data: { ...LINKED_DOC, zotero: { ...DEFAULT_DATA.zotero, apiKey: "key" } },
		});

		const parts = await runOver(harnessed);

		expect(parts.line).toContain("[web library](https://www.zotero.org/users/1234567/items/ITEM1)");
		expect(parts.line).toContain("highlights stay in the vault — writing them into Zotero is Tagged Sync Pro");
		expect(createAnnotations).not.toHaveBeenCalled();
	});

	// The id can come from either connection -- the desktop app knows it too -- but a vault that only
	// talks to Zotero on this machine has no business printing a zotero.org URL into a note (§4).
	it("prints no zotero.org link for a vault with no web connection", async () => {
		const parts = await runOver(harness({ data: LINKED_DOC }));

		expect(parts.line).not.toContain("web library");
	});

	// The picker of §2.3, reached through the pass: a run somebody is watching may ask, a background
	// one may not -- and neither may answer on the user's behalf.
	it("opens the picker for an ambiguous document in a watched run, and never in a background one", async () => {
		const twins = [attachment(), attachment({ key: "ATT2", parentKey: "ITEM2" })].map((entry) => ({ ...entry, md5: "same" }));
		const harnessed = harness({ client: fakeClient({ attachments: async () => twins }) });
		const ambiguous = { docId: "doc-1", visibleName: "Prompting", notePath: "Target/Prompting.md", pages: [], md5: async () => "same" };

		const watched = zoteroPassFor(harnessed.host, true)!.run(ambiguous);
		await vi.advanceTimersByTimeAsync(1);
		expect(takeModals()).toHaveLength(1);
		press("Smith 2024 · Prompting");
		expect((await watched).line).toContain("zotero://select/library/items/ITEM1");

		const background = harness({ client: fakeClient({ attachments: async () => twins }) });
		expect((await zoteroPassFor(background.host, false)!.run(ambiguous)).line).toBeNull();
		expect(takeModals()).toEqual([]);
	});

	it("says nothing about a web library Zotero cannot name", async () => {
		const harnessed = harness({ client: fakeClient({ libraryId: async () => null }), data: { ...LINKED_DOC, zotero: { ...DEFAULT_DATA.zotero, apiKey: "key" } } });

		expect((await runOver(harnessed)).line).not.toContain("web library");
	});
});
