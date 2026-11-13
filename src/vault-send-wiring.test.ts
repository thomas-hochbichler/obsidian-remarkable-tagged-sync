import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../tests/stubs/fake-clock";
import { FakeApp } from "../tests/stubs/fake-obsidian";
import { EMPTY_SYNC_INDEX } from "./sync-engine";
import type { ScreenSeen, VaultSendSettings } from "./vault-send-settings";
import type { StoredVaultSends, SyncMarks } from "./vault-sends";

// The vault send's half of a sync, as the plugin runs it (send spec §5, §7): what the run says about
// the screen its pages declared, and about the documents the vault sent, reaches `data.json`. The
// engine is replaced; what a run reports is the engine's own test, which screen wins is
// `vault-send-settings.test.ts`, how marks apply is `vault-sends.test.ts`.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

const engine = vi.hoisted(() => ({
	screenSeen: null as ScreenSeen | null,
	sendMarks: {} as Record<string, SyncMarks>,
	/** What the run read through `vaultSends` -- the plugin's map at that moment. */
	sendsRead: null as StoredVaultSends | null,
	/** Stands in for a rename made while the run goes on. */
	during: null as (() => void) | null,
}));

vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (deps: { vaultSends?: () => StoredVaultSends }, index: unknown) => {
			engine.sendsRead = deps.vaultSends?.() ?? null;
			engine.during?.();
			return {
				index,
				documentIds: null,
				stopped: false,
				notesWritten: 0,
				unavailableOcrUnits: 0,
				failedOcrUnits: 0,
				editedNotesSkipped: 0,
				documentsSkipped: 0,
				shrunkNotes: 0,
				relaidDocuments: 0,
				skipErrors: [],
				screenSeen: engine.screenSeen,
				sendMarks: engine.sendMarks,
			};
		},
	};
});

interface Plugin {
	data: { vaultSend: VaultSendSettings; vaultSends: StoredVaultSends };
	saves: unknown[];
	syncNow(): Promise<void>;
}

async function pluginWith(vaultSend: Partial<VaultSendSettings> = {}, vaultSends: StoredVaultSends = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(new FakeApp(), {
		id: "tagged-sync",
		name: "Tagged Sync",
		version: "0.0.0",
	});
	plugin.saved = { deviceToken: "device-token", ocrBackend: "off", syncIndex: EMPTY_SYNC_INDEX, vaultSend, vaultSends };
	// A clock nobody moves: the launch sync never comes due.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	return plugin;
}

const lastSaved = (plugin: Plugin) => (plugin.saves.at(-1) as Plugin["data"]).vaultSend;

beforeEach(() => {
	engine.screenSeen = null;
	engine.sendMarks = {};
	engine.sendsRead = null;
	engine.during = null;
});

describe("the screen a sync saw (send spec §7)", () => {
	it("is remembered with its document's time, and saved with the run", async () => {
		const plugin = await pluginWith();
		engine.screenSeen = { tablet: "paperPro", at: "2026-11-12T09:00:00.000Z" };

		await plugin.syncNow();

		expect([lastSaved(plugin).tabletSeen, lastSaved(plugin).tabletSeenAt]).toEqual(["paperPro", "2026-11-12T09:00:00.000Z"]);
	});

	it("does not replace one seen on a newer document", async () => {
		const plugin = await pluginWith({ tabletSeen: "paperPro", tabletSeenAt: "2026-11-12T09:00:00.000Z" });
		engine.screenSeen = { tablet: "rm12", at: "2026-10-01T00:00:00.000Z" };

		await plugin.syncNow();

		expect(plugin.data.vaultSend.tabletSeen).toBe("paperPro");
	});

	it("leaves the user's pick as it is", async () => {
		const plugin = await pluginWith({ tablet: "rm12" });
		engine.screenSeen = { tablet: "paperPro", at: "2026-11-12T09:00:00.000Z" };

		await plugin.syncNow();

		expect(plugin.data.vaultSend.tablet).toBe("rm12");
	});
});

describe("what a sync found about the vault's sends (send spec §5, §6.1)", () => {
	const SEND = { origin: "Specs/Login-Spec.md", kind: "note", sentAt: "2026-11-13T10:00:00.000Z" };

	it("reads the record the plugin holds, and saves the run's marks into it", async () => {
		const plugin = await pluginWith({}, { "doc-1": SEND });
		engine.sendMarks = { "doc-1": { promotedTags: ["sync"] } };

		await plugin.syncNow();

		expect(engine.sendsRead).toEqual({ "doc-1": SEND });
		expect((plugin.saves.at(-1) as Plugin["data"]).vaultSends).toEqual({ "doc-1": { ...SEND, promotedTags: ["sync"] } });
	});

	it("puts the marks on the live map, so a rename made while the run went on stays", async () => {
		const plugin = await pluginWith({}, { "doc-1": SEND });
		engine.during = () => {
			plugin.data.vaultSends = { "doc-1": { ...SEND, origin: "Specs/Login.md" } };
		};
		engine.sendMarks = { "doc-1": { promotedTags: ["sync"] } };

		await plugin.syncNow();

		expect(plugin.data.vaultSends["doc-1"]).toEqual({ ...SEND, origin: "Specs/Login.md", promotedTags: ["sync"] });
	});
});
