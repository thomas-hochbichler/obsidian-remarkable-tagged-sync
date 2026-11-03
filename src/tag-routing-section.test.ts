import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../tests/stubs/fake-clock";
import {
	createFragment,
	FakeApp,
	FakeEl,
	FuzzySuggestModal,
	type PluginSettingTab,
	renderSettingTab,
	type Setting,
	takeModals,
	takeNotices,
	takeSettings,
} from "../tests/stubs/fake-obsidian";
import { TAG_CAP_MESSAGE } from "./licence-messages";
import { type Entitlement, NO_LICENCE } from "./licence-state";
import { REMOVAL_MESSAGE } from "./tag-routing-view";

// Gap G04 -- the free version's one-tag cap, and the Tag routing group around it (settings-redesign
// spec §4). Band 1 on both sides: unlimited tags are half of what Pro sells, and the cap is the first
// rule a free user meets. The plan's rules are `tag-routing-view.test.ts`; this file is what the
// shipped tab does with them, driven the way a user drives it: scan, click a tag, choose a folder.
//
// Driven through `src/entry.ts` for the reason `ocr-backend-choice.test.ts` gives: `entry.ts` is what
// Obsidian actually loads.

vi.mock("rmapi-js", () => ({ session: () => ({}) }));

// Two globals Obsidian supplies and vitest does not. `createFragment` is modelled in the fake, read out
// of Obsidian's own `enhance.js`. `window.open` is the platform's and there is nothing to model.
vi.stubGlobal("createFragment", createFragment);
vi.stubGlobal("window", { open: () => undefined });

const PRO = { key: "test-key", activationId: "act-1", validatedAt: new Date().toISOString() };
const PRO_ENTITLEMENT: Entitlement = { tier: "pro", since: PRO.validatedAt, stale: false };
const FREE_ENTITLEMENT: Entitlement = { tier: "free", reason: "revoked" };

interface Plugin {
	data: { tagFolderMap: Record<string, string> };
	saves: unknown[];
	settingTabs: PluginSettingTab[];
	refreshLicence: () => Promise<Entitlement>;
	openSource: () => Promise<unknown>;
}

/** A tablet holding one notebook per tag, as `enumerateNotebookTags` reads it. */
function tablet(tags: string[]) {
	const closed: string[] = [];
	return {
		closed,
		session: {
			api: {
				listItems: async () => tags.map((tag, index) => ({ id: `doc-${index}`, type: "DocumentType", visibleName: tag, parent: "", tags: [tag] })),
				getContent: async () => ({}),
			},
			close: async () => void closed.push("closed"),
		},
	};
}

/**
 * A settings tab of the real plugin, loaded from a `data.json` and pointed at a vault holding
 * `folders`, with a tablet holding `tags`. `refreshLicence` is replaced by a spy: what the licence
 * *server* answers is `licence-check.ts`'s business, and this file is about what the tab does with it.
 */
async function tabWith(setup: {
	mapping?: Record<string, string>;
	licence?: Partial<typeof NO_LICENCE>;
	folders?: string[];
	/** What the tablet carries. Scanned before the test starts, unless it says `scanned: false`. */
	tags?: string[];
	scanned?: boolean;
	/** What the live re-check answers. Absent means this scenario says it must never be called. */
	recheck?: Entitlement;
}): Promise<{ plugin: Plugin; tab: PluginSettingTab; refreshLicence: ReturnType<typeof vi.fn> }> {
	const app = new FakeApp();
	for (const folder of setup.folders ?? []) await app.vault.createFolder(folder);

	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(app, {
		id: "tagged-sync",
		name: "Tagged Sync",
		version: "0.0.0",
	});
	// A device token: Tag routing is drawn only while there is something to scan.
	plugin.saved = { deviceToken: "d", ocrBackend: "off", tagFolderMap: setup.mapping ?? {}, licence: { ...NO_LICENCE, ...setup.licence } };
	// A clock nobody moves: the launch sync never comes due.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();

	const refreshLicence = vi.fn(async (): Promise<Entitlement> => {
		if (setup.recheck === undefined) throw new Error("refreshLicence was called and this scenario says it must not be");
		return setup.recheck;
	});
	plugin.refreshLicence = refreshLicence;
	plugin.openSource = async () => tablet(setup.tags ?? []);

	const tab = plugin.settingTabs[0];
	if (setup.tags !== undefined && setup.scanned !== false) {
		await scanButton(group(tab)).click();
		await settle();
	}
	(plugin as unknown as { saves: unknown[] }).saves.length = 0;
	takeNotices();
	takeModals();
	return { plugin, tab, refreshLicence };
}

