import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { FakeApp, takeNotices } from "../test-stubs/fake-obsidian";
import { registerOcrBackend } from "./ocr-registry";
import { EMPTY_SYNC_INDEX } from "./sync-engine";
import { UnavailableOcrBackend } from "./vision-ocr-backend";

// Gaps G13 and G17 -- when a background sync happens, and what stops one.
//
// Six gates decide whether an unattended run happens, and every one of them fails *silently* by
// design: no notice, no error, nothing in the console. A gate that stopped working would look
// exactly like a gate that was never reached, and two of the six are the only thing between a user
// and a cloud bill they did not agree to.
//
// The scheduling half is the same shape from the other side: a timer that leaks, or one that is
// never armed, shows up as a sync that happens too often or not at all -- months later, on somebody
// else's machine.
//
// This is the characterisation, written against the unmodified `main.ts`. The clock is a
// `FakeClock`, so "four seconds after launch" and "six hours later" are one call.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

/**
 * A backend that asks for background consent, on every platform.
 *
 * The shipped one that asks -- the local model -- registers on macOS and Windows only, so a test
 * driving it would pass here and quietly never run on CI. The rule under test is the plugin's, and
 * the registry entry is the seam it reads it through, so a purpose-built entry asks it honestly.
 */
const HUNGRY = "test-hungry";
registerOcrBackend({
	id: HUNGRY,
	label: "Hungry (test)",
	metered: false,
	requiresLicence: false,
	needsBackgroundConsent: true,
	create: () => new UnavailableOcrBackend(HUNGRY),
	backgroundConsent: {
		get: (settings) => settings.backgroundConsent === true,
		set: (settings, value) => {
			settings.backgroundConsent = value;
		},
		description: "Let it run in the background.",
	},
});

const engine = vi.hoisted(() => ({ runs: 0, fail: false }));

vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (_deps: unknown, index: unknown) => {
			engine.runs++;
			if (engine.fail) throw new Error("the cloud said no");
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
	};
});

interface Plugin {
	app: FakeApp;
	data: Record<string, unknown>;
	syncNow(): Promise<void>;
	onunload(): void;
	refreshLicence(silent?: boolean): Promise<unknown>;
}

const HOUR = 3_600_000;

/** A licence this vault has already had a valid answer for, so a Pro backend actually resolves. */
const ACTIVE_LICENCE = {
	key: "test-key",
	activationId: "test-activation",
	validatedAt: "2026-08-01T00:00:00.000Z",
	revokedAt: null,
	trialStartedAt: null,
	endedNoticeShown: false,
};

let clock: FakeClock;

interface Setup {
	enabled?: boolean;
	intervalHours?: number | null;
	autoTranscribeMetered?: boolean;
	connected?: boolean;
	backend?: string;
	providers?: Record<string, unknown>;
	lastSyncAt?: string | null;
}

