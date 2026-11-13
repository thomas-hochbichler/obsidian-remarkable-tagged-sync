import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRef } from "obsidian";
import { asApp, type Command, FakeApp, takeModals, takeNotices, takeSettings, type TFile } from "../tests/stubs/fake-obsidian";
import { DEFAULT_DATA, type TaggedSyncData } from "./settings-store";
import { SEND_THIS_FILE_COMMAND, SEND_TO_REMARKABLE_MENU } from "./vault-send";
import { registerVaultSendCommands, sendVaultFile, type VaultSendHost } from "./vault-send-plugin";
import { sendFor } from "./vault-sends";
import { registerZoteroCommands } from "./zotero-plugin";
import { SEND_COMMAND, type SendDocument, type SendTransport } from "./zotero-send";

// Where a person reaches a vault send (send spec §1), and what the plugin hands the send: the file's
// bytes, the settings, the record in data.json, the real dialog. The send itself is
// `vault-send.test.ts`; a note's print is the print surface's, so the sends here are PDFs.

interface Harness {
	host: VaultSendHost;
	app: FakeApp;
	data: TaggedSyncData;
	commands: Command[];
	uploads: SendDocument[];
	trashed: string[];
	saves: number;
}

function harness(transport: Partial<SendTransport> = {}): Harness {
	const app = new FakeApp();
	const data: TaggedSyncData = { ...structuredClone(DEFAULT_DATA), tagFolderMap: { sync: "Target", work: "Work" } };
	const commands: Command[] = [];
	const events: EventRef[] = [];
	const h = { app, data, commands, uploads: [], trashed: [], saves: 0 } as unknown as Harness;
	const cloud: SendTransport = {
		label: "reMarkable's cloud",
		namesIn: async () => [],
		putPdf: async (document) => {
			h.uploads.push(document);
			return { docId: `doc-${h.uploads.length}`, folderId: "folder-1" };
		},
		earlierCopies: async (copies) => ({ copies: copies.map((copy) => ({ docId: copy.docId, state: "users" as const, ref: { id: copy.docId, hash: "h" } })), strangerNamed: false }),
		moveToTrash: async (ref) => {
			h.trashed.push(ref.id);
			return true;
		},
		...transport,
	};
	h.host = {
		app: asApp(app),
		data,
		save: async () => {
			h.saves += 1;
		},
		now: () => new Date("2026-11-13T10:00:00.000Z"),
		sendRoutes: () => ({ cloud, ssh: null }),
		report: () => undefined,
		addCommand: (command) => commands.push(command),
		registerEvent: (ref) => events.push(ref),
	};
	return h;
}

function pdf(h: Harness, path = "Papers/Paper.pdf"): TFile {
	const file = h.app.vault.seed(path);
	void h.app.vault.modifyBinary(file, new Uint8Array([1, 2, 3]).buffer);
	return file;
}

