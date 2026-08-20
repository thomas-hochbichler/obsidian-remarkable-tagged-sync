import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { FakeApp, type FakeEl, noticeLog, takeNotices } from "../test-stubs/fake-obsidian";
import { EMPTY_SYNC_INDEX } from "./sync-engine";

// Gaps G27 and G34 -- everything the plugin says about a run, and the one thing it says once.
//
// Every *condition* reported here is tested in the engine; not one *sentence* was. That split is the
// whole risk: a sync that quietly skipped six notes and a sync that did everything look identical
// from outside if the announcing code stops working, and the announcement is the only place the
// difference exists. Same for the status item -- it is the only thing on screen during a run, and a
// bar left at 100% or an icon stuck on the spinner claims a state the plugin is not in.
//
// This is the characterisation, written against the unmodified `main.ts` and kept afterwards.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

const engine = vi.hoisted(() => ({
	ticks: [] as unknown[],
	result: {} as Record<string, unknown>,
	fail: false,
	hold: null as Promise<void> | null,
}));

vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (deps: { onProgress?: (progress: unknown) => void }, index: unknown) => {
			for (const tick of engine.ticks) deps.onProgress?.(tick);
			if (engine.hold) await engine.hold;
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
				...engine.result,
			};
		},
	};
});

interface Plugin {
	app: FakeApp;
	data: Record<string, unknown>;
	statusBarItems: FakeEl[];
	syncNow(): Promise<void>;
	stopSync(): void;
	refreshLicence(silent?: boolean): Promise<unknown>;
}

