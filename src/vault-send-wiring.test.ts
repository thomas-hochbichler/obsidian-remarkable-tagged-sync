import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../tests/stubs/fake-clock";
import { FakeApp } from "../tests/stubs/fake-obsidian";
import { EMPTY_SYNC_INDEX } from "./sync-engine";
import type { ScreenSeen, VaultSendSettings } from "./vault-send-settings";

// The vault send's half of a sync, as the plugin runs it (send spec §7): what the run says about the
// screen its pages declared reaches `data.json`. The engine is replaced; which screen a run reports
// is the engine's own test, which one wins is `vault-send-settings.test.ts`.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

const engine = vi.hoisted(() => ({ screenSeen: null as ScreenSeen | null }));

vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (_deps: unknown, index: unknown) => ({
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
		}),
	};
});

interface Plugin {
	data: { vaultSend: VaultSendSettings };
	saves: unknown[];
	syncNow(): Promise<void>;
}

async function pluginWith(vaultSend: Partial<VaultSendSettings> = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(new FakeApp(), {
		id: "tagged-sync",
		name: "Tagged Sync",
		version: "0.0.0",
	});
	plugin.saved = { deviceToken: "device-token", ocrBackend: "off", syncIndex: EMPTY_SYNC_INDEX, vaultSend };
	// A clock nobody moves: the launch sync never comes due.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	return plugin;
}

const lastSaved = (plugin: Plugin) => (plugin.saves.at(-1) as Plugin["data"]).vaultSend;

beforeEach(() => {
	engine.screenSeen = null;
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
