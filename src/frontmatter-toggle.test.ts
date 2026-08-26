import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { FakeApp, Platform, takeNotices, takeSettings } from "../test-stubs/fake-obsidian";
import { NO_LICENCE } from "./licence-state";
import { registerOcrBackend } from "./ocr-registry";
import { ALREADY_RUNNING_NOTICE } from "./sync-guards";

// The wires behind the "Frontmatter properties" toggle. The passes themselves are tested in
// `frontmatter-pass.test.ts`; what had nothing was `setFrontmatterEnabled` -- whether the setting
// persists only what actually happened, which pass runs when, and whether a lapsed licence really
// stops the sync from writing keys. Same harness idea as `re-transcribe.test.ts`: the real
// `main.ts`, a faked engine and faked passes, so every assertion is about the wiring.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

const machine = vi.hoisted(() => ({ visionAvailable: false }));
vi.mock("./vision-ocr-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./vision-ocr-runtime")>();
	return {
		...actual,
		visionPlatformSupported: () => machine.visionAvailable,
		visionUnavailableReason: () => (machine.visionAvailable ? null : "macos-only"),
	};
});

const passes = vi.hoisted(() => ({
	backfill: { written: 0, skipped: 0 },
	backfillError: null as unknown,
	backfillCalls: 0,
	cleaned: 0,
	cleanupCalls: 0,
}));
vi.mock("./frontmatter-pass", () => ({
	backfillFrontmatter: async () => {
		passes.backfillCalls++;
		if (passes.backfillError !== null) throw passes.backfillError;
		return passes.backfill;
	},
	cleanupFrontmatter: async () => {
		passes.cleanupCalls++;
		return passes.cleaned;
	},
}));