/** Lets an `onClick`/`onChange` promise chain finish -- the fake's `click()` cannot await it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The Tag routing group as drawn on the root: its heading and its rows, in order. */
interface Group {
	heading: Setting;
	rows: Setting[];
}

function group(tab: PluginSettingTab): Group {
	takeSettings();
	renderSettingTab(tab);
	return onScreen();
}

/** What the last draw put on screen, without drawing again. */
function onScreen(): Group {
	const drawn = takeSettings();
	const start = drawn.findIndex((setting) => setting.heading && setting.name === "Tag routing");
	if (start === -1) throw new Error("no Tag routing group on screen");
	const end = drawn.findIndex((setting, index) => index > start && setting.heading);
	return { heading: drawn[start], rows: drawn.slice(start + 1, end) };
}

function rowNamed(found: Group, name: string): Setting {
	const setting = found.rows.find((candidate) => candidate.name === name);
	if (!setting) throw new Error(`no row "${name}" among ${found.rows.map((candidate) => candidate.name).join(", ")}`);
	return setting;
}

function scanButton(found: Group) {
	return found.heading.extraButtons[0];
}

/** The pill buttons of the *Found tags* row, in order. */
function pills(found: Group): FakeEl[] {
	return rowNamed(found, "Found tags").settingEl.querySelector(".tagged-sync-pills")?.children ?? [];
}

function pill(found: Group, tag: string): FakeEl {
	const el = pills(found).find((candidate) => candidate.text === tag);
	if (!el) throw new Error(`no pill "${tag}"`);
	return el;
}

/** The folder picker the last click opened. */
function picker(): FuzzySuggestModal<string> {
	const [modal, ...rest] = takeModals();
	expect(rest).toEqual([]);
	expect(modal).toBeInstanceOf(FuzzySuggestModal);
	return modal as FuzzySuggestModal<string>;
}

/** Each visible row by name; a mapped row by its tag. */
function names(found: Group): string[] {
	return found.rows.filter((setting) => setting.settingEl.visible).map((setting) => setting.name);
}

beforeEach(() => {
	takeSettings();
	takeNotices();
	takeModals();
});

describe("scanning for tags", () => {
	it("asks for a scan before the first one, and shows what it found as pills", async () => {
		const { tab } = await tabWith({ tags: ["work", "home"], scanned: false });

		const before = group(tab);
		expect(names(before)).toEqual(["Scan for tags"]);
		expect(rowNamed(before, "Scan for tags").desc).toBe("Scan to see which tags your reMarkable uses.");

		await rowNamed(before, "Scan for tags").buttons[0].click();
		await settle();

		expect(takeNotices()).toEqual(["Found 2 tag(s)."]);
		const after = group(tab);
		expect(names(after)).toEqual(["Found tags"]);
		expect(pills(after).map((el) => el.text)).toEqual(["home", "work"]);
	});

	it("scans from the heading icon too, and says it is scanning until the tablet answers", async () => {
		const { plugin, tab } = await tabWith({ scanned: false });
		let answer: (value: unknown) => void = () => undefined;
		const asked = vi.fn(() => new Promise((resolve) => (answer = resolve)));
		plugin.openSource = asked;

		const icon = scanButton(group(tab));
		expect([icon.icon, icon.tooltip, icon.disabled]).toEqual(["refresh-cw", "Scan for tags", false]);
		void icon.click();

		const scanning = onScreen();
		expect(scanButton(scanning).disabled).toBe(true);
		expect(rowNamed(scanning, "Scan for tags").buttons.map((button) => [button.text, button.disabled])).toEqual([["Scanning…", true]]);
		// A second press while the first scan runs opens no second session.
		await rowNamed(scanning, "Scan for tags").buttons[0].click();
		expect(asked).toHaveBeenCalledOnce();

		const opened = tablet(["work"]);
		answer(opened);
		await settle();

		expect(scanButton(onScreen()).disabled).toBe(false);
		expect(opened.closed).toEqual(["closed"]);
	});

	it("keeps what an earlier scan found when a scan fails, and says why", async () => {
		const { plugin, tab } = await tabWith({ tags: ["work"] });
		plugin.openSource = async () => {
			throw new Error("tablet asleep");
		};

		await scanButton(group(tab)).click();
		await settle();

		expect(takeNotices()).toEqual(["Failed to discover tags: tablet asleep"]);
		expect(pills(group(tab)).map((el) => el.text)).toEqual(["work"]);
	});

	it("says when the tablet carries no tags, rather than showing nothing", async () => {
		const { tab } = await tabWith({ tags: [] });

		const found = group(tab);
		expect(names(found)).toEqual(["No tags found"]);
		expect(rowNamed(found, "No tags found").desc).toBe("Tag a notebook or page on your reMarkable, then scan again.");
	});

	it("draws neither pills nor a line when every tag found is mapped", async () => {
		const { tab } = await tabWith({ mapping: { work: "Work" }, tags: ["work"], folders: ["Work"] });

		expect(names(group(tab))).toEqual(["work", "Removing a tag"]);
	});
});

