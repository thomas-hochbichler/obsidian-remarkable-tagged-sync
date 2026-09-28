import { Setting } from "obsidian";
import { describe, expect, it } from "vitest";
import { FakeEl, takeSettings, type Setting as FakeSetting } from "../../test-stubs/fake-obsidian";
import { registerExtractionBackend } from "./extraction-registry";
import { type IntelligenceSettingsHost, renderIntelligenceSection, renderTagModes } from "./settings-section";
import { emptyIntelligence, setIntelligenceMode, TASKS_FORMAT, type IntelligenceSettings } from "./settings";

registerExtractionBackend({ id: "sectioncloud", label: "Section cloud", metered: true, requiresLicence: true, measured: true, create: () => null });
registerExtractionBackend({ id: "sectionlocal", label: "Section local", metered: false, requiresLicence: false, measured: false, create: () => null });

const MAP = { work: "Work", home: "Home" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(initial: IntelligenceSettings, pro: boolean, options: { device?: string | null; confirm?: boolean; templates?: Record<string, string> } = {}) {
	let settings = initial;
	let device = options.device ?? null;
	const log: string[] = [];
	const h: IntelligenceSettingsHost & { log: string[] } = {
		log,
		settings: () => settings,
		update: (next) => void (settings = next),
		tagFolderMap: () => MAP,
		pro,
		saveAndRedraw: async () => void log.push("redraw"),
		save: async () => void log.push("save"),
		deviceId: async (mint) => {
			if (device === null && mint) device = "this-device";
			return device;
		},
		confirm: async () => options.confirm ?? false,
		templateFolder: async () => "Templates",
		createTemplate: async (path, content) => (log.push(`create ${path}:${content.split("\n")[0]}`), path),
		readTemplate: async (path) => options.templates?.[path] ?? null,
		now: () => new Date("2026-09-28T10:00:00.000Z"),
		randomId: () => "0123456789abcdef",
	};
	return h;
}

const named = (settings: FakeSetting[], name: string) => settings.find((s) => s.name === name)!;

function section(h: IntelligenceSettingsHost): FakeSetting[] {
	takeSettings();
	renderIntelligenceSection(new FakeEl() as unknown as HTMLElement, h);
	return takeSettings();
}

describe("renderTagModes", () => {
	function row(h: IntelligenceSettingsHost, tag: string): FakeSetting {
		takeSettings();
		const setting = new Setting(new FakeEl() as unknown as HTMLElement);
		renderTagModes(setting, tag, h);
		return setting as unknown as FakeSetting;
	}

	it("switches Intelligence Mode on with its stamps and claims this device when no device runs the engine", async () => {
		const h = host(emptyIntelligence(), false);
		row(h, "work").toggles[1].toggle(true);
		await flush();
		expect(h.settings().mappings.work).toMatchObject({ intelligence: true, enabledAt: "2026-09-28T10:00:00.000Z", firstEnabledAt: "2026-09-28T10:00:00.000Z" });
		expect(h.settings().engineDeviceId).toBe("this-device");
		row(h, "work").toggles[1].toggle(false);
		await flush();
		expect(h.settings().engineDeviceId).toBe("this-device");
	});

	it("leaves the engine where it runs when a second tag is switched on", async () => {
		const h = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true);
		row(h, "home").toggles[1].toggle(true);
		await flush();
		expect(h.settings().engineDeviceId).toBe("other");
	});

	it("locks page notes on a second tag without Pro, and not with it", () => {
		const on = setIntelligenceMode(emptyIntelligence(), "work", true, new Date("2026-09-01T00:00:00.000Z"));
		expect(row(host(on, false), "home").toggles[1].disabled).toBe(true);
		expect(row(host(on, true), "home").toggles[1].disabled).toBe(false);
		expect(row(host(on, false), "work").toggles[1].disabled).toBe(false);
	});

	it("switches the transcript note, picks a Profile without Pro, and says what transcript off means", async () => {
		const h = host({ ...setIntelligenceMode(emptyIntelligence(), "work", true, new Date()), profiles: [{ id: "p", name: "Meetings", description: "", template: null, slots: [] }] }, false);
		const r = row(h, "work");
		r.toggles[0].toggle(false);
		await flush();
		r.dropdowns[0].pick("p");
		await flush();
		expect(h.settings().mappings.work).toMatchObject({ transcript: false, profiles: ["p"] });
		expect(row(h, "work").desc).toContain("Transcript off");
		row(h, "work").dropdowns[0].pick("");
		await flush();
		expect(h.settings().mappings.work.profiles).toEqual([]);
	});

	it("offers several Profiles per tag with Pro: added from a list, removed one by one", async () => {
		const profiles = [
			{ id: "m", name: "Meetings", description: "", template: null, slots: [] },
			{ id: "j", name: "Journal", description: "", template: null, slots: [] },
		];
		const h = host({ ...setIntelligenceMode(emptyIntelligence(), "work", true, new Date()), profiles }, true);
		expect(Object.values(row(h, "work").dropdowns[0].options)).toEqual(["Generic; add a profile…", "Meetings", "Journal"]);
		row(h, "work").dropdowns[0].pick("m");
		await flush();
		row(h, "work").dropdowns[0].pick("");
		row(h, "work").dropdowns[0].pick("j");
		await flush();
		expect(h.settings().mappings.work.profiles).toEqual(["m", "j"]);
		const full = row(h, "work");
		expect(full.buttons.map((b) => b.text)).toEqual(["Meetings ×", "Journal ×"]);
		expect(full.dropdowns).toHaveLength(0);
		full.buttons[0].click();
		await flush();
		expect(h.settings().mappings.work.profiles).toEqual(["j"]);
		expect(Object.values(row(h, "work").dropdowns[0].options)[0]).toBe("Add a profile…");
		h.update({ ...h.settings(), mappings: { work: { ...h.settings().mappings.work, profiles: ["gone"] } } });
		expect(row(h, "work").buttons[0].text).toBe("gone ×");
	});
});

