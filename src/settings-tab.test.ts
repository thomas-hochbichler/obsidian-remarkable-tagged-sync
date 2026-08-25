import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import {
	type ButtonComponent,
	createFragment,
	type DropdownComponent,
	FakeApp,
	type FakeEl,
	Platform,
	type Setting,
	takeNotices,
	takeSettings,
	type TextComponent,
	type ToggleComponent,
} from "../test-stubs/fake-obsidian";
import { DEFAULT_ATTACHMENTS_FOLDER } from "./attachment-writer";
import { explainError } from "./explain-error";
import {
	ACTIVATION_LIMIT_MESSAGE,
	OFFLINE_ACTIVATION_MESSAGE,
	WITHDRAWN_KEY_MESSAGE,
	WRONG_KEY_MESSAGE,
} from "./licence-messages";
import { NO_LICENCE } from "./licence-state";
import { isListedBackend, type OcrBackendEntry, ocrBackendEntries, registerOcrBackend } from "./ocr-registry";

// Gap G28 -- the settings tab. `main.ts` and `local-register.ts` are the only files that construct a
// `Setting`, and neither had a test file: every string, state and rule *below* the tab is verified
// and every **wire** is not. A dropdown that lists a backend the build cannot run, a toggle that
// changes the value and never saves it, a Pro section that offers "Start free trial" to somebody who
// already used theirs -- all of it passes the whole suite today.
//
// This is the characterisation, written against the unmodified `main.ts` and kept afterwards. It is
// what says the extraction that follows changed nothing.
//
// Driven through `src/entry.ts` for the reason `ocr-backend-choice.test.ts` gives: `entry.ts` is what
// Obsidian actually loads, and `main.ts` alone leaves a registry of `vision` and `off`.

const cloud = vi.hoisted(() => ({ register: async (_code: string): Promise<string> => "device-token" }));
vi.mock("rmapi-js", () => ({
	session: () => ({}),
	auth: async () => "session-token",
	register: (code: string) => cloud.register(code),
}));

// Whether Apple Vision can run is a property of the machine the test runs on, and the dropdown, the
// note contract hint and the default backend all turn on it. Left real, this file would say one thing
// on a Mac and another on CI.
const machine = vi.hoisted(() => ({ visionAvailable: false }));
vi.mock("./vision-ocr-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./vision-ocr-runtime")>();
	// Both, and not only the boolean: `visionPlatformSupported()` is defined as
	// `visionUnavailableReason() === null`, so mocking one and leaving the other real lets them
	// disagree -- and the one left real reads `os.platform()`, which is the machine the test happens
	// to run on. That is how a test passes on a Mac and fails on CI, or worse, passes on both for
	// opposite reasons.
	return {
		...actual,
		visionPlatformSupported: () => machine.visionAvailable,
		visionUnavailableReason: () => (machine.visionAvailable ? null : "macos-only"),
	};
});

// Two globals Obsidian supplies and vitest does not, both reached before this file gets anywhere near
// what it is about. `createFragment` is modelled in the fake, read out of Obsidian's `enhance.js`;
// `window.open` is the platform's and there is nothing to model.
vi.stubGlobal("createFragment", createFragment);
const opened: string[] = [];
vi.stubGlobal("window", { open: (url: string) => opened.push(url) });
const copied: string[] = [];
vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => void copied.push(text) } });

// --- test backends ------------------------------------------------------------------------------
//
// Four combinations of `unavailableLabel()` and `renderSetup`, because the listing rule is a rule
// about that pair and this build ships no machine on which all four are reachable: the managed local
// model is the only entry with a card, and it does not even register off a supported desktop. Adding
// them to the real registry rather than testing the predicate again is the point -- what is untested
// is the *wire* between the rule and the dropdown.

const setupCards: string[] = [];
const settingsRows: string[] = [];

function testBackend(id: string, extra: Partial<OcrBackendEntry> = {}): OcrBackendEntry {
	return {
		id,
		label: `Test ${id}`,
		metered: false,
		requiresLicence: false,
		needsBackgroundConsent: false,
		create: () => null,
		renderSetup: (containerEl, ctx) => {
			setupCards.push(`${id}${ctx.isSelected ? " (selected)" : ""}`);
			(containerEl as unknown as FakeEl).createDiv({ cls: "test-card", text: `card:${id}` });
		},
		...extra,
	} as OcrBackendEntry;
}

/** Runs here, no card. Listed and enabled -- and its rows appear only while it is selected. */
registerOcrBackend(
	testBackend("test-plain", {
		renderSetup: undefined,
		renderSettings: (containerEl, ctx) => {
			settingsRows.push(`test-plain${ctx.isSelected ? " (selected)" : ""}`);
			(containerEl as unknown as FakeEl).createDiv({ cls: "test-rows", text: "rows:test-plain" });
		},
	}),
);
/** A gap nothing can fix and no card to explain it: shown, disabled, with the reason in its place. */
registerOcrBackend(testBackend("test-gap", { renderSetup: undefined, unavailableLabel: () => "Test — not here" }));
/** A gap its own card is already explaining: hidden, so it cannot be selected into a dead setting. */
registerOcrBackend(testBackend("test-carded", { unavailableLabel: () => "Test — not ready" }));
/** A card and no gap: listed, and the card still renders. */
registerOcrBackend(testBackend("test-ready-card"));
/** Has a sentence of its own about what its transcripts look like. */
const CONTRACT = "Test backend: headings, lists and tables.";
registerOcrBackend(testBackend("test-contract", { noteContract: CONTRACT }));
/** Needs consent to run unattended and says how to store it -- both halves, which is the rule. */
const consented = { description: "Test consent row." } as const;
registerOcrBackend(
	testBackend("test-consent", {
		renderSetup: undefined,
		needsBackgroundConsent: true,
		backgroundConsent: {
			get: (settings) => settings.ok === true,
			set: (settings, value) => {
				settings.ok = value;
			},
			description: consented.description,
		},
	}),
);
/** Declares the need and forgets the accessors -- the half-declared pair, from the tab's side. */
registerOcrBackend(testBackend("test-half-consent", { renderSetup: undefined, needsBackgroundConsent: true }));

