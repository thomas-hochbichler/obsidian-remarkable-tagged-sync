import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ButtonComponent,
	createFragment,
	type DropdownComponent,
	FakeApp,
	FakeEl,
	type Setting,
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
// `createFragment` is modelled in the fake, read out of Obsidian's own `enhance.js`. The timers are
// the platform's and there is nothing to model; step 6 of the cut replaces them with an injected
// scheduler and this shim goes away with them.
vi.stubGlobal("createFragment", createFragment);
vi.stubGlobal("window", {
	setTimeout: () => 0,
	clearTimeout: () => undefined,
	setInterval: () => 0,
	clearInterval: () => undefined,
	open: () => undefined,
});

const PRO = { key: "test-key", activationId: "act-1", validatedAt: new Date().toISOString() };
const PRO_ENTITLEMENT: Entitlement = { tier: "pro", since: PRO.validatedAt, stale: false };
const FREE_ENTITLEMENT: Entitlement = { tier: "free", reason: "revoked" };

const CAP_ROW_DESC = "Not synced.";
const MAPPABLE_ROW_DESC = "Not synced until mapped to a folder.";
const REMOVAL_NOTE = "Removing a tag stops syncing it. Notes already in your vault stay where they are.";

interface Tab {
	discoveredTags: string[];
	renderTagRouting(container: FakeEl): void;
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
 * The heading and the Scan button are dropped: they are the same two rows in every scenario.
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
	return drawn.slice(2);
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

	it("offers a folder dropdown for the first tag a free user maps", async () => {
		const { tab } = await tabWith({ discovered: ["#work"], folders: ["Work"] });

		const [row, ...rest] = rows(draw(tab));
		expect(rest).toEqual([]);
		expect(row.name).toBe("#work");
		expect(row.desc).toBe(MAPPABLE_ROW_DESC);
		expect(Object.keys(row.dropdowns[0].options)).toEqual(["", "/", "Work"]);
	});

	it("refuses the second tag: no dropdown, a read-only row, and the cap sentence above it", async () => {
		const { tab } = await tabWith({
			mapping: { "#work": "Work" },
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
		});

		const drawn = draw(tab);
		expect(notes(drawn)).toEqual([REMOVAL_NOTE, TAG_CAP_MESSAGE]);
		// The cap sentence explains the rows under it, so it has to be above them.
		expect(drawn.findIndex((item) => item.kind === "note" && item.text === TAG_CAP_MESSAGE)).toBeLessThan(
			drawn.findIndex((item) => item.kind === "row" && item.name === "#home"),
		);

		const home = rows(drawn).find((row) => row.name === "#home");
		expect(home?.desc).toBe(CAP_ROW_DESC);
		expect(home?.dropdowns).toEqual([]);
	});

	it("lets a Pro user map the second tag", async () => {
		const { tab } = await tabWith({
			mapping: { "#work": "Work" },
			licence: PRO,
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
		});

		const drawn = draw(tab);
		expect(notes(drawn)).toEqual([REMOVAL_NOTE]);
		const home = rows(drawn).find((row) => row.name === "#home");
		expect(home?.desc).toBe(MAPPABLE_ROW_DESC);
		expect(Object.keys(home?.dropdowns[0].options ?? {})).toEqual(["", "/", "Home", "Work"]);
	});

	it("never revokes a mapping the user already has, even past the cap", async () => {
		// A Pro user who mapped three tags and then let the licence lapse. The cap blocks adding; it
		// must not take away what is already syncing.
		const { tab } = await tabWith({
			mapping: { "#work": "Work", "#home": "Home", "#ideas": "Ideas" },
			discovered: ["#work", "#home", "#ideas", "#new"],
			folders: ["Work", "Home", "Ideas"],
		});

		const mapped = rows(draw(tab)).filter((row) => row.name !== "#new");
		expect(mapped.map((row) => row.name)).toEqual(["#home", "#ideas", "#work"]);
		for (const row of mapped) {
			expect(row.dropdowns).toHaveLength(1);
			expect(row.buttons.map((button) => button.text)).toEqual(["Remove"]);
		}
	});

	it("makes no licence call for the very first mapping -- a free user never talks to Polar", async () => {
		const { plugin, tab, refreshLicence } = await tabWith({ discovered: ["#work"], folders: ["Work"] });

		rows(draw(tab))[0].dropdowns[0].pick("Work");
		await settle();

		expect(refreshLicence).not.toHaveBeenCalled();
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Work" });
		expect(plugin.saves).toHaveLength(1);
	});

	it("re-checks the licence when a Pro render maps a further tag, and refuses if it has ended", async () => {
		// The only way to reach the live re-check: the row carried a dropdown, which means the render
		// was under the cap, which past the free limit means the user had Pro when the tab drew -- and
		// has lost it by the time they pick a folder.
		const { plugin, tab, refreshLicence } = await tabWith({
			mapping: { "#work": "Work" },
			licence: PRO,
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
			recheck: FREE_ENTITLEMENT,
		});

		const home = rows(draw(tab)).find((row) => row.name === "#home");
		home?.dropdowns[0].pick("Home");
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

		const home = rows(draw(tab)).find((row) => row.name === "#home");
		home?.dropdowns[0].pick("Home");
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

		const work = rows(draw(tab)).find((row) => row.name === "#work");
		work?.dropdowns[0].pick("Home");
		await settle();

		expect(refreshLicence).not.toHaveBeenCalled();
		expect(plugin.data.tagFolderMap).toEqual({ "#work": "Home" });
	});

	it("offers Remove on a mapped tag only -- there is nothing to remove from an unmapped one", async () => {
		const { tab } = await tabWith({
			mapping: { "#work": "Work" },
			licence: PRO,
			discovered: ["#work", "#home"],
			folders: ["Work", "Home"],
		});

		const drawn = rows(draw(tab));
		expect(drawn.find((row) => row.name === "#work")?.buttons.map((b) => b.text)).toEqual(["Remove"]);
		expect(drawn.find((row) => row.name === "#home")?.buttons).toEqual([]);
	});

	it("keeps a mapped-but-missing folder selectable, labelled (missing)", async () => {
		const { tab } = await tabWith({ mapping: { "#work": "Gone" }, discovered: ["#work"], folders: ["Work"] });

		const dropdown = rows(draw(tab))[0].dropdowns[0];
		expect(dropdown.options["Gone"]).toBe("Gone (missing)");
		expect(dropdown.value).toBe("Gone");
	});
});
