import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../tests/stubs/fake-clock";
import {
	type ButtonComponent,
	createFragment,
	type DropdownComponent,
	FakeApp,
	type FakeEl,
	Platform,
	type PluginSettingTab,
	renderSettingTab,
	type SecretComponent,
	Setting,
	takeNotices,
	takeSettings,
	type TextComponent,
	type ToggleComponent,
} from "../tests/stubs/fake-obsidian";
import { resetNetwork, stubNetwork } from "../tests/stubs/network";
import { DEFAULT_ATTACHMENTS_FOLDER } from "./attachment-writer";
import { explainError } from "./explain-error";
import {
	ACTIVATION_LIMIT_MESSAGE,
	MONEY_BACK_MESSAGE,
	OFFLINE_ACTIVATION_MESSAGE,
	WITHDRAWN_KEY_MESSAGE,
	WRONG_KEY_MESSAGE,
} from "./licence-messages";
import { NO_LICENCE } from "./licence-state";
import { ticketMessage, type TrialIssuer, type TrialTicket, vaultHashOf } from "./trial-ticket";
import { DeviceUnreachableError } from "./ssh-connection";
import { NOT_CONNECTED_NOTICE } from "./sync-guards";
import { PairingRefusedError } from "./ssh-pairing";
import { BACKGROUND_CONSENT_NAME, type OcrBackendEntry, ocrBackendEntries, registerOcrBackend } from "./ocr-registry";
import { tokenFingerprint } from "./readwise-push";

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

// Pairing itself stays real -- `ssh-pairing.test.ts` runs it. Only the one call is replaceable, so a
// test can say what the tablet did without a tablet, and what the user is then told.
const pairing = vi.hoisted(() => ({ fail: null as unknown }));
vi.mock("./ssh-pairing", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ssh-pairing")>();
	return {
		...actual,
		pairDevice: async (request: Parameters<typeof actual.pairDevice>[0]) => {
			if (pairing.fail !== null) throw pairing.fail;
			return actual.pairDevice(request);
		},
	};
});

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
// `setTimeout`/`clearTimeout` are here for the Zotero probe: `withZoteroTimeout` uses the window's
// timers (Obsidian's popout rule), and without them the race between the request and its timeout is
// decided by microtask order rather than by the request. Delegated per call, so a test that installs
// fake timers still sees them.
vi.stubGlobal("window", {
	open: (url: string) => opened.push(url),
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
const copied: string[] = [];
vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => void copied.push(text) } });

// --- test backends ------------------------------------------------------------------------------
//
// Added to the real registry rather than mocked, because what is under test is the *wire* between
// the registry and the dropdown.

const settingsRows: string[] = [];

function testBackend(id: string, extra: Partial<OcrBackendEntry> = {}): OcrBackendEntry {
	return {
		id,
		label: `Test ${id}`,
		metered: false,
		requiresLicence: false,
		needsBackgroundConsent: false,
		create: () => null,
		...extra,
	} as OcrBackendEntry;
}

/** Runs here. Listed and enabled -- and its rows appear only while it is selected. */
registerOcrBackend(
	testBackend("test-plain", {
		renderSettings: (containerEl) => {
			settingsRows.push("test-plain");
			(containerEl as unknown as FakeEl).createDiv({ cls: "test-rows", text: "rows:test-plain" });
		},
	}),
);
/** A gap nothing can fix: shown, disabled, with the reason in its place. */
registerOcrBackend(testBackend("test-gap", { unavailableLabel: () => "Test — not here" }));
/** Costs money per page, which is the only thing that makes a backend "cloud" here. */
registerOcrBackend(testBackend("test-metered", { metered: true }));
/** Has a sentence of its own about what its transcripts look like. */
const CONTRACT = "Test backend: headings, lists and tables.";
registerOcrBackend(testBackend("test-contract", { noteContract: CONTRACT }));
/** Needs consent to run unattended and says how to store it -- both halves, which is the rule. */
const consented = { description: "Test consent row." } as const;
registerOcrBackend(
	testBackend("test-consent", {
				needsBackgroundConsent: true,
		backgroundConsent: {
			get: (settings) => settings.ok === true,
			set: (settings, value) => {
				settings.ok = value;
			},
			description: () => consented.description,
		},
	}),
);
/** Declares the need and forgets the accessors -- the half-declared pair, from the tab's side. */
registerOcrBackend(testBackend("test-half-consent", { needsBackgroundConsent: true }));
/** Its rows cannot be drawn. */
registerOcrBackend(
	testBackend("test-throws", {
		renderSettings: () => {
			throw new Error("broken rows");
		},
	}),
);
/** Draws a row and keeps something running until its rows are torn down, like the local model's download ticks. */
const tornDown: string[] = [];
registerOcrBackend(
	testBackend("test-cleanup", {
		renderSettings: (containerEl) => {
			new Setting(containerEl as unknown as FakeEl).setName("Backend's own row");
			return () => void tornDown.push("test-cleanup");
		},
	}),
);

/**
 * A key pair for the trial ticket (`trial-ticket.ts`). The plugin gets its public half; "signed by
 * taggedsync.com" is then a fact the test controls rather than a secret it would have to carry.
 */
const TICKET_PAIR = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const TICKET_PUBLIC = await crypto.subtle.exportKey("jwk", TICKET_PAIR.publicKey);
async function ticketFor(vault: string, startedAt: string): Promise<TrialTicket> {
	const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, TICKET_PAIR.privateKey, ticketMessage(vault, startedAt));
	const signature = btoa(String.fromCharCode(...new Uint8Array(raw)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { startedAt, signature };
}

// --- harness ------------------------------------------------------------------------------------

interface Tab extends PluginSettingTab {
	getControlValue(key: string): unknown;
	setControlValue(key: string, value: unknown): Promise<void>;
}

interface Plugin {
	data: Record<string, unknown>;
	saves: unknown[];
	saved: unknown;
	settingTabs: Tab[];
	trialIssuer: TrialIssuer;
	trialPublicKey: JsonWebKey;
	rearmAutoSyncInterval(): void;
}

async function tabWith(
	saved: Record<string, unknown> = {},
	app: FakeApp = new FakeApp(),
	trialPublicKey: JsonWebKey = TICKET_PUBLIC,
): Promise<{ plugin: Plugin; tab: Tab }> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin)(app, {
		id: "tagged-sync",
		name: "Tagged Sync",
		version: "9.9.9",
	});
	// Before `onload`, which is where a stored trial is checked against it.
	plugin.trialPublicKey = trialPublicKey;
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
	| { kind: "heading"; name: string; desc: string }
	| { kind: "row"; name: string; desc: string; setting: Setting }
	| { kind: "note"; cls: string; text: string };

/**
 * Everything on the screen, in the order it was drawn. Order is a decision this plugin makes. Each
 * page is read right under its entry, as the one long tab this file was written against.
 */
function draw(tab: Tab): Drawn[] {
	takeSettings();
	renderSettingTab(tab, { openPages: true });
	return onScreen(tab);
}

/**
 * What the screen holds now, without drawing it again -- so a control that changed the page and lost
 * its re-render reads as the stale page it left behind. An element that holds rows at any depth (the
 * backend's host row) is read as the rows it holds.
 */