// --- harness ------------------------------------------------------------------------------------

interface Tab {
	containerEl: FakeEl;
	display(): void;
}

interface Plugin {
	data: Record<string, unknown>;
	saves: unknown[];
	saved: unknown;
	settingTabs: Tab[];
	rearmAutoSyncInterval(): void;
}

async function tabWith(saved: Record<string, unknown> = {}): Promise<{ plugin: Plugin; tab: Tab }> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin)(new FakeApp(), {
		id: "tagged-sync",
		name: "Tagged Sync",
		version: "9.9.9",
	});
	plugin.saved = { ocrBackend: "off", licence: { ...NO_LICENCE }, ...saved };
	// A clock nobody moves: the launch sync never comes due, so nothing runs behind these assertions.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	takeSettings();
	takeNotices();
	return { plugin, tab: plugin.settingTabs[0] };
}

/** One thing the tab drew, in draw order -- a `Setting` row, a heading, or a bare note div. */
type Drawn =
	| { kind: "heading"; name: string }
	| { kind: "row"; name: string; desc: string; setting: Setting }
	| { kind: "note"; cls: string; text: string };

/** Everything on the screen, in the order it was drawn. Order is a decision this plugin makes. */
function draw(tab: Tab): Drawn[] {
	takeSettings();
	tab.display();
	const bySettingEl = new Map(takeSettings().map((setting: Setting) => [setting.settingEl, setting]));
	return tab.containerEl.children.map((child): Drawn => {
		const setting = bySettingEl.get(child);
		if (!setting) return { kind: "note", cls: [...child.classes].join(" "), text: child.allText().join(" ") };
		if (setting.heading) return { kind: "heading", name: setting.name };
		return { kind: "row", name: setting.name, desc: setting.desc, setting };
	});
}

/** The rows and notes under one heading, up to the next one. */
function section(drawn: Drawn[], heading: string): Drawn[] {
	const start = drawn.findIndex((item) => item.kind === "heading" && item.name === heading);
	if (start === -1) return [];
	const rest = drawn.slice(start + 1);
	const end = rest.findIndex((item) => item.kind === "heading");
	return end === -1 ? rest : rest.slice(0, end);
}

function row(drawn: Drawn[], name: string): Extract<Drawn, { kind: "row" }> {
	const found = drawn.find((item): item is Extract<Drawn, { kind: "row" }> => item.kind === "row" && item.name === name);
	if (!found) throw new Error(`no row named "${name}" among ${drawn.map((d) => `${d.kind}:${"name" in d ? d.name : d.cls}`).join(", ")}`);
	return found;
}

function rowNames(drawn: Drawn[]): string[] {
	return drawn.filter((item) => item.kind === "row").map((item) => item.name);
}

function buttons(drawn: Drawn[], name: string): ButtonComponent[] {
	return row(drawn, name).setting.buttons;
}
function dropdown(drawn: Drawn[], name: string): DropdownComponent {
	return row(drawn, name).setting.dropdowns[0];
}
function toggle(drawn: Drawn[], name: string): ToggleComponent {
	return row(drawn, name).setting.toggles[0];
}
function field(drawn: Drawn[], name: string): TextComponent {
	return row(drawn, name).setting.texts[0];
}

