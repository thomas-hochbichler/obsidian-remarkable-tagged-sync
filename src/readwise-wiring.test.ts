import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../tests/stubs/fake-clock";
import { FakeApp, takeNotices } from "../tests/stubs/fake-obsidian";
import type { DigestPage } from "./digest-builder";
import { NO_LICENCE } from "./licence-state";
import type { ReadwiseClient } from "./readwise-client";
import type { ReadwiseRecorder } from "./readwise-push";
import { EMPTY_SYNC_INDEX, RENDER_VERSION } from "./sync-engine";

// The Readwise half of a sync, as the plugin runs it (Readwise spec §4.1, §5, §6): which run gets a
// recorder, when the push runs, under which lock, and what it says. The engine and readwise.io are
// replaced; what record and push do with the state has its own tests (`readwise-push.test.ts`).

const cloud = vi.hoisted(() => ({ down: false }));

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => {
		if (cloud.down) throw new Error("the reMarkable cloud did not answer");
		return "session-token";
	},
	register: async () => "device-token",
}));

/** Every run's recorder, and how the run ends. `during` runs inside the run, while it holds the lock. */
const engine = vi.hoisted(() => ({
	recorders: [] as (ReadwiseRecorder | undefined)[],
	stopped: false,
	during: null as (() => Promise<void>) | null,
}));

vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (deps: { readwise?: ReadwiseRecorder }, index: unknown) => {
			engine.recorders.push(deps.readwise);
			await engine.during?.();
			return { index, documentIds: null, stopped: engine.stopped, notesWritten: 0, unavailableOcrUnits: 0, failedOcrUnits: 0, editedNotesSkipped: 0, documentsSkipped: 0, shrunkNotes: 0, relaidDocuments: 0, skipErrors: [] };
		},
	};
});

/** readwise.io, as the push sees it: an account holding none of our books, answering what a test says. */
const readwise = vi.hoisted(() => ({
	tokens: [] as string[],
	calls: [] as string[],
	failure: null as Error | null,
	/** Asked on every call, so a test can see the state the plugin is in while the push talks to Readwise. */
	onCall: null as (() => void) | null,
	locked: [] as boolean[],
}));

vi.mock("./readwise-client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./readwise-client")>();
	return {
		...actual,
		createReadwiseClient: (token: string): ReadwiseClient => {
			readwise.tokens.push(token);
			const answer = async <T>(call: string, value: T): Promise<T> => {
				readwise.calls.push(call);
				readwise.onCall?.();
				if (readwise.failure) throw readwise.failure;
				return value;
			};
			return {
				check: async () => "ok",
				ourBooks: async () => await answer("books", []),
				push: async (items) => await answer(`push ${items.length}`, { kind: "pushed", books: [], ids: new Map() }),
				bookHighlights: async () => await answer("highlights", []),
				remove: async () => await answer("delete", undefined),
				rename: async () => await answer("rename", undefined),
			};
		},
	};
});

const { ReadwiseError } = await import("./readwise-client");

interface Plugin {
	app: FakeApp;
	data: Record<string, unknown> & { readwiseBooks: Record<string, { highlights: Record<string, unknown> }>; syncIndex: { rows: Record<string, { renderVersion?: number }> } };
	syncNow(): Promise<void>;
	requestStop(): void;
	refreshLicence(silent?: boolean): Promise<unknown>;
}

const KEY = "6a7b8c9d-page:1a2b";
const WANT = { text: "The weather station at **Cape Marrow** was built in the spring.", location: 12 };
const TRIAL = { ...NO_LICENCE, trialStartedAt: new Date().toISOString() };

