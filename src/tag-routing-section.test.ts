import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import {
	type ButtonComponent,
	createFragment,
	type DropdownComponent,
	FakeApp,
	FakeEl,
	type Setting,
	takeModals,
	takeSettings,
} from "../test-stubs/fake-obsidian";
import { TAG_CAP_MESSAGE } from "./licence-messages";
import { type Entitlement, NO_LICENCE } from "./licence-state";

// Gap G04 -- the free version's one-tag cap. Band 1 on both sides: unlimited tags are half of what
// Pro sells, and the cap is the first rule a free user meets. The gap list said it was untestable
// "at all" until `main.ts` was cut, because the gate lives *inside* a `Setting`-rendering method.
//
// This is the characterisation, written against the unmodified `main.ts` and kept afterwards. It
// asserts that the shipped settings tab, driven the way a user drives it, refuses and permits the
// mappings the licence says -- which is the one thing a unit test of the extracted plan cannot say.
//
// Driven through `src/entry.ts` for the reason `ocr-backend-choice.test.ts` gives: `entry.ts` is what
// Obsidian actually loads.

vi.mock("rmapi-js", () => ({ session: () => ({}) }));

// Two globals Obsidian supplies and vitest does not, both reached from `onload()` or from the
// re-render every persist path ends in -- so without them this file dies before reaching anything it
// is about, six sections away in the connection block.
//
// `createFragment` is modelled in the fake, read out of Obsidian's own `enhance.js`. `window.open` is
// the platform's and there is nothing to model.
vi.stubGlobal("createFragment", createFragment);
// Only `open`, for the settings tab's Buy/Manage buttons. The timers moved to `plugin.scheduler`.
vi.stubGlobal("window", { open: () => undefined });

const PRO = { key: "test-key", activationId: "act-1", validatedAt: new Date().toISOString() };
const PRO_ENTITLEMENT: Entitlement = { tier: "pro", since: PRO.validatedAt, stale: false };
const FREE_ENTITLEMENT: Entitlement = { tier: "free", reason: "revoked" };

const REMOVAL_NOTE = "Removing a tag stops syncing it. Notes already in your vault stay where they are.";

interface Tab {
	discoveredTags: string[];
	renderTagRouting(container: FakeEl): void;
	renderTagDialog(container: FakeEl, tag: string): void;
}

interface Plugin {
	data: { tagFolderMap: Record<string, string> };
	saves: unknown[];
	settingTabs: Tab[];
	refreshLicence: () => Promise<Entitlement>;
}

/** One thing the section drew, in draw order -- a `Setting` row or a bare note div. */
type Drawn =
	| { kind: "row"; name: string; desc: string; dropdowns: DropdownComponent[]; buttons: ButtonComponent[] }
	| { kind: "note"; text: string };

/**
 * A settings tab of the real plugin, loaded from a `data.json` and pointed at a vault holding
 * `folders`. `refreshLicence` is replaced by a spy: what the licence *server* answers is
 * `licence-check.ts`'s business, and this file is about what the tab does with the answer.
 */
async function tabWith(setup: {
	mapping?: Record<string, string>;
	licence?: Partial<typeof NO_LICENCE>;
	folders?: string[];
	discovered?: string[];
	/** What the live re-check answers. Absent means this scenario says it must never be called. */
	recheck?: Entitlement;
}): Promise<{ plugin: Plugin; tab: Tab; refreshLicence: ReturnType<typeof vi.fn> }> {
	const app = new FakeApp();
	for (const folder of setup.folders ?? []) await app.vault.createFolder(folder);

	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(app, {
		id: "tagged-sync",
		name: "Tagged Sync",
		version: "0.0.0",
	});
	plugin.saved = { tagFolderMap: setup.mapping ?? {}, licence: { ...NO_LICENCE, ...setup.licence } };
	// A clock nobody moves: the interval backstop arms and never fires.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();

	const refreshLicence = vi.fn(async (): Promise<Entitlement> => {
		if (setup.recheck === undefined) throw new Error("refreshLicence was called and this scenario says it must not be");
		return setup.recheck;
	});
	plugin.refreshLicence = refreshLicence;

	const tab = plugin.settingTabs[0];
	tab.discoveredTags = setup.discovered ?? [];
	return { plugin, tab, refreshLicence };
}

/**
 * Draws the section and reads back what it drew, in order. Rows and notes interleave, and the order
 * is a decision -- a cap sentence below the rows it explains is a different screen from one above
 * them -- so both go into one list rather than being asserted separately.
 *
 * The heading is dropped: it is the same row in every scenario.
 */
function draw(tab: Tab): Drawn[] {
	takeSettings();
	const container = new FakeEl();
	tab.renderTagRouting(container);
	const bySettingEl = new Map(takeSettings().map((setting: Setting) => [setting.settingEl, setting]));
	const drawn: Drawn[] = container.children.map((child) => {
		const setting = bySettingEl.get(child);
		return setting
			? {
					kind: "row" as const,
					name: setting.name,
					desc: setting.desc,
					dropdowns: setting.dropdowns,
					buttons: setting.buttons,
				}
			: { kind: "note" as const, text: child.text };
	});
	return drawn.slice(1);
}