/** Lets an `onClick`/`onChange` promise chain finish -- the fake's `click()` cannot await it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	Platform.isDesktop = false;
	Platform.isMacOS = false;
	machine.visionAvailable = false;
	cloud.register = async () => "device-token";
	opened.length = 0;
	copied.length = 0;
	setupCards.length = 0;
	settingsRows.length = 0;
	takeNotices();
	takeSettings();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("the shape of the settings screen", () => {
	it("orders the sections by how often a row is touched, not by how they were built", async () => {
		const { tab } = await tabWith({ deviceToken: "d" });

		expect(draw(tab).filter((item) => item.kind === "heading").map((item) => item.name)).toEqual([
			// First, because with two sources the question before every other one is which source this
			// vault is reading from.
			"Where your notes come from",
			"Tag routing",
			"Vault output",
			"Transcription",
			"Automatic sync",
			"Tagged Sync Pro",
			"Actions",
		]);
	});

	it("hides tag routing and Sync now until there is a device to sync with", async () => {
		const { tab } = await tabWith();
		const drawn = draw(tab);

		expect(drawn.filter((item) => item.kind === "heading").map((item) => item.name)).not.toContain("Tag routing");
		expect(rowNames(section(drawn, "Actions"))).toEqual(["Report a problem", "Request a feature"]);
	});
});

describe("the reMarkable cloud account", () => {
	it("takes a one-time code, says where to get it, and re-draws as connected", async () => {
		const { plugin, tab } = await tabWith();
		const drawn = draw(tab);

		expect(row(drawn, "reMarkable cloud account").desc).toBe("Not connected.");
		expect(row(drawn, "Connect").desc).toContain("https://my.remarkable.com/device/browser/connect");
		field(drawn, "Connect").type("ABCDEFGH");
		await buttons(drawn, "Connect")[0].click();
		await settle();

		expect(takeNotices()).toEqual(["Connected to reMarkable."]);
		expect(row(draw(tab), "reMarkable cloud account").desc).toBe("Connected.");
		expect(plugin.data.deviceToken).toBe("device-token");
	});

	it("explains a refused code instead of repeating the cloud's words, and leaves the field there", async () => {
		// `explainError` is what turns a 401 into a sentence, and it is tested. What was not: that the
		// Connect button routes its failure through it at all. A raw `error.message` here would read
		// "Request failed, status 401" -- true, and no help to somebody whose code has expired.
		const { tab } = await tabWith();
		cloud.register = async () => {
			throw new Error("Request failed, status 401");
		};
		const drawn = draw(tab);
		field(drawn, "Connect").type("WRONGONE");
		await buttons(drawn, "Connect")[0].click();
		await settle();

		const [notice] = takeNotices();
		expect(notice).toBe(explainError(new Error("Request failed, status 401"), "connect"));
		expect(notice).not.toContain("401");
		expect(rowNames(draw(tab))).toContain("Connect");
	});

	it("disconnects and re-draws, without touching what is already in the vault", async () => {
		const { plugin, tab } = await tabWith({ deviceToken: "d", tagFolderMap: { "#work": "Work" } });

		await buttons(draw(tab), "reMarkable cloud account")[0].click();
		await settle();

		expect(row(draw(tab), "reMarkable cloud account").desc).toBe("Not connected.");
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Work" });
	});
});

// The second transport's whole entrance is these rows: which source, what to try when it is not
// there, and the pairing that makes the second one possible at all. Everything *below* them is
// verified in `ssh-transport.test.ts` and `ssh-pairing.test.ts`, and every **wire** was not -- a
// picker that offers a Pro source to a free user and saves it, a fallback left pointing at the
// primary, a "Forget device" that forgets the key and keeps the hashes. Same argument as the file
// header makes for the backend dropdown.
describe("where your notes come from", () => {
	const PAIRED = { host: "192.168.178.76", port: 22, privateKey: "PRIVATE-KEY", hostKeyFingerprint: "SHA256:abcd" };
	const BOUGHT_PRO = {
		licence: {
			...NO_LICENCE,
			key: "TS-XXXX-1234",
			activationId: "act-1",
			validatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		},
	};

	/** Every option on a picker, in draw order: its value, its label, and whether it can be chosen. */
	function options(drawn: Drawn[], name: string): { id: string; text: string; disabled: boolean }[] {
		return dropdown(drawn, name).selectEl.options.map((option) => ({
			id: option.value,
			text: option.text,
			disabled: option.disabled,
		}));
	}

	it("shows a free user the direct connection, locked, rather than hiding what Pro buys", async () => {
		// Hidden, it is a feature nobody can decide to buy. Shown and enabled, Obsidian would save the
		// choice the moment it is made and the vault would point at a source it may not use.
		const { tab } = await tabWith({ deviceToken: "d" });

		expect(options(draw(tab), "Sync from")).toEqual([
			{ id: "cloud", text: "reMarkable cloud", disabled: false },
			{ id: "ssh", text: "Your reMarkable directly (USB or Wi-Fi) (Pro)", disabled: true },
		]);
	});

	it("unlocks it for a licence, and drops the (Pro) from its name", async () => {
		const { tab } = await tabWith({ deviceToken: "d", ...BOUGHT_PRO });

		expect(options(draw(tab), "Sync from")).toContainEqual({
			id: "ssh",
			text: "Your reMarkable directly (USB or Wi-Fi)",
			disabled: false,
		});
	});

	it("offers as a fallback only the source that is not already the primary", async () => {
		// A fallback to where the run just failed is a second attempt dressed as a recovery, and it
		// would double every timeout. The picker cannot offer it, so nobody can configure it.
		const cloudFirst = await tabWith({ deviceToken: "d", ...BOUGHT_PRO });
		expect(options(draw(cloudFirst.tab), "If that is not reachable").map((o) => o.id)).toEqual(["none", "ssh"]);

		const deviceFirst = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ...BOUGHT_PRO });
		expect(options(draw(deviceFirst.tab), "If that is not reachable").map((o) => o.id)).toEqual(["none", "cloud"]);
	});

	it("clears a fallback the new primary has just become, and saves both", async () => {
		const { plugin, tab } = await tabWith({ deviceToken: "d", fallbackTransport: "ssh", ...BOUGHT_PRO });

		dropdown(draw(tab), "Sync from").pick("ssh");
		await settle();

		expect(plugin.data.primaryTransport).toBe("ssh");
		expect(plugin.data.fallbackTransport).toBeNull();
		expect(plugin.saves).toHaveLength(1);
	});

	it("keeps the pairing row out of the way of a vault that syncs from the cloud alone", async () => {
		const cloudOnly = await tabWith({ deviceToken: "d", ...BOUGHT_PRO });
		expect(rowNames(draw(cloudOnly.tab))).not.toContain("Connect device");

		// As a fallback it is just as much a source, and just as much in need of a paired device.
		const asFallback = await tabWith({ deviceToken: "d", fallbackTransport: "ssh", ...BOUGHT_PRO });
		expect(rowNames(draw(asFallback.tab))).toContain("Connect device");
	});

	it("names the tablet it is paired with, because a vault may have two sources", async () => {
		const { tab } = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ssh: PAIRED, ...BOUGHT_PRO });

		expect(row(draw(tab), "Your reMarkable").desc).toBe("Paired with root@192.168.178.76 · host key pinned");
	});

	it("carries the address into a re-pair, which is asked for when the tablet stopped answering", async () => {
		// The button is pressed *because* the device is unreachable. Making somebody go and find the
		// Wi-Fi address again at that exact moment is the worst time to ask for it.
		const { plugin, tab } = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ssh: PAIRED, ...BOUGHT_PRO });

		await buttons(draw(tab), "Your reMarkable")[0].click();
		await settle();

		const drawn = draw(tab);
		expect((plugin.data.ssh as { privateKey: string | null }).privateKey).toBeNull();
		expect(field(drawn, "Connect device").value).toBe("192.168.178.76");
	});

	it("forgets the address and the hashes along with the device, but leaves the key on the tablet", async () => {
		const { plugin, tab } = await tabWith({
			deviceToken: "d",
			primaryTransport: "ssh",
			ssh: PAIRED,
			sshHashes: { "a.rm|1|2": "hash" },
			...BOUGHT_PRO,
		});

		await buttons(draw(tab), "Your reMarkable")[1].click();
		await settle();

		expect(plugin.data.ssh).toEqual({ host: "10.11.99.1", port: 22, privateKey: null, hostKeyFingerprint: null });
		expect(plugin.data.sshHashes).toEqual({});
		// Nothing left in the form either: the next pairing is a different tablet as far as this vault
		// is concerned, and an address carried over from the last one is a wrong answer already typed in.
		expect(field(draw(tab), "Connect device").value).toBe("");
	});

	it("drops the root password however the attempt ended", async () => {
		// It buys one connection and is never stored -- which has to hold for the attempt that failed
		// as much as for the one that worked. `Platform.isDesktop` is false here, so pairing refuses
		// before it reaches a socket: the failing path, which is the one that used to keep it.
		const { plugin, tab } = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ...BOUGHT_PRO });
		const drawn = draw(tab);
		row(drawn, "Connect device").setting.texts[1].type("hunter2");

		await buttons(drawn, "Connect device")[0].click();
		await settle();

		expect((plugin.data.ssh as { privateKey: string | null }).privateKey).toBeNull();
		expect(row(draw(tab), "Connect device").setting.texts[1].value).toBe("");
	});

	it("says out loud, before anyone types a password, what Developer Mode costs", async () => {
		// The one fact no competitor states in-product, and the worst possible one to meet halfway
		// through pairing. Folded away, but present and reachable without an attempt first.
		const { tab } = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ...BOUGHT_PRO });
		const help = draw(tab).filter((item) => item.kind === "note" && item.cls.includes("tagged-sync-pairing-help"));

		expect(help).toHaveLength(1);
		expect(help[0].kind === "note" && help[0].text).toContain("erases the tablet");
	});
});