describe("renderIntelligenceSection", () => {
	it("shows the device switch as this device's state, and moves the engine here only after asking", async () => {
		const elsewhere = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true, { device: "this-device" });
		const settings = section(elsewhere);
		await flush();
		const device = named(settings, "Run page extraction on this device").toggles[0];
		expect(device.getValue()).toBe(false);
		device.toggle(true);
		await flush();
		expect(elsewhere.settings().engineDeviceId).toBe("other");

		const agreed = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true, { device: "this-device", confirm: true });
		named(section(agreed), "Run page extraction on this device").toggles[0].toggle(true);
		await flush();
		expect(agreed.settings().engineDeviceId).toBe("this-device");
		named(section(agreed), "Run page extraction on this device").toggles[0].toggle(false);
		await flush();
		expect(agreed.settings().engineDeviceId).toBeNull();

		const unclaimed = host(emptyIntelligence(), true);
		named(section(unclaimed), "Run page extraction on this device").toggles[0].toggle(true);
		await flush();
		expect(unclaimed.settings().engineDeviceId).toBe("this-device");
		const keep = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true, { device: "this-device" });
		named(section(keep), "Run page extraction on this device").toggles[0].toggle(false);
		await flush();
		expect(keep.settings().engineDeviceId).toBe("other");
	});

	it("offers every extraction backend, marking Pro and unmeasured ones, and saves the model as typed", async () => {
		const h = host(emptyIntelligence(), false);
		const settings = section(h);
		const backend = named(settings, "Extraction backend").dropdowns[0];
		expect(Object.values(backend.options)).toEqual(expect.arrayContaining(["Same as transcription", "Section cloud (Pro)", "Section local — not measured"]));
		backend.pick("sectionlocal");
		await flush();
		expect(h.settings().backend).toBe("sectionlocal");
		backend.pick("");
		await flush();
		expect(h.settings().backend).toBeNull();
		const model = named(settings, "Extraction model").texts[0];
		model.type(" my-model ");
		await flush();
		model.type("");
		await flush();
		expect(h.settings().model).toBeNull();
		expect(h.log.filter((entry) => entry === "save")).toHaveLength(2);
		expect(Object.values(named(section(host(emptyIntelligence(), true)), "Extraction backend").dropdowns[0].options)).toContain("Section cloud");
	});

	it("asks for consent to extract in automatic syncs, per kind of backend", async () => {
		const h = host(emptyIntelligence(), true);
		named(section(h), "Extract in automatic syncs with a paid backend").toggles[0].toggle(true);
		named(section(h), "Extract in automatic syncs with the local model").toggles[0].toggle(true);
		await flush();
		expect([h.settings().autoExtractMetered, h.settings().autoExtractLocal]).toEqual([true, true]);
	});

	it("adds one Profile without Pro and more with it; edits, removes, and creates its template", async () => {
		const h = host(setIntelligenceMode(emptyIntelligence(), "work", true, new Date()), false);
		named(section(h), "Add a profile").buttons[0].click();
		await flush();
		expect(h.settings().profiles).toEqual([{ id: "01234567", name: "My pages", description: "Handwritten notes", template: null, slots: ["tasks", "summary"] }]);
		expect(named(section(h), "Add a profile (Pro)").buttons[0].disabled).toBe(true);

		h.update({ ...h.settings(), mappings: { ...h.settings().mappings, work: { ...h.settings().mappings.work, profiles: ["01234567"] } } });
		let settings = section(h);
		const card = named(settings, "My pages");
		card.texts[0].type("Journal");
		card.texts[1].type("Diary pages");
		named(settings, "Template").texts[0].type(" T/J.md ");
		await flush();
		expect(h.settings().profiles[0]).toMatchObject({ name: "Journal", description: "Diary pages", template: "T/J.md" });
		named(settings, "Template").texts[0].type("");
		await flush();
		expect(h.settings().profiles[0].template).toBeNull();

		settings = section(h);
		named(settings, "Template").buttons[0].click();
		await flush();
		expect(h.log).toContain("create Templates/Journal.md:## Tasks");
		expect(h.settings().profiles[0].template).toBe("Templates/Journal.md");

		settings = section(h);
		expect(named(settings, "Fills Decisions (Pro)").toggles[0].disabled).toBe(true);
		named(settings, "Fills Summary").toggles[0].toggle(false);
		await flush();
		expect(h.settings().profiles[0].slots).toEqual(["tasks"]);
		named(section(h), "Fills Summary").toggles[0].toggle(true);
		await flush();
		expect(h.settings().profiles[0].slots).toEqual(["tasks", "summary"]);

		named(section(h), "Journal").buttons[0].click();
		await flush();
		expect(h.settings().profiles).toEqual([]);
		expect(h.settings().mappings.work.profiles).toEqual([]);

		// With two Profiles, an edit to one leaves the other as it was.
		const two = host({ ...emptyIntelligence(), profiles: [{ id: "a", name: "A", description: "", template: null, slots: [] }, { id: "b", name: "B", description: "", template: null, slots: [] }] }, true);
		named(section(two), "A").texts[0].type("A2");
		named(section(two), "Fills Tasks").toggles[0].toggle(true);
		await flush();
		expect(two.settings().profiles.map((p) => [p.name, p.slots])).toEqual([
			["A2", ["tasks"]],
			["B", []],
		]);

		const root = host(emptyIntelligence(), true);
		root.templateFolder = async () => "";
		named(section(root), "Add a profile").buttons[0].click();
		await flush();
		named(section(root), "Template").buttons[0].click();
		await flush();
		expect(root.settings().profiles[0].template).toBe("My pages.md");
	});

	it("edits a Slot's instruction, and keeps review and item format Pro, with presets and no format without {{text}}", async () => {
		const free = host(emptyIntelligence(), false);
		let settings = section(free);
		named(settings, "Tasks").texts[0].type("Only my own tasks");
		await flush();
		expect(free.settings().slots[0].instruction).toBe("Only my own tasks");
		expect(named(settings, "Review new and dropped tasks (Pro)").toggles[0]).toMatchObject({ disabled: true });
		expect(named(settings, "Review new and dropped tasks (Pro)").toggles[0].getValue()).toBe(true);
		expect(named(settings, "Item format (Pro)").desc).toBe(TASKS_FORMAT);
		expect(named(settings, "Decisions (Pro)").texts[0].disabled).toBe(true);

		const pro = host({ ...emptyIntelligence(), profiles: [{ id: "a", name: "A", description: "", template: null, slots: ["tasks"] }, { id: "b", name: "B", description: "", template: null, slots: ["tasks"] }] }, true);
		settings = section(pro);
		expect(named(settings, "Tasks").desc).toBe("Used by A, B: an edit here changes all of them.");
		named(settings, "Review new and dropped tasks").toggles[0].toggle(false);
		await flush();
		expect(pro.settings().slots[0].review).toBe(false);
		settings = section(pro);
		named(settings, "Item format").dropdowns[0].pick("Dataview");
		await flush();
		expect(pro.settings().slots[0].itemFormat).toBe("- [ ] {{text}} [due:: {{due}}]");
		settings = section(pro);
		named(settings, "Item format").dropdowns[0].pick("");
		named(settings, "Item format").texts[0].type("- {{txt}}");
		await flush();
		expect(pro.settings().slots[0].itemFormat).toBe("- [ ] {{text}} [due:: {{due}}]");
		named(settings, "Item format").texts[0].type("- {{text}} #todo");
		await flush();
		expect(pro.settings().slots[0].itemFormat).toBe("- {{text}} #todo");
	});
});

