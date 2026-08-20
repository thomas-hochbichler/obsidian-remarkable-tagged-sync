import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { type ButtonComponent, type Command, FakeApp, Platform, type Modal, modalLog, type Setting, takeModals, takeNotices, takeSettings } from "../test-stubs/fake-obsidian";
import { NO_LICENCE } from "./licence-state";
import { registerOcrBackend } from "./ocr-registry";
import { UnavailableOcrBackend } from "./vision-ocr-backend";
import { ALREADY_RUNNING_NOTICE, NOT_CONNECTED_NOTICE, NOTHING_SYNCED_NOTICE } from "./sync-guards";

// Gap G29 -- the re-transcribe command surface and the confirmation in front of it.
//
// The engine half is covered: `reTranscribeAll` has six tests including checkpointing and stop. What
// had nothing was everything the user meets before it runs -- whether the command is offered at all,
// what the dialog says, and what happens to each of the three ways of saying no. That matters here
// more than for most dialogs: on a metered backend this command re-sends every page to a paid API,
// so a confirmation that resolves the wrong way spends the user's money on a click they did not make.
//
// This is the characterisation, written against the unmodified `main.ts` and kept afterwards.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

const machine = vi.hoisted(() => ({ visionAvailable: false }));
vi.mock("./vision-ocr-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./vision-ocr-runtime")>();
	return { ...actual, visionPlatformSupported: () => machine.visionAvailable };
});

const engine = vi.hoisted(() => ({
	updated: 0,
	stopped: false,
	calls: 0,
	/** Held open so a test can click the status bar while a run really is in flight. */
	release: null as (() => void) | null,
}));
vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (_deps: unknown, index: unknown) => {
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
		reTranscribeAll: async (_deps: unknown, index: unknown) => {
			engine.calls++;
			return { updated: engine.updated, index, stopped: engine.stopped };
		},
	};
});

/** Starts a sync and leaves it in flight; the returned function lets it finish. */
async function syncInFlight(plugin: Plugin): Promise<() => Promise<void>> {
	engine.release = null;
	const running = plugin.syncNow();
	await settle();
	return async () => {
		engine.release?.();
		await running;
		takeNotices();
	};
}

vi.stubGlobal("createFragment", () => ({ appendText: () => undefined, createEl: () => ({}) }));
vi.stubGlobal("window", { open: () => undefined });

// A backend that produces text, costs nothing, and has no sentence of its own to add.
registerOcrBackend({
	id: "test-free",
	label: "Test free",
	metered: false,
	requiresLicence: false,
	needsBackgroundConsent: false,
	create: () => ({ id: "test-free", metered: false, transcribe: async () => "" }) as never,
});
// One that is registered but not configured enough to run: `create` returns null, which is what
// makes `resolveOcrBackend` fall back -- and say so, unless it was asked silently.
registerOcrBackend({
	id: "test-unconfigured",
	label: "Test unconfigured",
	metered: false,
	requiresLicence: false,
	needsBackgroundConsent: false,
	create: () => null,
});
// One that spends money per page, and says how long it takes.
registerOcrBackend({
	id: "test-paid",
	label: "Test paid",
	metered: true,
	requiresLicence: false,
	needsBackgroundConsent: true,
	create: () => ({ id: "test-paid", metered: true, transcribe: async () => "" }) as never,
	reTranscribeCaveat: (_settings, unitCount) => ` and takes about ${unitCount} minutes`,
});

interface Plugin {
	app: FakeApp;
	data: Record<string, unknown>;
	commands: Command[];
	statusBarItems: { dispatch(type: string, event?: unknown): void }[];
	syncNow(): Promise<void>;
	isSyncing(): boolean;
	refreshLicence(silent?: boolean): Promise<unknown>;
}

const activeRows = (count: number) =>
	Object.fromEntries(
		Array.from({ length: count }, (_, i) => [`doc-${i}`, { notePath: `n${i}.md`, status: "active", blockHash: "h" }]),
	);