async function pluginWith(setup: { pro?: boolean; token?: string | null; recording?: boolean; autoSync?: boolean } = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const app = new FakeApp();
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(app, { id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" });
	if (setup.token !== null) app.secretStorage.secrets.set("readwise", setup.token ?? "rw-token");
	plugin.saved = {
		deviceToken: "device-token",
		ocrBackend: "off",
		syncIndex: { ...EMPTY_SYNC_INDEX, rows: { "unit-1": { syncKey: "unit-1", docId: "doc-1", pageId: null, tag: "sync", entryHash: "h", pageHash: null, notePath: "Notes/1.md", status: "active", syncedAt: "2026-11-02T00:00:00.000Z", renderVersion: RENDER_VERSION } } },
		licence: setup.pro === false ? NO_LICENCE : TRIAL,
		readwise: { push: true, tokenSecret: "readwise" },
		readwiseBooks: { "doc-1": { title: "Cape Marrow", highlights: { [KEY]: { want: WANT } } } },
		...(setup.recording === false ? {} : { readwiseRecording: true }),
		...(setup.autoSync ? { autoSync: { enabled: true, intervalHours: 6 } } : {}),
	};
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	plugin.refreshLicence = async () => ({ tier: "pro" });
	takeNotices();
	return plugin;
}

const pushed = (plugin: Plugin) => plugin.data.readwiseBooks["doc-1"].highlights[KEY];

beforeEach(() => {
	cloud.down = false;
	engine.recorders = [];
	engine.stopped = false;
	engine.during = null;
	readwise.tokens = [];
	readwise.calls = [];
	readwise.failure = null;
	readwise.onCall = null;
	readwise.locked = [];
});

describe("the Readwise half of a sync", () => {
	it("records during the run and pushes after it, with the token from this computer's Keychain", async () => {
		const plugin = await pluginWith();

		await plugin.syncNow();

		expect(engine.recorders[0]).toBeDefined();
		expect(readwise.tokens).toEqual(["rw-token"]);
		expect(readwise.calls).toEqual(["books", "push 1"]);
		expect(pushed(plugin)).toEqual({ pushed: WANT });
	});

	it("records into the vault's data, where the run's checkpoint saves it", async () => {
		const plugin = await pluginWith();
		const page: DigestPage = { pageLabel: "3", embedPage: 1, source: null, highlights: [{ id: "hl-1", key: "p0:9f", sentence: "A new mark.", rects: [], tool: "marker", marked: [], color: null, notes: [], section: null, top: 0 }], notes: [] };
		engine.during = async () => {
			await engine.recorders[0]!.record({ docId: "doc-2", pages: [page], scope: "document", pageOrder: null, marginNotes: true, category: "articles", sources: async () => ({ visibleName: "Second" }) });
		};
		readwise.failure = new ReadwiseError("unreachable", "Could not reach readwise.io.");

		await plugin.syncNow();

		expect(plugin.data.readwiseBooks["doc-2"]).toEqual({ title: "Second", category: "articles", highlights: { "p0:9f": { want: { text: "A new mark.", location: 3 } } } });
	});

	it("records nothing and pushes nothing without Pro", async () => {
		const plugin = await pluginWith({ pro: false });

		await plugin.syncNow();

		expect(engine.recorders).toEqual([undefined]);
		expect(readwise.tokens).toEqual([]);
		expect(pushed(plugin)).toEqual({ want: WANT });
	});

	// Spec §11 P2: the computer with the token pushes what this one recorded.
	it("records on a computer without a token, and pushes nothing from it", async () => {
		await pluginWith({ token: null }).then(async (plugin) => await plugin.syncNow());

		expect(engine.recorders[0]).toBeDefined();
		expect(readwise.tokens).toEqual([]);
	});

	// Spec §11 P22: cloud down, tablet asleep -- the push needs neither.
	it("pushes when the source cannot be opened", async () => {
		cloud.down = true;
		const plugin = await pluginWith();

		await plugin.syncNow();

		expect(engine.recorders).toEqual([]);
		expect(readwise.calls).toEqual(["books", "push 1"]);
	});

	it("does not push on a run the user stopped", async () => {
		const plugin = await pluginWith();
		engine.during = async () => {
			plugin.requestStop();
			engine.stopped = true;
		};

		await plugin.syncNow();

		expect(readwise.calls).toEqual([]);
		expect(pushed(plugin)).toEqual({ want: WANT });
	});

	// Spec §5: the flag and the invalidation are saved together at the start, before the source is opened.
	it("makes every note due once when recording starts, even when the source then fails", async () => {
		cloud.down = true;
		const plugin = await pluginWith({ recording: false });

		await plugin.syncNow();

		expect(plugin.data.readwiseRecording).toBe(true);
		expect(plugin.data.syncIndex.rows["unit-1"].renderVersion).toBeUndefined();
	});

	it("says why a push stopped on a sync the user started", async () => {
		readwise.failure = new ReadwiseError("rejected", "Readwise did not accept the access token.");
		const plugin = await pluginWith();

		await plugin.syncNow();

		expect(takeNotices()).toContain("Readwise: the access token was not accepted — paste a new one in Settings → Tagged Sync → Readwise.");
	});

	it("keeps a push that throws out of the sync's report", async () => {
		readwise.failure = new TypeError("not readwise.io's");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const plugin = await pluginWith();

		await plugin.syncNow();

		expect(warn).toHaveBeenCalledWith("Tagged Sync: the Readwise push failed", readwise.failure);
		expect(pushed(plugin)).toEqual({ want: WANT });
		warn.mockRestore();
	});
});

describe("the push when a background sync finds the tablet asleep (spec §11 P22)", () => {
	type Asleep = Plugin & { autoSyncSourceReachable(): Promise<boolean>; triggerAutoSync(): Promise<void>; isSyncing(): boolean };

	async function asleep(): Promise<Asleep> {
		const plugin = (await pluginWith({ autoSync: true })) as Asleep;
		plugin.autoSyncSourceReachable = async () => false;
		return plugin;
	}

	it("pushes alone and quietly, holding the run lock while it does", async () => {
		const plugin = await asleep();
		readwise.failure = new ReadwiseError("unreachable", "Could not reach readwise.io.");
		readwise.onCall = () => readwise.locked.push(plugin.isSyncing());

		await plugin.triggerAutoSync();

		expect(engine.recorders).toEqual([]);
		expect(readwise.calls).toEqual(["books"]);
		expect(readwise.locked).toEqual([true]);
		expect(plugin.isSyncing()).toBe(false);
		expect(takeNotices()).toEqual([]);
	});

	// A run that started while the tablet was being asked about has its own push; two would send the same batch.
	it("does not push while a run holds the lock", async () => {
		const plugin = await asleep();
		plugin.autoSyncSourceReachable = async () => {
			(plugin as unknown as { syncing: boolean }).syncing = true;
			return false;
		};

		await plugin.triggerAutoSync();

		expect(readwise.calls).toEqual([]);
	});
});