/** Fires the `file-menu` handlers over `file` and returns the titles offered, with a way to click one. */
function menuFor(h: Harness, file: unknown): { titles: string[]; click: (title: string) => void } {
	const items: { title: string; onClick: () => void }[] = [];
	const menu = {
		addItem: (build: (item: unknown) => void) => {
			const item = {
				title: "",
				icon: "",
				setTitle(title: string) {
					item.title = title;
					return item;
				},
				setIcon(icon: string) {
					item.icon = icon;
					return item;
				},
				onClick(handler: () => void) {
					items.push({ title: item.title, onClick: handler });
					return item;
				},
			};
			build(item);
		},
	};
	h.app.workspace.trigger("file-menu", menu, file);
	return { titles: items.map((item) => item.title), click: (title) => items.find((item) => item.title === title)?.onClick() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	takeNotices();
	takeModals();
	takeSettings();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("where a vault send is offered (send spec §1)", () => {
	it("offers the palette command only while a note or a PDF is the active file", () => {
		const h = harness();
		registerVaultSendCommands(h.host);
		const command = h.commands.find((candidate) => candidate.id === "vault-send");
		expect(command?.name).toBe(SEND_THIS_FILE_COMMAND);

		const offered = (path: string | null) => {
			h.app.workspace.activeFile = path === null ? null : h.app.vault.seed(path);
			return command?.checkCallback?.(true);
		};
		expect([offered("Specs/Login-Spec.md"), offered("Papers/Paper.pdf")]).toEqual([true, true]);
		expect([offered(null), offered("Board.canvas"), offered("Photo.png"), offered("Book.epub"), offered("Table.base")]).toEqual([false, false, false, false, false]);
	});

	it("puts Send to reMarkable in the file menu of a note or a PDF, and of nothing else", () => {
		const h = harness();
		registerVaultSendCommands(h.host);

		expect(menuFor(h, h.app.vault.seed("Specs/Login-Spec.md")).titles).toEqual([SEND_TO_REMARKABLE_MENU]);
		expect(menuFor(h, h.app.vault.seed("Papers/Paper.pdf")).titles).toEqual([SEND_TO_REMARKABLE_MENU]);
		expect(menuFor(h, h.app.vault.seed("Board.canvas")).titles).toEqual([]);
		expect(menuFor(h, h.app.vault.getAbstractFileByPath("Specs")).titles).toEqual([]);
	});

	it("shows both sends on a note that names a Zotero paper", () => {
		const h = harness();
		const zoteroHost = { ...h.host, entitlement: () => ({ tier: "free" }) as never, zoteroClient: () => null };
		registerZoteroCommands(zoteroHost);
		registerVaultSendCommands(h.host);
		const note = h.app.vault.seed("Papers/Prompting.md");
		h.app.metadataCache.frontmatter.set(note.path, { "zotero-key": "ITEM1" });

		expect(menuFor(h, note).titles).toEqual([SEND_COMMAND, SEND_TO_REMARKABLE_MENU]);
	});
});

describe("what the plugin hands a vault send", () => {
	it("sends the file's bytes into the folder of the settings, records it in data.json and shows the notice", async () => {
		const h = harness();
		h.data.vaultSend = { ...h.data.vaultSend, folder: "Inbox" };
		registerVaultSendCommands(h.host);

		menuFor(h, pdf(h)).click(SEND_TO_REMARKABLE_MENU);
		await settle();

		expect(h.uploads.map((upload) => [upload.visibleName, [...upload.bytes], upload.folder])).toEqual([["Paper", [1, 2, 3], "Inbox"]]);
		expect(sendFor(h.data.vaultSends, "doc-1")).toMatchObject({ origin: "Papers/Paper.pdf", kind: "pdf", folderId: "folder-1" });
		expect(h.saves).toBe(1);
		expect(takeNotices()).toEqual(['Sent "Paper" to your reMarkable, into "Inbox". Tag it, or any page of it, with one of your sync tags ("sync", "work") on the tablet to bring your marks back as one note.']);
	});

	it("sends the active file when the palette command runs", async () => {
		const h = harness();
		registerVaultSendCommands(h.host);
		h.app.workspace.activeFile = pdf(h);

		h.commands.find((command) => command.id === "vault-send")?.checkCallback?.(false);
		await settle();

		expect(h.uploads.map((upload) => upload.visibleName)).toEqual(["Paper"]);
		expect(takeNotices()).toHaveLength(1);
	});

	it("hands a note to Obsidian's renderer, and sends nothing when it cannot print", async () => {
		const h = harness();
		const note = h.app.vault.seed("Specs/Login-Spec.md", "# Login\n\nThe spec.");
		// Where the note is rendered off-screen; the renderer itself is the stub's, which refuses.
		vi.stubGlobal("activeDocument", { body: { createDiv: () => ({ remove: () => undefined }) } });
		vi.stubGlobal("activeWindow", { setTimeout });

		await sendVaultFile(h.host, note as never);

		expect(h.uploads).toEqual([]);
		expect(takeNotices()).toEqual(['"Login-Spec" could not be printed, so nothing was sent: tests/stubs: MarkdownRenderer.render is not modelled. Hand the code a renderer instead.']);
	});

	it("asks about the user's copy with Keep it as the other button and the trash drawn as destructive, never as the call to action", async () => {
		const h = harness();
		const file = pdf(h);
		await sendVaultFile(h.host, file as never);
		takeNotices();

		const second = sendVaultFile(h.host, file as never);
		await settle();
		const [modal] = takeModals();
		const buttons = takeSettings().flatMap((setting) => setting.buttons);

		expect(buttons.map((button) => [button.text, button.cta, button.destructive])).toEqual([
			["Keep it", false, false],
			["Move it to the trash", false, true],
		]);
		expect(modal.titleEl.text).toBe('"Paper" has an earlier copy with your marks');
		buttons[1].click();
		await second;
		expect(h.trashed).toEqual(["doc-1"]);
	});

	it("keeps the user's copy when the dialog is closed with Escape", async () => {
		const h = harness();
		const file = pdf(h);
		await sendVaultFile(h.host, file as never);
		takeNotices();

		const second = sendVaultFile(h.host, file as never);
		await settle();
		takeModals()[0].close();
		await second;

		expect(h.trashed).toEqual([]);
		expect(sendFor(h.data.vaultSends, "doc-1")?.kept).toBe(true);
		expect(takeNotices()[0]).toMatch(/ The earlier copy with your marks is still there\.$/);
	});
});