describe("vault output", () => {
	it("shows the folder the plugin will actually use, as both placeholder and value", async () => {
		// The default is seeded by the settings migration rather than left empty, so the field arrives
		// filled: a fresh install reads its own answer instead of an empty box under a grey hint, and
		// there is no state in which the two disagree.
		const { tab } = await tabWith();
		const text = field(draw(tab), "Attachments folder");

		expect(text.placeholder).toBe(DEFAULT_ATTACHMENTS_FOLDER);
		expect(text.value).toBe(DEFAULT_ATTACHMENTS_FOLDER);
	});

	it("keeps a folder the user chose, rather than showing them the default", async () => {
		const { tab } = await tabWith({ attachmentsFolder: "Notes/Scans" });

		expect(field(draw(tab), "Attachments folder").value).toBe("Notes/Scans");
	});

	it("takes the typed folder immediately and reaches data.json 500 ms after the last keystroke", async () => {
		// `debounce(cb, 500, true)` is trailing with a resetting timer, not leading: obsidian.d.ts's
		// third parameter is `resetTimer`. The gap list called it a leading debounce; it is not, and the
		// difference is a save on the first character versus none until the typing stops.
		vi.useFakeTimers();
		const { plugin, tab } = await tabWith();
		const text = field(draw(tab), "Attachments folder");

		text.type("Notes");
		expect(plugin.data.attachmentsFolder).toBe("Notes");
		expect(plugin.saves).toEqual([]);

		vi.advanceTimersByTime(400);
		text.type("Notes/PDF");
		vi.advanceTimersByTime(400);
		expect(plugin.saves).toEqual([]);

		vi.advanceTimersByTime(100);
		expect(plugin.saves).toHaveLength(1);
		expect((plugin.saves[0] as { attachmentsFolder: string }).attachmentsFolder).toBe("Notes/PDF");
	});

	it("re-renders every synced note when the handwriting switch moves", async () => {
		// The device has not changed, so nothing would re-run without this: the switch decides what a
		// note *contains*, and every already-synced note has to be rewritten to match.
		const { plugin, tab } = await tabWith({
			syncIndex: { rows: { a: { notePath: "a.md", status: "active", renderVersion: 7 } } },
		});
		const switchRow = toggle(draw(tab), "Handwritten notes");
		expect(switchRow.value).toBe(false);

		switchRow.toggle(true);
		await settle();

		expect(plugin.data.marginNotes).toBe(true);
		const saved = plugin.saves.at(-1) as { syncIndex: { rows: Record<string, { renderVersion?: number }> } };
		expect(saved.syncIndex.rows.a.renderVersion).toBeUndefined();
	});
});