async function loadWith(setup: Setup = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(
		new FakeApp(),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	plugin.saved = {
		deviceToken: setup.connected === false ? null : "device-token",
		ocrBackend: setup.backend ?? "off",
		llmProviders: setup.providers ?? {},
		licence: ACTIVE_LICENCE,
		lastSyncAt: setup.lastSyncAt ?? null,
		syncIndex: { ...EMPTY_SYNC_INDEX, rows: {} },
		autoSync: {
			enabled: setup.enabled ?? true,
			intervalHours: setup.intervalHours === undefined ? 6 : setup.intervalHours,
			autoTranscribeMetered: setup.autoTranscribeMetered ?? false,
		},
	};
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	// The real one talks to Polar. What this file is about is the gates around it.
	plugin.refreshLicence = async () => plugin.data.licence as unknown;
	takeNotices();
	return plugin;
}

/** Moves the clock and lets whatever it started finish. */
async function advance(ms: number): Promise<void> {
	clock.advance(ms);
	vi.setSystemTime(clock.now());
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** What Obsidian does once the workspace has loaded, plus the delay the launch sync waits out. */
async function launch(plugin: Plugin): Promise<void> {
	plugin.app.workspace.markLayoutReady();
	await advance(4_000);
}

beforeEach(() => {
	engine.runs = 0;
	engine.fail = false;
	clock = new FakeClock();
	vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: false });
	vi.setSystemTime(0);
	// `Date` is moved with the clock rather than after it: the interval tick asks `Date.now()` whether
	// it is due, from inside the callback, so a system time updated afterwards would answer for the
	// tick before. Step 6's injected scheduler makes this one `now()` and the wrapper goes away.
	const tick = (fn: () => void) => () => {
		vi.setSystemTime(clock.now());
		fn();
	};
	vi.stubGlobal("window", {
		setTimeout: (fn: () => void, ms: number) => clock.setTimeout(tick(fn), ms),
		clearTimeout: (id: number) => clock.clearTimeout(id),
		setInterval: (fn: () => void, ms: number) => clock.setInterval(tick(fn), ms),
		clearInterval: (id: number) => clock.clearInterval(id),
		open: () => undefined,
	});
	takeNotices();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("when a background sync is scheduled", () => {
	it("waits for the workspace before arming the launch sync", async () => {
		// Obsidian loads plugins during startup. Syncing into a workspace that is still assembling
		// itself is what the wait is for.
		await loadWith();

		await advance(60_000);

		expect(engine.runs).toBe(0);
	});

	it("does not sync in the first seconds after the workspace is ready", async () => {
		const plugin = await loadWith();
		plugin.app.workspace.markLayoutReady();

		await advance(3_999);

		expect(engine.runs).toBe(0);
	});

	it("syncs once the launch delay has passed", async () => {
		const plugin = await loadWith();

		await launch(plugin);

		expect(engine.runs).toBe(1);
	});

	it("arms the interval backstop on load", async () => {
		await loadWith({ intervalHours: 6 });

		expect(clock.armed).toBe(1);
	});

	it("arms no interval when auto-sync is off", async () => {
		await loadWith({ enabled: false });

		expect(clock.armed).toBe(0);
	});

	it("arms no interval on launch-only", async () => {
		// `null` is the "on launch only" choice in settings, not a missing value.
		await loadWith({ intervalHours: null });

		expect(clock.armed).toBe(0);
	});

	it("syncs again once the interval has elapsed", async () => {
		const plugin = await loadWith({ intervalHours: 6, lastSyncAt: null });
		await launch(plugin);
		expect(engine.runs).toBe(1);

		await advance(6 * HOUR);

		expect(engine.runs).toBe(2);
	});

	it("lets a tick pass without syncing when the interval has not elapsed", async () => {
		// The tick fires on its own period; whether it is *due* is counted from the last completed
		// sync, which is what makes a manual sync push the next auto run out.
		const plugin = await loadWith({ intervalHours: 6 });
		await launch(plugin);
		const afterLaunch = engine.runs;

		await advance(1 * HOUR);

		expect(engine.runs).toBe(afterLaunch);
	});

	it("pushes the next auto run out when the user syncs by hand", async () => {
		const plugin = await loadWith({ intervalHours: 6 });
		await launch(plugin);

		await advance(5 * HOUR);
		await plugin.syncNow();
		const afterManual = engine.runs;

		// The tick that would have been due had the manual sync not happened.
		await advance(1 * HOUR);

		expect(engine.runs).toBe(afterManual);
	});

	it("replaces the interval timer rather than stacking another one", async () => {
		// Deliberately not registerInterval(): that only clears on unload, so every re-arm would leak
		// one -- and a run re-arms.
		const plugin = await loadWith({ intervalHours: 6 });
		await launch(plugin);

		expect(clock.armed).toBe(1);
	});

	it("leaves nothing running after unload", async () => {
		const plugin = await loadWith({ intervalHours: 6 });
		plugin.app.workspace.markLayoutReady();

		plugin.onunload();

		expect(clock.armed).toBe(0);
	});
});

describe("what stops a background sync", () => {
	it("does not sync when auto-sync is switched off", async () => {
		const plugin = await loadWith({ enabled: false });

		await launch(plugin);

		expect(engine.runs).toBe(0);
	});

	it("does not sync when the device is not connected", async () => {
		const plugin = await loadWith({ connected: false });

		await launch(plugin);

		expect(engine.runs).toBe(0);
	});

	it("does not run a paid backend unattended without consent", async () => {
		// The money gate. Nothing else stands between an overnight Obsidian and a cloud bill.
		const plugin = await loadWith({
			backend: "anthropic",
			providers: { anthropic: { apiKey: "sk-test", model: "claude-test" } },
			autoTranscribeMetered: false,
		});

		await launch(plugin);

		expect(engine.runs).toBe(0);
	});

	it("runs a paid backend unattended once the user has consented", async () => {
		const plugin = await loadWith({
			backend: "anthropic",
			providers: { anthropic: { apiKey: "sk-test", model: "claude-test" } },
			autoTranscribeMetered: true,
		});

		await launch(plugin);

		expect(engine.runs).toBe(1);
	});

	it("leaves a sync the user asked for alone, consent or no consent", async () => {
		// The gate is about unattended runs. Someone who presses Sync now has just consented.
		const plugin = await loadWith({
			backend: "anthropic",
			providers: { anthropic: { apiKey: "sk-test", model: "claude-test" } },
			autoTranscribeMetered: false,
		});

		await plugin.syncNow();

		expect(engine.runs).toBe(1);
	});

	it("does not run a battery-hungry backend unattended without its own consent", async () => {
		// A separate promise from the money one: it costs nothing and still costs battery, fans and
		// several GB of RAM without anyone having asked.
		const plugin = await loadWith({ backend: HUNGRY, providers: { [HUNGRY]: {} } });

		await launch(plugin);

		expect(engine.runs).toBe(0);
	});

	it("does not let consent to spend stand in for consent to run in the background", async () => {
		const plugin = await loadWith({
			backend: HUNGRY,
			providers: { [HUNGRY]: {} },
			autoTranscribeMetered: true,
		});

		await launch(plugin);

		expect(engine.runs).toBe(0);
	});

	it("runs it unattended once it has been consented to", async () => {
		const plugin = await loadWith({ backend: HUNGRY, providers: { [HUNGRY]: { backgroundConsent: true } } });

		await launch(plugin);

		expect(engine.runs).toBe(1);
	});

	it("reads the money gate off the backend that will actually run, not the one that was chosen", async () => {
		// A cloud backend with no API key falls back to a free local one. Judging the id rather than
		// the resolved adapter would refuse a run that costs nothing.
		const plugin = await loadWith({ backend: "anthropic", providers: {}, autoTranscribeMetered: false });

		await launch(plugin);

		expect(engine.runs).toBe(1);
	});
});

describe("how loud a background sync is", () => {
	it("says nothing when it starts", async () => {
		const plugin = await loadWith();

		await launch(plugin);

		expect(takeNotices()).toEqual([]);
	});

	it("says nothing when it finds nothing to do", async () => {
		// A manual sync says "Already up to date."; a background one that did the same would be a
		// popup every six hours saying nothing happened.
		const plugin = await loadWith();

		await launch(plugin);

		expect(takeNotices()).toEqual([]);
	});

	it("stays silent when it fails", async () => {
		// Auto-sync spec: a background failure is a status-bar matter. A notice would interrupt
		// someone who never asked for the run.
		engine.fail = true;
		const plugin = await loadWith();

		await launch(plugin);

		expect(takeNotices()).toEqual([]);
	});

	it("still speaks up when the user asks for the sync", async () => {
		const plugin = await loadWith();

		await plugin.syncNow();

		expect(takeNotices()).toEqual(["Syncing…", "Already up to date."]);
	});
});