describe("renderIntelligenceSection > own Slots (Pro)", () => {
	it("adds a Slot with a name and a Shape, and not without a name or without Pro", async () => {
		const h = host(emptyIntelligence(), true);
		let settings = section(h);
		const add = named(settings, "Add a slot");
		add.buttons[0].click();
		await flush();
		expect(h.settings().slots).toHaveLength(4);
		add.texts[0].type("Ausgaben");
		add.dropdowns[0].pick("value");
		add.buttons[0].click();
		await flush();
		expect(h.settings().slots.at(-1)).toMatchObject({ id: "ausgaben", name: "Ausgaben", shape: "value", itemFormat: "", review: false });
		settings = section(h);
		const add2 = named(settings, "Add a slot");
		add2.texts[0].type("Offene Fragen");
		add2.dropdowns[0].pick("checklist");
		add2.buttons[0].click();
		await flush();
		expect(h.settings().slots.at(-1)).toMatchObject({ id: "offene-fragen", shape: "checklist", itemFormat: "- [ ] {{text}}", review: true });
		const add3 = named(section(h), "Add a slot");
		add3.texts[0].type("Ideen");
		add3.buttons[0].click();
		await flush();
		expect(h.settings().slots.at(-1)).toMatchObject({ id: "ideen", shape: "list", itemFormat: "- {{text}}", review: true });
		expect(named(section(host(emptyIntelligence(), false)), "Add a slot (Pro)").buttons[0].disabled).toBe(true);
	});

	it("duplicates and deletes a Slot, taking a deleted one out of every Profile", async () => {
		const h = host({ ...emptyIntelligence(), profiles: [{ id: "p", name: "P", description: "", template: null, slots: ["tasks", "summary"] }] }, true);
		const tasks = () => section(h).find((s) => s.name === "Tasks" && s.buttons.length === 2)!;
		tasks().buttons[0].click();
		await flush();
		expect(h.settings().slots.at(-1)).toMatchObject({ id: "tasks-copy", name: "Tasks copy", used: false, shape: "checklist" });
		tasks().buttons[1].click();
		await flush();
		expect(h.settings().slots.map((s) => s.id)).not.toContain("tasks");
		expect(h.settings().profiles[0].slots).toEqual(["summary"]);
	});

	it("changes a Shape until the Slot is used in a note, then keeps it fixed", async () => {
		const h = host(emptyIntelligence(), true);
		const shapeOf = (index: number) => section(h).filter((s) => s.name.startsWith("Shape"))[index];
		shapeOf(1).dropdowns[0].pick("checklist");
		await flush();
		expect(h.settings().slots[1]).toMatchObject({ id: "decisions", shape: "checklist", instruction: "Decisions that were made, as written." });
		h.update({ ...h.settings(), slots: h.settings().slots.map((s) => (s.id === "tasks" ? { ...s, used: true } : s)) });
		const fixed = shapeOf(0);
		expect(fixed.name).toBe("Shape (fixed: duplicate to change it)");
		expect(fixed.dropdowns[0].disabled).toBe(true);
	});

	it("edits examples and counter-examples", async () => {
		const empty = emptyIntelligence();
		// The default Tasks Slot ships with two examples; this starts from none.
		const h = host({ ...empty, slots: empty.slots.map((slot, index) => (index === 0 ? { ...slot, examples: [] } : slot)) }, true);
		named(section(h), "Add an example").buttons[0].click();
		named(section(h), "Add an example").buttons[1].click();
		await flush();
		let settings = section(h);
		const example = named(settings, "Example");
		example.texts[0].type("call Bob");
		example.texts[1].type("Call Bob");
		named(settings, "Counter-example").texts[0].type("Bob will call");
		await flush();
		expect(h.settings().slots[0].examples).toEqual([
			{ input: "call Bob", output: "Call Bob", positive: true },
			{ input: "Bob will call", output: "", positive: false },
		]);
		expect(named(settings, "Counter-example").texts[1].disabled).toBe(true);
		settings = section(h);
		named(settings, "Example").buttons[0].click();
		await flush();
		expect(h.settings().slots[0].examples).toEqual([{ input: "Bob will call", output: "", positive: false }]);
	});

	it("points a Value at a frontmatter property, or back into the body", async () => {
		const h = host(emptyIntelligence(), true);
		const property = named(section(h), "Frontmatter property");
		expect(property.texts[0].getValue()).toBe("tags");
		property.texts[0].type(" ");
		await flush();
		expect(h.settings().slots[3].property).toBeUndefined();
		property.texts[0].type(" project ");
		await flush();
		expect(h.settings().slots[3].property).toBe("project");
		expect(named(section(host(emptyIntelligence(), false)), "Frontmatter property (Pro)").texts[0].disabled).toBe(true);
	});

	it("adds up to five fields, types them, gives a choice its options, and removes them", async () => {
		const h = host({ ...emptyIntelligence(), slots: [{ id: "x", name: "X", shape: "list", instruction: "", examples: [], fields: [], itemFormat: "- {{text}}", review: false }] }, true);
		for (let n = 0; n < 5; n++) {
			named(section(h), "Add a field").buttons[0].click();
			await flush();
		}
		expect(h.settings().slots[0].fields.map((f) => f.name)).toEqual(["field1", "field2", "field3", "field4", "field5"]);
		let settings = section(h);
		expect(settings.some((s) => s.name === "Add a field")).toBe(false);
		const first = named(settings, "Field field1");
		first.texts[0].type(" owner ");
		first.dropdowns[0].pick("choice");
		await flush();
		settings = section(h);
		named(settings, "Field owner").texts[1].type("Anna, Bob, ,Carl");
		await flush();
		expect(h.settings().slots[0].fields[0]).toEqual({ name: "owner", type: "choice", options: ["Anna", "Bob", "Carl"] });
		named(section(h), "Field owner").buttons[0].click();
		await flush();
		expect(h.settings().slots[0].fields).toHaveLength(4);
		const free = host({ ...emptyIntelligence(), slots: [{ ...h.settings().slots[0], fields: [{ name: "c", type: "choice" }] }] }, false);
		const locked = section(free);
		expect(named(locked, "Field c (Pro)").texts[1].getValue()).toBe("");
		expect(named(locked, "Add a field (Pro)").buttons[0].disabled).toBe(true);
	});
});

