import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { type Command, createFragment, FakeApp, noticeLog, Platform, takeModals, takeSettings } from "../test-stubs/fake-obsidian";
import { NO_LICENCE } from "./licence-state";
import type { ZoteroAttachment, ZoteroClient, ZoteroItem } from "./zotero-client";
import { linkFor } from "./zotero-links";
import { SEND_NEEDS_TRANSPORT, type SendDocument } from "./zotero-send";

// The Zotero commands as the shipped plugin registers them. Everything they *decide* is unit-tested
// in `zotero-plugin.test.ts` against a host literal; what only this file can say is that `main.ts`
// hands that host the real plugin -- its licence, its settings, its transports and its clock. A host
// wired to the wrong thing passes every test over there and ships a command that does nothing.
//
// Driven through `src/entry.ts` for the reason `tag-routing-section.test.ts` gives: `entry.ts` is
// what Obsidian actually loads.

vi.mock("rmapi-js", () => ({ session: () => ({}) }));
vi.stubGlobal("createFragment", createFragment);
vi.stubGlobal("window", { open: () => undefined });

const PRO = { key: "test-key", activationId: "act-1", validatedAt: new Date("2026-09-10T09:00:00.000Z").toISOString() };

const ITEM: ZoteroItem = { key: "ITEM1", title: "Prompting", creator: "Smith", year: "2024", citationKey: null };
const ATTACHMENT: ZoteroAttachment = { key: "ATT1", parentKey: "ITEM1", filename: "prompting.pdf", md5: null, title: "Full Text PDF" };

function fakeClient(): ZoteroClient {
	return {
		status: async () => ({ web: false, local: true, summary: "" }),
		libraryId: async () => null,
		attachments: async () => [ATTACHMENT],
		attachment: async () => ATTACHMENT,
		parentItem: async () => ITEM,
		search: async () => [ITEM],
		filePath: async () => null,
		fileBytes: async () => new Uint8Array([1, 2, 3]),
		ownAnnotations: async () => [],
		createAnnotations: async () => ({ keys: [], failures: [] }),
		patchAnnotation: async () => "written",
	} as ZoteroClient;
}

interface LoadedPlugin {
	commands: Command[];
	saved: { zoteroLinks?: Record<string, unknown>; zotero?: { lastTag: string | null } };
	zoteroClient(): ZoteroClient | null;
}

/** The shipped plugin, loaded from a `data.json`, with a clock nobody moves. */
async function load(saved: Record<string, unknown>): Promise<LoadedPlugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => LoadedPlugin & { saved: unknown })(new FakeApp(), {
		id: "tagged-sync",
		name: "Tagged Sync",
		version: "0.0.0",
	});
	plugin.saved = saved;
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	return plugin;
}

/** Runs *Send Zotero PDF to reMarkable…* and answers its dialog with the one paper the library has. */
async function sendOnePaper(plugin: LoadedPlugin): Promise<void> {
	plugin.commands.find((command) => command.id === "zotero-send")!.callback!();
	await vi.advanceTimersByTimeAsync(1);
	takeSettings().flatMap((setting) => setting.texts)[0].type("smith");
	await vi.advanceTimersByTimeAsync(400);
	takeSettings()
		.find((setting) => setting.name === "Smith 2024 · Prompting")!
		.buttons[0].click();
	await vi.advanceTimersByTimeAsync(10);
}

const zoteroCommands = (plugin: LoadedPlugin): string[] => plugin.commands.map((command) => command.id).filter((id) => id.startsWith("zotero-"));
const notices = (): string[] => noticeLog.splice(0, noticeLog.length).map((notice) => notice.message);

beforeEach(() => {
	Platform.isDesktop = true;
	vi.useFakeTimers();
	takeSettings();
	takeModals();
	notices();
});

describe("the Zotero commands as the plugin registers them", () => {
	// §5: Send and the link are the free half, so a free vault's palette has both commands too.
	it("registers both in a free vault", async () => {
		const plugin = await load({ licence: NO_LICENCE, zotero: { apiKey: "key" } });

		expect(zoteroCommands(plugin)).toEqual(["zotero-send", "zotero-link"]);
	});

	it("registers both in a Pro vault", async () => {
		const plugin = await load({ licence: PRO, zotero: { apiKey: "key" } });

		expect(zoteroCommands(plugin)).toEqual(["zotero-send", "zotero-link"]);
	});

	// The host is wired to the plugin's own transports: with neither connected there is no route, and
	// Send says so before it opens anything.
	it("reads this vault's transports when Send asks for a route", async () => {
		const plugin = await load({ licence: PRO, zotero: { apiKey: "key" }, tagFolderMap: { sync: "Target" } });

		plugin.commands.find((command) => command.id === "zotero-send")!.callback!();
		await vi.advanceTimersByTimeAsync(1);

		expect(notices()).toEqual([SEND_NEEDS_TRANSPORT]);
	});

	// §2.4's fallback, and the one route that costs the reader something: SSH send restarts the
	// tablet's reading app, so it is off unless the user switched it on and the cloud cannot do it.
	it("takes the SSH route when it is switched on and the cloud is not connected", async () => {
		const plugin = await load({
			licence: PRO,
			zotero: { apiKey: "key", sendOverSsh: true },
			tagFolderMap: { sync: "Target" },
			ssh: { host: "10.11.99.1", port: 22, privateKey: "key", hostKeyFingerprint: "SHA256:x" },
		});
		const sent: SendDocument[] = [];
		plugin.zoteroClient = () => fakeClient();
		(plugin as unknown as { sshTransport: unknown }).sshTransport = {
			label: "your reMarkable",
			status: () => ({ connected: true, summary: "Paired", connectNotice: "" }),
			putPdf: async (document: SendDocument) => {
				sent.push(document);
				return { docId: "doc-2" };
			},
		};

		await sendOnePaper(plugin);

		expect(sent).toHaveLength(1);
		expect(linkFor(plugin.saved.zoteroLinks ?? {}, "doc-2")?.attachmentKey).toBe("ATT1");
	});

	// The whole wiring in one press: the plugin's client, its tag map, its cloud transport, its clock
	// and its `data.json`. The transport is replaced because the real one talks to reMarkable.
	it("sends through the plugin's own transport and saves the link in its own data", async () => {
		const plugin = await load({ licence: PRO, zotero: { apiKey: "key" }, tagFolderMap: { sync: "Target" }, deviceToken: "device-token" });
		const sent: SendDocument[] = [];
		plugin.zoteroClient = () => fakeClient();
		(plugin as unknown as { cloudTransport: unknown }).cloudTransport = {
			label: "reMarkable's cloud",
			status: () => ({ connected: true, summary: "Connected.", connectNotice: "" }),
			putPdf: async (document: SendDocument) => {
				sent.push(document);
				return { docId: "doc-1" };
			},
		};

		await sendOnePaper(plugin);

		expect(sent).toHaveLength(1);
		expect(linkFor(plugin.saved.zoteroLinks ?? {}, "doc-1")?.attachmentKey).toBe("ATT1");
		expect(plugin.saved.zotero?.lastTag).toBe("sync");
	});
});