async function loadWith(saved: Record<string, unknown> = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(
		new FakeApp(),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	plugin.saved = {
		deviceToken: "device-token",
		ocrBackend: "off",
		syncIndex: { ...EMPTY_SYNC_INDEX, rows: {} },
		...saved,
	};
	// A clock nobody moves: the launch sync never comes due, so nothing runs behind these assertions.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	plugin.refreshLicence = async () => ({ tier: "free" });
	takeNotices();
	return plugin;
}

/** The one status bar item, as the user sees it. */
function status(plugin: Plugin) {
	const item = plugin.statusBarItems[0];
	const [icon, bar, text, name] = item.children;
	return {
		item,
		icon: icon.attributes["data-icon"],
		spinning: item.classes.has("is-busy"),
		clickable: item.classes.has("mod-clickable"),
		tooltip: item.attributes["aria-label"] ?? "",
		barVisible: bar.visible,
		text: text.visible ? text.text : null,
		document: name.visible ? name.text : null,
		visible: item.visible,
	};
}

function deferred(): { promise: Promise<void>; open: () => void } {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs a sync held open after its last progress tick, so the busy state can be read. */
async function duringSync(plugin: Plugin, ticks: unknown[]): Promise<{ finish: () => Promise<void> }> {
	const gate = deferred();
	engine.hold = gate.promise;
	engine.ticks = ticks;
	const run = plugin.syncNow();
	await settle();
	return {
		finish: async () => {
			gate.open();
			await run;
		},
	};
}

beforeEach(() => {
	engine.ticks = [];
	engine.result = {};
	engine.fail = false;
	engine.hold = null;
	takeNotices();
});

describe("what the status item shows while a sync runs", () => {
	it("spins, and offers to stop", async () => {
		const plugin = await loadWith();
		const run = await duringSync(plugin, []);

		expect(status(plugin)).toMatchObject({ icon: "refresh-cw", spinning: true, clickable: true, visible: true });
		expect(status(plugin).tooltip).toContain("Click to stop the sync");

		await run.finish();
	});

	it("counts documents during the scan, with no bar, because how much there is to do is what is not known yet", async () => {
		const plugin = await loadWith();
		const run = await duringSync(plugin, [
			{ phase: "scanning", checked: 3, candidates: 12, document: "Reading List" },
		]);

		expect(status(plugin)).toMatchObject({
			text: "checking 3 of 12 ·",
			document: "Reading List",
			barVisible: false,
		});

		await run.finish();
	});

	it("says it is scanning while it still has nothing to count", async () => {
		// `candidates` is 0 until the enumeration comes back. "checking 0 of 0" reads as a finished
		// run that found nothing.
		const plugin = await loadWith();
		const run = await duringSync(plugin, [{ phase: "scanning", checked: 0, candidates: 0 }]);

		expect(status(plugin).text).toBe("Tagged Sync: scanning…");

		await run.finish();
	});

	it("drops the separator when there is no document name to put after it", async () => {
		const plugin = await loadWith();
		const run = await duringSync(plugin, [{ phase: "scanning", checked: 3, candidates: 12 }]);

		expect(status(plugin).text).toBe("checking 3 of 12");
		expect(status(plugin).document).toBeNull();

		await run.finish();
	});

	it("fills the bar against the work it counted, and shows the name instead of a prefix", async () => {
		const plugin = await loadWith();
		const run = await duringSync(plugin, [
			{ phase: "working", done: 3, total: 12, document: "Reading List", tag: "sync", step: "rendering", unitDone: 1, unitTotal: 4 },
		]);

		expect(status(plugin)).toMatchObject({ barVisible: true, document: "Reading List", text: null });
		expect(barValue(plugin)).toBe(25);

		await run.finish();
	});

	it("never lets the bar past full, however the count was measured", async () => {
		// A pre-scan that under-counted would otherwise drive a bar past 100 and the plugin would look
		// broken at exactly the moment it is nearly done.
		const plugin = await loadWith();
		const run = await duringSync(plugin, [
			{ phase: "working", done: 20, total: 12, document: "Reading List", tag: "sync", step: "rendering", unitDone: 1, unitTotal: 1 },
		]);

		expect(barValue(plugin)).toBe(100);

		await run.finish();
	});

	it("puts the whole story in the tooltip, which is where there is room for it", async () => {
		const plugin = await loadWith();
		const run = await duringSync(plugin, [
			{ phase: "working", done: 3, total: 12, document: "Reading List", tag: "sync", step: "transcribing", unitDone: 2, unitTotal: 4 },
		]);

		expect(status(plugin).tooltip).toContain("Reading List\ntag: sync · page 2 of 4 · transcribing");

		await run.finish();
	});
});

describe("what the status item shows once a sync ends", () => {
	it("checks off a run that wrote notes, and says how many", async () => {
		const plugin = await loadWith();
		engine.result = { notesWritten: 3 };

		await plugin.syncNow();

		expect(status(plugin)).toMatchObject({ icon: "check", spinning: false, clickable: false, text: "Tagged Sync: 3 note(s)" });
	});

	it("says up to date when there was nothing to write", async () => {
		const plugin = await loadWith();

		await plugin.syncNow();

		expect(status(plugin).text).toBe("Tagged Sync: up to date");
	});

	it("hides the bar when the run ends, rather than leaving it sitting at full", async () => {
		// A bar left at 100% claims the run is still happening.
		const plugin = await loadWith();
		engine.ticks = [
			{ phase: "working", done: 12, total: 12, document: "Reading List", tag: "sync", step: "writing", unitDone: 4, unitTotal: 4 },
		];

		await plugin.syncNow();

		expect(status(plugin).barVisible).toBe(false);
	});

	it("gives a stopped run its own icon, because a check and a cross would both lie about it", async () => {
		const plugin = await loadWith();
		engine.result = { stopped: true, notesWritten: 2 };

		await plugin.syncNow();

		expect(status(plugin)).toMatchObject({ icon: "square", text: "Tagged Sync: stopped · 2 note(s)" });
	});

	it("crosses out a run that threw", async () => {
		const plugin = await loadWith();
		engine.fail = true;

		await plugin.syncNow();

		expect(status(plugin)).toMatchObject({ icon: "x", spinning: false, text: "Tagged Sync: sync failed" });
	});

	it("stops offering to stop once the user has asked it to, and freezes the bar where it stands", async () => {
		// The bar freezes rather than emptying: the work already done is not undone by stopping.
		const plugin = await loadWith();
		const run = await duringSync(plugin, [
			{ phase: "working", done: 6, total: 12, document: "Reading List", tag: "sync", step: "rendering", unitDone: 1, unitTotal: 2 },
		]);

		(plugin as unknown as { requestStop(): void }).requestStop();
		progressTick(plugin, { phase: "working", done: 9, total: 12, document: "Reading List", tag: "sync", step: "writing", unitDone: 2, unitTotal: 2 });

		expect(status(plugin)).toMatchObject({ clickable: false, text: "Tagged Sync: stopping…" });
		expect(status(plugin).tooltip).not.toContain("Click to stop");
		expect(barValue(plugin)).toBe(50);

		await run.finish();
	});
});

describe("what a sync says when it finished but did not do everything", () => {
	it("says nothing at all when nothing was skipped", async () => {
		const plugin = await loadWith();
		engine.result = { notesWritten: 1 };

		await plugin.syncNow();

		expect(takeNotices()).toEqual(["Syncing…", "Synced 1 note(s)."]);
	});

	it("names failed transcription, and keeps the render out of the bad news", async () => {
		const plugin = await loadWith();
		engine.result = { failedOcrUnits: 1 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toBe(
			"1 note synced without a transcript because transcription failed. " +
				"The handwriting render is still there. Press Copy diagnostics in settings if it keeps happening.",
		);
	});

	it("pluralises failed transcription", async () => {
		const plugin = await loadWith();
		engine.result = { failedOcrUnits: 2 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toContain("2 notes synced without a transcript");
	});

	it("says which notes it refused to overwrite, and what to do about it", async () => {
		const plugin = await loadWith();
		engine.result = { editedNotesSkipped: 1 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toBe(
			"1 note was not updated because they were edited. " +
				"Tagged Sync only rewrites notes it wrote itself. " +
				"Undo the change to resume syncing, and keep your own text in a separate note.",
		);
	});

	it("pluralises the refused notes", async () => {
		const plugin = await loadWith();
		engine.result = { editedNotesSkipped: 2 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toContain("2 notes were not updated");
	});

	it("says how many notebooks it could not read", async () => {
		const plugin = await loadWith();
		engine.result = { documentsSkipped: 1 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toBe("1 notebook was skipped — see the developer console for details.");
	});

	it("pluralises skipped notebooks", async () => {
		const plugin = await loadWith();
		engine.result = { documentsSkipped: 3 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toContain("3 notebooks were skipped");
	});

	it("warns that a re-laid-out book's quotes may describe other sentences now", async () => {
		// Nothing else will ever flag this: the marks stay, the text moves under them, and the quotes
		// go on looking perfectly plausible.
		const plugin = await loadWith();
		engine.result = { relaidDocuments: 1 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toContain("1 book has been laid out again on the tablet");
	});

	it("pluralises re-laid-out books", async () => {
		const plugin = await loadWith();
		engine.result = { relaidDocuments: 2 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toContain("2 books have been laid out again");
	});

	it("says a note came back with fewer highlights than it had", async () => {
		const plugin = await loadWith();
		engine.result = { shrunkNotes: 1 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toContain("1 note has fewer highlights than the last sync wrote");
	});

	it("pluralises shrunk notes", async () => {
		const plugin = await loadWith();
		engine.result = { shrunkNotes: 4 };

		await plugin.syncNow();

		expect(takeNotices().at(-1)).toContain("4 notes have fewer highlights");
	});

	it("raises all five in one fixed order, worst first", async () => {
		// The order is the point: notices stack and the last one raised sits on top, so whichever is
		// raised last is the one a user standing up from their desk actually reads.
		const plugin = await loadWith();
		engine.result = {
			notesWritten: 1,
			failedOcrUnits: 1,
			editedNotesSkipped: 1,
			documentsSkipped: 1,
			relaidDocuments: 1,
			shrunkNotes: 1,
		};

		await plugin.syncNow();

		expect(takeNotices().map((notice) => notice.slice(0, 24))).toEqual([
			"Syncing…",
			"Synced 1 note(s).",
			"1 note synced without a ",
			"1 note was not updated b",
			"1 notebook was skipped —",
			"1 book has been laid out",
			"1 note has fewer highlig",
		]);
	});

	it("says none of it on a background run, while still announcing the notes it wrote", async () => {
		// Nobody is at the keyboard. A stack of notices about a run the user did not ask for is how a
		// plugin gets uninstalled -- and every one of them is still in the diagnostics block. New
		// notes are the exception on purpose: that one is good news and is why auto-sync is on.
		const plugin = await loadWith({ autoSync: { enabled: true, intervalHours: 6, autoTranscribeMetered: false } });
		engine.result = { notesWritten: 1, editedNotesSkipped: 2, shrunkNotes: 1 };

		await (plugin as unknown as { triggerAutoSync(): Promise<void> }).triggerAutoSync();

		expect(takeNotices()).toEqual(["Synced 1 note(s)."]);
	});

	it("does not even say 'up to date' on a background run that found nothing", async () => {
		// The one notice a background run must never raise: it would fire every six hours, forever,
		// to report that nothing happened.
		const plugin = await loadWith({ autoSync: { enabled: true, intervalHours: 6, autoTranscribeMetered: false } });

		await (plugin as unknown as { triggerAutoSync(): Promise<void> }).triggerAutoSync();

		expect(takeNotices()).toEqual([]);
	});

	it("says all of it on a background run the user stopped by hand", async () => {
		// They are at the keyboard, watching, and owed the same reporting a manual sync gets.
		const plugin = await loadWith({ autoSync: { enabled: true, intervalHours: 6, autoTranscribeMetered: false } });
		engine.result = { stopped: true, notesWritten: 1, editedNotesSkipped: 2 };

		await (plugin as unknown as { triggerAutoSync(): Promise<void> }).triggerAutoSync();

		expect(takeNotices().join("\n")).toContain("2 notes were not updated");
	});

	it("leaves the ones that did not happen unsaid", async () => {
		const plugin = await loadWith();
		engine.result = { notesWritten: 1, editedNotesSkipped: 2 };

		await plugin.syncNow();

		expect(takeNotices()).toEqual([
			"Syncing…",
			"Synced 1 note(s).",
			expect.stringContaining("2 notes were not updated"),
		]);
	});
});

describe("what a sync records for the diagnostics block", () => {
	it("keeps the skip errors, so Last error does not read none after a run that skipped things", async () => {
		const plugin = await loadWith();
		engine.result = { skipErrors: ["Reading List: page 4 would not render", "Notes: no scene"] };

		await plugin.syncNow();

		expect((plugin as unknown as { lastSyncError: string | null }).lastSyncError).toBe(
			"Reading List: page 4 would not render\nNotes: no scene",
		);
	});

	it("clears a stale error after a clean run, so diagnostics describes the latest sync", async () => {
		const plugin = await loadWith();
		engine.result = { skipErrors: ["something"] };
		await plugin.syncNow();

		engine.result = {};
		await plugin.syncNow();

		expect((plugin as unknown as { lastSyncError: string | null }).lastSyncError).toBeNull();
	});
});

describe("the one-time notice about what this platform cannot transcribe", () => {
	it("explains the gap the first time a sync produces a note it could not transcribe", async () => {
		const plugin = await loadWith();
		engine.result = { unavailableOcrUnits: 1 };

		await plugin.syncNow();

		expect(takeNotices().join("\n")).toContain("Text transcription needs macOS 13 or later");
	});

	it("stays silent when every note was transcribable", async () => {
		const plugin = await loadWith();

		await plugin.syncNow();

		expect(takeNotices().join(" ")).not.toContain("macOS 13");
	});

	it("says it once and never again", async () => {
		const plugin = await loadWith();
		engine.result = { unavailableOcrUnits: 1 };
		await plugin.syncNow();
		takeNotices();

		await plugin.syncNow();

		expect(takeNotices().join(" ")).not.toContain("macOS 13");
	});

	it("is still silent after a restart, because the flag is written to data.json", async () => {
		// The whole promise is "once", and a flag kept in memory would say it again every morning.
		const plugin = await loadWith();
		engine.result = { unavailableOcrUnits: 1 };
		await plugin.syncNow();

		const restarted = await loadWith({ ocrUnavailableNoticeShown: true });
		takeNotices();
		await restarted.syncNow();

		expect(plugin.data.ocrUnavailableNoticeShown).toBe(true);
		expect(takeNotices().join(" ")).not.toContain("macOS 13");
	});

	it("gives the partial-outcome notices room to be read", async () => {
		// Not a detail: these sentences ask the user to go and do something, and Obsidian's default
		// notice is gone in five seconds.
		const plugin = await loadWith();
		engine.result = { editedNotesSkipped: 1, unavailableOcrUnits: 1 };

		await plugin.syncNow();

		expect(noticeLog.filter((notice) => notice.timeout !== undefined).map((notice) => notice.timeout)).toEqual([
			15_000, 15_000,
		]);
	});
});

/** One more progress tick into a run that is already held open. */
function progressTick(plugin: Plugin, progress: unknown): void {
	(plugin as unknown as { showProgress(progress: unknown): void }).showProgress(progress);
}

function barValue(plugin: Plugin): number {
	return (plugin as unknown as { statusProgress: { value: number } }).statusProgress.value;
}