async function pluginWith(saved: Record<string, unknown> = {}): Promise<Plugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(
		new FakeApp(),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	plugin.saved = {
		deviceToken: "device-token",
		ocrBackend: "test-free",
		licence: { ...NO_LICENCE },
		syncIndex: { rows: activeRows(3) },
		...saved,
	};
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	plugin.refreshLicence = async () => ({ tier: "free" });
	takeNotices();
	takeModals();
	takeSettings();
	return plugin;
}

function command(plugin: Plugin, id: string): Command {
	const found = plugin.commands.find((entry) => entry.id === `${id}`);
	if (!found) throw new Error(`no command ${id}`);
	return found;
}

/** Whether the palette would show it. `checkCallback(true)` is the question Obsidian asks. */
const offered = (plugin: Plugin, id: string): boolean => command(plugin, id).checkCallback?.(true) === true;

/** The dialog on screen: its title, the paragraph, and the two buttons. */
function dialog(): { modal: Modal; title: string; body: string; cancel: ButtonComponent; confirm: ButtonComponent } {
	const modals = takeModals();
	expect(modals).toHaveLength(1);
	const modal = modals[0];
	const setting = takeSettings().at(-1) as Setting;
	return {
		modal,
		title: modal.titleEl.text,
		body: modal.contentEl.allText().join(" "),
		cancel: setting.buttons[0],
		confirm: setting.buttons[1],
	};
}

