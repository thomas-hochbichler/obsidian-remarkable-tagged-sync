import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { FakeApp, takeNotices, takeSettings } from "../test-stubs/fake-obsidian";
import { EMPTY_SYNC_INDEX } from "./sync-engine";

// Gap G15 -- one run at a time. Both long jobs share a single `syncing` flag and a single sync
// index, and the only thing standing between two runs and the index they would both write is a
// three-line pre-flight neither job has a test for.
//
// This is the characterisation, written against the unmodified `main.ts` and kept afterwards. It
// drives the shipped `syncNow()` and `reTranscribeAll()` the way a command palette entry does, with
// the engine mocked so a run can be held open for as long as the test needs.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

/**
 * The engine, replaced. A real run is a network conversation; what this file is about is who is
 * allowed to start one, so the run itself is reduced to a counter and a gate the test opens.
 */
const engine = vi.hoisted(() => ({
	syncRuns: 0,
	reTranscribeRuns: 0,
	hold: null as Promise<void> | null,
}));

vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (_deps: unknown, index: unknown) => {
			engine.syncRuns++;
			if (engine.hold) await engine.hold;
			return {
				index,
				stopped: false,
				notesWritten: 0,
				unavailableOcrUnits: 0,
				failedOcrUnits: 0,
				editedNotesSkipped: 0,
				documentsSkipped: 0,
				shrunkNotes: 0,
				relaidDocuments: 0,
				skipErrors: [],
			};
		},
		reTranscribeAll: async (_deps: unknown, index: unknown) => {
			engine.reTranscribeRuns++;
			if (engine.hold) await engine.hold;
			return { updated: 0, index, stopped: false };
		},
	};
});

interface Plugin {
	data: Record<string, unknown>;
	syncNow(): Promise<void>;
	reTranscribeAll(): Promise<void>;
	isSyncing(): boolean;
	refreshLicence(silent?: boolean): Promise<unknown>;
}

/** Every `refreshLicence` the pre-flight asked for, as its `silent` argument. */
let licenceChecks: boolean[] = [];

function activeRow(notePath: string) {
	return { docId: "doc-1", unitId: "unit-1", notePath, status: "active" };
}