describe("the backend dropdown", () => {
	/** Every option, in draw order: the id, the text on it, and whether it can be picked. */
	function options(drawn: Drawn[]): { id: string; text: string; disabled: boolean }[] {
		return dropdown(drawn, "Backend").selectEl.options.map((option) => ({
			id: option.value,
			text: option.text,
			disabled: option.disabled,
		}));
	}

	it("lists exactly what the listing rule says, over the registry this build actually has", async () => {
		// Asserted as the rule over the live registry rather than as a fixed list of ids: a build that
		// gains a backend would pass a hard-coded list by simply not showing it.
		const { tab } = await tabWith({ ocrBackend: "off" });
		const listed = options(draw(tab)).map((option) => option.id);

		expect(listed).toEqual(ocrBackendEntries().filter((entry) => isListedBackend(entry, "off")).map((entry) => entry.id));
		// The two halves of the rule, named, so a mutation that lists everything still fails here.
		expect(listed).toContain("test-gap");
		expect(listed).not.toContain("test-carded");
	});

	it("shows a gap nothing can close, disabled, with the reason where the name was", async () => {
		const { tab } = await tabWith({ ocrBackend: "off" });

		expect(options(draw(tab))).toContainEqual({ id: "test-gap", text: "Test — not here", disabled: true });
		expect(options(draw(tab))).toContainEqual({ id: "test-plain", text: "Test test-plain", disabled: false });
	});

	it("keeps a hidden backend visible while it is the selected one, so the box is never blank", async () => {
		// The user selects it while it works and its model later disappears. Hiding it would leave the
		// dropdown showing nothing at all.
		const { tab } = await tabWith({ ocrBackend: "test-carded" });
		const drawn = draw(tab);

		expect(options(drawn)).toContainEqual({ id: "test-carded", text: "Test — not ready", disabled: true });
		expect(dropdown(drawn, "Backend").value).toBe("test-carded");
	});

	it("saves the pick and re-draws itself, because the rows below it belong to the backend", async () => {
		// The re-draw is the assertion, and it has to be made without drawing again: every row under
		// the dropdown is the chosen backend's own, so a pick that saves and does not re-render leaves
		// the user looking at the settings of the backend they just moved away from.
		const { plugin, tab } = await tabWith({ ocrBackend: "off" });
		dropdown(draw(tab), "Backend").pick("test-plain");
		settingsRows.length = 0;
		await settle();

		expect(plugin.data.ocrBackend).toBe("test-plain");
		expect((plugin.saves.at(-1) as { ocrBackend: string }).ocrBackend).toBe("test-plain");
		expect(settingsRows).toEqual(["test-plain (selected)"]);
		expect(dropdown(draw(tab), "Backend").value).toBe("test-plain");
	});

	it("describes the families this build has, and claims nothing about the ones it does not", async () => {
		const { tab } = await tabWith();
		const desc = row(draw(tab), "Backend").desc;

		expect(desc).toContain("Apple Vision runs locally and privately on macOS 13 or later");
		// Both clauses are true of this build: the localhost servers are on-device, the six providers
		// are cloud. The sentence is composed rather than fixed because the three cases are three
		// different promises.
		expect(desc).toContain("needs no account and no key");
		expect(desc).toContain("using your own API key");
	});
});

describe("the sentence under the dropdown", () => {
	function note(drawn: Drawn[]): string | undefined {
		return drawn.find((item): item is Extract<Drawn, { kind: "note" }> => item.kind === "note" && item.cls === "tagged-sync-note")
			?.text;
	}

	it("says nothing about Apple Vision's ceiling on a machine that cannot run Apple Vision", async () => {
		// Naming the limit of a backend this system does not offer is noise, and it reads as a limit of
		// whatever the user *did* pick.
		machine.visionAvailable = false;
		const { tab } = await tabWith({ ocrBackend: "off" });

		expect(note(draw(tab))).toBe("Choose an LLM backend for structured Markdown.");
	});

	it("names the ceiling where Apple Vision is a real option", async () => {
		machine.visionAvailable = true;
		const { tab } = await tabWith({ ocrBackend: "off" });

		expect(note(draw(tab))).toBe(
			"Apple Vision: flat text only, no headings or tables. Choose an LLM backend for structured Markdown.",
		);
	});

	it("lets the selected backend's own contract replace it, rather than join it", async () => {
		// With another backend chosen, Vision's flat-text ceiling is not what the user's notes will look
		// like -- and claiming parity with the cloud providers would be wrong the other way.
		machine.visionAvailable = true;
		const { tab } = await tabWith({ ocrBackend: "test-contract" });

		expect(note(draw(tab))).toBe(CONTRACT);
	});
});

