import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidianSurface from "./obsidian";
import {
	checkPath,
	createFragment,
	debounce,
	DropdownComponent,
	FakeApp,
	type FakeDefinition,
	FakeEl,
	FakeVault,
	FuzzySuggestModal,
	normalizePath,
	parseLinktext,
	Plugin,
	PluginSettingTab,
	renderSettingTab,
	takeModals,
	takeSettings,
	TFile,
	TFolder,
} from "./fake-obsidian";

// `rmapi-js` cannot be resolved under vitest at all -- its `dist/raw.js` imports `crc-32/crc32c`,
// which the package does not ship a resolvable entry for. That is a packaging fact, unrelated to
// any testing decision, and it is the second of the two things that stop `main.ts` being imported.
vi.mock("rmapi-js", () => ({ session: () => ({}) }));

describe("the plugin's module graph", () => {
	it("loads against this fake, which is the whole reason the fake exists", async () => {
		const main = await import("../../src/main");
		expect(typeof main.default).toBe("function");
	});

	// `tsc` checks these imports against the real obsidian.d.ts, so a name the surface lacks passes
	// the typecheck and fails only when a test reaches it ("requireApiVersion is not a function").
	it("exports every value a non-test file imports from obsidian", () => {
		const missing: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
					for (const [, typeOnly, names] of readFileSync(full, "utf8").matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*"obsidian"/g)) {
						if (typeOnly) continue;
						for (const name of names.split(",").map((n) => n.trim().split(/\s+as\s+/)[0])) {
							if (name && !name.startsWith("type ") && !(name in obsidianSurface)) missing.push(`${name} (${full.replace(`${process.cwd()}/`, "")})`);
						}
					}
				}
			}
		};
		walk(join(process.cwd(), "src"));
		walk(join(process.cwd(), "pro"));
		expect(missing).toEqual([]);
	});
});

describe("normalizePath", () => {
	it("collapses repeated and backslash separators into single forward ones", () => {
		expect(normalizePath("a\\\\b//c")).toBe("a/b/c");
	});

	it("strips leading and trailing separators", () => {
		expect(normalizePath("/notes/x.md/")).toBe("notes/x.md");
	});

	it("turns a path that was nothing but separators into the vault root", () => {
		expect(normalizePath("///")).toBe("/");
	});

	// The reMarkable side of this: a notebook titled by hand carries whatever space the pen put
	// there, and this is the rewrite that made such a note unfindable after it was written.
	it("rewrites a non-breaking space and a narrow one to an ordinary space", () => {
		expect(normalizePath("Meeting\u00A0notes.md")).toBe("Meeting notes.md");
		expect(normalizePath("Meeting\u202Fnotes.md")).toBe("Meeting notes.md");
	});

	it("composes to NFC, so a decomposed umlaut is the same path as a composed one", () => {
		expect(normalizePath("Bücher.md")).toBe("Bücher.md");
	});

	// Deliberately not an ordering assertion. Slashes have to come first, and that much this pins;
	// swapping the last two steps changes no path at all, so a test claiming to pin their order
	// would be a test that cannot fail. Measured, by making the swap.
	it("applies all three rewrites to one path, with the slash collapse first", () => {
		expect(normalizePath("//A\u00A0/B\u0308//")).toBe("A /B\u0308".normalize("NFC"));
	});
});

describe("parseLinktext", () => {
	it("splits a link at its first hash and keeps the hash on the subpath", () => {
		expect(parseLinktext("Note#Heading")).toEqual({ path: "Note", subpath: "#Heading" });
	});

	it("gives a link with no hash an empty subpath rather than a null one", () => {
		expect(parseLinktext("Note")).toEqual({ path: "Note", subpath: "" });
	});

	it("leaves the path empty when the link is nothing but a subpath", () => {
		expect(parseLinktext("#Heading")).toEqual({ path: "", subpath: "#Heading" });
	});
});