async function pluginWith(setup: { connected?: boolean; backend?: string; rows?: number } = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(
		new FakeApp(),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	const rows: Record<string, unknown> = {};
	for (let i = 0; i < (setup.rows ?? 1); i++) rows[`unit-${i}`] = activeRow(`Notes/${i}.md`);
	plugin.saved = {
		deviceToken: setup.connected === false ? null : "device-token",
		ocrBackend: setup.backend ?? "off",
		syncIndex: { ...EMPTY_SYNC_INDEX, rows },
	};
	// A clock nobody moves: the interval backstop arms and never fires.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();

	// Swapped rather than spied on: the real one talks to Polar, and what this file needs to know is
	// only whether the pre-flight asked and how loudly.
	licenceChecks = [];
	plugin.refreshLicence = async (silent = false) => {
		licenceChecks.push(silent);
		return { tier: "free" };
	};
	takeNotices();
	return plugin;
}

function deferred(): { promise: Promise<void>; open: () => void } {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The confirm dialog draws one `Setting` carrying Cancel and the confirm button, in that order. */
function dialogButtons() {
	const row = takeSettings().at(-1);
	if (!row) throw new Error("no dialog is open");
	return row.buttons;
}

const confirmDialog = () => dialogButtons().at(-1)?.click();
const cancelDialog = () => dialogButtons().at(0)?.click();

beforeEach(() => {
	engine.syncRuns = 0;
	engine.reTranscribeRuns = 0;
	engine.hold = null;
	takeNotices();
	takeSettings();
});

describe("what has to be true before a sync starts", () => {
	it("refuses to sync without a device token, and says which thing is missing", async () => {
		const plugin = await pluginWith({ connected: false });

		await plugin.syncNow();

		expect(takeNotices()).toEqual(["Connect to reMarkable first."]);
		expect(engine.syncRuns).toBe(0);
	});

	it("refuses a second sync while one is running", async () => {
		const plugin = await pluginWith();
		const gate = deferred();
		engine.hold = gate.promise;

		const first = plugin.syncNow();
		await settle();
		takeNotices();

		await plugin.syncNow();

		expect(takeNotices()).toEqual(["A sync is already running."]);
		expect(engine.syncRuns).toBe(1);

		gate.open();
		await first;
	});

	it("refuses a re-transcribe while a sync is running", async () => {
		const plugin = await pluginWith();
		const gate = deferred();
		engine.hold = gate.promise;

		const first = plugin.syncNow();
		await settle();
		takeNotices();

		await plugin.reTranscribeAll();

		expect(takeNotices()).toEqual(["A sync is already running."]);
		expect(engine.reTranscribeRuns).toBe(0);

		gate.open();
		await first;
	});

	it("checks the connection before the running job -- an unplugged user is told the more useful thing", async () => {
		const plugin = await pluginWith({ connected: false });
		const gate = deferred();
		engine.hold = gate.promise;
		// Reachable: the connection can be dropped in settings while a run is in flight.
		(plugin as unknown as { syncing: boolean }).syncing = true;

		await plugin.syncNow();

		expect(takeNotices()).toEqual(["Connect to reMarkable first."]);
		gate.open();
	});

	it("lets the sync through once nothing is in the way", async () => {
		const plugin = await pluginWith();

		await plugin.syncNow();

		expect(engine.syncRuns).toBe(1);
		expect(plugin.isSyncing()).toBe(false);
	});

	it("re-reads the licence before a sync on a backend that needs one", async () => {
		const plugin = await pluginWith({ backend: "anthropic" });

		await plugin.syncNow();

		expect(licenceChecks).toEqual([false]);
	});

	it("causes no licence call at all on a backend that needs none", async () => {
		// The promise a free user never talks to Polar. `off` and `vision` are both ungated.
		const plugin = await pluginWith({ backend: "off" });

		await plugin.syncNow();

		expect(licenceChecks).toEqual([]);
	});

	it("re-reads the licence before a re-transcribe too", async () => {
		const plugin = await pluginWith({ backend: "anthropic", rows: 0 });

		await plugin.reTranscribeAll();

		expect(licenceChecks).toEqual([false]);
	});
});

describe("what has to be true before a re-transcribe starts", () => {
	it("refuses without a device token", async () => {
		const plugin = await pluginWith({ connected: false });

		await plugin.reTranscribeAll();

		expect(takeNotices()).toEqual(["Connect to reMarkable first."]);
		expect(engine.reTranscribeRuns).toBe(0);
	});

	it("says there is nothing to re-transcribe when no note has been synced", async () => {
		const plugin = await pluginWith({ rows: 0 });

		await plugin.reTranscribeAll();

		expect(takeNotices()).toEqual(["No synced notes to re-transcribe yet."]);
		expect(engine.reTranscribeRuns).toBe(0);
	});

	it("counts only the rows a note still stands behind", async () => {
		// A row goes `orphaned` when its note is gone from the vault -- the user deleted it. Offering to
		// re-transcribe one would offer to write it straight back.
		const plugin = await pluginWith({ rows: 0 });
		plugin.data.syncIndex = {
			...EMPTY_SYNC_INDEX,
			rows: { a: { ...activeRow("Notes/a.md"), status: "orphaned" } },
		};

		await plugin.reTranscribeAll();

		expect(takeNotices()).toEqual(["No synced notes to re-transcribe yet."]);
	});

	it("starts nothing until the dialog is answered", async () => {
		// The wording of that dialog is step 10 of the cut. What belongs here is only that a run this
		// expensive never begins on the pre-flight alone.
		const plugin = await pluginWith({ rows: 2 });

		const run = plugin.reTranscribeAll();
		await settle();

		expect(engine.reTranscribeRuns).toBe(0);
		expect(takeNotices()).toEqual([]);

		cancelDialog();
		await run;
		expect(engine.reTranscribeRuns).toBe(0);
	});
});

describe("two runs at once", () => {
	it("does not let two presses of Sync now become two runs", async () => {
		// The pre-flight reads the flag, then awaits -- the licence re-check, and the `async` call
		// itself. Both presses get through the check before either sets the flag, and then both write
		// the one sync index.
		const plugin = await pluginWith();
		const gate = deferred();
		engine.hold = gate.promise;

		const both = Promise.all([plugin.syncNow(), plugin.syncNow()]);
		await settle();

		expect(engine.syncRuns).toBe(1);

		gate.open();
		await both;
	});

	it("re-checks the lock after the confirmation dialog, not only before it", async () => {
		// The dialog can sit open for as long as the user leaves it. Everything the pre-flight
		// established is stale by the time they answer, and a sync started in between is running.
		const plugin = await pluginWith({ rows: 2 });
		const confirmation = plugin.reTranscribeAll();
		await settle();

		const gate = deferred();
		engine.hold = gate.promise;
		const sync = plugin.syncNow();
		await settle();
		takeNotices();

		confirmDialog();
		await settle();

		expect(engine.reTranscribeRuns).toBe(0);
		expect(takeNotices()).toEqual(["A sync is already running."]);

		gate.open();
		await Promise.all([confirmation, sync]);
	});
});