describe("a backend's own rows and its setup card", () => {
	it("draws the settings rows of the selected backend and of no other", async () => {
		const { tab } = await tabWith({ ocrBackend: "test-plain" });
		draw(tab);
		expect(settingsRows).toEqual(["test-plain (selected)"]);

		settingsRows.length = 0;
		const other = await tabWith({ ocrBackend: "off" });
		draw(other.tab);
		expect(settingsRows).toEqual([]);
	});

	it("draws every registered backend's setup card, selected or not", async () => {
		// The difference is the whole point: a backend that cannot yet be selected has no other way to
		// say what would make it selectable, because `renderSettings` fires only once it already is.
		const { tab } = await tabWith({ ocrBackend: "off" });
		draw(tab);

		expect(setupCards).toEqual(["test-carded", "test-ready-card", "test-contract"]);
	});

	it("tells a card whether it is the selected backend, so a finished one can stand down", async () => {
		const { tab } = await tabWith({ ocrBackend: "test-ready-card" });
		draw(tab);

		expect(setupCards).toContain("test-ready-card (selected)");
		expect(setupCards).toContain("test-carded");
	});
});

describe("automatic sync", () => {
	const AUTO_ON = { enabled: true, intervalHours: 6, autoTranscribeMetered: false };

	it("shows one switch and nothing else while it is off", async () => {
		const { tab } = await tabWith();

		expect(rowNames(section(draw(tab), "Automatic sync"))).toEqual(["Enable automatic sync"]);
	});

	it("re-draws the moment it is switched on, so the rows it unlocks are there to be set", async () => {
		const { plugin, tab } = await tabWith();
		toggle(draw(tab), "Enable automatic sync").toggle(true);
		await settle();

		expect((plugin.saves.at(-1) as { autoSync: { enabled: boolean } }).autoSync.enabled).toBe(true);
		expect(rowNames(section(draw(tab), "Automatic sync"))).toEqual(["Enable automatic sync", "Sync interval"]);
	});

	it("offers launch-only and four intervals, and stores launch-only as no interval at all", async () => {
		const { plugin, tab } = await tabWith({ autoSync: AUTO_ON });
		const interval = dropdown(draw(tab), "Sync interval");

		expect(interval.options).toEqual({
			launch: "Only on launch",
			"2": "Every 2 hours",
			"6": "Every 6 hours",
			"12": "Every 12 hours",
			"24": "Every 24 hours",
		});
		expect(interval.value).toBe("6");

		interval.pick("launch");
		await settle();
		expect((plugin.data.autoSync as { intervalHours: number | null }).intervalHours).toBeNull();
		expect(dropdown(draw(tab), "Sync interval").value).toBe("launch");
	});

	it("re-arms the timer on every change, not only on the next restart", async () => {
		// The setting is the interval a running Obsidian syncs at. Saved and not re-armed, it would
		// take effect the next time the vault opened -- which is the one moment the user is not there
		// to notice that nothing changed.
		const { plugin, tab } = await tabWith({ autoSync: { ...AUTO_ON, intervalHours: null } });
		const clock = (plugin as unknown as { scheduler: FakeClock }).scheduler;
		const before = clock.armed;

		dropdown(draw(tab), "Sync interval").pick("2");
		await settle();

		expect(clock.armed).toBe(before + 1);

		dropdown(draw(tab), "Sync interval").pick("launch");
		await settle();
		expect(clock.armed).toBe(before);
	});

	it("asks for background consent only where the backend declares both halves of it", async () => {
		// `needsBackgroundConsent` says a background run needs permission; `backgroundConsent` says
		// where to keep the answer. One without the other draws no row -- so a backend that declares
		// the need alone is background-gated with no way for anyone to lift the gate.
		const withBoth = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-consent" });
		expect(rowNames(section(draw(withBoth.tab), "Automatic sync"))).toContain("Transcribe during background sync");

		const withHalf = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-half-consent" });
		expect(rowNames(section(draw(withHalf.tab), "Automatic sync"))).not.toContain("Transcribe during background sync");
	});

	it("writes the consent through the backend's own accessors, never into a field of its own", async () => {
		// The blob stays opaque: the plugin renders the row and gates the run without ever learning
		// which key inside it holds the answer.
		const { plugin, tab } = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-consent" });
		const drawn = draw(tab);
		const consent = row(drawn, "Transcribe during background sync");

		expect(consent.desc).toBe("Test consent row.");
		expect(consent.setting.toggles[0].value).toBe(false);

		consent.setting.toggles[0].toggle(true);
		await settle();

		expect((plugin.data.llmProviders as Record<string, { ok?: boolean }>)["test-consent"].ok).toBe(true);
	});

	it("asks about spending money only on a backend that spends money", async () => {
		const free = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-plain" });
		expect(rowNames(section(draw(free.tab), "Automatic sync"))).not.toContain(
			"Automatically transcribe during background sync (uses your paid API)",
		);

		const metered = await tabWith({ autoSync: AUTO_ON, ocrBackend: "anthropic" });
		const paid = row(draw(metered.tab), "Automatically transcribe during background sync (uses your paid API)");
		expect(paid.desc).toContain("Off by default");
		expect(paid.setting.toggles[0].value).toBe(false);

		paid.setting.toggles[0].toggle(true);
		await settle();
		expect((metered.plugin.data.autoSync as { autoTranscribeMetered: boolean }).autoTranscribeMetered).toBe(true);
	});
});