const engine = vi.hoisted(() => ({
	deps: null as { frontmatter?: boolean } | null,
	/** Held open so a test can flip the toggle while a run really is in flight. */
	release: null as (() => void) | null,
}));
vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (deps: { frontmatter?: boolean }, index: unknown) => {
			engine.deps = deps;
			if (engine.release === null) await new Promise<void>((resolve) => (engine.release = resolve));
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

vi.stubGlobal("createFragment", () => ({ appendText: () => undefined, createEl: () => ({}) }));
vi.stubGlobal("window", { open: () => undefined });

registerOcrBackend({
	id: "test-free",
	label: "Test free",
	metered: false,
	requiresLicence: false,
	needsBackgroundConsent: false,
	create: () => ({ id: "test-free", metered: false, transcribe: async () => "" }) as never,
});
// A backend only a licence unlocks: what makes the pre-flight ask for a licence re-check first.
registerOcrBackend({
	id: "test-gated",
	label: "Test gated",
	metered: false,
	requiresLicence: true,
	needsBackgroundConsent: false,
	create: () => ({ id: "test-gated", metered: false, transcribe: async () => "" }) as never,
});

interface Plugin {
	data: Record<string, unknown>;
	saves: unknown[];
	syncNow(): Promise<void>;
	setFrontmatterEnabled(enabled: boolean): Promise<void>;
	refreshLicence(silent?: boolean): Promise<unknown>;
}

const TRIAL = { ...NO_LICENCE, trialStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() };

async function pluginWith(saved: Record<string, unknown> = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(
		new FakeApp(),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	plugin.saved = { deviceToken: "device-token", ocrBackend: "test-free", licence: TRIAL, ...saved };
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	takeNotices();
	takeSettings();
	return plugin;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Starts a sync and leaves it in flight; the returned function lets it finish. */
async function syncInFlight(plugin: Plugin): Promise<() => Promise<void>> {
	engine.release = null;
	const running = plugin.syncNow();
	await settle();
	takeNotices(); // the run's own "Syncing…" is not what these tests are about
	return async () => {
		engine.release?.();
		await running;
		takeNotices();
	};
}

beforeEach(() => {
	machine.visionAvailable = false;
	passes.backfill = { written: 0, skipped: 0 };
	passes.backfillError = null;
	passes.backfillCalls = 0;
	passes.cleaned = 0;
	passes.cleanupCalls = 0;
	engine.deps = null;
	engine.release = null;
	Platform.isDesktop = false;
	takeNotices();
	takeSettings();
});

describe("turning the setting on", () => {
	it("runs the backfill and persists the setting with what the pass did", async () => {
		const plugin = await pluginWith();
		passes.backfill = { written: 3, skipped: 0 };

		await plugin.setFrontmatterEnabled(true);

		expect(passes.backfillCalls).toBe(1);
		expect(plugin.data.frontmatter).toBe(true);
		expect((plugin.saves.at(-1) as { frontmatter: boolean }).frontmatter).toBe(true);
		expect(takeNotices()).toEqual(["Frontmatter properties are on. Wrote them into 3 note(s)."]);
	});

	it("says out loud what it could not reach", async () => {
		const plugin = await pluginWith();
		passes.backfill = { written: 2, skipped: 1 };

		await plugin.setFrontmatterEnabled(true);

		expect(takeNotices()).toEqual([
			"Frontmatter properties are on. Wrote them into 2 note(s); 1 could not be reached and will catch up on their next sync.",
		]);
	});

	it("keeps the setting on when the pass dies halfway -- the next sync picks up what it missed", async () => {
		const plugin = await pluginWith();
		passes.backfillError = new Error("connection lost");

		await plugin.setFrontmatterEnabled(true);

		expect(plugin.data.frontmatter).toBe(true);
		expect((plugin.saves.at(-1) as { frontmatter: boolean }).frontmatter).toBe(true);
		expect(takeNotices()).toHaveLength(1);
	});

	it("survives a throw that is not an Error, and still reports", async () => {
		// The transport layer wraps most failures, but a raw rejection from deep inside a dependency
		// arrives as whatever it was thrown as.
		const plugin = await pluginWith();
		passes.backfillError = "socket hang up";

		await plugin.setFrontmatterEnabled(true);

		expect(takeNotices()).toHaveLength(1);
	});

	it("re-checks the licence first when the selected backend is one a licence unlocks", async () => {
		// The same rule every long job follows: a lapsed card must be discovered before the run, not
		// after it has spent the user's time.
		const plugin = await pluginWith({ ocrBackend: "test-gated" });
		let refreshed = 0;
		plugin.refreshLicence = async () => {
			refreshed++;
			return { tier: "trial" };
		};

		await plugin.setFrontmatterEnabled(true);

		expect(refreshed).toBe(1);
		expect(plugin.data.frontmatter).toBe(true);
	});

	it("is refused while a sync runs, and does not pretend it is on", async () => {
		const plugin = await pluginWith();
		const finish = await syncInFlight(plugin);

		await plugin.setFrontmatterEnabled(true);

		expect(takeNotices()).toEqual([ALREADY_RUNNING_NOTICE]);
		expect(plugin.data.frontmatter).toBe(false);
		expect(passes.backfillCalls).toBe(0);
		await finish();
	});
});

describe("turning the setting off", () => {
	it("runs the cleanup pass, persists off, and says what it removed", async () => {
		const plugin = await pluginWith({ frontmatter: true });
		passes.cleaned = 2;

		await plugin.setFrontmatterEnabled(false);

		expect(passes.cleanupCalls).toBe(1);
		expect(plugin.data.frontmatter).toBe(false);
		expect((plugin.saves.at(-1) as { frontmatter: boolean }).frontmatter).toBe(false);
		expect(takeNotices()).toEqual(["Frontmatter properties are off. Removed them from 2 note(s)."]);
	});

	it("says off even when there was nothing left to remove", async () => {
		const plugin = await pluginWith({ frontmatter: true });

		await plugin.setFrontmatterEnabled(false);

		expect(takeNotices()).toEqual(["Frontmatter properties are off."]);
	});

	it("is refused while a sync runs, and the setting stays on", async () => {
		const plugin = await pluginWith({ frontmatter: true });
		const finish = await syncInFlight(plugin);

		await plugin.setFrontmatterEnabled(false);

		expect(takeNotices()).toEqual(["A sync is running. Try again when it has finished."]);
		expect(plugin.data.frontmatter).toBe(true);
		expect(passes.cleanupCalls).toBe(0);
		await finish();
	});
});

describe("the licence gate on the sync itself", () => {
	it("hands the engine the feature only while the licence allows it", async () => {
		const trial = await pluginWith({ frontmatter: true });
		engine.release = () => {};
		await trial.syncNow();
		expect(engine.deps?.frontmatter).toBe(true);

		// The same vault with the setting still on and no entitlement left: the sync keeps working,
		// minus the Pro part -- and nothing in the vault is touched to say so.
		const lapsed = await pluginWith({ frontmatter: true, licence: { ...NO_LICENCE } });
		engine.release = () => {};
		await lapsed.syncNow();
		expect(engine.deps?.frontmatter).toBe(false);
	});
});