/** Lets an `onClick` promise chain finish -- the fake's `click()` cannot await it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	machine.visionAvailable = false;
	engine.updated = 0;
	engine.stopped = false;
	engine.calls = 0;
	engine.release = null;
	Platform.isDesktop = false;
	modalLog.length = 0;
	takeNotices();
	takeSettings();
});

describe("whether the re-transcribe command is offered at all", () => {
	it("is hidden with transcription switched off", async () => {
		// Pointless rather than broken: the command would fetch every notebook again and write the
		// same notes back with no transcript. Hidden from the palette instead of failing at run time.
		const plugin = await pluginWith({ ocrBackend: "off" });

		expect(offered(plugin, "re-transcribe-all")).toBe(false);
	});

	// Characterisation of a hole, not of a rule. `main.ts` says this command is hidden "when the
	// backend produces no text (Off, or **Vision on Windows/Linux**)", and the Off half works. The
	// Vision half does not: `vision`'s `create()` hands back a real `VisionOcrBackend` on every
	// desktop, and only its `recognize()` -- much later, mid-run -- answers `unavailable`. The check
	// looks for an `UnavailableOcrBackend`, and never sees one.
	//
	// Reachable, and not exotically: `data.json` is a synced file (see `settings-store.ts`), so a Mac
	// and a Windows machine on one vault share the selected backend. And the run is destructive --
	// `updateTranscript` removes the whole Transcript section for a blank result, which
	// `note-builder.test.ts` asserts on purpose. So the command that promises to hide itself here
	// instead re-fetches every notebook and strips every transcript in the vault.
	//
	// Recorded as it is. Filed as ticket 19.
	it("is offered for Apple Vision on a Windows or Linux desktop, where it produces nothing", async () => {
		Platform.isDesktop = true;
		machine.visionAvailable = false;
		const plugin = await pluginWith({ ocrBackend: "vision" });
		const backend = (plugin as unknown as { resolveOcrBackend(silent: boolean): { id: string } }).resolveOcrBackend(true);

		expect(backend.id).toBe("vision");
		expect(backend).not.toBeInstanceOf(UnavailableOcrBackend);
		expect(offered(plugin, "re-transcribe-all")).toBe(true);
	});

	it("is hidden for a backend this build does not have at all", async () => {
		// The other half of the same check, and the one that works: an id from another build resolves
		// to an `UnavailableOcrBackend`, which is what the check actually looks for.
		const plugin = await pluginWith({ ocrBackend: "test-free" });
		plugin.data.ocrBackend = "tesseract";

		expect(offered(plugin, "re-transcribe-all")).toBe(false);
	});

	it("is offered as soon as a backend that produces text is selected", async () => {
		const plugin = await pluginWith({ ocrBackend: "test-free" });

		expect(offered(plugin, "re-transcribe-all")).toBe(true);
	});

	it("asks the backend without letting it speak, so the palette cannot raise a notice", async () => {
		// The check runs every time the palette is opened, so it has to use the *silent* resolver. A
		// backend that falls back -- an unconfigured one, or a licence that lapsed -- announces the
		// fallback, and without the silent form that notice would fire for typing a letter into the
		// command palette. The backend here is one whose `create` returns null, because a backend that
		// resolves cleanly cannot tell the two forms apart, and the fallback only has something to say
		// where there is a free local backend to fall back *to*.
		Platform.isDesktop = true;
		machine.visionAvailable = true;
		const plugin = await pluginWith({ ocrBackend: "test-unconfigured" });
		offered(plugin, "re-transcribe-all");

		expect(takeNotices()).toEqual([]);
	});
});

describe("whether the stop command is offered", () => {
	it("is hidden while nothing is running, and there is nothing to confirm about it", async () => {
		// No confirmation on this one, unlike the status-bar click: a command the user went looking for
		// and named "Stop sync" *is* the intent, while a click on a status bar could be a slip.
		const plugin = await pluginWith();

		expect(offered(plugin, "stop-sync")).toBe(false);
	});
});

describe("the guards in front of the confirmation", () => {
	it("names the missing connection rather than a run the user cannot see", async () => {
		const plugin = await pluginWith({ deviceToken: null });
		await (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();

		expect(takeNotices()).toEqual([NOT_CONNECTED_NOTICE]);
		expect(takeModals()).toEqual([]);
	});

	it("refuses while a sync holds the index, without opening a dialog first", async () => {
		// The dialog is spared rather than shown and then refused: being asked to confirm something
		// that was never going to run is worse than being told why.
		const plugin = await pluginWith();
		const finish = await syncInFlight(plugin);
		await (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();

		expect(takeNotices()).toContain(ALREADY_RUNNING_NOTICE);
		expect(takeModals()).toEqual([]);
		await finish();
	});

	it("says there is nothing to re-transcribe instead of confirming a run over nothing", async () => {
		const plugin = await pluginWith({ syncIndex: { rows: {} } });
		await (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();

		expect(takeNotices()).toEqual([NOTHING_SYNCED_NOTICE]);
		expect(takeModals()).toEqual([]);
	});

	it("counts only the notes that are still in the vault", async () => {
		// An orphaned row names a note the user deleted. Re-transcribing one would write the deleted
		// note straight back.
		const plugin = await pluginWith({
			syncIndex: { rows: { a: { notePath: "a.md", status: "active" }, b: { notePath: "b.md", status: "orphaned" } } },
		});
		void (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();

		expect(dialog().body).toContain("Re-transcribe 1 synced note(s)");
	});
});

describe("what the confirmation says", () => {
	it("names the count, the backend and what the run costs in time and data", async () => {
		const plugin = await pluginWith({ ocrBackend: "test-free" });
		void (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();
		const asked = dialog();

		expect(asked.title).toBe("Re-transcribe synced notes");
		expect(asked.body).toContain("Re-transcribe 3 synced note(s)");
		expect(asked.body).toContain('"test-free" backend');
		expect(asked.body).toContain("This re-fetches each notebook from reMarkable");
		expect(asked.confirm.text).toBe("Re-transcribe");
		expect(asked.cancel.text).toBe("Cancel");
	});

	it("says nothing about money where no money is spent", async () => {
		const plugin = await pluginWith({ ocrBackend: "test-free" });
		void (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();

		expect(dialog().body).not.toContain("API quota");
	});

	it("names the API quota and the backend's own estimate where both apply", async () => {
		// The estimate is a total, not a rate: "about 3 minutes" decides the answer where "about a
		// minute a note" only hands the user a multiplication.
		const plugin = await pluginWith({ ocrBackend: "test-paid" });
		void (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();
		const body = dialog().body;

		expect(body).toContain("re-sends every page to your OCR provider, using your API quota");
		expect(body).toContain("takes about 3 minutes");
	});
});

describe("the three ways of saying no", () => {
	it("runs nothing when Cancel is pressed", async () => {
		const plugin = await pluginWith();
		const done = (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();

		dialog().cancel.click();
		await done;

		expect(engine.calls).toBe(0);
		expect(takeNotices()).toEqual([]);
	});

	it("runs nothing when the dialog is dismissed without an answer", async () => {
		// Escape and a click outside are the same path as Cancel: all three end in `onClose` with the
		// confirm flag still false, and the modal exposes nothing that tells them apart. That is the
		// characterisation -- one behaviour, three doors -- and it is why the flag defaults to false
		// rather than being set by whichever handler ran.
		const plugin = await pluginWith();
		const done = (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();

		dialog().modal.close();
		await done;

		expect(engine.calls).toBe(0);
	});

	it("runs, and says how many it refreshed, when the answer is yes", async () => {
		engine.updated = 3;
		const plugin = await pluginWith();
		const done = (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();

		dialog().confirm.click();
		await done;

		expect(engine.calls).toBe(1);
		expect(takeNotices()).toEqual(["Re-transcribed 3 note(s)."]);
	});

	it("says a stopped run kept what it did, rather than reporting plain success", async () => {
		engine.updated = 1;
		engine.stopped = true;
		const plugin = await pluginWith();
		const done = (plugin as unknown as { reTranscribeAll(): Promise<void> }).reTranscribeAll();
		await settle();

		dialog().confirm.click();
		await done;

		expect(takeNotices()).toEqual(["Re-transcribe stopped. 1 note(s) refreshed; the rest are unchanged."]);
	});
});

describe("the dialog the status bar opens", () => {
	it("does not ask about stopping a run that is not happening", async () => {
		// The item stays on screen after a run ends, showing its outcome. Clicking that should do
		// nothing rather than explain itself.
		const plugin = await pluginWith();
		plugin.statusBarItems[0].dispatch("click");
		await settle();

		expect(takeModals()).toEqual([]);
	});

	it("states the delay, because a stop that keeps spinning reads as a broken button", async () => {
		const plugin = await pluginWith();
		const finish = await syncInFlight(plugin);
		plugin.statusBarItems[0].dispatch("click");
		await settle();
		const asked = dialog();

		expect(asked.title).toBe("Stop sync");
		expect(asked.body).toContain("finished first, so this can take a moment");
		expect(asked.body).toContain("Everything already written is kept");
		expect(asked.confirm.text).toBe("Stop");

		asked.cancel.click();
		await finish();
	});

	it("stops the run on yes and leaves it alone on no", async () => {
		const plugin = await pluginWith();
		const finish = await syncInFlight(plugin);
		plugin.statusBarItems[0].dispatch("click");
		await settle();
		dialog().cancel.click();
		await settle();
		expect((plugin as unknown as { stopRequested: boolean }).stopRequested).toBe(false);

		plugin.statusBarItems[0].dispatch("click");
		await settle();
		dialog().confirm.click();
		await settle();
		expect((plugin as unknown as { stopRequested: boolean }).stopRequested).toBe(true);
		await finish();
	});

	it("does not ask twice while the first stop is still pending", async () => {
		const plugin = await pluginWith();
		const finish = await syncInFlight(plugin);
		plugin.statusBarItems[0].dispatch("click");
		await settle();
		dialog().confirm.click();
		await settle();

		plugin.statusBarItems[0].dispatch("click");
		await settle();
		expect(takeModals()).toEqual([]);
		await finish();
	});
});