describe("the Tagged Sync Pro section", () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
	const BOUGHT = { key: "TS-XXXX-1234", activationId: "act-1" };

	function pro(drawn: Drawn[]): { heading: string; desc: string; buttons: string[] } {
		const heading = section(drawn, "Tagged Sync Pro").find((item) => item.kind === "row");
		if (heading?.kind !== "row") throw new Error("no status row under Tagged Sync Pro");
		return { heading: heading.name, desc: heading.desc, buttons: heading.setting.buttons.map((b) => b.text) };
	}
	function keyField(drawn: Drawn[]): boolean {
		return rowNames(section(drawn, "Tagged Sync Pro")).includes("Licence key");
	}
	function moneyBack(drawn: Drawn[]): boolean {
		return section(drawn, "Tagged Sync Pro").some((item) => item.kind === "note" && item.text.includes("no questions asked"));
	}

	it("offers the trial once, to somebody who has never had one", async () => {
		const { tab } = await tabWith();

		expect(pro(draw(tab)).buttons).toEqual(["Start free trial", "Buy"]);
	});

	it("never offers it again, not even after it has run out", async () => {
		// There is deliberately no restart button: one would turn the purchase into a donation.
		const running = await tabWith({ licence: { ...NO_LICENCE, trialStartedAt: iso(2 * DAY_MS) } });
		expect(pro(draw(running.tab)).buttons).toEqual(["Buy"]);

		const over = await tabWith({ licence: { ...NO_LICENCE, trialStartedAt: iso(40 * DAY_MS) } });
		expect(pro(draw(over.tab))).toMatchObject({ heading: "Trial ended", buttons: ["Buy"] });
	});

	it("counts the days left on a running trial, on the row itself", async () => {
		const { tab } = await tabWith({ licence: { ...NO_LICENCE, trialStartedAt: iso(2 * DAY_MS) } });
		const row = pro(draw(tab));

		expect(row.heading).toBe("Trial");
		expect(row.desc).toContain("12 day(s) left.");
	});

	it("starts the trial on the spot, saves it, and re-draws without the button", async () => {
		const { plugin, tab } = await tabWith();
		await buttons(draw(tab), "Not active")[0].click();
		await settle();

		expect((plugin.data.licence as { trialStartedAt: string | null }).trialStartedAt).not.toBeNull();
		expect(plugin.saves).toHaveLength(1);
		expect(pro(draw(tab))).toMatchObject({ heading: "Trial", buttons: ["Buy"] });
	});

	it("swaps Buy for the two account buttons once the licence is active", async () => {
		const { tab } = await tabWith({
			licence: { ...NO_LICENCE, ...BOUGHT, validatedAt: iso(DAY_MS), trialStartedAt: iso(40 * DAY_MS) },
		});
		const drawn = draw(tab);

		expect(pro(drawn)).toMatchObject({ heading: "Active", buttons: ["Manage devices", "Deactivate this vault"] });
		// A key field under a working licence invites somebody to paste a second one over a good first,
		// and the money-back sentence is an offer to a buyer who has not bought yet.
		expect(keyField(drawn)).toBe(false);
		expect(moneyBack(drawn)).toBe(false);
	});

	it("keeps those buttons while a valid licence has merely not been re-confirmed", async () => {
		// Pro keeps working: this is almost always a network problem, not a licence problem, and taking
		// the buttons away would be the plugin acting on a suspicion it has no evidence for.
		const { tab } = await tabWith({
			licence: { ...NO_LICENCE, ...BOUGHT, validatedAt: iso(60 * DAY_MS), trialStartedAt: iso(90 * DAY_MS) },
		});
		const row = pro(draw(tab));

		expect(row.heading).toContain("not confirmed since");
		expect(row.buttons).toEqual(["Manage devices", "Deactivate this vault"]);
	});

	it("puts a refunded buyer back where a free user is, and does not ask them to hunt for a typo", async () => {
		const { tab } = await tabWith({
			licence: { ...NO_LICENCE, ...BOUGHT, validatedAt: iso(DAY_MS), revokedAt: iso(DAY_MS), trialStartedAt: iso(90 * DAY_MS) },
		});
		const drawn = draw(tab);

		expect(pro(drawn).heading).toContain("refunded");
		expect(pro(drawn).buttons).toEqual(["Buy"]);
		expect(keyField(drawn)).toBe(true);
	});

	// Characterisation, not endorsement. The trial button asks one question -- has a trial ever been
	// started -- and asks it of the licence state alone, so it also stands beside "Deactivate this
	// vault" for somebody who bought without trialling first, and beside "Buy" for a refunded buyer.
	// Neither costs anything: the trial unlocks what a Pro licence already unlocks, and a refunded
	// buyer has had the product either way. Recorded here so the next change to this row is a decision
	// rather than a surprise.
	it("offers the trial by the trial's own history, even to somebody who already has Pro", async () => {
		const bought = await tabWith({ licence: { ...NO_LICENCE, ...BOUGHT, validatedAt: iso(DAY_MS) } });
		expect(pro(draw(bought.tab)).buttons).toEqual(["Start free trial", "Manage devices", "Deactivate this vault"]);

		const refunded = await tabWith({
			licence: { ...NO_LICENCE, ...BOUGHT, validatedAt: iso(DAY_MS), revokedAt: iso(DAY_MS) },
		});
		expect(pro(draw(refunded.tab)).buttons).toEqual(["Start free trial", "Buy"]);
	});

	it("sends Buy and Manage devices to the two links they are for", async () => {
		const free = await tabWith();
		buttons(draw(free.tab), "Not active")[1].click();
		expect(opened.at(-1)).toContain("buy.polar.sh");

		const bought = await tabWith({
			licence: { ...NO_LICENCE, ...BOUGHT, validatedAt: iso(DAY_MS), trialStartedAt: iso(40 * DAY_MS) },
		});
		buttons(draw(bought.tab), "Active")[0].click();
		expect(opened.at(-1)).toContain("polar.sh/hochbichler-com/portal");
	});

	it("activates a pasted key, saves the result, says one sentence and re-draws as Pro", async () => {
		// The key is handed over trimmed, because a key pasted out of an order mail arrives with a
		// newline on it and Polar would answer "not found" to a string that is right.
		const { plugin, tab } = await tabWith({ licence: { ...NO_LICENCE, trialStartedAt: iso(90 * DAY_MS) } });
		const asked: string[] = [];
		(plugin as unknown as { licenceApi: unknown }).licenceApi = {
			activate: async (key: string, label: string) => {
				asked.push(`${key}|${label}`);
				return { outcome: "valid", activationId: "act-9" };
			},
			validate: async () => "valid",
			deactivate: async () => undefined,
		};
		const key = row(draw(tab), "Licence key");

		key.setting.texts[0].type("  TS-XXXX-1234\n");
		await key.setting.buttons[0].click();
		await settle();

		expect(asked).toEqual(["TS-XXXX-1234|" + (plugin as unknown as { app: FakeApp }).app.vault.getName()]);
		// Stored trimmed as well, so the next validation does not ask about a different string.
		expect(plugin.data.licence).toMatchObject({ key: "TS-XXXX-1234", activationId: "act-9" });
		expect(plugin.saves).toHaveLength(1);
		expect(takeNotices()).toHaveLength(1);
		expect(pro(draw(tab))).toMatchObject({ heading: "Active", buttons: ["Manage devices", "Deactivate this vault"] });
	});

	it("does nothing at all on an empty field, rather than asking Polar about whitespace", async () => {
		const { plugin, tab } = await tabWith({ licence: { ...NO_LICENCE, trialStartedAt: iso(90 * DAY_MS) } });
		const key = row(draw(tab), "Licence key");

		key.setting.texts[0].type("   ");
		await key.setting.buttons[0].click();
		await settle();

		expect(plugin.saves).toEqual([]);
		expect(takeNotices()).toEqual([]);
		expect(key.setting.buttons[0].disabled).toBe(false);
	});
});