function onScreen(tab: Tab): Drawn[] {
	const bySettingEl = new Map(takeSettings().map((setting: Setting) => [setting.settingEl, setting]));
	const holdsRows = (el: FakeEl): boolean => el.children.some((inner) => bySettingEl.has(inner) || holdsRows(inner));
	const read = (el: FakeEl): Drawn[] =>
		el.children.flatMap((child): Drawn[] => {
			const setting = bySettingEl.get(child);
			if (holdsRows(child)) return read(child);
			if (!setting) return [{ kind: "note", cls: [...child.classes].join(" "), text: child.allText().join(" ") }];
			if (setting.heading) return [{ kind: "heading", name: setting.name, desc: setting.desc }];
			return [{ kind: "row", name: setting.name, desc: setting.desc, setting }];
		});
	return read(tab.containerEl);
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

/** The live line inside a row's description -- the connection verdict under Zotero. */
function verdict(found: Extract<Drawn, { kind: "row" }>): FakeEl {
	const line = found.setting.descEl.children.find((child) => child.classes.has("tagged-sync-verdict"));
	if (!line) throw new Error(`no verdict line under "${found.name}"`);
	return line;
}

/** The rows a reader sees: a row hidden by its `visible` predicate is in the page and not on screen. */
function rowNames(drawn: Drawn[]): string[] {
	return drawn
		.filter((item): item is Extract<Drawn, { kind: "row" }> => item.kind === "row" && item.setting.settingEl.visible)
		.map((item) => item.name);
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

// Requests are answered by `stubNetwork` in place of zotero.org or the desktop app (tests/stubs/network.ts).
vi.mock("./obsidian-fetch", async () => (await import("../tests/stubs/network")).obsidianFetchModule());

/** Lets an `onClick`/`onChange` promise chain finish -- the fake's `click()` cannot await it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	Platform.isDesktop = false;
	Platform.isMacOS = false;
	machine.visionAvailable = false;
	pairing.fail = null;
	resetNetwork();
	cloud.register = async () => "device-token";
	opened.length = 0;
	copied.length = 0;
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
			"reMarkable connection",
			"Tag routing",
			"Vault output",
			"Transcription",
			"Automatic sync",
			// Between automatic sync and the Pro section: set up once, each on its own page.
			"Integrations",
			// The page's title; its first group, the connection, has no heading (settings-redesign 05 #5).
			"Zotero",
			"Libraries",
			// What goes into Zotero, apart from the connections that carry it (Zotero spec §1).
			"Into Zotero",
			"Send to your tablet",
			// Built like Zotero and after it (Readwise spec §2): the other place highlights go.
			"Readwise",
			"Tagged Sync Pro",
			"Help",
		]);
	});

	it("hides tag routing and Sync now until there is a device to sync with", async () => {
		const { tab } = await tabWith();
		const drawn = draw(tab);

		expect(drawn.filter((item) => item.kind === "heading").map((item) => item.name)).not.toContain("Tag routing");
		expect(rowNames(section(drawn, "reMarkable connection"))).not.toContain("Sync now");
	});
});

describe("the reMarkable connection group", () => {
	// Every row is ours to draw: dropdowns with a disabled option, pairing, the cloud code (spec §3.1).
	// Rows come and go with `update()`, so they are in the array or out of it, never hidden (spec §2.4).
	it("starts with Sync now once connected, then the sources and the cloud account", async () => {
		const { tab } = await tabWith({ deviceToken: "d" });

		expect(rowsOf(tab, "reMarkable connection")).toEqual([
			{ name: "Sync now", kind: "render", shown: true },
			{ name: "Sync from", kind: "render", shown: true },
			{ name: "If that is not reachable", kind: "render", shown: true },
			{ name: "reMarkable cloud account", kind: "render", shown: true },
		]);
		const syncNow = buttons(draw(tab), "Sync now");
		expect(syncNow.map((button) => [button.text, button.cta])).toEqual([["Sync", true]]);
	});

	// The palette was the only way in, and the plugin registers no ribbon icon.
	it("syncs from the button", async () => {
		const { plugin, tab } = await tabWith({ deviceToken: "d" });
		const synced = vi.fn();
		(plugin as unknown as { syncNow(): void }).syncNow = synced;

		await buttons(draw(tab), "Sync now")[0].click();

		expect(synced).toHaveBeenCalledOnce();
	});

	it("asks for the one-time code while nothing is connected, and offers pairing only for a device source", async () => {
		const cloudOnly = await tabWith();
		expect(rowsOf(cloudOnly.tab, "reMarkable connection").map((item) => item.name)).toEqual([
			"Sync from",
			"If that is not reachable",
			"reMarkable cloud account",
			"Connect",
		]);

		const device = await tabWith({ primaryTransport: "ssh" });
		expect(rowsOf(device.tab, "reMarkable connection").map((item) => item.name)).toEqual([
			"Sync from",
			"If that is not reachable",
			"Connect device",
			"reMarkable cloud account",
			"Connect",
		]);
	});

	it("finds Sync from by the words people search for", async () => {
		const { tab } = await tabWith();
		expect(itemsOf(tab, "reMarkable connection").find((item) => item.name === "Sync from")?.aliases).toEqual(["source", "SSH", "USB", "Wi-Fi", "cloud"]);
	});
});

/** A group or page as `getSettingDefinitions()` answers it, as far as these tests read one. */
interface Definition {
	type?: string;
	name?: string;
	desc?: string;
	heading?: string;
	cls?: string;
	aliases?: string[];
	searchable?: boolean;
	visible?: () => boolean;
	control?: { type: string; key: string; disabled?: boolean | (() => boolean) };
	render?: unknown;
	items?: Definition[];
	displayValue?: () => string;
	status?: () => "warning" | null;
}

/** A page's groups as definitions: heading, class, and their rows as {@link rowsOf} reads them. */
function pageGroups(tab: Tab, name: string): { heading?: string; cls?: string; rows: Row[] }[] {
	return integrationPage(tab, name).items?.map((group) => ({ heading: group.heading, cls: group.cls, rows: rowsIn(group.items ?? []) })) ?? [];
}

/** The page `name` under *Integrations*, as a definition. */
function integrationPage(tab: Tab, name: string): Definition {
	const integrations = (tab.getSettingDefinitions() as unknown as Definition[]).find((item) => item.heading === "Integrations");
	const page = integrations?.items?.find((item) => item.type === "page" && item.name === name);
	if (!page) throw new Error(`no ${name} page`);
	return page;
}

/** One root group's row definitions, as `getSettingDefinitions()` answers them. */
function itemsOf(tab: Tab, heading: string): Definition[] {
	const group = (tab.getSettingDefinitions() as unknown as Definition[]).find((item) => item.heading === heading);
	if (!group) throw new Error(`no group "${heading}"`);
	return group.items ?? [];
}

/**
 * One root group's rows as definitions: the name, the kind (a control's type, `render`, or `text`),
 * the control's key, and whether a `visible` predicate shows it right now.
 */
function rowsOf(tab: Tab, heading: string): Row[] {
	return rowsIn(itemsOf(tab, heading));
}

type Row = { name: string; kind: string; key?: string; shown: boolean };

function rowsIn(items: Definition[]): Row[] {
	return items.map((item) => ({
		name: item.name ?? "",
		kind: item.control?.type ?? (item.render ? "render" : "text"),
		...(item.control ? { key: item.control.key } : {}),
		shown: item.visible?.() ?? true,
	}));
}

describe("the declarative tab (settings-redesign spec §2, §3)", () => {
	const groupsOf = (tab: Tab): [string | undefined, string | undefined][] =>
		(tab.getSettingDefinitions() as unknown as Definition[]).map((group) => [group.heading, group.cls]);

	it("answers with the root page's eight groups in order, Zotero and Readwise as pages", async () => {
		const { tab } = await tabWith({ deviceToken: "d" });

		expect(groupsOf(tab)).toEqual([
			["reMarkable connection", "tagged-sync-group-connection"],
			["Tag routing", "tagged-sync-group-tags"],
			["Vault output", "tagged-sync-group-vault"],
			["Transcription", "tagged-sync-group-transcription"],
			["Automatic sync", "tagged-sync-group-autosync"],
			["Integrations", "tagged-sync-group-integrations"],
			["Tagged Sync Pro", "tagged-sync-group-pro"],
			["Help", "tagged-sync-group-help"],
		]);
		const integrations = (tab.getSettingDefinitions() as unknown as Definition[])[5];
		expect(integrations.items?.map((item) => [item.type, item.name])).toEqual([
			["page", "Zotero"],
			["page", "Readwise"],
		]);
	});

	// Left out rather than hidden: a hidden row stays in the page and draws a stray border (spec §2.4).
	it("leaves Tag routing out of the definitions until there is a device to sync with", async () => {
		const { tab } = await tabWith();

		expect(groupsOf(tab).map(([heading]) => heading)).not.toContain("Tag routing");
	});

	it("draws a row that throws as one sentence, and every other row as before", async () => {
		const { tab } = await tabWith({ ocrBackend: "test-throws" });
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const drawn = draw(tab);

		expect(section(drawn, "Transcription")).toEqual([
			expect.objectContaining({ kind: "row", name: "Backend" }),
			expect.objectContaining({ kind: "row", desc: "This row could not be drawn. Copy diagnostics under Help and report it." }),
		]);
		expect(rowNames(section(drawn, "Vault output"))).toContain("Attachments folder");
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	// A predicate that throws must not take the tab with it either; hidden is the answer that shows
	// nothing broken (spec §2.2).
	it("hides a row whose visible predicate throws, and says why in the console", async () => {
		const { plugin, tab } = await tabWith({ autoSync: { enabled: true, intervalHours: 6, autoTranscribeMetered: false } });
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const drawn = draw(tab);
		Object.defineProperty(plugin.data, "autoSync", {
			get: () => {
				throw new Error("broken");
			},
		});

		tab.refreshDomState();

		expect(rowNames(section(drawn, "Automatic sync"))).toEqual(["Enable automatic sync"]);
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	// It runs inside `onload` too (via `addSettingTab`), where a throw would stop the whole plugin.
	it("answers one row instead of throwing when the definitions cannot be built", async () => {
		const { plugin, tab } = await tabWith();
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		(plugin as unknown as { transport(): never }).transport = () => {
			throw new Error("broken");
		};

		expect(tab.getSettingDefinitions()).toEqual([
			{ name: "The settings could not be drawn.", desc: "Report it with the steps that led here." },
		]);
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});

	it("reads and writes data.json by dot path, replacing the object a running sync may hold", async () => {
		const { plugin, tab } = await tabWith();
		const before = plugin.data.zotero as { useWeb: boolean };

		expect(tab.getControlValue("zotero.useWeb")).toBe(false);
		await tab.setControlValue("zotero.useWeb", true);

		expect(before.useWeb).toBe(false);
		expect(tab.getControlValue("zotero.useWeb")).toBe(true);
		expect((plugin.saves.at(-1) as { zotero: { useWeb: boolean } }).zotero.useWeb).toBe(true);
	});

	// A toggle's `setValue` fires its change again, and a re-render that sets would loop (spec §2.3).
	it("saves nothing for the value that is already stored", async () => {
		const { plugin, tab } = await tabWith({ marginNotes: false });
		const saves = plugin.saves.length;

		await tab.setControlValue("marginNotes", false);

		expect(plugin.saves).toHaveLength(saves);
	});

	// Settings may sit in their own window, and closing it must not drop what was typed (spec §2.3).
	it("holds a typed value back from data.json, and writes it when the tab closes", async () => {
		const { plugin, tab } = await tabWith();
		const saves = plugin.saves.length;

		await tab.setControlValue("attachmentsFolder", "Renders");
		expect(plugin.data.attachmentsFolder).toBe("Renders");
		expect(plugin.saves).toHaveLength(saves);

		tab.hide();
		expect((plugin.saves.at(-1) as { attachmentsFolder: string }).attachmentsFolder).toBe("Renders");
	});

	// Written anyway, it would add a field `data.json` never had (spec scope: its shape stays).
	it("refuses a key that names nothing in data.json, and saves nothing", async () => {
		const { plugin, tab } = await tabWith();
		const saves = plugin.saves.length;

		await expect(tab.setControlValue("zotero.group:4711", true)).rejects.toThrow('no setting "zotero.group:4711"');
		await expect(tab.setControlValue("nonsense", true)).rejects.toThrow('no setting "nonsense"');
		expect(plugin.data).not.toHaveProperty("nonsense");
		expect(plugin.saves).toHaveLength(saves);
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

	it("gives a tablet that never answered the whole paragraph, not a line about a connection", async () => {
		pairing.fail = new DeviceUnreachableError("192.168.1.9", null);
		const { tab } = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ...BOUGHT_PRO });
		const drawn = draw(tab);
		row(drawn, "Connect device").setting.texts[1].type("hunter2");
		takeNotices();

		await buttons(drawn, "Connect device")[0].click();
		await settle();

		// On a Paper Pro the answer to a silent tablet is a factory reset, and nobody should meet that
		// fact halfway through pairing. Which tablet this is cannot be known when it did not answer, so
		// the guidance covers both generations -- including, out loud, the one that costs the reset.
		const [notice] = takeNotices();
		expect(notice).toContain("erases the tablet");
		expect(notice).toContain("Copyrights");
	});

	it("passes on a refusal the tablet itself explained, without talking over it", async () => {
		pairing.fail = new PairingRefusedError("Pairing stopped: the device's key was not trusted.");
		const { tab } = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ...BOUGHT_PRO });
		const drawn = draw(tab);
		row(drawn, "Connect device").setting.texts[1].type("hunter2");
		takeNotices();

		await buttons(drawn, "Connect device")[0].click();
		await settle();

		// Saying "not trusted" and then a paragraph about Developer Mode would send someone to erase a
		// tablet over a dialog they answered themselves.
		expect(takeNotices()).toEqual(["Pairing stopped: the device's key was not trusted."]);
	});

	it("says out loud, before anyone types a password, what Developer Mode costs", async () => {
		// The one fact no competitor states in-product, and the worst possible one to meet halfway
		// through pairing. Folded away, but present and reachable without an attempt first -- in the
		// row's own description, since a group has no loose text between rows (spec P10).
		const { tab } = await tabWith({ deviceToken: "d", primaryTransport: "ssh", ...BOUGHT_PRO });
		const help = row(draw(tab), "Connect device").setting.descEl.children.filter((child) => child.classes.has("tagged-sync-pairing-help"));

		expect(help.map((fold) => fold.tag)).toEqual(["details"]);
		expect(help[0].allText().join(" ")).toContain("erases the tablet");
		expect(help[0].children[0]).toMatchObject({ tag: "summary", text: "What your reMarkable needs before this works" });
	});
});

describe("vault output", () => {
	// Frontmatter stays drawn by our code: a refused switch has to be set back, and Obsidian leaves a
	// control showing what was clicked (settings-redesign ticket 17's F5).
	it("binds the folder and the handwriting switch to data.json, and draws frontmatter itself", async () => {
		const { tab } = await tabWith();

		expect(rowsOf(tab, "Vault output")).toEqual([
			{ name: "Attachments folder", kind: "folder", key: "attachmentsFolder", shown: true },
			{ name: "Your notes on PDFs", kind: "toggle", key: "marginNotes", shown: true },
			{ name: "Frontmatter properties (Pro)", kind: "render", shown: true },
		]);
		expect(itemsOf(tab, "Vault output")[0]).toMatchObject({
			aliases: ["PDF folder", "render"],
			control: { placeholder: DEFAULT_ATTACHMENTS_FOLDER, includeRoot: false },
		});
	});

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

	it("records the old value when the handwriting switch moves, and rewrites no note yet", async () => {
		// Decided at the next sync (`settleMarginNotesChoice`), not here: a switch knocked off and back on
		// must not read every margin note again. What it needs from here is what the last sync ran with,
		// on a vault that has not recorded that yet.
		const { plugin, tab } = await tabWith({
			syncIndex: { rows: { a: { notePath: "a.md", status: "active", renderVersion: 7 } } },
		});
		const switchRow = toggle(draw(tab), "Your notes on PDFs");
		expect(switchRow.value).toBe(false);

		switchRow.toggle(true);
		await settle();

		expect(plugin.data.marginNotes).toBe(true);
		const saved = plugin.saves.at(-1) as { marginNotesSynced?: boolean; syncIndex: { rows: Record<string, { renderVersion?: number }> } };
		expect(saved.syncIndex.rows.a.renderVersion).toBe(7);
		expect(saved.marginNotesSynced).toBe(false);
	});

	// An active trial -- the cheapest entitlement that unlocks Pro, with no key to fake.
	const TRIAL = { ...NO_LICENCE, trialStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() };

	it("offers frontmatter properties locked to a free user and open past the paywall", async () => {
		// Shown and disabled rather than hidden -- the transport dropdown's rule, on a toggle.
		const free = await tabWith();
		expect(toggle(draw(free.tab), "Frontmatter properties (Pro)").disabled).toBe(true);

		const trial = await tabWith({ licence: TRIAL });
		expect(toggle(draw(trial.tab), "Frontmatter properties").disabled).toBe(false);
	});

	it("refuses to enable frontmatter without a connection, and does not pretend it is on", async () => {
		// The backfill needs the device listing, so an unconnected vault gets the connect sentence --
		// and the setting must not persist as on when no pass could run.
		const { plugin, tab } = await tabWith({ licence: TRIAL });

		toggle(draw(tab), "Frontmatter properties").toggle(true);
		await settle();

		expect(plugin.data.frontmatter).toBe(false);
		expect(takeNotices()).toEqual([NOT_CONNECTED_NOTICE]);
	});

	it("treats a click that changes nothing as nothing -- no pass, no notice", async () => {
		// setValue fires the change handler again in real Obsidian, so setting the toggle back after a
		// refused enable re-enters the handler with the value it already shows. Without the guard that
		// re-entry would run a cleanup pass nobody asked for.
		const { plugin, tab } = await tabWith({ licence: TRIAL });

		toggle(draw(tab), "Frontmatter properties").toggle(false);
		await settle();

		expect(plugin.data.frontmatter).toBe(false);
		expect(plugin.saves).toEqual([]);
		expect(takeNotices()).toEqual([]);
	});

	it("turns frontmatter off through the cleanup pass, forgetting the tracked tags", async () => {
		const { plugin, tab } = await tabWith({
			licence: TRIAL,
			frontmatter: true,
			syncIndex: { rows: { a: { notePath: "a.md", status: "active", frontmatterTags: ["remarkable/x"] } } },
		});

		toggle(draw(tab), "Frontmatter properties").toggle(false);
		await settle();

		expect(plugin.data.frontmatter).toBe(false);
		const saved = plugin.saves.at(-1) as { frontmatter: boolean; syncIndex: { rows: Record<string, { frontmatterTags?: string[] }> } };
		expect(saved.frontmatter).toBe(false);
		expect(saved.syncIndex.rows.a.frontmatterTags).toBeUndefined();
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

	it("lists every registered backend, whether or not it can run here", async () => {
		// Asserted over the live registry rather than as a fixed list of ids: a build that gains a
		// backend would pass a hard-coded list by simply not showing it. Nothing is hidden any more --
		// a backend whose model is not downloaded yet is listed, and its own rows say what to do once
		// it is picked. Hiding it until then was reported as the entry missing.
		const { tab } = await tabWith({ ocrBackend: "off" });
		const listed = options(draw(tab)).map((option) => option.id);

		expect(listed).toEqual(ocrBackendEntries().map((entry) => entry.id));
		expect(listed).toContain("test-gap");
	});

	it("shows a gap nothing can close, disabled, with the reason where the name was", async () => {
		const { tab } = await tabWith({ ocrBackend: "off" });

		expect(options(draw(tab))).toContainEqual({ id: "test-gap", text: "Test — not here", disabled: true });
		expect(options(draw(tab))).toContainEqual({ id: "test-plain", text: "Test test-plain", disabled: false });
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
		expect(settingsRows).toEqual(["test-plain"]);
		expect(dropdown(draw(tab), "Backend").value).toBe("test-plain");
	});

	/**
	 * The re-draw above is what makes the rows right; this is what stops it costing the reader their
	 * place. Transcription sits well down a long page, so choosing a backend emptied the element the
	 * pane scrolls, took the offset to zero with it, and left the user at the top -- away from the very
	 * setting they had just changed. Reported from a real settings page on 2026-09-10. Since 1.11.0
	 * `update()` keeps the place itself (measured, settings-redesign ticket 17's F1); this guards that
	 * nothing of ours moves it.
	 */
	it("leaves the reader where they were after a re-draw", async () => {
		const { tab } = await tabWith({ ocrBackend: "off" });
		const drawn = draw(tab);
		tab.containerEl.scrollTop = 420;

		dropdown(drawn, "Backend").pick("test-plain");
		await settle();

		expect(tab.containerEl.scrollTop).toBe(420);
	});

	/**
	 * Reported from a real settings page: with LM Studio selected, the row explained Apple Vision, then
	 * local models, then cloud providers, and left the reader to work out which clause was theirs. The
	 * three families really are three different promises, which is the argument for making one.
	 */
	it("describes the backend that is selected, and none of the others", async () => {
		const onDevice = row(draw((await tabWith({ ocrBackend: "test-plain" })).tab), "Backend").desc;

		expect(onDevice).toBe("Runs on hardware you own — no account and no key.");
		expect(onDevice).not.toContain("Apple Vision");
		expect(onDevice).not.toContain("API key");
	});

	it("names the cost where the pages leave the machine, and only there", async () => {
		const metered = row(draw((await tabWith({ ocrBackend: "test-metered" })).tab), "Backend").desc;

		expect(metered).toBe("Each page is sent to the provider, charged to your own API key.");
	});

	// The macOS floor belongs on the option that cannot run -- the dropdown carries it there -- not in
	// the description of the backend somebody has already chosen.
	it("keeps the macOS floor out of the description", async () => {
		const vision = row(draw((await tabWith({ ocrBackend: "vision" })).tab), "Backend").desc;

		expect(vision).toContain("Runs on your Mac");
		expect(vision).not.toContain("macOS 13");
	});
});

describe("the transcript sentence in the Backend row", () => {
	const desc = (drawn: Drawn[]) => row(drawn, "Backend").desc;

	it("names Apple Vision's ceiling only while Apple Vision is the selected backend", async () => {
		machine.visionAvailable = true;
		const { tab } = await tabWith({ ocrBackend: "vision" });

		expect(desc(draw(tab))).toBe(
			"Runs on your Mac — no account, no key, no network. Transcripts are flat text, no headings or tables. Choose an LLM backend for structured Markdown.",
		);
	});

	it("says nothing about Apple Vision under a backend that has no contract of its own", async () => {
		// The ceiling used to be the fallback sentence for every backend without a contract, so a reader
		// who had already chosen an LLM backend was told to choose an LLM backend.
		machine.visionAvailable = true;
		const { tab } = await tabWith({ ocrBackend: "test-plain" });

		expect(desc(draw(tab))).toBe("Runs on hardware you own — no account and no key.");
	});

	it("appends the selected backend's own contract to its promise, as one description", async () => {
		// One row, not a loose line under it: on its own the sentence read as a footnote with nothing to
		// belong to.
		machine.visionAvailable = true;
		const { tab } = await tabWith({ ocrBackend: "test-contract" });

		expect(desc(draw(tab))).toBe(`Runs on hardware you own — no account and no key. ${CONTRACT}`);
	});
});

describe("a backend's own rows", () => {
	// One row hosts them (spec P3): the backends keep their code, and settings search skips the host.
	it("are hosted by one unsearchable row, there only while the selected backend has rows", async () => {
		const { tab } = await tabWith({ ocrBackend: "test-plain" });

		expect(rowsOf(tab, "Transcription")).toEqual([
			{ name: "Backend", kind: "render", shown: true },
			{ name: "Backend settings", kind: "render", shown: true },
		]);
		expect(itemsOf(tab, "Transcription").map((item) => [item.aliases, item.searchable])).toEqual([
			[["OCR", "handwriting", "transcription model"], undefined],
			[undefined, false],
		]);
		expect(rowsOf((await tabWith({ ocrBackend: "off" })).tab, "Transcription").map((item) => item.name)).toEqual(["Backend"]);
	});

	it("draws them into the host row's own element, without the row's name or controls beside them", async () => {
		const { tab } = await tabWith({ ocrBackend: "test-cleanup" });
		const drawn = draw(tab);

		expect(rowNames(section(drawn, "Transcription"))).toEqual(["Backend", "Backend's own row"]);
		const own = row(drawn, "Backend's own row").setting.settingEl.parentEl;
		expect(own?.classes.has("tagged-sync-backend-host")).toBe(true);
	});

	// Obsidian keeps the host row across a redraw (same name, same row) and draws into it again; the
	// rows of the backend left behind must go with the switch. Found on the device: the local model's
	// card stayed under LM Studio's rows.
	it("replaces the previous backend's rows when another backend is picked", async () => {
		const { tab } = await tabWith({ ocrBackend: "test-cleanup" });
		dropdown(draw(tab), "Backend").pick("test-plain");
		await settle();

		const drawn = onScreen(tab);
		expect(rowNames(section(drawn, "Transcription"))).not.toContain("Backend's own row");
		const hosts = row(drawn, "Backend settings").setting.settingEl.children.filter((child) => child.classes.has("tagged-sync-backend-host"));
		expect(hosts.map((host) => host.allText())).toEqual([["rows:test-plain"]]);
	});

	// The local model's card redraws itself on each download tick; a torn-down host must stop that.
	it("tears the backend's rows down with the host row: on a redraw and when the tab closes", async () => {
		tornDown.length = 0;
		const { tab } = await tabWith({ ocrBackend: "test-cleanup" });
		draw(tab);

		tab.update();
		expect(tornDown).toEqual(["test-cleanup"]);
		tab.hide();
		expect(tornDown).toEqual(["test-cleanup", "test-cleanup"]);
	});

	it("draws the settings rows of the selected backend and of no other", async () => {
		const { tab } = await tabWith({ ocrBackend: "test-plain" });
		draw(tab);
		expect(settingsRows).toEqual(["test-plain"]);

		settingsRows.length = 0;
		const other = await tabWith({ ocrBackend: "off" });
		draw(other.tab);
		expect(settingsRows).toEqual([]);
	});
});

describe("automatic sync", () => {
	const AUTO_ON = { enabled: true, intervalHours: 6, autoTranscribeMetered: false };

	it("keeps its rows as controls bound to data.json, the ones after the switch shown only while it is on", async () => {
		const off = await tabWith({ ocrBackend: "anthropic" });
		expect(rowsOf(off.tab, "Automatic sync")).toEqual([
			{ name: "Enable automatic sync", kind: "toggle", key: "autoSync.enabled", shown: true },
			{ name: "Sync interval", kind: "dropdown", key: "autoSync.interval", shown: false },
			{ name: BACKGROUND_CONSENT_NAME, kind: "toggle", key: "autoSync.autoTranscribeMetered", shown: false },
		]);

		// The consent row whose blob the backend owns is drawn by our code: its description reads the disk.
		const on = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-consent" });
		expect(rowsOf(on.tab, "Automatic sync")).toEqual([
			{ name: "Enable automatic sync", kind: "toggle", key: "autoSync.enabled", shown: true },
			{ name: "Sync interval", kind: "dropdown", key: "autoSync.interval", shown: true },
			{ name: BACKGROUND_CONSENT_NAME, kind: "render", shown: true },
		]);
	});

	it("shows one switch and nothing else while it is off", async () => {
		const { tab } = await tabWith();

		expect(rowNames(section(draw(tab), "Automatic sync"))).toEqual(["Enable automatic sync"]);
	});

	// The rows it unlocks are in the page already and only shown (spec §3.5): nothing is drawn again,
	// so the page cannot jump under the reader's pointer.
	it("shows the rows it unlocks the moment it is switched on, without drawing the page again", async () => {
		const { plugin, tab } = await tabWith();
		const drawn = draw(tab);
		toggle(drawn, "Enable automatic sync").toggle(true);
		await settle();

		expect((plugin.saves.at(-1) as { autoSync: { enabled: boolean } }).autoSync.enabled).toBe(true);
		expect(rowNames(section(drawn, "Automatic sync"))).toEqual(["Enable automatic sync", "Sync interval"]);
		expect(takeSettings()).toEqual([]);
	});

	// Not numeric keys: an object lists integer-like keys first, which would put "Only on launch" last.
	it("offers launch-only and four intervals, launch-only first, and stores it as no interval at all", async () => {
		const { plugin, tab } = await tabWith({ autoSync: AUTO_ON });
		const interval = dropdown(draw(tab), "Sync interval");

		expect(Object.entries(interval.options)).toEqual([
			["launch", "Only on launch"],
			["h2", "Every 2 hours"],
			["h6", "Every 6 hours"],
			["h12", "Every 12 hours"],
			["h24", "Every 24 hours"],
		]);
		expect(interval.value).toBe("h6");

		interval.pick("launch");
		await settle();
		expect((plugin.data.autoSync as { intervalHours: number | null }).intervalHours).toBeNull();
		expect(dropdown(draw(tab), "Sync interval").value).toBe("launch");

		dropdown(draw(tab), "Sync interval").pick("h12");
		await settle();
		expect((plugin.saves.at(-1) as { autoSync: { intervalHours: number | null } }).autoSync.intervalHours).toBe(12);
	});

	it("re-arms the timer on every change, not only on the next restart", async () => {
		// The setting is the interval a running Obsidian syncs at. Saved and not re-armed, it would
		// take effect the next time the vault opened -- which is the one moment the user is not there
		// to notice that nothing changed.
		const { plugin, tab } = await tabWith({ autoSync: { ...AUTO_ON, intervalHours: null } });
		const clock = (plugin as unknown as { scheduler: FakeClock }).scheduler;
		const before = clock.armed;

		dropdown(draw(tab), "Sync interval").pick("h2");
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
		expect(rowNames(section(draw(withBoth.tab), "Automatic sync"))).toContain(BACKGROUND_CONSENT_NAME);

		const withHalf = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-half-consent" });
		expect(rowNames(section(draw(withHalf.tab), "Automatic sync"))).not.toContain(BACKGROUND_CONSENT_NAME);
	});

	it("writes the consent through the backend's own accessors, never into a field of its own", async () => {
		// The blob stays opaque: the plugin renders the row and gates the run without ever learning
		// which key inside it holds the answer.
		const { plugin, tab } = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-consent" });
		const drawn = draw(tab);
		const consent = row(drawn, BACKGROUND_CONSENT_NAME);

		expect(consent.desc).toBe("Test consent row.");
		expect(consent.setting.toggles[0].value).toBe(false);

		consent.setting.toggles[0].toggle(true);
		await settle();

		expect((plugin.data.llmProviders as Record<string, { ok?: boolean }>)["test-consent"].ok).toBe(true);
	});

	it("asks about spending money only on a backend that spends money", async () => {
		const free = await tabWith({ autoSync: AUTO_ON, ocrBackend: "test-plain" });
		expect(rowNames(section(draw(free.tab), "Automatic sync"))).not.toContain(BACKGROUND_CONSENT_NAME);

		// Same name as the battery/RAM row, because off means the same thing: no scheduled run at
		// all. The old name promised a sync without transcripts, which is not what the gate does.
		const metered = await tabWith({ autoSync: AUTO_ON, ocrBackend: "anthropic" });
		const paid = row(draw(metered.tab), BACKGROUND_CONSENT_NAME);
		expect(paid.desc).toContain("bills your API key");
		expect(paid.desc).toContain("Anthropic (Claude)");
		expect(paid.desc).toContain("automatic sync does nothing while this backend is chosen");
		expect(paid.setting.toggles[0].value).toBe(false);

		paid.setting.toggles[0].toggle(true);
		await settle();
		expect((metered.plugin.data.autoSync as { autoTranscribeMetered: boolean }).autoTranscribeMetered).toBe(true);
	});
});

describe("the Zotero section", () => {
	// Zotero is split (spec §5): zotero.org, Send and the note's Zotero line are free; the desktop
	// app and Send over SSH are Pro, and those two rows are *shown* disabled with "(Pro)" rather than
	// hidden -- the same rule as the transport dropdown and the frontmatter toggle. What a free user
	// cannot see is not something they can decide to buy.
	const PRO = {
		licence: {
			...NO_LICENCE,
			key: "TS-XXXX-1234",
			activationId: "act-1",
			validatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		},
	};

	it("opens zotero.org to a free user, shows the desktop app shut, and says which half is Pro", async () => {
		const { tab } = await tabWith();
		const drawn = draw(tab);

		const page = section(drawn, "Zotero");
		expect(toggle(page, "Use zotero.org").disabled).toBe(false);
		expect(toggle(page, "Use the Zotero desktop app (Pro)").disabled).toBe(true);
		// The Pro rows are on this page, not below it (settings-redesign P5).
		expect(row(page, "Connection").desc).toBe(
			"zotero.org is enough: send papers to your tablet, and your notes know which paper they are. Writing your highlights into Zotero, and the desktop app connection, are part of Tagged Sync Pro.",
		);
	});

	it("drops the (Pro) and opens both connections for a buyer", async () => {
		const { tab } = await tabWith(PRO);
		const drawn = draw(tab);

		expect(rowNames(drawn)).not.toContain("Use the Zotero desktop app (Pro)");
		expect(toggle(drawn, "Use zotero.org").disabled).toBe(false);
		expect(toggle(drawn, "Use the Zotero desktop app").disabled).toBe(false);
	});

	// One switch per connection (desk test 2026-09-13): whether anything goes over the internet is
	// then one visible thing, not "is the key field empty". The key row belongs to the switch, and is
	// left out rather than hidden while it is off: the switch redraws the page anyway (spec §2.4).
	it("puts the key row on the page only while zotero.org is switched on", async () => {
		const off = draw((await tabWith(PRO)).tab);
		expect(rowNames(section(off, "Zotero"))).toEqual(["Connection", "Use zotero.org", "Use the Zotero desktop app"]);

		const on = draw((await tabWith({ ...PRO, zotero: { useWeb: true } })).tab);
		expect(rowNames(section(on, "Zotero"))).toEqual(["Connection", "Use zotero.org", "Zotero API key", "Use the Zotero desktop app"]);
		expect(rowNames(section(on, "Send to your tablet"))).toContain("Tablet folder for sent PDFs");
	});

	it("saves the cloud switch, shows the key row and asks the status line again", async () => {
		const { plugin, tab } = await tabWith(PRO);
		toggle(draw(tab), "Use zotero.org").toggle(true);
		await settle();

		const drawn = onScreen(tab);
		expect((plugin.data.zotero as { useWeb: boolean }).useWeb).toBe(true);
		expect(plugin.saves).toHaveLength(1);
		expect(rowNames(drawn)).toContain("Zotero API key");
		// On with no key yet is still nothing: the line was asked again and says so.
		expect(verdict(row(drawn, "Connection")).text).toBe("Not connected.");
	});

	// Settings-redesign spec §6: four groups, the connection without a heading; every switch and field
	// is a control row bound to its `data.json` key, and the live lines are drawn by our code.
	it("answers four groups on its page, each row bound to its key", async () => {
		const { tab } = await tabWith({ ...PRO, zotero: { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ" } });

		expect(pageGroups(tab, "Zotero")).toEqual([
			{
				heading: undefined,
				cls: "tagged-sync-group-zotero-connection",
				rows: [
					{ name: "Connection", kind: "render", shown: true },
					{ name: "Use zotero.org", kind: "toggle", key: "zotero.useWeb", shown: true },
					{ name: "Zotero API key", kind: "render", shown: true },
					{ name: "Use the Zotero desktop app", kind: "toggle", key: "zotero.useLocal", shown: true },
				],
			},
			{ heading: "Libraries", cls: "tagged-sync-group-zotero-libraries", rows: [{ name: "Group libraries", kind: "render", shown: true }] },
			{
				heading: "Into Zotero",
				cls: "tagged-sync-group-zotero-into",
				rows: [
					{ name: "Write text to Zotero", kind: "toggle", key: "zotero.writeText", shown: true },
					{ name: "Add the render to Zotero", kind: "toggle", key: "zotero.addRender", shown: true },
					{ name: "What leaves your machine", kind: "text", shown: true },
				],
			},
			{
				heading: "Send to your tablet",
				cls: "tagged-sync-group-zotero-send",
				rows: [
					{ name: "Tablet folder for sent PDFs", kind: "text", key: "zotero.folder", shown: true },
					{ name: "Send tag in Zotero", kind: "text", key: "zotero.sendTag", shown: true },
					{ name: "Send over SSH when the cloud is not connected", kind: "toggle", key: "zotero.sendOverSsh", shown: true },
				],
			},
		]);
	});

	it("finds the key field by the word people search for", async () => {
		const { tab } = await tabWith({ zotero: { useWeb: true } });
		const connection = integrationPage(tab, "Zotero").items?.[0].items ?? [];

		expect(connection.find((item) => item.name === "Zotero API key")?.aliases).toEqual(["token"]);
	});

	// Settings-redesign spec §5: the entry on the root says what is set up, without opening the page.
	describe("its entry on the root", () => {
		const entry = (tab: Tab): unknown => {
			takeSettings();
			renderSettingTab(tab);
			return takeSettings().find((setting: Setting) => setting.name === "Zotero")?.components;
		};

		it("warns for zotero.org switched on with no key behind it", async () => {
			expect(entry((await tabWith({ zotero: { useWeb: true } })).tab)).toEqual([expect.objectContaining({ value: "No API key", status: "warning" })]);
		});

		it("names both connections for a buyer who set up both", async () => {
			const { tab } = await tabWith({ ...PRO, zotero: { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ", useLocal: true } });
			expect(entry(tab)).toEqual([expect.objectContaining({ value: "zotero.org + desktop app", status: null })]);
		});

		// A predicate that throws must not take the tab with it (spec §2.2): an empty entry shows nothing broken.
		it("shows nothing on the entry when its state cannot be read, and says why in the console", async () => {
			const { plugin, tab } = await tabWith();
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const page = integrationPage(tab, "Zotero");
			Object.defineProperty(plugin.data, "zotero", {
				get: () => {
					throw new Error("broken");
				},
			});

			expect([page.displayValue?.(), page.status?.()]).toEqual(["", null]);
			expect(errors).toHaveBeenCalled();
			errors.mockRestore();
		});
	});

	// A key left in place with the switch off is kept, and reaches nothing: the line says so without
	// a single request going out.
	it("reads a key with zotero.org switched off as not connected, without asking zotero.org", async () => {
		const fetched = vi.fn(async () => new Response("[]", { status: 200 }));
		stubNetwork(fetched);
		const { tab } = await tabWith({ ...PRO, zotero: { useWeb: false, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ", useLocal: false, localKeys: {} } });
		const drawn = draw(tab);
		await settle();

		expect(verdict(row(drawn, "Connection")).text).toBe("Not connected.");
		expect(fetched).not.toHaveBeenCalled();
	});

	// The privacy sentence sits beside the switches it is about, not only in the README (spec §1.2;
	// Zotero spec §1 moved it under *Into Zotero*, words from ticket 05 #6).
	it("says what leaves the machine, under the two switches it is about", async () => {
		const drawn = draw((await tabWith(PRO)).tab);

		expect(rowNames(section(drawn, "Into Zotero"))).toEqual(["Write text to Zotero", "Add the render to Zotero", "What leaves your machine"]);
		expect(row(drawn, "What leaves your machine").desc).toBe(
			"Your handwriting never does, unless you switch on Add the render to Zotero. With Write text to Zotero, the text of your highlights, " +
				"margin notes and added pages is written into your own Zotero library -- and to zotero.org, if that is the connection carrying it.",
		);
	});

	describe("Into Zotero", () => {
		const WEB = { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ" };

		it("writes text and adds no render until told otherwise, in the words of ticket 05", async () => {
			const drawn = draw((await tabWith({ ...PRO, zotero: WEB })).tab);

			expect([toggle(drawn, "Write text to Zotero").value, toggle(drawn, "Add the render to Zotero").value]).toEqual([true, false]);
			expect([toggle(drawn, "Write text to Zotero").disabled, toggle(drawn, "Add the render to Zotero").disabled]).toEqual([false, false]);
			expect(row(drawn, "Write text to Zotero").desc).toBe(
				"Your tablet highlights become Zotero annotations, with your margin notes as their comments, and each page you added to a PDF " +
					"becomes a note under the paper. Everything carries the tag tagged-sync. Switched off, nothing new is written and what is " +
					"already in Zotero stays; filter by the tag in Zotero to remove it.",
			);
			expect(row(drawn, "Add the render to Zotero").desc).toBe(
				'Uploads the PDF as it looks on your tablet, ink and all and searchable, to Zotero Storage as an attachment "Annotated PDF" ' +
					"under the paper. Your handwriting then leaves this machine for zotero.org and counts against your storage there. Only " +
					"documents tagged as a whole, in your personal library. If your Zotero files sync over WebDAV, leave this off.",
			);
			expect(row(drawn, "Use zotero.org").desc).toContain("with write-back your highlights and notes are written there, and the render if you add it.");
		});

		it("shows both switches shut to a free vault, as Pro rows", async () => {
			const drawn = draw((await tabWith({ zotero: WEB })).tab);

			expect(rowNames(section(drawn, "Into Zotero"))).toEqual(["Write text to Zotero (Pro)", "Add the render to Zotero (Pro)", "What leaves your machine"]);
			expect([toggle(drawn, "Write text to Zotero (Pro)").disabled, toggle(drawn, "Add the render to Zotero (Pro)").disabled]).toEqual([true, true]);
		});

		// Ticket 04 #1: a render reaches Zotero over zotero.org only.
		it("shuts the render switch without a zotero.org connection and says why, and opens it once there is one", async () => {
			const { plugin, tab } = await tabWith({ ...PRO, zotero: { useLocal: true } });
			const drawn = draw(tab);

			expect(toggle(drawn, "Add the render to Zotero").disabled).toBe(true);
			expect(row(drawn, "Add the render to Zotero").desc).toMatch(/^Needs a zotero\.org connection\. Uploads the PDF/);
			expect(toggle(drawn, "Write text to Zotero").disabled).toBe(false);

			toggle(drawn, "Use zotero.org").toggle(true);
			await settle();
			const typing = onScreen(tab);
			const key = field(typing, "Zotero API key");
			key.type("P9c46b0lkV2XzAoUTqPmPuGZ");
			await settle();

			// Opened in place while the key is typed, not redrawn: a redraw under a field being typed into
			// takes its focus. The sentence follows when the field is left (settings-redesign P15).
			expect(plugin.data.zotero).toMatchObject(WEB);
			expect(takeSettings()).toEqual([]);
			expect(toggle(typing, "Add the render to Zotero").disabled).toBe(false);
			expect(row(typing, "Add the render to Zotero").setting.desc).toMatch(/^Needs a zotero\.org connection\./);

			key.inputEl.dispatch("blur");
			expect(row(onScreen(tab), "Add the render to Zotero").setting.desc).toMatch(/^Uploads the PDF/);
		});

		// Settings-redesign spec §2.8: a change that ends in `update()` leaves the probe to the redraw --
		// one request per change, not one from the redraw and one from the typing's debounce.
		it("asks zotero.org once when the field is left before the line's own recheck", async () => {
			vi.useFakeTimers();
			const asked = vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith("/keys/current") ? new Response(JSON.stringify({ userID: 1597773 }), { status: 200 }) : new Response("[]", { status: 200 }),
			);
			stubNetwork(asked);
			// Free, so no group lookup redraws the page and asks again on its own.
			const { tab } = await tabWith({ zotero: { useWeb: true } });
			const key = field(draw(tab), "Zotero API key");

			key.type("P9c46b0lkV2XzAoUTqPmPuGZ");
			await vi.advanceTimersByTimeAsync(0);
			key.inputEl.dispatch("blur");
			await vi.advanceTimersByTimeAsync(700);

			// `/items/top` is the line's probe (`status()`); `/keys/current` comes with every client call.
			expect(asked.mock.calls.filter(([input]) => String(input).includes("/items/top"))).toHaveLength(1);
		});

		it("draws nothing again when the field is left with the connection as it was", async () => {
			const { tab } = await tabWith({ ...PRO, zotero: WEB });
			const key = field(draw(tab), "Zotero API key");

			key.type("ANOTHERGOODKEYANOTHERGOO");
			key.inputEl.dispatch("blur");

			expect(takeSettings()).toEqual([]);
		});

		// Decided at the next sync (`settleZoteroSwitches`), so a switch knocked off and back on reads
		// nothing again. What it needs from here is what the last sync ran with, on a vault without it.
		it.each(["Write text to Zotero", "Add the render to Zotero"])("records the old values and makes no document due yet when %s is switched on", async (name) => {
			const index = {
				rows: {
					"doc-1::sync": { docId: "doc-1", notePath: "a.md", status: "active", renderVersion: 33 },
					"doc-2::sync": { docId: "doc-2", notePath: "b.md", status: "active", renderVersion: 33 },
				},
			};
			const links = { "doc-1": { attachmentKey: "ATT1", library: "user", annotations: {} } };
			const { plugin, tab } = await tabWith({ ...PRO, zotero: { ...WEB, writeText: false }, syncIndex: index, zoteroLinks: links });
			const drawn = draw(tab);

			toggle(drawn, name).toggle(true);
			await settle();

			const saved = plugin.saves.at(-1) as { syncIndex: { rows: Record<string, { renderVersion?: number }> }; zotero: Record<string, boolean>; zoteroSwitchesSynced?: unknown };
			expect([saved.syncIndex.rows["doc-1::sync"].renderVersion, saved.syncIndex.rows["doc-2::sync"].renderVersion]).toEqual([33, 33]);
			expect(saved.zotero[name === "Write text to Zotero" ? "writeText" : "addRender"]).toBe(true);
			expect(saved.zoteroSwitchesSynced).toEqual({ writeText: false, addRender: false });
		});

		it("leaves every document as it is when a switch goes off", async () => {
			const index = { rows: { "doc-1::sync": { docId: "doc-1", notePath: "a.md", status: "active", renderVersion: 33 } } };
			const links = { "doc-1": { attachmentKey: "ATT1", library: "user", annotations: {} } };
			const { plugin, tab } = await tabWith({ ...PRO, zotero: WEB, syncIndex: index, zoteroLinks: links });

			toggle(draw(tab), "Write text to Zotero").toggle(false);
			await settle();

			const saved = plugin.saves.at(-1) as { syncIndex: { rows: Record<string, { renderVersion?: number }> }; zotero: { writeText: boolean } };
			expect([saved.zotero.writeText, saved.syncIndex.rows["doc-1::sync"].renderVersion]).toEqual([false, 33]);
		});
	});

	it("says nothing is connected until one of the two is set up", async () => {
		const { tab } = await tabWith(PRO);

		// The line is drawn inside the row's own description, not as a sibling below it: Obsidian 1.13
		// draws each setting as a card, and a loose note lands in the gap between two of them.
		const line = verdict(row(draw(tab), "Connection"));
		expect(line.text).toBe("Not connected.");
		expect(line.style["color"]).toBe("var(--text-error)");
	});

	// The four states of §2.1 come from the client, because what *answered* is not the same question
	// as what is configured -- a key that is set up and rejected reads as "not connected", which is the
	// state the user has to see to go and fix it.
	it("replaces the line with what actually answered", async () => {
		stubNetwork(async (input: RequestInfo | URL) =>
			String(input).endsWith("/keys/current")
				? new Response(JSON.stringify({ userID: 1597773 }), { status: 200 })
				: new Response("[]", { status: 200 }),
		);
		const { tab } = await tabWith({ ...PRO, zotero: { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ", useLocal: false, localKeys: {} } });
		const drawn = draw(tab);
		expect(verdict(row(drawn, "Connection")).style["color"]).toBe("");
		await settle();

		const line = verdict(row(drawn, "Connection"));
		expect(line.text).toBe("Connected via web.");
		expect(line.style["color"]).toBe("var(--text-success)");
	});

	// Ticket 26: the personal library is fixed on; each group the connection can see is a switch of
	// its own, off until named -- what write-back puts into a group is visible to everyone in it.
	const WEB = { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ", useLocal: false, localKeys: {} };
	const zoteroAnswering = (groups: unknown[]) => async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/keys/current")) return new Response(JSON.stringify({ userID: 1597773 }), { status: 200 });
		if (url.includes("/groups?")) return new Response(JSON.stringify(groups), { status: 200 });
		return new Response("[]", { status: 200 });
	};

	it("lists the groups Zotero names as switches", async () => {
		stubNetwork(zoteroAnswering([{ id: 4711, data: { id: 4711, name: "Lab reading group" } }]));
		const { plugin, tab } = await tabWith({ ...PRO, zotero: WEB });
		draw(tab);
		await settle();

		const libraries = section(draw(tab), "Libraries");
		expect(rowNames(libraries)).toEqual(["Group libraries", "Lab reading group"]);
		expect(row(libraries, "Group libraries").desc).toContain("visible to everyone in that group");
		toggle(libraries, "Lab reading group").toggle(true);
		await settle();
		expect((plugin.data.zotero as { groups: unknown }).groups).toEqual([{ id: 4711, name: "Lab reading group" }]);
	});

	it("keeps a switched-on group on the screen while Zotero does not list it, so it can be switched off", async () => {
		stubNetwork(zoteroAnswering([]));
		const { plugin, tab } = await tabWith({ ...PRO, zotero: { ...WEB, groups: [{ id: 4711, name: "Lab reading group" }] } });
		draw(tab);
		await settle();

		const libraries = section(draw(tab), "Libraries");
		expect(row(libraries, "Lab reading group").desc).toContain("Not listed by Zotero right now");
		toggle(libraries, "Lab reading group").toggle(false);
		await settle();
		expect((plugin.data.zotero as { groups: unknown }).groups).toEqual([]);
	});

	it("shows the group switches shut to a free vault, without asking Zotero for its groups", async () => {
		const fetched = vi.fn(zoteroAnswering([{ id: 4711, data: { id: 4711, name: "Lab reading group" } }]));
		stubNetwork(fetched);
		const drawn = draw((await tabWith({ zotero: WEB })).tab);
		await settle();

		expect(rowNames(section(drawn, "Libraries"))).toEqual(["Group libraries (Pro)"]);
		expect(toggle(section(drawn, "Libraries"), "Group libraries (Pro)").disabled).toBe(true);
		expect(fetched.mock.calls.map((call) => String(call[0]))).not.toContainEqual(expect.stringContaining("/groups"));
	});

	it("says not connected when the connection that is set up does not answer", async () => {
		stubNetwork(async () => {
			throw new TypeError("fetch failed");
		});
		const { tab } = await tabWith({ ...PRO, zotero: { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ", useLocal: false, localKeys: {} } });
		const drawn = draw(tab);
		await settle();

		const line = verdict(row(drawn, "Connection"));
		expect(line.text).toBe("Not connected.");
		expect(line.style["color"]).toBe("var(--text-error)");
	});

	it("saves the desktop switch and redraws, because the status line is now about something else", async () => {
		const { plugin, tab } = await tabWith(PRO);
		toggle(draw(tab), "Use the Zotero desktop app").toggle(true);
		await settle();

		expect((plugin.data.zotero as { useLocal: boolean }).useLocal).toBe(true);
		expect(plugin.saves).toHaveLength(1);
	});

	// §2.4's own sentence, in advance rather than in a notice afterwards: this is the one thing the
	// plugin does that interrupts the person holding the tablet.
	it("names the restart before the SSH send switch is touched", async () => {
		const drawn = draw((await tabWith(PRO)).tab);
		const restart = row(drawn, "Send over SSH when the cloud is not connected");

		expect(restart.desc).toContain("restarts the tablet's reading app");
		expect(restart.desc).toContain("the document you have open is closed first");
	});

	it("saves the SSH send switch", async () => {
		const { plugin, tab } = await tabWith(PRO);
		toggle(draw(tab), "Send over SSH when the cloud is not connected").toggle(true);
		await settle();

		expect((plugin.data.zotero as { sendOverSsh: boolean }).sendOverSsh).toBe(true);
	});

	// Send over the cloud is free (§5); the SSH route is the Pro transport, and its row says so.
	it("opens the folder row to a free vault and keeps SSH send shut", async () => {
		const drawn = draw((await tabWith()).tab);

		expect(field(drawn, "Tablet folder for sent PDFs").disabled).toBe(false);
		expect(toggle(drawn, "Send over SSH when the cloud is not connected (Pro)").disabled).toBe(true);
	});

	// A folder with no name would put every sent paper at the root of the tablet, where the user has
	// to go looking for it.
	it("takes an emptied folder name as the default rather than as no folder", async () => {
		vi.useFakeTimers();
		const { plugin, tab } = await tabWith(PRO);
		field(draw(tab), "Tablet folder for sent PDFs").type("  ");

		expect((plugin.data.zotero as { folder: string }).folder).toBe("Zotero");
		vi.useRealTimers();
	});

	it("takes a folder name the user typed", async () => {
		vi.useFakeTimers();
		const { plugin, tab } = await tabWith(PRO);
		field(draw(tab), "Tablet folder for sent PDFs").type(" Papers ");

		expect((plugin.data.zotero as { folder: string }).folder).toBe("Papers");
		await vi.advanceTimersByTimeAsync(600);
		expect(plugin.saves.length).toBeGreaterThan(0);
		vi.useRealTimers();
	});

	// The same debounce the attachments folder uses, and for the same reason: a 24-character key is 24
	// writes to `data.json` otherwise.
	it("takes a typed key immediately and reaches data.json when the typing stops", async () => {
		vi.useFakeTimers();
		const { plugin, tab } = await tabWith({ ...PRO, zotero: { useWeb: true } });
		const text = field(draw(tab), "Zotero API key");

		text.type("P9c46b0lkV2XzAoUTqPmPuGZ");
		expect((plugin.data.zotero as { apiKey: string | null }).apiKey).toBe("P9c46b0lkV2XzAoUTqPmPuGZ");
		expect(plugin.saves).toEqual([]);

		vi.advanceTimersByTime(500);
		expect(plugin.saves).toHaveLength(1);
	});

	// Prefilled: nothing happens until the command is run, so the tag is a name, not a switch -- and the
	// sentence names the command and says that no sync sends (decided 2026-09-18).
	it("starts the send tag at to-remarkable and names the command that uses it", async () => {
		const sendTag = row(draw((await tabWith()).tab), "Send tag in Zotero");

		expect(sendTag.setting.texts[0].getValue()).toBe("to-remarkable");
		expect(sendTag.desc).toContain("Send tagged Zotero papers to reMarkable");
		expect(sendTag.desc).toContain("No sync sends");
		expect(sendTag.desc).not.toContain("automatic");
	});

	it("takes the send tag the user typed, trimmed, and keeps an emptied one empty", async () => {
		vi.useFakeTimers();
		const { plugin, tab } = await tabWith(PRO);
		field(draw(tab), "Send tag in Zotero").type(" lesen ");
		expect((plugin.data.zotero as { sendTag: string }).sendTag).toBe("lesen");

		field(draw(tab), "Send tag in Zotero").type("");
		expect((plugin.data.zotero as { sendTag: string }).sendTag).toBe("");
		vi.useRealTimers();
	});

	// Found in the desk test of 2026-09-13: the line was computed once at draw, so a key changed to a
	// wrong one kept reading "Connected via web." until the tab was reopened.
	it("asks again when the key changes, so a wrong key reads as not connected at once", async () => {
		vi.useFakeTimers();
		let accepted = true;
		// A good answer is held back while `held` is set, so a slow probe can be overtaken by a later one.
		const held: (() => void)[] = [];
		let holding = false;
		stubNetwork(async (input: RequestInfo | URL) => {
			if (!accepted) return new Response("Forbidden", { status: 403 });
			if (holding && String(input).includes("/items/top")) await new Promise<void>((resolve) => held.push(resolve));
			return String(input).endsWith("/keys/current") ? new Response(JSON.stringify({ userID: 1597773 }), { status: 200 }) : new Response("[]", { status: 200 });
		});
		const { tab } = await tabWith({ ...PRO, zotero: { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ", useLocal: false, localKeys: {} } });
		const drawn = draw(tab);
		await vi.advanceTimersByTimeAsync(0);
		expect(row(drawn, "Connection").setting.descEl.allText()).toContain("Connected via web.");

		// A second good key whose probe is slow, then a wrong key whose probe answers first.
		holding = true;
		field(drawn, "Zotero API key").type("ANOTHERGOODKEYANOTHERGOO");
		await vi.advanceTimersByTimeAsync(700);
		expect(row(drawn, "Connection").setting.descEl.allText()).toContain("Checking…");

		accepted = false;
		field(drawn, "Zotero API key").type("WRONGKEYWRONGKEYWRONGKEY");
		await vi.advanceTimersByTimeAsync(700);
		expect(row(drawn, "Connection").setting.descEl.allText()).toContain("Not connected.");

		// The slow answer arrives last and lands nowhere: the line belongs to the newest probe.
		for (const release of held.splice(0)) release();
		await vi.advanceTimersByTimeAsync(0);
		expect(row(drawn, "Connection").setting.descEl.allText()).toContain("Not connected.");
	});

	it("reads a cleared field as no key at all, rather than as an empty one", async () => {
		// `""` would be a configured connection that answers 401 on every call -- and the status line
		// would say "not connected" for a vault that is, as far as the settings go, set up.
		vi.useFakeTimers();
		const { plugin, tab } = await tabWith({ ...PRO, zotero: { useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ", useLocal: false, localKeys: {} } });
		field(draw(tab), "Zotero API key").type("");
		vi.advanceTimersByTime(500);

		expect((plugin.data.zotero as { apiKey: string | null }).apiKey).toBeNull();
	});

	// The listing runs once per draw and answers late; two draws in flight would otherwise redraw
	// twice for one list. Only an answer that adds a row is a reason to redraw.
	it("redraws once for the answer that adds groups, and not again for the same list", async () => {
		stubNetwork(zoteroAnswering([{ id: 4711, data: { id: 4711, name: "Lab reading group" } }]));
		const { tab } = await tabWith({ ...PRO, zotero: WEB });
		draw(tab);
		draw(tab);
		await settle();
		await settle();

		// Every draw starts with this heading, so counting it counts the redraws since the two above.
		const redraws = takeSettings().filter((setting: Setting) => setting.heading && setting.name === "reMarkable connection");
		expect(redraws).toHaveLength(1);
	});

	it("says why when the groups cannot be listed", async () => {
		const answering = zoteroAnswering([]);
		stubNetwork(async (input: RequestInfo | URL) => {
			if (String(input).includes("/groups?")) throw new TypeError("fetch failed");
			return answering(input);
		});
		const { tab } = await tabWith({ ...PRO, zotero: WEB });
		const drawn = draw(tab);
		await settle();

		expect(verdict(row(section(drawn, "Libraries"), "Group libraries")).text).toContain("Could not list your groups:");
	});

	// A group the user switched on is theirs to see and to switch off before Zotero has said a word.
	it("shows a switched-on group before Zotero has answered", async () => {
		stubNetwork(zoteroAnswering([]));
		const { tab } = await tabWith({ ...PRO, zotero: { ...WEB, groups: [{ id: 4711, name: "Lab reading group" }] } });

		expect(rowNames(section(draw(tab), "Libraries"))).toEqual(["Group libraries", "Lab reading group"]);
	});

	// Settings-redesign spec §6.2: one control per group, `zotero.group:<id>`; the stored list is
	// replaced, never changed in place, and holds the name Zotero gave beside the id.
	it("binds each group to a key of its own, and refuses a group nobody has named", async () => {
		stubNetwork(zoteroAnswering([{ id: 4711, data: { id: 4711, name: "Lab reading group" } }]));
		const { plugin, tab } = await tabWith({ ...PRO, zotero: { ...WEB, groups: [{ id: 815, name: "Old group" }] } });
		draw(tab);
		await settle();
		const before = (plugin.data.zotero as { groups: unknown[] }).groups;

		expect(pageGroups(tab, "Zotero")[1].rows.map((item) => item.key)).toEqual([undefined, "zotero.group:815", "zotero.group:4711"]);
		expect([tab.getControlValue("zotero.group:815"), tab.getControlValue("zotero.group:4711")]).toEqual([true, false]);
		await tab.setControlValue("zotero.group:4711", true);
		await tab.setControlValue("zotero.group:815", false);
		const saves = plugin.saves.length;
		// A toggle's `setValue` fires its change again: the stored value is no change (spec §2.3).
		await tab.setControlValue("zotero.group:4711", true);

		expect((plugin.data.zotero as { groups: unknown }).groups).toEqual([{ id: 4711, name: "Lab reading group" }]);
		expect(before).toEqual([{ id: 815, name: "Old group" }]);
		expect(plugin.saves).toHaveLength(saves);
		await expect(tab.setControlValue("zotero.group:9", true)).rejects.toThrow('no setting "zotero.group:9"');
	});
});

describe("the Readwise page", () => {
	// Readwise spec §2: shown to every vault, the switch shut with "(Pro)" to a free one; the token is a
	// Keychain entry's name in data.json, never the token; the Connection line says which of §2.1's
	// states this computer is in, counts from the state and never from Readwise. Settings-redesign spec
	// §7: one group without a heading on a page of its own.
	const PRO = {
		licence: {
			...NO_LICENCE,
			key: "TS-XXXX-1234",
			activationId: "act-1",
			validatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		},
	};
	const ON = { readwise: { push: true, tokenSecret: "readwise-token" } };

	/** An app whose Keychain holds `token` under the entry `ON` names. */
	function keychainWith(token: string): FakeApp {
		const app = new FakeApp();
		app.secretStorage.secrets.set("readwise-token", token);
		return app;
	}

	/** readwise.io's `/auth/` answering `status`, every request to readwise.io recorded (a Pro vault's Zotero line asks too). */
	function readwiseAnswering(status: number): string[] {
		const asked: string[] = [];
		stubNetwork(async (input) => {
			if (String(input).startsWith("https://readwise.io/")) asked.push(String(input));
			return new Response(null, { status });
		});
		return asked;
	}

	const lineOf = (drawn: Drawn[]): FakeEl => verdict(row(section(drawn, "Readwise"), "Connection"));
	const secret = (drawn: Drawn[]): SecretComponent => row(drawn, "Readwise access token").setting.components[0] as SecretComponent;
	/** Waits for the line to read `text`: a probe first hashes the token, which takes the crypto worker more than one tick. */
	const answered = (drawn: Drawn[], text: string) => vi.waitFor(() => expect(lineOf(drawn).text).toBe(text));

	it("draws the rows of the spec, in its words", async () => {
		const drawn = draw((await tabWith(PRO)).tab);

		expect(rowNames(section(drawn, "Readwise"))).toEqual(["Connection", "Push highlights to Readwise", "Readwise access token", "Readwise's own Obsidian plugin"]);
		expect(row(drawn, "Push highlights to Readwise").desc).toBe(
			"Your highlights and margin notes become highlights in your Readwise library, one book or article per document, and come up in your Daily Review. " +
				"The text goes to readwise.io; your handwriting and page images never leave this machine. Needs a Readwise plan with API access " +
				"(Full or Highlights). Switching on re-reads every note once, and your margin notes go to your transcription backend again.",
		);
		expect(row(drawn, "Readwise access token").desc).toBe(
			"From readwise.io/access_token. Stored in Obsidian's keychain on this computer, not in the vault — add it on each computer that should push.",
		);
		expect(row(drawn, "Readwise's own Obsidian plugin").desc).toBe(
			"If you also use Readwise's own Obsidian plugin, it copies these books back into your vault, each highlight linking to your note. " +
				"To keep them out, turn on 'Select Items to be Exported' in Readwise and uncheck each new Tagged Sync book.",
		);
		expect(toggle(drawn, "Push highlights to Readwise").disabled).toBe(false);
	});

	it("answers one group without a heading on its page, each row bound to its key", async () => {
		const { tab } = await tabWith({ ...PRO, ...ON, readwiseAccountClash: true }, keychainWith("rw-token"));

		expect(pageGroups(tab, "Readwise")).toEqual([
			{
				heading: undefined,
				cls: "tagged-sync-group-readwise",
				rows: [
					{ name: "Connection", kind: "render", shown: true },
					{ name: "Push highlights to Readwise", kind: "toggle", key: "readwise.push", shown: true },
					{ name: "Readwise access token", kind: "secret", key: "readwise.tokenSecret", shown: true },
					{ name: "Readwise's own Obsidian plugin", kind: "text", shown: true },
					{ name: "Start over with this computer's token", kind: "render", shown: true },
				],
			},
		]);
	});

	it("finds the token field by the word people search for", async () => {
		const { tab } = await tabWith(PRO);
		const rows = integrationPage(tab, "Readwise").items?.[0].items ?? [];

		expect(rows.find((item) => item.name === "Readwise access token")?.aliases).toEqual(["API key"]);
	});

	// Settings-redesign spec §5: the entry on the root says whether this computer pushes, without opening the page.
	describe("its entry on the root", () => {
		const entry = (tab: Tab): unknown => {
			takeSettings();
			renderSettingTab(tab);
			return takeSettings().find((setting: Setting) => setting.name === "Readwise")?.components;
		};

		it("says Pro to a free vault, without reading the Keychain", async () => {
			const app = keychainWith("rw-token");
			const keychain = vi.spyOn(app.secretStorage, "getSecret");
			const { tab } = await tabWith(ON, app);

			expect(entry(tab)).toEqual([expect.objectContaining({ value: "Pro", status: null })]);
			expect(keychain).not.toHaveBeenCalled();
		});

		it("warns for a switch on with no token on this computer", async () => {
			expect(entry((await tabWith({ ...PRO, ...ON })).tab)).toEqual([expect.objectContaining({ value: "No access token", status: "warning" })]);
		});

		it("warns once readwise.io did not accept the token, and forgets it when another token is chosen", async () => {
			const app = keychainWith("rw-token");
			app.secretStorage.secrets.set("readwise-new", "rw-new");
			// The old token refused, at once and then once more late; the new one's answer never comes, so only
			// the choice can clear the warning.
			const asked: (string | null)[] = [];
			const late: ((response: Response) => void)[] = [];
			stubNetwork((_input, init) => {
				const token = new Headers(init?.headers).get("Authorization");
				asked.push(token);
				if (token !== "Token rw-token") return new Promise<Response>(() => undefined);
				return asked.length === 1 ? Promise.resolve(new Response(null, { status: 401 })) : new Promise<Response>((resolve) => late.push(resolve));
			});
			const { tab } = await tabWith({ ...PRO, ...ON }, app);
			expect(entry(tab)).toEqual([expect.objectContaining({ value: "Pushing", status: null })]);

			renderSettingTab(tab, { page: "Readwise" });
			const first = onScreen(tab);
			await vi.waitFor(() => expect(verdict(row(first, "Connection")).text).toBe("The access token was not accepted — paste a new one from readwise.io/access_token."));
			expect(entry(tab)).toEqual([expect.objectContaining({ value: "Token not accepted", status: "warning" })]);

			renderSettingTab(tab, { page: "Readwise" });
			const drawn = onScreen(tab);
			await vi.waitFor(() => expect(late).toHaveLength(1));
			await secret(drawn).pick("readwise-new");
			// Asked inside this test, so the probe cannot land in the next one's network.
			await vi.waitFor(() => expect(asked).toContain("Token rw-new"));
			// The old token's answer, after the choice: about a token no longer in use.
			late[0](new Response(null, { status: 401 }));
			await settle();

			expect(entry(tab)).toEqual([expect.objectContaining({ value: "Pushing", status: null })]);
		});

		// The reader glanced at the page and went back before readwise.io answered: the answer is still about this token.
		it("warns on an answer that comes after the page was left", async () => {
			const answers: ((response: Response) => void)[] = [];
			stubNetwork(() => new Promise((resolve) => answers.push(resolve)));
			const { tab } = await tabWith({ ...PRO, ...ON }, keychainWith("rw-token"));
			renderSettingTab(tab, { page: "Readwise" });
			await vi.waitFor(() => expect(answers).toHaveLength(1));
			expect(entry(tab)).toEqual([expect.objectContaining({ value: "Pushing", status: null })]);

			answers[0](new Response(null, { status: 401 }));
			await settle();

			expect(entry(tab)).toEqual([expect.objectContaining({ value: "Token not accepted", status: "warning" })]);
		});
	});

	it("shows a free vault the switch shut, and says pushing is Pro", async () => {
		const asked = readwiseAnswering(204);
		const drawn = draw((await tabWith(ON, keychainWith("rw-token"))).tab);
		await settle();

		expect(toggle(drawn, "Push highlights to Readwise (Pro)").disabled).toBe(true);
		expect(lineOf(drawn).text).toBe("Pushing to Readwise is part of Tagged Sync Pro.");
		expect(lineOf(drawn).style.color).toBe("var(--text-muted)");
		expect(asked).toEqual([]);
	});

	it("reads Off. while the switch is off, without asking readwise.io", async () => {
		const asked = readwiseAnswering(204);
		const drawn = draw((await tabWith({ ...PRO, readwise: { push: false, tokenSecret: "readwise-token" } }, keychainWith("rw-token"))).tab);
		await settle();

		expect(lineOf(drawn).text).toBe("Off.");
		expect(asked).toEqual([]);
	});

	it("says so when this computer has no token, without asking readwise.io", async () => {
		const asked = readwiseAnswering(204);
		const drawn = draw((await tabWith({ ...PRO, ...ON })).tab);
		await settle();

		expect(lineOf(drawn).text).toBe("No Readwise token on this computer — add it to push from here too.");
		expect(lineOf(drawn).style.color).toBe("var(--text-error)");
		expect(asked).toEqual([]);
	});

	it("asks readwise.io and counts what the state says was pushed", async () => {
		const asked = readwiseAnswering(204);
		const { tab } = await tabWith(
			{
				...PRO,
				...ON,
				readwiseBooks: {
					a: {
						title: "A",
						highlights: {
							"p:1": { pushed: { text: "one", location: 1 } },
							"p:2": { pushed: { text: "two", location: 1 } },
							"p:4": { want: { text: "four", location: 1 }, rejected: { text: "four", location: 1 } },
						},
					},
					b: { title: "B", highlights: { "p:3": { want: { text: "three", location: 2 } } } },
				},
			},
			keychainWith("rw-token"),
		);
		const drawn = draw(tab);
		const tail = " 1 document waiting to be pushed. 1 highlight Readwise refused — it is retried when it changes on the tablet.";
		expect(lineOf(drawn).text).toBe(`Checking…${tail}`);
		await answered(drawn, `Connected — 1 book, 2 highlights pushed.${tail}`);

		expect(asked).toEqual(["https://readwise.io/api/v2/auth/"]);
		expect(lineOf(drawn).style.color).toBe("var(--text-success)");
	});

	it("reads 0 books before the first push, and says what Readwise refused", async () => {
		readwiseAnswering(204);
		const refused = { text: "x", location: 1 };
		const { tab } = await tabWith(
			{ ...PRO, ...ON, readwiseBooks: { a: { title: "A", highlights: { "p:1": { want: refused, rejected: refused }, "p:2": { want: refused, rejected: refused } } } } },
			keychainWith("rw-token"),
		);
		await answered(draw(tab), "Connected — 0 books, 0 highlights pushed. 2 highlights Readwise refused — they are retried when they change on the tablet.");
	});

	it.each([
		[401, "The access token was not accepted — paste a new one from readwise.io/access_token."],
		[403, "Your Readwise plan doesn't include API access."],
		[500, "Readwise didn't answer."],
	])("reads a %i as an error line, with no counts", async (status, text) => {
		readwiseAnswering(status);
		const { tab } = await tabWith({ ...PRO, ...ON, readwiseBooks: { b: { title: "B", highlights: { "p:3": { want: { text: "three", location: 2 } } } } } }, keychainWith("rw-token"));
		const drawn = draw(tab);
		await answered(drawn, text);

		expect(lineOf(drawn).style.color).toBe("var(--text-error)");
	});

	it("saves the Keychain entry's name, never the token, and asks again", async () => {
		const asked = readwiseAnswering(204);
		const app = keychainWith("rw-token");
		const { plugin, tab } = await tabWith({ ...PRO, readwise: { push: true, tokenSecret: null } }, app);
		const drawn = draw(tab);
		expect(lineOf(drawn).text).toBe("No Readwise token on this computer — add it to push from here too.");

		await secret(drawn).pick("readwise-token");
		await answered(drawn, "Connected — 0 books, 0 highlights pushed.");

		expect(plugin.data.readwise).toEqual({ push: true, tokenSecret: "readwise-token" });
		expect(JSON.stringify(plugin.saves)).not.toContain("rw-token");
		expect(asked).toEqual(["https://readwise.io/api/v2/auth/"]);
	});

	it("shows the chosen entry, and forgets it when the choice is cleared", async () => {
		readwiseAnswering(204);
		const { plugin, tab } = await tabWith({ ...PRO, ...ON }, keychainWith("rw-token"));
		const drawn = draw(tab);
		expect(secret(drawn).value).toBe("readwise-token");
		// Its probe done first, so it cannot land in the next test's network.
		await answered(drawn, "Connected — 0 books, 0 highlights pushed.");

		await secret(drawn).pick(null);
		await settle();

		expect(plugin.data.readwise).toEqual({ push: true, tokenSecret: null });
		expect(lineOf(drawn).text).toBe("No Readwise token on this computer — add it to push from here too.");
	});

	// Ticket 20 item 4: the next sync's backfill (Readwise spec §5) does the rest.
	it("saves the switch and asks the line again", async () => {
		const asked = readwiseAnswering(204);
		const { plugin, tab } = await tabWith({ ...PRO, readwise: { push: false, tokenSecret: "readwise-token" } }, keychainWith("rw-token"));
		const drawn = draw(tab);

		toggle(drawn, "Push highlights to Readwise").toggle(true);
		await answered(drawn, "Connected — 0 books, 0 highlights pushed.");

		expect(plugin.data.readwise).toEqual({ push: true, tokenSecret: "readwise-token" });
		expect(plugin.saves).toHaveLength(1);
		expect(asked).toEqual(["https://readwise.io/api/v2/auth/"]);
	});

	it("never lets a slow answer land on top of a newer one", async () => {
		const answers: ((response: Response) => void)[] = [];
		stubNetwork(async (input) =>
			String(input).startsWith("https://readwise.io/") ? new Promise((resolve) => answers.push(resolve)) : new Response(null, { status: 404 }),
		);
		const { tab } = await tabWith({ ...PRO, ...ON }, keychainWith("rw-token"));
		const drawn = draw(tab);
		await vi.waitFor(() => expect(answers).toHaveLength(1));

		// Off and on again: the line asks again while the first answer is still out.
		toggle(drawn, "Push highlights to Readwise").toggle(false);
		await settle();
		toggle(drawn, "Push highlights to Readwise").toggle(true);
		await vi.waitFor(() => expect(answers).toHaveLength(2));
		answers[1](new Response(null, { status: 204 }));
		await answered(drawn, "Connected — 0 books, 0 highlights pushed.");
		// The old probe's 401, with a sign of having been read: without it the test could end first and pass by default.
		let read = false;
		const rejected = new Response(null, { status: 401 });
		answers[0](
			new Proxy(rejected, {
				get: (target, key) => {
					if (key === "status") read = true;
					const value: unknown = Reflect.get(target, key, target);
					return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
				},
			}),
		);
		await vi.waitFor(() => expect(read).toBe(true));
		await settle();

		expect(lineOf(drawn).text).toBe("Connected — 0 books, 0 highlights pushed.");
	});

	// Readwise spec §11 P4, and the way out the user chose for ticket 19's open point (C): once two
	// computers were caught pushing to two accounts, neither of the two tokens clears it again, so the
	// section offers to start over with this computer's.
	describe("two computers on two accounts", () => {
		async function clashed(fingerprintOf: "readwiseAccount" | "readwiseAccountBefore") {
			const fingerprint = await tokenFingerprint("rw-token");
			const other = fingerprint === "aaaaaaaaaaaa" ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa";
			return {
				...PRO,
				...ON,
				readwiseAccount: fingerprintOf === "readwiseAccount" ? fingerprint : other,
				readwiseAccountBefore: fingerprintOf === "readwiseAccount" ? other : fingerprint,
				readwiseAccountClash: true,
				readwiseRecording: true,
				readwiseBooks: { a: { title: "A", bookId: 7, highlights: { "p:1": { pushed: { text: "one", location: 1 } } } } },
			};
		}

		it.each(["readwiseAccount", "readwiseAccountBefore"] as const)("says so for a token that is the %s, without asking readwise.io", async (which) => {
			const asked = readwiseAnswering(204);
			const drawn = draw((await tabWith(await clashed(which), keychainWith("rw-token"))).tab);
			await answered(drawn, "This computer and another one push to different Readwise accounts — use one account's token on both, then start over below.");

			expect(lineOf(drawn).style.color).toBe("var(--text-error)");
			expect(asked).toEqual([]);
		});

		it("starts over with this computer's token: the state goes, the next sync pushes everything", async () => {
			readwiseAnswering(204);
			const { plugin, tab } = await tabWith(await clashed("readwiseAccount"), keychainWith("rw-token"));
			const drawn = draw(tab);
			expect(row(drawn, "Start over with this computer's token").desc).toBe(
				"Forgets what was pushed to Readwise; the next sync pushes every document again, into the account of this computer's token. " +
					"Books you deleted in Readwise come back, and your margin notes go to your transcription backend again.",
			);
			expect(buttons(drawn, "Start over with this computer's token")[0].destructive).toBe(true);

			buttons(drawn, "Start over with this computer's token")[0].click();
			await settle();

			for (const key of ["readwiseAccount", "readwiseAccountBefore", "readwiseAccountClash", "readwiseRecording"]) expect(plugin.data).not.toHaveProperty(key);
			expect(plugin.data.readwiseBooks).toEqual({});
			expect(plugin.saves).toHaveLength(1);
			const after = onScreen(tab);
			expect(rowNames(section(after, "Readwise"))).not.toContain("Start over with this computer's token");
			await answered(after, "Connected — 0 books, 0 highlights pushed.");
		});

		it("offers no start-over on a computer without a token to start over with", async () => {
			const drawn = draw((await tabWith(await clashed("readwiseAccount"))).tab);

			expect(lineOf(drawn).text).toBe("No Readwise token on this computer — add it to push from here too.");
			expect(rowNames(section(drawn, "Readwise"))).not.toContain("Start over with this computer's token");
		});

		// The push holds the run lock and writes the state back when it ends: starting over under it would be undone.
		it("does not start over while a sync runs", async () => {
			readwiseAnswering(204);
			const { plugin, tab } = await tabWith(await clashed("readwiseAccount"), keychainWith("rw-token"));
			const drawn = draw(tab);
			(plugin as unknown as { syncing: boolean }).syncing = true;

			buttons(drawn, "Start over with this computer's token")[0].click();
			await settle();

			expect(takeNotices()).toEqual(["Wait for the sync to finish, then start over."]);
			expect(plugin.data.readwiseAccountClash).toBe(true);
			expect(plugin.saves).toHaveLength(0);
		});

		it("offers no start-over while nothing clashes", async () => {
			readwiseAnswering(204);
			const drawn = draw((await tabWith({ ...PRO, ...ON }, keychainWith("rw-token"))).tab);

			expect(rowNames(section(drawn, "Readwise"))).not.toContain("Start over with this computer's token");
		});
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
		return section(drawn, "Tagged Sync Pro").some((item) => item.kind === "row" && item.desc.includes("no questions asked"));
	}

	// A group has no loose text between rows, so the money-back note is the key row's second sentence
	// (spec P11), and every row is ours to draw: its buttons change with the licence.
	it("draws the status row and, until Pro is active, the key row with the money-back promise", async () => {
		const free = await tabWith();
		expect(rowsOf(free.tab, "Tagged Sync Pro")).toEqual([
			{ name: "Not active", kind: "render", shown: true },
			{ name: "Licence key", kind: "render", shown: true },
		]);
		expect(itemsOf(free.tab, "Tagged Sync Pro")[1]).toMatchObject({ desc: `Paste the key from your purchase page. ${MONEY_BACK_MESSAGE}`, aliases: ["license"] });
		expect(section(draw(free.tab), "Tagged Sync Pro").filter((item) => item.kind === "note")).toEqual([]);

		const bought = await tabWith({ licence: { ...NO_LICENCE, ...BOUGHT, validatedAt: iso(DAY_MS) } });
		expect(rowsOf(bought.tab, "Tagged Sync Pro").map((item) => item.name)).toEqual(["Active"]);
	});

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

	// --- the ticket ------------------------------------------------------------------------------
	//
	// Since 1.8 the start date comes signed from taggedsync.com (`trial-ticket.ts`); the key pair
	// is at the top of the file.
	/** An Obsidian that gave this vault an id, as every real one does. The fake's default has none. */
	function appWithId(): FakeApp {
		return Object.assign(new FakeApp(), { appId: "3f8a1c9e2b7d4e60" });
	}
	/** Records what was asked, answers from the server's point of view. */
	function issuer(answer: (vault: string) => Promise<TrialTicket>): TrialIssuer & { asked: string[] } {
		const asked: string[] = [];
		return {
			asked,
			issue: (vault) => {
				asked.push(vault);
				return answer(vault);
			},
		};
	}

	it("starts the trial on the spot, saves it, and re-draws without the button", async () => {
		const { plugin, tab } = await tabWith({}, appWithId());
		const server = issuer((vault) => ticketFor(vault, iso(0)));
		plugin.trialIssuer = server;

		await buttons(draw(tab), "Not active")[0].click();
		await settle();

		expect(server.asked).toEqual([expect.stringMatching(/^[0-9a-f]{12}$/)]);
		expect((plugin.data.licence as { trialStartedAt: string | null }).trialStartedAt).not.toBeNull();
		expect(plugin.saves).toHaveLength(1);
		expect(pro(draw(tab))).toMatchObject({ heading: "Trial", buttons: ["Buy"] });
	});

	it("starts nothing when taggedsync.com cannot be reached, and says so once, in place", async () => {
		const { plugin, tab } = await tabWith({}, appWithId());
		plugin.trialIssuer = issuer(() => Promise.reject(new Error("ENOTFOUND")));

		await buttons(draw(tab), "Not active")[0].click();
		await settle();

		expect(takeNotices()).toEqual([expect.stringContaining("needs a connection to taggedsync.com")]);
		expect((plugin.data.licence as { trialStartedAt: string | null }).trialStartedAt).toBeNull();
		expect(plugin.saves).toHaveLength(0);
		expect(pro(draw(tab)).buttons).toEqual(["Start free trial", "Buy"]);
	});

	// The restart trick this replaces: delete `trialStartedAt`, click again. The server remembers.
	it("gets the same trial back for a vault the server already knows, however the file was edited", async () => {
		const { plugin, tab } = await tabWith({}, appWithId());
		plugin.trialIssuer = issuer((vault) => ticketFor(vault, iso(10 * DAY_MS)));

		await buttons(draw(tab), "Not active")[0].click();
		await settle();

		expect(pro(draw(tab)).desc).toContain("4 day(s) left.");
	});

	it("does not honour a trial in data.json that taggedsync.com never signed", async () => {
		// A pre-1.8 file, or a hand-written one: same thing to the plugin.
		const { plugin, tab } = await tabWith({ licence: { ...NO_LICENCE, trialStartedAt: iso(2 * DAY_MS) } }, appWithId());

		expect((plugin.data.licence as { trialStartedAt: string | null }).trialStartedAt).toBeNull();
		expect(plugin.saves).toHaveLength(1);
		expect(pro(draw(tab)).buttons).toEqual(["Start free trial", "Buy"]);
	});

	it("does not honour a signed trial whose date was moved by hand", async () => {
		const honest = await ticketFor(await vaultHashOf("3f8a1c9e2b7d4e60"), iso(2 * DAY_MS));
		const { plugin, tab } = await tabWith(
			{ licence: { ...NO_LICENCE, trialStartedAt: iso(0), trialSignature: honest.signature } },
			appWithId(),
		);

		expect((plugin.data.licence as { trialStartedAt: string | null }).trialStartedAt).toBeNull();
		expect(pro(draw(tab)).buttons).toEqual(["Start free trial", "Buy"]);
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

describe("help at the bottom", () => {
	// Read when something has gone wrong, so last; *Sync now* went to the top (spec P1 (a)).
	it("holds the diagnostics button and the feature links, and nothing else", async () => {
		const { tab } = await tabWith({ deviceToken: "d" });

		expect(rowsOf(tab, "Help")).toEqual([
			{ name: "Report a problem", kind: "render", shown: true },
			{ name: "Request a feature", kind: "text", shown: true },
		]);
		const links = row(draw(tab), "Request a feature").setting.descEl.children.map((link) => link.attributes.href);
		expect(links).toEqual([expect.stringContaining("feature_request"), expect.stringContaining("label%3Aenhancement")]);
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