describe("renderIntelligenceSection > what a Profile's Slots will do", () => {
	const profile = (template: string | null, slots: string[]) => ({ id: "p", name: "P", description: "", template, slots });

	it("says per Slot where the template puts it, and whether it is kept up to date", async () => {
		const TEMPLATE = "## To do\n{{ts.tasks}}\n\n## Notes\nToday: {{ts.summary}}\n";
		const withProperty = { ...emptyIntelligence(), profiles: [profile("T.md", ["tasks", "summary", "decisions", "tags"])] };
		const h = host(withProperty, true, { templates: { "T.md": TEMPLATE } });
		const settings = section(h);
		await flush();
		expect(named(settings, "Fills Tasks").desc).toBe('Under "To do", kept up to date.');
		expect(named(settings, "Fills Summary").desc).toContain("Filled once");
		expect(named(settings, "Fills Decisions").desc).toBe('Not in the template: it gets a "Decisions" heading at the end.');
		expect(named(settings, "Fills Tags").desc).toBe("Frontmatter: tags.");
		const builtIn = section(host({ ...emptyIntelligence(), profiles: [profile(null, ["tasks"])] }, true));
		await flush();
		expect(named(builtIn, "Fills Tasks").desc).toBe("Its own heading in the built-in template.");
	});

	it("warns about many Slots on a local model, and not on a cloud one", () => {
		const many = { ...emptyIntelligence(), profiles: [profile(null, ["a", "b", "c", "d", "e", "f", "g", "h"])] };
		const notes = (settings: IntelligenceSettings) => {
			const el = new FakeEl();
			renderIntelligenceSection(el as unknown as HTMLElement, host(settings, true));
			return el.allText().filter((text) => text.includes("slots on a local model"));
		};
		expect(notes({ ...many, backend: "sectionlocal" })).toEqual(["8 slots on a local model: expect some items to be missed. 7 or fewer read best."]);
		expect(notes({ ...many, backend: "sectioncloud" })).toEqual([]);
		expect(notes(many)).toEqual([]);
	});
});