describe("the actions at the bottom", () => {
	it("puts a Sync button on the settings screen, because the palette was the only way in", async () => {
		const { tab } = await tabWith({ deviceToken: "d" });

		expect(buttons(draw(tab), "Sync now").map((button) => button.text)).toEqual(["Sync"]);
	});

	it("copies the diagnostics to the clipboard and says it did, without sending anything", async () => {
		const { tab } = await tabWith({ deviceToken: "d", ocrBackend: "test-plain", tagFolderMap: { "#a": "A" } });
		const drawn = draw(tab);

		expect(row(drawn, "Report a problem").desc).toContain("Nothing is sent from here.");
		await buttons(drawn, "Report a problem")[0].click();
		await settle();

		expect(copied).toHaveLength(1);
		expect(copied[0]).toContain("9.9.9");
		expect(copied[0]).toContain("test-plain");
		expect(takeNotices()).toEqual(["Diagnostics copied to the clipboard."]);
	});
});

// Gap G37. The four sentences exist, are argued for at length in `licence-messages.ts`, and appear
// **zero times** in any test file. `licence-client.test.ts` proves the four outcomes are told apart;
// nothing proved each one reaches the sentence written for it, so swapping two `case` arms was
// invisible -- and one of the swaps tells a refunded buyer to go hunting for a typo they did not make.
describe("what the paste field says about each answer", () => {
	async function activateWith(outcome: string): Promise<string[]> {
		const { plugin, tab } = await tabWith({
			licence: { ...NO_LICENCE, trialStartedAt: new Date(Date.now() - 90 * 86_400_000).toISOString() },
		});
		(plugin as unknown as { licenceApi: unknown }).licenceApi = {
			activate: async () => (outcome === "valid" ? { outcome, activationId: "act-1" } : { outcome }),
			validate: async () => outcome,
			deactivate: async () => undefined,
		};
		const key = row(draw(tab), "Licence key");
		key.setting.texts[0].type("TS-XXXX-1234");
		await key.setting.buttons[0].click();
		await settle();
		return takeNotices();
	}

	it("gives each outcome its own sentence, and none of them another's", async () => {
		const said = {
			valid: (await activateWith("valid"))[0],
			unknownKey: (await activateWith("unknown-key"))[0],
			withdrawn: (await activateWith("withdrawn"))[0],
			limit: (await activateWith("activation-limit"))[0],
			offline: (await activateWith("unreachable"))[0],
		};

		expect(said.valid).toBe("Tagged Sync Pro is active in this vault.");
		expect(said.unknownKey).toBe(WRONG_KEY_MESSAGE);
		expect(said.withdrawn).toBe(WITHDRAWN_KEY_MESSAGE);
		expect(said.limit).toBe(ACTIVATION_LIMIT_MESSAGE);
		expect(said.offline).toBe(OFFLINE_ACTIVATION_MESSAGE);
		expect(new Set(Object.values(said)).size).toBe(5);
	});

	it("does not tell a refunded buyer to look for a typo", async () => {
		// The one swap that is cruel rather than merely wrong, and the reason the two outcomes are
		// separate at all: for the stored state they are identical.
		expect(await activateWith("withdrawn")).not.toContain(WRONG_KEY_MESSAGE);
		expect(WITHDRAWN_KEY_MESSAGE).not.toContain("typo");
	});
});