describe("debounce", () => {
	beforeEach(() => vi.useFakeTimers());

	it("calls through once after the wait, with the last arguments it was given", () => {
		const spy = vi.fn();
		const d = debounce(spy, 500);
		d("first");
		d("second");
		vi.advanceTimersByTime(500);
		expect(spy.mock.calls).toEqual([["second"]]);
	});

	// The third argument is `resetTimer`, not "leading". Nothing here fires on the leading edge --
	// worth pinning, because a settings field that persists through one is asserted against it.
	it("does not fire on the leading edge, whatever the third argument says", () => {
		const spy = vi.fn();
		debounce(spy, 500, true)("x");
		expect(spy).not.toHaveBeenCalled();
	});

	it("keeps the first call's deadline when resetTimer is off", () => {
		const spy = vi.fn();
		const d = debounce(spy, 500, false);
		d("a");
		vi.advanceTimersByTime(400);
		d("b");
		vi.advanceTimersByTime(100);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("pushes the deadline out on every further call when resetTimer is on", () => {
		const spy = vi.fn();
		const d = debounce(spy, 500, true);
		d("a");
		vi.advanceTimersByTime(400);
		d("b");
		vi.advanceTimersByTime(100);
		expect(spy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(400);
		expect(spy.mock.calls).toEqual([["b"]]);
	});

	it("run() fires the pending call immediately and cancel() drops it", () => {
		const ran = vi.fn();
		debounce(ran, 500)("x").run();
		expect(ran).toHaveBeenCalledTimes(1);

		const dropped = vi.fn();
		debounce(dropped, 500)("x").cancel();
		vi.advanceTimersByTime(5000);
		expect(dropped).not.toHaveBeenCalled();
	});
});

describe("checkPath", () => {
	it("refuses a colon on macOS, which is where a handwritten 'Meeting 14:30' lands", () => {
		expect(() => checkPath("Notes/Meeting 14:30.md", "macos")).toThrow(/cannot contain/);
	});

	it("allows on macOS the characters only Windows forbids", () => {
		expect(() => checkPath("Notes/What? <draft>.md", "macos")).not.toThrow();
		expect(() => checkPath("Notes/What? <draft>.md", "windows")).toThrow(/cannot contain/);
	});

	it("forbids on mobile a set wider than the desktop one it otherwise shares", () => {
		expect(() => checkPath("Notes/What?.md", "linux")).not.toThrow();
		expect(() => checkPath("Notes/What?.md", "mobile")).toThrow(/cannot contain/);
	});

	it("refuses a trailing dot or space only on Windows", () => {
		expect(() => checkPath("Notes/draft.", "windows")).toThrow(/cannot end with a dot or a space/);
		expect(() => checkPath("Notes/draft ", "windows")).toThrow(/cannot end with a dot or a space/);
		expect(() => checkPath("Notes/draft.", "macos")).not.toThrow();
	});

	it("refuses a reserved device name only on Windows, extension or not", () => {
		expect(() => checkPath("Notes/CON.md", "windows")).toThrow("File name is forbidden: CON");
		expect(() => checkPath("Notes/lpt1.md", "windows")).toThrow(/forbidden/);
		expect(() => checkPath("Notes/CON.md", "macos")).not.toThrow();
	});

	it("checks every segment, not only the last one", () => {
		expect(() => checkPath("Note:s/x.md", "macos")).toThrow(/cannot contain/);
	});
});

describe("the vault's file index", () => {
	it("looks a path up exactly, without folding case", () => {
		const vault = new FakeVault();
		vault.seed("Notes/X.md", "hello");
		expect(vault.getFileByPath("Notes/X.md")?.path).toBe("Notes/X.md");
		expect(vault.getFileByPath("notes/x.md")).toBeNull();
	});

	it("keeps files and folders apart, so a folder is not returned as a file", async () => {
		const vault = new FakeVault();
		await vault.createFolder("Notes");
		expect(vault.getFolderByPath("Notes")).toBeInstanceOf(TFolder);
		expect(vault.getFileByPath("Notes")).toBeNull();
	});

	it("splits a name into basename and extension the way a TFile carries them", () => {
		const file = new FakeVault().seed("Notes/Meeting.md");
		expect(file).toBeInstanceOf(TFile);
		expect([file.name, file.basename, file.extension]).toEqual(["Meeting.md", "Meeting", "md"]);
	});
});

// The two rules this fake models. Both were read out of Obsidian 1.13.7's shipped `app.js`, and
// together they are the highest-ranked gap in the repo: `create` decides a path is taken through the
// filesystem, while every lookup the plugin makes goes through the index.
describe("what the vault refuses to write over", () => {
	it("throws Obsidian's own sentence when creating over a file that is there", async () => {
		const vault = new FakeVault();
		await vault.create("Notes/X.md", "one");
		await expect(vault.create("Notes/X.md", "two")).rejects.toThrow("File already exists.");
	});

	it("throws it for a binary write too, from the same shape", async () => {
		const vault = new FakeVault();
		await vault.createBinary("Files/a.png", new ArrayBuffer(1));
		await expect(vault.createBinary("Files/a.png", new ArrayBuffer(1))).rejects.toThrow("File already exists.");
	});

	it("has its own sentence for a folder", async () => {
		const vault = new FakeVault();
		await vault.createFolder("Notes");
		await expect(vault.createFolder("Notes")).rejects.toThrow("Folder already exists.");
	});

	// This is the disagreement itself, and it is what makes a "free" path not free.
	it("refuses a path the index says is free, when only its case differs", async () => {
		const vault = new FakeVault({ platform: "macos" });
		await vault.create("Notes/X.md", "one");
		expect(vault.getFileByPath("Notes/x.md")).toBeNull();
		await expect(vault.create("Notes/x.md", "two")).rejects.toThrow("File already exists.");
	});

	it("accepts that same path on Linux, where the filesystem does not fold case", async () => {
		const vault = new FakeVault({ platform: "linux" });
		await vault.create("Notes/X.md", "one");
		await expect(vault.create("Notes/x.md", "two")).resolves.toBeInstanceOf(TFile);
	});

	// The write normalises and the lookup does not. That asymmetry is the whole bug behind the fix
	// in `note-builder.ts`, and the fake has to reproduce it or a test cannot see it.
	it("normalises the path it writes to, while the lookup keeps whatever it was given", async () => {
		const vault = new FakeVault();
		await vault.create("Notes/Meeting\u00A0notes.md", "x");
		expect(vault.getFileByPath("Notes/Meeting\u00A0notes.md")).toBeNull();
		expect(vault.getFileByPath("Notes/Meeting notes.md")?.path).toBe("Notes/Meeting notes.md");
	});

	it("applies checkPath before the existence check, so an illegal name never lands", async () => {
		const vault = new FakeVault({ platform: "macos" });
		await expect(vault.create("Notes/Meeting 14:30.md", "x")).rejects.toThrow(/cannot contain/);
		expect(vault.getAllLoadedFiles()).toEqual([]);
	});
});

describe("writing through the vault", () => {
	it("process() writes only when the callback changed something, and returns the new text", async () => {
		const vault = new FakeVault();
		const file = vault.seed("Notes/X.md", "before");

		await expect(vault.process(file, () => "before")).resolves.toBe("before");
		expect(vault.writeLog).toEqual([]);

		await expect(vault.process(file, (data) => data + "!")).resolves.toBe("before!");
		expect(vault.writeLog).toEqual(["Notes/X.md"]);
		expect(vault.fileContents()["Notes/X.md"]).toBe("before!");
	});

	it("a rename moves the content with the file and tells whoever subscribed", async () => {
		const vault = new FakeVault();
		const file = vault.seed("Notes/Old.md", "body");
		const seen: [string, string][] = [];
		vault.on("rename", ((f: TFile, oldPath: string) => seen.push([f.path, oldPath])) as never);

		const app = new FakeApp(vault);
		await app.fileManager.renameFile(file, "Notes/New.md");

		expect(vault.getFileByPath("Notes/Old.md")).toBeNull();
		expect(vault.getFileByPath("Notes/New.md")?.path).toBe("Notes/New.md");
		expect(vault.fileContents()).toEqual({ "Notes/New.md": "body" });
		expect(seen).toEqual([["Notes/New.md", "Notes/Old.md"]]);
	});

	it("fans a folder rename out into one event for the folder and one per descendant", async () => {
		// The shape a listener has to survive. Obsidian's adapter walks the index after moving the
		// folder and fires again for everything under the old prefix, folder first.
		const vault = new FakeVault();
		const folder = (await vault.createFolder("Notes")) as TFolder;
		vault.seed("Notes/A.md", "a");
		vault.seed("Notes/Deep/B.md", "b");
		await vault.createFolder("Notes/Deep");
		vault.seed("Elsewhere/C.md", "c");
		const seen: [string, string][] = [];
		vault.on("rename", ((f: TFile, oldPath: string) => seen.push([f.path, oldPath])) as never);

		await new FakeApp(vault).fileManager.renameFile(folder, "Archive");

		expect(seen[0]).toEqual(["Archive", "Notes"]);
		expect(seen.slice(1).sort()).toEqual([
			["Archive/A.md", "Notes/A.md"],
			["Archive/Deep", "Notes/Deep"],
			["Archive/Deep/B.md", "Notes/Deep/B.md"],
		]);
		expect(vault.fileContents()).toEqual({
			"Archive/A.md": "a",
			"Archive/Deep/B.md": "b",
			"Elsewhere/C.md": "c",
		});
	});

	it("leaves a folder whose name is only a prefix of the renamed one alone", async () => {
		// `Notes2` starts with `Notes`, and the plugin's own remap depends on the separator being
		// part of the comparison. A fake that got this wrong would hide that.
		const vault = new FakeVault();
		const folder = (await vault.createFolder("Notes")) as TFolder;
		vault.seed("Notes2/Keep.md", "keep");

		await new FakeApp(vault).fileManager.renameFile(folder, "Archive");

		expect(vault.fileContents()).toEqual({ "Notes2/Keep.md": "keep" });
	});
});

describe("the plugin host", () => {
	it("hands loadData whatever the test says data.json holds, and records every save", async () => {
		const plugin = new Plugin(new FakeApp());
		plugin.saved = { deviceToken: "abc" };
		await expect(plugin.loadData()).resolves.toEqual({ deviceToken: "abc" });

		const data = { deviceToken: "abc" };
		await plugin.saveData(data);
		data.deviceToken = "changed-after-the-save";
		expect(plugin.saves).toEqual([{ deviceToken: "abc" }]);
	});

	it("holds an onLayoutReady callback until the workspace is ready, then runs it", async () => {
		// A plugin loaded during Obsidian's own startup sees a workspace that is not ready yet. Running
		// the callback at once would make "waits for the workspace" untestable and always true.
		const app = new FakeApp();
		const ran: string[] = [];

		app.workspace.onLayoutReady(() => ran.push("early"));
		expect(ran).toEqual([]);

		app.workspace.markLayoutReady();
		expect(ran).toEqual(["early"]);

		// Enabled by hand, long after startup: Obsidian runs it straight away.
		app.workspace.onLayoutReady(() => ran.push("late"));
		expect(ran).toEqual(["early", "late"]);
	});
});

describe("the settings controls the plugin reaches past", () => {
	it("gives a dropdown real option elements, because src/main.ts mutates one", () => {
		// `addOption` is `selectEl.createEl("option", …)` and nothing else (app.js), which is why the
		// plugin can grey out the last option it added and rewrite its text. Modelled as one list, so
		// an option the plugin relabels reads back relabelled rather than keeping its first label.
		const dropdown = new DropdownComponent();
		dropdown.addOption("vision", "Apple Vision").addOption("local", "Local model");

		const last = dropdown.selectEl.options[dropdown.selectEl.options.length - 1];
		last.disabled = true;
		last.text = "Local model (needs a download)";

		expect(dropdown.options).toEqual({ vision: "Apple Vision", local: "Local model (needs a download)" });
		expect(dropdown.selectEl.options.map((option) => option.value)).toEqual(["vision", "local"]);
	});

	it("builds a fragment the way the global does: the callback fills it, the fragment comes back", () => {
		// enhance.js: `window.createFragment = function (t) { var e = document.createDocumentFragment();
		// return t && t(e), e; }` -- the callback's return value is discarded, and it is optional.
		const filled = createFragment((fragment) => {
			fragment.appendText("Needs a licence. ");
			fragment.createEl("a", { text: "Buy" });
			return "discarded";
		});

		expect(filled.allText()).toEqual(["Needs a licence. ", "Buy"]);
		expect(createFragment().allText()).toEqual([]);
	});

	it("hides an element the plugin toggles off, and shows it again", () => {
		// enhance.js, in full: `toggle(t) { t ? this.show() : this.hide() }`. The status bar hides its
		// own parts this way rather than emptying them, so that a progress tick does not rebuild them.
		const el = new FakeEl("span");

		el.toggle(false);
		expect(el.visible).toBe(false);

		el.toggle(true);
		expect(el.visible).toBe(true);
	});
});

describe("the declarative settings tab", () => {
	/** A tab drawing the definitions a test hands it. */
	function tabOf(definitions: () => FakeDefinition[]): PluginSettingTab {
		const tab = new PluginSettingTab(new FakeApp(), new Plugin(new FakeApp()));
		tab.getSettingDefinitions = definitions;
		return tab;
	}

	it("draws a group's heading, then its rows, and a page as one entry on the root", () => {
		takeSettings();
		const tab = tabOf(() => [
			{ type: "group", heading: "Vault output", items: [{ name: "Folder", desc: "Where it goes." }] },
			{ type: "page", name: "Zotero", items: [{ name: "Connection" }] },
		]);

		renderSettingTab(tab);
		expect(takeSettings().map((setting) => [setting.name, setting.heading])).toEqual([
			["Vault output", true],
			["Folder", false],
			["Zotero", false],
		]);

		renderSettingTab(tab, { page: "Zotero" });
		expect(takeSettings().map((setting) => setting.name)).toEqual(["Connection"]);
	});

	// obsidian.d.ts: a render callback "may return a cleanup function, invoked before the row is torn down".
	it("runs a render row's cleanup before every redraw and when the tab closes", () => {
		const torn: string[] = [];
		const tab = tabOf(() => [{ name: "Line", render: () => () => void torn.push("line") }]);

		renderSettingTab(tab);
		tab.update();
		expect(torn).toEqual(["line"]);

		tab.hide();
		expect(torn).toEqual(["line", "line"]);
		tab.update();
		expect(torn).toEqual(["line", "line"]);
	});

	// app.js `getControlBinding`: the value comes from `getControlValue`, a change is `await
	// setControlValue` and then `refreshDomState()`, which hides and shows without drawing anything again.
	it("binds a control row to the tab, and re-evaluates visible after a change without a redraw", async () => {
		// The debounce tests above leave fake timers installed.
		vi.useRealTimers();
		takeSettings();
		const stored: Record<string, unknown> = { on: false };
		const tab = tabOf(() => [
			{ name: "Switch", control: { type: "toggle", key: "on" } },
			{ name: "Shown when on", visible: () => stored.on === true },
		]);
		tab.getControlValue = (key) => stored[key];
		tab.setControlValue = async (key, value) => void (stored[key] = value);

		renderSettingTab(tab);
		const [toggle, shown] = takeSettings();
		expect(toggle.toggles[0].value).toBe(false);
		expect(shown.settingEl.visible).toBe(false);

		toggle.toggles[0].toggle(true);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(stored.on).toBe(true);
		expect(shown.settingEl.visible).toBe(true);
		expect(takeSettings()).toEqual([]);
	});

	// app.js `due`/`nue`: a redraw keeps a row whose key it drew before, runs its cleanup, clears its
	// controls and draws the definition into the same `Setting` -- what the render put into `settingEl`
	// itself stays.
	it("redraws a row with the same key into the same element, after its cleanup and without its old controls", () => {
		takeSettings();
		const log: string[] = [];
		const tab = tabOf(() => [
			{
				name: "Row",
				render: (setting) => {
					setting.settingEl.createDiv({ cls: "drawn" });
					setting.addButton((button) => button.setButtonText("Go"));
					return () => void log.push("cleanup");
				},
			},
		]);

		renderSettingTab(tab);
		const [first] = takeSettings();
		tab.update();
		const [again] = takeSettings();

		expect(again).toBe(first);
		expect(log).toEqual(["cleanup"]);
		expect(again.buttons.map((button) => button.text)).toEqual(["Go"]);
		expect(again.settingEl.children.filter((child) => child.classes.has("drawn"))).toHaveLength(2);
	});

	it("runs the cleanup of a row the redraw no longer has", () => {
		const log: string[] = [];
		let rows = ["Kept", "Dropped"];
		const tab = tabOf(() => rows.map((name) => ({ name, render: () => () => void log.push(name) })));

		renderSettingTab(tab);
		rows = ["Kept"];
		tab.update();

		expect(log).toEqual(["Kept", "Dropped"]);
	});

	it("draws a dropdown control with its options, and a folder control as a field with its placeholder", () => {
		takeSettings();
		const tab = tabOf(() => [
			{ name: "Pick", control: { type: "dropdown", key: "pick", options: { a: "A", b: "B" } } },
			{ name: "Folder", control: { type: "folder", key: "folder", placeholder: "Here", defaultValue: "There" } },
		]);
		tab.getControlValue = (key) => (key === "pick" ? "b" : undefined);

		renderSettingTab(tab);
		const [pick, folder] = takeSettings();

		expect(pick.dropdowns[0].options).toEqual({ a: "A", b: "B" });
		expect(pick.dropdowns[0].value).toBe("b");
		expect(folder.texts[0]).toMatchObject({ placeholder: "Here", value: "There" });
	});

	it("refuses a definition field it does not model, rather than drawing it as understood", () => {
		const tab = tabOf(() => [{ type: "group", visible: false, items: [] } as FakeDefinition]);

		expect(() => renderSettingTab(tab)).toThrow('a definition\'s "visible" is not modelled yet');
	});

	it("refuses a list, which it does not model either", () => {
		const tab = tabOf(() => [{ type: "list", items: [] }]);

		expect(() => renderSettingTab(tab)).toThrow('a definition\'s "list" is not modelled yet');
	});

	// obsidian.d.ts: `extraButtons` are "for the header", and `cls` goes on the group element, which
	// holds the header and the rows (app.js `HDe`: `setting-group`, then header, search, items).
	it("draws a group as an element holding its heading with the extra buttons, and its rows", () => {
		takeSettings();
		const clicked: string[] = [];
		const tab = tabOf(() => [
			{
				type: "group",
				heading: "Tags",
				cls: "my-group",
				extraButtons: [(button) => button.setIcon("refresh-cw").setTooltip("Scan").onClick(() => clicked.push("scan"))],
				items: [{ name: "Row" }],
			},
		]);

		renderSettingTab(tab);
		const [heading, row] = takeSettings();
		heading.extraButtons[0].click();

		expect(heading.extraButtons.map((button) => [button.icon, button.tooltip])).toEqual([["refresh-cw", "Scan"]]);
		expect(clicked).toEqual(["scan"]);
		const groupEl = tab.containerEl.querySelector(".my-group");
		expect(groupEl?.classes.has("setting-group")).toBe(true);
		expect(row.settingEl.closest(".my-group")).toBe(groupEl);
		expect(row.settingEl.closest(".nowhere")).toBeNull();
	});

	// app.js `rue`: a redraw that finds a group with the same key (`id`, else its heading) sets its
	// heading and draws its items again -- the class, the extra buttons and the search box, with its
	// `match`, stay as the group's first draw made them. Only a group drawn anew gets the new ones.
	it("keeps a group's header from its first draw, however the definition changes", () => {
		takeSettings();
		let round = 1;
		const tab = tabOf(() => [
			{
				type: "group",
				heading: "Tags",
				cls: `round-${round}`,
				extraButtons: [(button) => button.setTooltip(`round ${round}`)],
				search: { placeholder: `round ${round}`, match: () => round === 1 },
				items: [{ name: "Row" }],
			},
		]);

		renderSettingTab(tab);
		round = 2;
		tab.update();
		const [heading] = takeSettings().slice(-2);

		expect(heading.extraButtons.map((button) => button.tooltip)).toEqual(["round 1"]);
		expect(tab.groupSearch("Tags").placeholder).toBe("round 1");
		expect(tab.containerEl.querySelector(".round-2")).toBeNull();

		tab.hide();
		renderSettingTab(tab);
		expect(tab.groupSearch("Tags").placeholder).toBe("round 2");
	});

	// app.js `HDe`: the search box is added only `if (o.search && o.items && o.items.length > 0)`.
	it("draws no search box for a group that starts without rows", () => {
		const tab = tabOf(() => [{ type: "group", heading: "Empty", search: { match: () => true }, items: [] }]);

		renderSettingTab(tab);

		expect(() => tab.groupSearch("Empty")).toThrow('no group "Empty" with a search box');
	});

	// obsidian.d.ts `search`: `match(def, query)` is called "for each direct child definition", items with
	// `searchable: false` "bypass this filter and always show", and "the query is preserved across
	// re-renders and the filter is reapplied after each render".
	it("filters a group's searchable rows by its match, keeps the query across a redraw, and leaves the rest shown", () => {
		takeSettings();
		const asked: string[] = [];
		const tab = tabOf(() => [
			{
				type: "group",
				heading: "Fruit",
				search: {
					placeholder: "Filter fruit",
					match: (def, query) => {
						asked.push(`${def.name}:${query}`);
						return (def.name ?? "").includes(query);
					},
				},
				items: [{ name: "apple" }, { name: "pear" }, { name: "note", searchable: false }],
			},
		]);
		renderSettingTab(tab);
		const visibleNames = (): string[] =>
			takeSettings()
				.filter((setting) => !setting.heading && setting.settingEl.visible)
				.map((setting) => setting.name);

		const search = tab.groupSearch("Fruit");
		expect(search.placeholder).toBe("Filter fruit");
		search.type("ap");
		expect(visibleNames()).toEqual(["apple", "note"]);
		expect(asked).toEqual(["apple:ap", "pear:ap"]);

		tab.update();
		expect(visibleNames()).toEqual(["apple", "note"]);

		tab.groupSearch("Fruit").type("");
		tab.update();
		expect(visibleNames()).toEqual(["apple", "pear", "note"]);
	});

	it("scrolls an element into view when asked, and finds it by its class", () => {
		const root = new FakeEl();
		const target = root.createDiv().createDiv({ cls: "far down" });

		root.querySelector(".down")?.scrollIntoView();

		expect(target.scrolledIntoView).toBe(1);
		expect(root.querySelector(".nowhere")).toBeNull();
	});
});

// obsidian.d.ts: a `FuzzySuggestModal` lists `getItems()` by `getItemText`, and choosing one calls
// `onChooseItem`.
describe("the fuzzy picker", () => {
	class Picker extends FuzzySuggestModal<string> {
		chosen: string[] = [];
		getItems(): string[] {
			return ["/", "Work"];
		}
		getItemText(item: string): string {
			return item === "/" ? "Vault root" : item;
		}
		onChooseItem(item: string): void {
			this.chosen.push(item);
		}
	}

	it("lists the items by their text, and hands back the item the user chose", () => {
		takeModals();
		const picker = new Picker(new FakeApp());
		picker.setPlaceholder("Choose a folder");
		picker.open();

		expect(takeModals()).toEqual([picker]);
		expect(picker.placeholder).toBe("Choose a folder");
		expect(picker.itemTexts).toEqual(["Vault root", "Work"]);

		picker.choose("Vault root");
		expect(picker.chosen).toEqual(["/"]);
		expect(picker.opened).toBe(false);
	});
});