/** The rows of a tag's dialog, as it stands now. */
function dialog(tab: Tab, tag: string): Setting[] {
	takeSettings();
	tab.renderTagDialog(new FakeEl(), tag);
	return takeSettings();
}

/** The one row that adds a tag. */
function adder(drawn: Drawn[]): Extract<Drawn, { kind: "row" }> {
	return rows(drawn).find((row) => row.name === "Add a tag")!;
}

/** The rows a modal holds after `act`, which opened or redrew it. */
function modalRows(modal: { contentEl: FakeEl }, settings: Setting[]): Setting[] {
	return settings.filter((setting) => setting.containerEl === modal.contentEl);
}

/** Lets the `onChange` handler's promise chain finish -- `pick()` cannot await it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function rows(drawn: Drawn[]): Extract<Drawn, { kind: "row" }>[] {
	return drawn.filter((item): item is Extract<Drawn, { kind: "row" }> => item.kind === "row");
}
function notes(drawn: Drawn[]): string[] {
	return drawn.filter((item) => item.kind === "note").map((item) => item.text);
}

describe("the free version's tag cap", () => {
	beforeEach(() => {
		takeSettings();
	});

	it("offers the first tag a free user found in the one add row, and its folders in its dialog", async () => {
		const { tab } = await tabWith({ discovered: ["#work"], folders: ["Work"] });

		const [row, ...rest] = rows(draw(tab));
		expect(rest).toEqual([]);
		expect(row.name).toBe("Add a tag");
		expect(row.dropdowns[0].options).toEqual({ "": "Choose a tag… (1 found)", "#work": "#work" });
		expect(row.dropdowns[0].disabled).toBe(false);
		expect(row.buttons.map((button) => button.text)).toEqual(["Scan"]);
		const folder = dialog(tab, "#work");
		expect(folder.map((setting) => setting.name)).toEqual(["Folder"]);
		expect(Object.keys(folder[0].dropdowns[0].options)).toEqual(["", "/", "Work"]);
	});

	it("says to scan first, and offers nothing, before a scan", async () => {
		const { tab } = await tabWith({});
		const row = adder(draw(tab));
		expect(row.desc).toBe("Scan your reMarkable notebooks and pages for tags, then pick one to sync.");
		expect(row.dropdowns[0].options).toEqual({ "": "No tags to add" });
		expect(row.dropdowns[0].disabled).toBe(true);
	});

	it("refuses the second tag: the add row closed, its dialog empty, and the cap sentence above it", async () => {
		const { tab } = await tabWith({
			mapping: { "#work": "Work" },
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
		});

		const drawn = draw(tab);
		expect(notes(drawn)).toEqual([TAG_CAP_MESSAGE]);
		// The cap sentence explains the row under it, so it has to be above it.
		expect(drawn.findIndex((item) => item.kind === "note")).toBeLessThan(drawn.findIndex((item) => item.kind === "row" && item.name === "Add a tag"));
		expect(adder(drawn).dropdowns[0].disabled).toBe(true);
		expect(dialog(tab, "#home")).toEqual([]);
	});

	it("lets a Pro user map the second tag", async () => {
		const { tab } = await tabWith({
			mapping: { "#work": "Work" },
			licence: PRO,
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
		});

		const drawn = draw(tab);
		expect(notes(drawn)).toEqual([]);
		expect(Object.keys(adder(drawn).dropdowns[0].options)).toEqual(["", "#home"]);
		expect(Object.keys(dialog(tab, "#home")[0].dropdowns[0].options)).toEqual(["", "/", "Home", "Work"]);
	});

	it("lists every mapped tag on one line, even past the cap, with its folder and what it makes", async () => {
		// A Pro user who mapped three tags and then let the licence lapse. The cap blocks adding; it
		// must not take away what is already syncing.
		const { tab } = await tabWith({
			mapping: { "#work": "Work", "#home": "Home", "#ideas": "Ideas" },
			discovered: ["#work", "#home", "#ideas", "#new"],
			folders: ["Work", "Home", "Ideas"],
		});

		const mapped = rows(draw(tab)).filter((row) => row.name !== "Add a tag");
		expect(mapped.map((row) => row.name)).toEqual(["#home", "#ideas", "#work"]);
		expect(mapped[0].desc).toBe("Home · Transcript note");
		for (const row of mapped) {
			expect(row.dropdowns).toHaveLength(0);
			expect(row.buttons.map((button) => [button.icon, button.tooltip])).toEqual([
				["pencil", "Edit"],
				["trash", "Remove"],
			]);
		}
		// Its dialog: the folder, then what it makes.
		expect(dialog(tab, "#home").map((setting) => setting.name)).toEqual(["Folder", "Transcript note", "Page notes"]);
	});

	it("makes no licence call for the very first mapping -- a free user never talks to Polar", async () => {
		const { plugin, tab, refreshLicence } = await tabWith({ discovered: ["#work"], folders: ["Work"] });

		dialog(tab, "#work")[0].dropdowns[0].pick("Work");
		await settle();

		expect(refreshLicence).not.toHaveBeenCalled();
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Work" });
		expect(plugin.saves).toHaveLength(1);
	});

	it("re-checks the licence when a Pro render maps a further tag, and refuses if it has ended", async () => {
		// The only way to reach the live re-check: the tag could be added, which means the render was
		// under the cap, which past the free limit means the user had Pro when the tab drew -- and has
		// lost it by the time they pick a folder.
		const { plugin, tab, refreshLicence } = await tabWith({
			mapping: { "#work": "Work" },
			licence: PRO,
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
			recheck: FREE_ENTITLEMENT,
		});

		dialog(tab, "#home")[0].dropdowns[0].pick("Home");
		await settle();

		expect(refreshLicence).toHaveBeenCalledTimes(1);
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Work" });
		expect(plugin.saves).toHaveLength(0);
	});

	it("writes the mapping when that live re-check still says Pro", async () => {
		const { plugin, tab, refreshLicence } = await tabWith({
			mapping: { "#work": "Work" },
			licence: PRO,
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
			recheck: PRO_ENTITLEMENT,
		});

		dialog(tab, "#home")[0].dropdowns[0].pick("Home");
		await settle();

		expect(refreshLicence).toHaveBeenCalledTimes(1);
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Work", "#home": "Home" });
		expect(plugin.saves).toHaveLength(1);
	});

	it("re-points a mapping the user already has without asking Polar -- that is not an add", async () => {
		// The re-check is armed here (Pro, one tag mapped, one still unmapped). Changing where an
		// existing tag writes is not buying anything, so it must not be able to fail on a licence.
		const { plugin, tab, refreshLicence } = await tabWith({
			mapping: { "#work": "Work" },
			licence: PRO,
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
		});

		dialog(tab, "#work")[0].dropdowns[0].pick("Home");
		await settle();

		expect(refreshLicence).not.toHaveBeenCalled();
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Home" });
	});

	it("removes a mapped tag only once asked, saying what removal does", async () => {
		const { plugin, tab } = await tabWith({ mapping: { "#work": "Work" }, licence: PRO, folders: ["Work"] });
		const trash = () => rows(draw(tab)).find((row) => row.name === "#work")!.buttons[1];

		takeModals();
		trash().click();
		const [ask] = takeModals();
		expect(ask.contentEl.allText()).toContain(REMOVAL_NOTE);
		takeSettings().at(-1)!.buttons[0].click(); // Cancel
		await settle();
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Work" });

		trash().click();
		takeSettings().at(-1)!.buttons[1].click(); // Remove
		await settle();
		expect(plugin.data.tagFolderMap).toEqual({});
	});

	it("opens a tag's dialog from the add row and from its pencil, and keeps it current as the tag is mapped", async () => {
		const { plugin, tab } = await tabWith({ discovered: ["#work"], folders: ["Work"] });
		takeModals();
		// The placeholder opens nothing.
		adder(draw(tab)).dropdowns[0].pick("");
		expect(takeModals()).toEqual([]);
		adder(draw(tab)).dropdowns[0].pick("#work");
		const [opened] = takeModals();
		expect(opened.titleEl.text).toBe("Tag: #work");
		const before = modalRows(opened, takeSettings());
		expect(before.map((setting) => setting.name)).toEqual(["Folder"]);

		// The folder placeholder maps nothing; choosing a folder maps the tag, and the dialog, drawn again
		// with the tab, now offers what it makes.
		before[0].dropdowns[0].pick("");
		await settle();
		expect(plugin.data.tagFolderMap).toEqual({});
		before[0].dropdowns[0].pick("Work");
		await settle();
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Work" });
		expect(modalRows(opened, takeSettings()).map((setting) => setting.name)).toEqual(["Folder", "Transcript note", "Page notes"]);

		opened.close();
		takeSettings();
		rows(draw(tab)).find((row) => row.name === "#work")!.buttons[0].click();
		const [edit] = takeModals();
		expect(edit.titleEl.text).toBe("Tag: #work");
		expect(modalRows(edit, takeSettings())[0].dropdowns[0].value).toBe("Work");
	});

	it("keeps a mapped-but-missing folder selectable, labelled (missing)", async () => {
		const { tab } = await tabWith({ mapping: { "#work": "Gone" }, discovered: ["#work"], folders: ["Work"] });

		const dropdown = dialog(tab, "#work")[0].dropdowns[0];
		expect(dropdown.options["Gone"]).toBe("Gone (missing)");
		expect(dropdown.value).toBe("Gone");
	});
});