describe("the free version's tag cap", () => {
	it("maps the first tag a free user clicks to the folder chosen, without asking Polar", async () => {
		const { plugin, tab, refreshLicence } = await tabWith({ tags: ["work"], folders: ["Work", "Home"] });

		pill(group(tab), "work").dispatch("click");
		const chooser = picker();
		expect(chooser.placeholder).toBe("Choose a folder for work");
		expect(chooser.itemTexts).toEqual(["Vault root", "Home", "Work"]);
		chooser.choose("Work");
		await settle();

		expect(refreshLicence).not.toHaveBeenCalled();
		expect(plugin.data.tagFolderMap).toEqual({ work: "Work" });
		expect(plugin.saves).toHaveLength(1);
		const mapped = onScreen();
		expect(names(mapped)).toEqual(["work", "Removing a tag"]);
		expect(rowNamed(mapped, "Removing a tag").desc).toBe(REMOVAL_MESSAGE);
	});

	it("offers only the vault root in a vault without folders", async () => {
		const { tab } = await tabWith({ tags: ["work"] });

		pill(group(tab), "work").dispatch("click");

		expect(picker().itemTexts).toEqual(["Vault root"]);
	});

	it("refuses a second tag in place: a faded pill, the cap sentence above it, and a way to Pro", async () => {
		const { plugin, tab } = await tabWith({ mapping: { work: "Work" }, tags: ["work", "home"], folders: ["Work", "Home"] });

		const found = group(tab);
		expect(names(found)).toEqual(["work", "Removing a tag", "One tag in the free version", "Found tags"]);
		expect(rowNamed(found, "One tag in the free version").desc).toBe(TAG_CAP_MESSAGE);
		expect(pill(found, "home").classes.has("is-capped")).toBe(true);

		pill(found, "home").dispatch("click");

		expect(takeModals()).toEqual([]);
		expect(plugin.saves).toEqual([]);
		const line = rowNamed(found, "Found tags").settingEl.querySelector(".tagged-sync-capped-line");
		expect(line?.allText()).toEqual(["Syncing home needs Tagged Sync Pro.", "See Pro"]);

		line?.children.find((child) => child.text === "See Pro")?.dispatch("click");
		expect(tab.containerEl.querySelector(".tagged-sync-group-pro")?.scrolledIntoView).toBe(1);
	});

	it("says it for the capped pill clicked last, and forgets it on the next redraw", async () => {
		const { tab } = await tabWith({ mapping: { work: "Work" }, tags: ["work", "home", "ideas"], folders: ["Work"] });
		const capLine = (found: Group) => rowNamed(found, "Found tags").settingEl.querySelector(".tagged-sync-capped-line");

		const found = group(tab);
		pill(found, "home").dispatch("click");
		pill(found, "ideas").dispatch("click");
		expect(capLine(found)?.allText()).toEqual(["Syncing ideas needs Tagged Sync Pro.", "See Pro"]);

		expect(capLine(group(tab))?.allText()).toEqual([]);
	});

	it("lets a Pro user map the second tag", async () => {
		const { tab } = await tabWith({ mapping: { work: "Work" }, licence: PRO, tags: ["work", "home"], folders: ["Work", "Home"] });

		const found = group(tab);
		expect(names(found)).toEqual(["work", "Removing a tag", "Found tags"]);
		expect(pill(found, "home").classes.has("is-capped")).toBe(false);
	});

	it("never revokes a mapping the user already has, even past the cap", async () => {
		// A Pro user who mapped three tags and then let the licence lapse. The cap blocks adding; it
		// must not take away what is already syncing.
		const { tab } = await tabWith({
			mapping: { work: "Work", home: "Home", ideas: "Ideas" },
			tags: ["work", "home", "ideas", "new"],
			folders: ["Work", "Home", "Ideas"],
		});

		const found = group(tab);
		for (const tag of ["home", "ideas", "work"]) {
			const row = rowNamed(found, tag);
			expect(row.buttons).toHaveLength(1);
			expect(row.extraButtons.map((button) => [button.icon, button.tooltip])).toEqual([["x", "Remove mapping"]]);
		}
		expect(pill(found, "new").classes.has("is-capped")).toBe(true);
	});

	it("re-checks the licence when a Pro render maps a further tag, and refuses if it has ended", async () => {
		// The only way to reach the live re-check: the pill was not capped, which past the free limit
		// means the user had Pro when the tab drew -- and has lost it by the time they pick a folder.
		const { plugin, tab, refreshLicence } = await tabWith({
			mapping: { work: "Work" },
			licence: PRO,
			tags: ["work", "home"],
			folders: ["Work", "Home"],
			recheck: FREE_ENTITLEMENT,
		});

		pill(group(tab), "home").dispatch("click");
		picker().choose("Home");
		await settle();

		expect(refreshLicence).toHaveBeenCalledTimes(1);
		expect(plugin.data.tagFolderMap).toEqual({ work: "Work" });
		expect(plugin.saves).toHaveLength(0);
	});

	it("writes the mapping when that live re-check still says Pro", async () => {
		const { plugin, tab, refreshLicence } = await tabWith({
			mapping: { work: "Work" },
			licence: PRO,
			tags: ["work", "home"],
			folders: ["Work", "Home"],
			recheck: PRO_ENTITLEMENT,
		});

		pill(group(tab), "home").dispatch("click");
		picker().choose("Home");
		await settle();

		expect(refreshLicence).toHaveBeenCalledTimes(1);
		expect(plugin.data.tagFolderMap).toEqual({ work: "Work", home: "Home" });
		expect(plugin.saves).toHaveLength(1);
	});
});

