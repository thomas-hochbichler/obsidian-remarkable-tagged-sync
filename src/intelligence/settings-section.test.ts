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

function host(initial: IntelligenceSettings, pro: boolean, options: { device?: string | null; confirm?: boolean } = {}) {
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

	it("switches the transcript note, picks a Profile, and says what transcript off means", async () => {
		const h = host({ ...setIntelligenceMode(emptyIntelligence(), "work", true, new Date()), profiles: [{ id: "p", name: "Meetings", description: "", template: null, slots: [] }] }, true);
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