describe("a mapped tag", () => {
	it("shows the tag as a pill and its folder on a button", async () => {
		const { tab } = await tabWith({ mapping: { work: "/" } });

		const row = rowNamed(group(tab), "work");
		expect(row.nameEl.children.map((child) => [child.text, child.classes.has("tagged-sync-pill")])).toEqual([["work", true]]);
		expect(row.buttons.map((button) => button.text)).toEqual(["Vault root"]);
	});

	it("re-points a mapping the user already has without asking Polar -- that is not an add", async () => {
		// The re-check is armed here (Pro, one tag mapped, one still unmapped). Changing where an
		// existing tag writes is not buying anything, so it must not be able to fail on a licence.
		const { plugin, tab, refreshLicence } = await tabWith({
			mapping: { work: "Work" },
			licence: PRO,
			tags: ["work", "home"],
			folders: ["Work", "Home"],
		});

		await rowNamed(group(tab), "work").buttons[0].click();
		const chooser = picker();
		expect(chooser.placeholder).toBe("Choose a folder for work");
		chooser.choose("Home");
		await settle();

		expect(refreshLicence).not.toHaveBeenCalled();
		expect(plugin.data.tagFolderMap).toEqual({ work: "Home" });
		expect(rowNamed(onScreen(), "work").buttons[0].text).toBe("Home");
	});

	it("is removed by its ×, at once and without a question", async () => {
		const { plugin, tab } = await tabWith({ mapping: { work: "Work" }, tags: ["work"], folders: ["Work"] });

		await rowNamed(group(tab), "work").extraButtons[0].click();

		expect(takeModals()).toEqual([]);
		expect(plugin.data.tagFolderMap).toEqual({});
		expect(plugin.saves).toHaveLength(1);
		expect(pills(onScreen()).map((el) => el.text)).toEqual(["work"]);
	});

	it("names a folder that is gone on its button, in the warning colour", async () => {
		const { tab } = await tabWith({ mapping: { work: "Gone" }, folders: ["Work"] });

		const [button] = rowNamed(group(tab), "work").buttons;
		expect(button.text).toBe("Gone (missing)");
		expect(button.buttonEl.classes.has("tagged-sync-folder-missing")).toBe(true);
	});

	it("is found by its folder in the settings search, and the other rows are not searched", async () => {
		const { tab } = await tabWith({ mapping: { work: "Projects/Work" }, tags: ["work", "home"], licence: PRO });

		const definitions = tab.getSettingDefinitions() as unknown as { heading?: string; items?: { name: string; aliases?: string[]; searchable?: boolean }[] }[];
		const items = definitions.find((item) => item.heading === "Tag routing")?.items ?? [];
		expect(items.map((item) => [item.name, item.aliases, item.searchable])).toEqual([
			["work", ["Projects/Work"], undefined],
			["Removing a tag", undefined, false],
			// Searchable, so a tag the tablet carries finds the row, and so the group's filter reaches the pills.
			["Found tags", ["home"], undefined],
		]);
	});

	it("is found by the name its button shows for the vault root, not by '/'", async () => {
		const { tab } = await tabWith({ mapping: { inbox: "/" }, licence: PRO });

		const definitions = tab.getSettingDefinitions() as unknown as { heading?: string; items?: { name: string; aliases?: string[] }[] }[];
		const items = definitions.find((item) => item.heading === "Tag routing")?.items ?? [];
		expect(items.find((item) => item.name === "inbox")?.aliases).toEqual(["Vault root"]);
	});
});

describe("the filter", () => {
	const TWELVE = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];

	// Obsidian builds a group's search box once, when the group is first drawn, and the first draw is
	// before any scan (found on the device, ticket 12). So the box is always there, and shown from twelve.
	it("is shown from twelve tags, also when a scan in the open tab brings the twelfth", async () => {
		const { plugin, tab } = await tabWith({ tags: TWELVE.slice(0, 11), licence: PRO });
		const filterShown = (): boolean | undefined => tab.containerEl.querySelector(".tagged-sync-group-tags")?.classes.has("tagged-sync-filter-on");

		const few = group(tab);
		expect(tab.groupSearch("Tag routing").placeholder).toBe("Filter tags");
		expect(filterShown()).toBe(false);

		plugin.openSource = async () => tablet(TWELVE);
		await scanButton(few).click();
		await settle();

		expect(filterShown()).toBe(true);
	});

	it("narrows mapped rows by tag or folder and pills by tag, keeps the notes, and survives a redraw", async () => {
		const { tab } = await tabWith({ mapping: { alpha: "Greek/Alpha", beta: "Letters" }, tags: TWELVE, licence: PRO, folders: ["Greek/Alpha", "Letters"] });
		const shownPills = (found: Group): string[] => pills(found).filter((el) => el.visible).map((el) => el.text);

		// Typing filters what is on screen; it draws nothing again.
		const filtered = group(tab);
		tab.groupSearch("Tag routing").type("ET");
		// "Letters" holds "et"; "beta", "zeta", "eta", "theta" too. Case does not matter.
		expect(names(filtered)).toEqual(["beta", "Removing a tag", "Found tags"]);
		expect(shownPills(filtered)).toEqual(["eta", "theta", "zeta"]);

		const redrawn = group(tab);
		expect(names(redrawn)).toEqual(["beta", "Removing a tag", "Found tags"]);
		expect(shownPills(redrawn)).toEqual(["eta", "theta", "zeta"]);

		tab.groupSearch("Tag routing").type("");
		expect(shownPills(redrawn)).toHaveLength(10);
	});

	it("keeps a mapped row by its folder alone, and by its tag alone", async () => {
		const { tab } = await tabWith({ mapping: { alpha: "Letters", zeta: "Greek" }, tags: TWELVE, licence: PRO, folders: ["Letters", "Greek"] });
		const found = group(tab);
		const mappedShown = (): string[] => names(found).filter((name) => name === "alpha" || name === "zeta");

		tab.groupSearch("Tag routing").type("lett");
		expect(mappedShown()).toEqual(["alpha"]);

		tab.groupSearch("Tag routing").type("zet");
		expect(mappedShown()).toEqual(["zeta"]);
	});
});
