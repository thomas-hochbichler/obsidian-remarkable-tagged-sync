import { describe, expect, it } from "vitest";
import { FakeEl, takeSettings, type Setting as FakeSetting } from "../../test-stubs/fake-obsidian";
import { registerExtractionBackend } from "./extraction-registry";
import { type IntelligenceSettingsHost, renderIntelligenceSection, renderProfileEditor, renderSlotEditor, renderTagModes, tagModesSummary, uniqueName } from "./settings-section";
import { emptyIntelligence, setIntelligenceMode, TASKS_FORMAT, type IntelligenceSettings } from "./settings";

registerExtractionBackend({ id: "sectioncloud", label: "Section cloud", metered: true, requiresLicence: true, measured: true, create: () => null });
registerExtractionBackend({ id: "sectionlocal", label: "Section local", metered: false, requiresLicence: false, measured: false, create: () => null });
// A server that reports reasoning for the model "thinker", and for its own default when none is typed,
// and that has no model "typo".
registerExtractionBackend({
	id: "sectionserver",
	label: "Section server",
	metered: false,
	requiresLicence: false,
	measured: false,
	create: () => null,
	modelNote: async (settings, model) => {
		const used = model ?? String(settings.model);
		if (used === "typo") return { kind: "missing", model: used, suggestion: "pub/typo-1" };
		return used === "thinker" ? { kind: "reasons", model: used } : null;
	},
});

const MAP = { work: "Work", home: "Home" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(initial: IntelligenceSettings, pro: boolean, options: { device?: string | null; confirm?: boolean; templates?: Record<string, string>; transcription?: string; providers?: Record<string, Record<string, unknown>> } = {}) {
	let settings = initial;
	let device = options.device ?? null;
	const log: string[] = [];
	const dialogs: { title: string; draw: (containerEl: HTMLElement) => void }[] = [];
	const h: IntelligenceSettingsHost & { log: string[]; dialogs: typeof dialogs } = {
		log,
		dialogs,
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
		transcriptionBackend: () => options.transcription ?? "vision",
		providerSettings: (id) => options.providers?.[id] ?? {},
		dialog: (title, draw) => void dialogs.push({ title, draw }),
	};
	return h;
}

const named = (settings: FakeSetting[], name: string) => settings.find((s) => s.name === name)!;

function section(h: IntelligenceSettingsHost): FakeSetting[] {
	takeSettings();
	renderIntelligenceSection(new FakeEl() as unknown as HTMLElement, h);
	return takeSettings();
}

/** The rows a draw function makes. */
function drawn(draw: (containerEl: HTMLElement) => void): FakeSetting[] {
	takeSettings();
	draw(new FakeEl() as unknown as HTMLElement);
	return takeSettings();
}

/** A Profile's dialog, as it stands now. */
const profileEditor = (h: IntelligenceSettingsHost, id: string) => drawn((el) => renderProfileEditor(el, h, id));
/** A Slot's dialog, as it stands now. */
const slotEditor = (h: IntelligenceSettingsHost, id: string) => drawn((el) => renderSlotEditor(el, h, id));
/** The last dialog opened, drawn as it stands now. */
const lastDialog = (h: { dialogs: { draw: (containerEl: HTMLElement) => void }[] }) => drawn(h.dialogs.at(-1)!.draw);

describe("renderTagModes", () => {
	const rows = (h: IntelligenceSettingsHost, tag: string) => drawn((el) => renderTagModes(el, tag, h));
	const pageNotes = (h: IntelligenceSettingsHost, tag: string) => rows(h, tag).find((s) => s.name.startsWith("Insight notes"))!;

	it("switches Intelligence Mode on with its stamps and claims this device when no device runs the engine", async () => {
		const h = host(emptyIntelligence(), false);
		pageNotes(h, "work").toggles[0].toggle(true);
		await flush();
		expect(h.settings().mappings.work).toMatchObject({ intelligence: true, enabledAt: "2026-09-28T10:00:00.000Z", firstEnabledAt: "2026-09-28T10:00:00.000Z" });
		expect(h.settings().engineDeviceId).toBe("this-device");
		pageNotes(h, "work").toggles[0].toggle(false);
		await flush();
		expect(h.settings().engineDeviceId).toBe("this-device");
	});

	it("leaves the engine where it runs when a second tag is switched on", async () => {
		const h = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true);
		pageNotes(h, "home").toggles[0].toggle(true);
		await flush();
		expect(h.settings().engineDeviceId).toBe("other");
	});

	it("locks insight notes on a second tag without Pro, and not with it", () => {
		const on = setIntelligenceMode(emptyIntelligence(), "work", true, new Date("2026-09-01T00:00:00.000Z"));
		const locked = pageNotes(host(on, false), "home");
		expect(locked.name).toBe("Insight notes (Pro)");
		expect(locked.desc).toBe("Insight notes on more than one tag.");
		expect(locked.toggles[0].disabled).toBe(true);
		expect(pageNotes(host(on, true), "home").toggles[0].disabled).toBe(false);
		expect(pageNotes(host(on, false), "work").toggles[0].disabled).toBe(false);
	});

	it("switches the transcript note, picks a Profile without Pro, and says what transcript off means", async () => {
		const h = host({ ...setIntelligenceMode(emptyIntelligence(), "work", true, new Date()), profiles: [{ id: "p", name: "Meetings", description: "", template: null, slots: [] }] }, false);
		const r = rows(h, "work");
		// Each control on a row of its own, named: a tooltip is all the two switches had, and a phone shows none.
		expect(r.map((s) => s.name)).toEqual(["Transcript note", "Insight notes", "Profile"]);
		named(r, "Transcript note").toggles[0].toggle(false);
		await flush();
		named(r, "Profile").dropdowns[0].pick("p");
		await flush();
		expect(h.settings().mappings.work).toMatchObject({ transcript: false, profiles: ["p"] });
		expect(pageNotes(h, "work").desc).toContain("Transcript off");
		named(rows(h, "work"), "Profile").dropdowns[0].pick("");
		await flush();
		expect(h.settings().mappings.work.profiles).toEqual([]);
		// No Profile while insight notes are off.
		expect(rows(host(emptyIntelligence(), false), "work").map((s) => s.name)).toEqual(["Transcript note", "Insight notes"]);
	});

	it("offers several Profiles per tag with Pro: added from a list, removed one by one", async () => {
		const profiles = [
			{ id: "m", name: "Meetings", description: "", template: null, slots: [] },
			{ id: "j", name: "Journal", description: "", template: null, slots: [] },
		];
		const h = host({ ...setIntelligenceMode(emptyIntelligence(), "work", true, new Date()), profiles }, true);
		const row = () => named(rows(h, "work"), "Profiles");
		expect(Object.values(row().dropdowns[0].options)).toEqual(["Generic; add a profile…", "Meetings", "Journal"]);
		row().dropdowns[0].pick("m");
		await flush();
		row().dropdowns[0].pick("");
		row().dropdowns[0].pick("j");
		await flush();
		expect(h.settings().mappings.work.profiles).toEqual(["m", "j"]);
		const full = row();
		expect(full.buttons.map((b) => b.text)).toEqual(["Meetings ×", "Journal ×"]);
		expect(full.dropdowns).toHaveLength(0);
		full.buttons[0].click();
		await flush();
		expect(h.settings().mappings.work.profiles).toEqual(["j"]);
		expect(Object.values(row().dropdowns[0].options)[0]).toBe("Add a profile…");
		h.update({ ...h.settings(), mappings: { work: { ...h.settings().mappings.work, profiles: ["gone"] } } });
		expect(row().buttons[0].text).toBe("gone ×");
	});

	it("sums up what a tag makes in a few words, for its line in the list", () => {
		const profiles = [{ id: "m", name: "Meetings", description: "", template: null, slots: [] }];
		const on = setIntelligenceMode(emptyIntelligence(), "work", true, new Date());
		expect(tagModesSummary("work", host(emptyIntelligence(), false))).toBe("Transcript note");
		expect(tagModesSummary("work", host(on, false))).toBe("Transcript note · Insight notes: Generic");
		const picked = { ...on, profiles, mappings: { work: { ...on.mappings.work, transcript: false, profiles: ["m", "gone"] } } };
		expect(tagModesSummary("work", host(picked, true))).toBe("Insight notes: Meetings, gone");
		expect(tagModesSummary("work", host({ ...on, mappings: { work: { ...on.mappings.work, transcript: false, intelligence: false } } }, true))).toBe("Writes nothing");
	});
});

describe("renderIntelligenceSection", () => {
	it("shows the switch on for the engine device without saving or redrawing, so the tab does not redraw itself forever", async () => {
		const here = host({ ...emptyIntelligence(), engineDeviceId: "this-device" }, true, { device: "this-device" });
		const toggle = named(section(here), "Run page extraction on this device").toggles[0];
		await flush();
		await flush();
		expect(toggle.getValue()).toBe(true);
		expect(here.log).toEqual([]);
	});

	it("shows the device switch as this device's state, and moves the engine here only after asking", async () => {
		const elsewhere = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true, { device: "this-device" });
		const settings = section(elsewhere);
		await flush();
		const device = named(settings, "Run page extraction on this device").toggles[0];
		expect(device.getValue()).toBe(false);
		device.toggle(true);
		await flush();
		expect(elsewhere.settings().engineDeviceId).toBe("other");

		// The switch as it stands once the tab has read this device's id, which is when a user can click it.
		// Wrapped: a component is a thenable, and an async function returning one never settles.
		const shown = async (h: IntelligenceSettingsHost) => {
			const toggle = named(section(h), "Run page extraction on this device").toggles[0];
			await flush();
			return { toggle };
		};
		const agreed = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true, { device: "this-device", confirm: true });
		(await shown(agreed)).toggle.toggle(true);
		await flush();
		expect(agreed.settings().engineDeviceId).toBe("this-device");
		(await shown(agreed)).toggle.toggle(false);
		await flush();
		expect(agreed.settings().engineDeviceId).toBeNull();

		const unclaimed = host(emptyIntelligence(), true);
		(await shown(unclaimed)).toggle.toggle(true);
		await flush();
		expect(unclaimed.settings().engineDeviceId).toBe("this-device");
		const keep = host({ ...emptyIntelligence(), engineDeviceId: "other" }, true, { device: "this-device" });
		(await shown(keep)).toggle.toggle(false);
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

	it("warns under the extraction model when its server says it reasons or has no such model, and takes the warning back when another is typed", async () => {
		const BASE = "Leave it empty to use the model set for this provider under Transcription.";
		// The warning is its own line, in the warning colour, under the description.
		const warning = (row: FakeSetting) => row.descEl.children.find((child) => child.classes.has("tagged-sync-verdict"))!;
		const h = host({ ...emptyIntelligence(), backend: "sectionserver", model: "thinker" }, true);
		const row = named(section(h), "Extraction model");
		await flush();
		expect(row.desc).toBe(BASE);
		expect(warning(row).text).toBe(`⚠ "thinker" reasons before answering — expect insight notes to take several times longer. A model that doesn't reason (often the "-instruct" build) is faster.`);
		expect(warning(row).classes.has("mod-warning")).toBe(true);
		row.texts[0].type("instruct");
		await flush();
		expect(warning(row).text).toBe("");
		// A name the server does not have: every page would fail, so that is said first, with the name that fits.
		row.texts[0].type("typo");
		await flush();
		expect(warning(row).text).toBe('⚠ The server has no model "typo". Did you mean "pub/typo-1"?');

		// No backend picked: the transcription backend extracts, with the model set for it there.
		const same = named(section(host(emptyIntelligence(), true, { transcription: "sectionserver", providers: { sectionserver: { model: "thinker" } } })), "Extraction model");
		await flush();
		expect(warning(same).text).toContain('"thinker" reasons before answering');

		// A backend that cannot be asked, and one that is not registered at all, say nothing.
		for (const backend of ["sectioncloud", "gone"]) {
			const quiet = named(section(host({ ...emptyIntelligence(), backend, model: "thinker" }, true)), "Extraction model");
			await flush();
			expect(warning(quiet).text).toBe("");
		}
	});

	it("asks for consent to extract in automatic syncs, per kind of backend", async () => {
		const h = host(emptyIntelligence(), true);
		named(section(h), "Extract in automatic syncs with a paid backend").toggles[0].toggle(true);
		named(section(h), "Extract in automatic syncs with the local model").toggles[0].toggle(true);
		await flush();
		expect([h.settings().autoExtractMetered, h.settings().autoExtractLocal]).toEqual([true, true]);
	});

	it("sets how slashed dates are written, following Obsidian's language until told otherwise", async () => {
		const h = host(emptyIntelligence(), true);
		const row = named(section(h), "Dates with slashes");
		expect(row.dropdowns[0].value).toBe("auto");
		row.dropdowns[0].pick("mdy");
		await flush();
		expect(h.settings().dateOrder).toBe("mdy");
	});

	it("adds one Profile without Pro and more with it, each with a name of its own, and opens it", async () => {
		const h = host(setIntelligenceMode(emptyIntelligence(), "work", true, new Date()), false);
		named(section(h), "Add a profile").buttons[0].click();
		await flush();
		expect(h.settings().profiles).toEqual([{ id: "01234567", name: "My pages", description: "Handwritten notes", template: null, slots: ["tasks", "summary"] }]);
		expect(h.dialogs.map((d) => d.title)).toEqual(["Edit profile"]);
		expect(lastDialog(h).map((s) => s.name)).toContain("Name");
		expect(named(section(h), "Add a profile (Pro)").buttons[0].disabled).toBe(true);

		const pro = host(emptyIntelligence(), true);
		let n = 0;
		pro.randomId = () => `id${n++}-padding`;
		for (let i = 0; i < 3; i++) {
			named(section(pro), "Add a profile").buttons[0].click();
			await flush();
		}
		expect(pro.settings().profiles.map((p) => p.name)).toEqual(["My pages", "My pages 2", "My pages 3"]);
		expect(uniqueName("A", [])).toBe("A");
	});

	it("lists a Profile on one line: its Slots, its template and the tags that use it", () => {
		const on = setIntelligenceMode(emptyIntelligence(), "work", true, new Date());
		const profiles = [
			{ id: "m", name: "Meetings", description: "", template: "T/M.md", slots: ["tasks", "decisions", "gone"] },
			{ id: "j", name: "Journal", description: "", template: null, slots: [] },
		];
		const settings = section(host({ ...on, profiles, mappings: { work: { ...on.mappings.work, profiles: ["m"] }, home: { ...on.mappings.work, intelligence: false, profiles: ["m"] } } }, true));
		expect(named(settings, "Meetings").desc).toBe("Tasks, Decisions · T/M.md · Used by work");
		expect(named(settings, "Journal").desc).toBe("Fills nothing · Built-in template · No tag uses it");
		expect(named(settings, "Meetings").buttons.map((b) => [b.icon, b.tooltip])).toEqual([
			["pencil", "Edit"],
			["copy", "Duplicate"],
			["trash", "Delete"],
		]);
	});

	it("opens, duplicates under a name of its own, and deletes a Profile only once asked", async () => {
		const on = setIntelligenceMode(emptyIntelligence(), "work", true, new Date());
		const h = host({ ...on, profiles: [{ id: "a", name: "A", description: "D", template: null, slots: ["tasks"] }], mappings: { work: { ...on.mappings.work, profiles: ["a"] } } }, true);
		named(section(h), "A").buttons[0].click();
		expect(h.dialogs.map((d) => d.title)).toEqual(["Edit profile"]);
		// Typed in the dialog, which saves without redrawing the list: the copy is of what was typed.
		named(lastDialog(h), "Name").texts[0].type("Typed");
		named(section(h), "Typed").buttons[1].click();
		await flush();
		expect(h.settings().profiles.map((p) => [p.name, p.description, p.slots])).toEqual([
			["Typed", "D", ["tasks"]],
			["Typed copy", "D", ["tasks"]],
		]);
		expect(h.settings().profiles[1].id).not.toBe("a");
		expect(named(section(host({ ...emptyIntelligence(), profiles: h.settings().profiles }, false)), "Typed").buttons[1].disabled).toBe(true);

		named(section(h), "Typed").buttons[2].click();
		await flush();
		expect(h.settings().profiles).toHaveLength(2);
		const yes = host(h.settings(), true, { confirm: true });
		named(section(yes), "Typed").buttons[2].click();
		await flush();
		expect(yes.settings().profiles.map((p) => p.name)).toEqual(["Typed copy"]);
		expect(yes.settings().mappings.work.profiles).toEqual([]);
		// The dialog of a Profile that is gone draws nothing.
		expect(profileEditor(yes, "a")).toEqual([]);
	});

	it("edits a Profile in its dialog, and creates its template", async () => {
		const h = host({ ...emptyIntelligence(), profiles: [{ id: "a", name: "My pages", description: "", template: null, slots: ["tasks", "summary"] }] }, false);
		let editor = profileEditor(h, "a");
		named(editor, "Name").texts[0].type("Journal");
		named(editor, "Description").texts[0].type("Diary pages");
		named(editor, "Template").texts[0].type(" T/J.md ");
		await flush();
		expect(h.settings().profiles[0]).toMatchObject({ name: "Journal", description: "Diary pages", template: "T/J.md" });
		named(editor, "Template").texts[0].type("");
		await flush();
		expect(h.settings().profiles[0].template).toBeNull();
		named(editor, "Dates on these pages").texts[0].type("Each entry starts with its date.");
		await flush();
		expect(h.settings().profiles[0].dates).toBe("Each entry starts with its date.");
		named(editor, "Dates on these pages").texts[0].type("  ");
		await flush();
		expect(h.settings().profiles[0]).not.toHaveProperty("dates", expect.anything());

		named(profileEditor(h, "a"), "Template").buttons[0].click();
		await flush();
		expect(h.log).toContain("create Templates/Journal.md:## Tasks");
		expect(h.settings().profiles[0].template).toBe("Templates/Journal.md");

		editor = profileEditor(h, "a");
		expect(named(editor, "Decisions (Pro)").toggles[0].disabled).toBe(true);
		named(editor, "Summary").toggles[0].toggle(false);
		await flush();
		expect(h.settings().profiles[0].slots).toEqual(["tasks"]);
		named(profileEditor(h, "a"), "Summary").toggles[0].toggle(true);
		await flush();
		expect(h.settings().profiles[0].slots).toEqual(["tasks", "summary"]);
		// A Slot's pencil opens that Slot's dialog, so it need not be looked for further down.
		named(profileEditor(h, "a"), "Summary").buttons[0].click();
		expect(h.dialogs.at(-1)!.title).toBe("Edit slot");
		expect(lastDialog(h)[0].name).toBe("Summary");

		// With two Profiles, an edit to one leaves the other as it was.
		const two = host({ ...emptyIntelligence(), profiles: [{ id: "a", name: "A", description: "", template: null, slots: [] }, { id: "b", name: "B", description: "", template: null, slots: [] }] }, true);
		named(profileEditor(two, "a"), "Name").texts[0].type("A2");
		named(profileEditor(two, "a"), "Tasks").toggles[0].toggle(true);
		await flush();
		expect(two.settings().profiles.map((p) => [p.name, p.slots])).toEqual([
			["A2", ["tasks"]],
			["B", []],
		]);

		const root = host({ ...emptyIntelligence(), profiles: [{ id: "a", name: "My pages", description: "", template: null, slots: [] }] }, true);
		root.templateFolder = async () => "";
		named(profileEditor(root, "a"), "Template").buttons[0].click();
		await flush();
		expect(root.settings().profiles[0].template).toBe("My pages.md");
	});

	it("keeps what was just typed when a toggle, a preset or a button of the same dialog follows", async () => {
		const h = host({ ...emptyIntelligence(), profiles: [{ id: "a", name: "A", description: "", template: null, slots: ["tasks"] }] }, true);
		let editor = profileEditor(h, "a");
		named(editor, "Name").texts[0].type("Journal");
		named(editor, "Template").texts[0].type("T/J.md");
		named(editor, "Summary").toggles[0].toggle(true);
		await flush();
		expect(h.settings().profiles[0]).toMatchObject({ name: "Journal", template: "T/J.md", slots: ["tasks", "summary"] });

		editor = profileEditor(h, "a");
		named(editor, "Name").texts[0].type("Diary");
		named(editor, "Template").buttons[0].click();
		await flush();
		expect(h.log).toContain("create Templates/Diary.md:## Tasks");
		expect(h.settings().profiles[0]).toMatchObject({ name: "Diary", template: "Templates/Diary.md" });

		editor = slotEditor(h, "tasks");
		named(editor, "Tasks").texts[0].type("Only mine");
		named(editor, "Review new and dropped tasks").toggles[0].toggle(false);
		named(editor, "Item format").dropdowns[0].pick("Dataview");
		await flush();
		expect(h.settings().slots[0]).toMatchObject({ instruction: "Only mine", review: false, itemFormat: "- [ ] {{text}} [due:: {{due}}]" });

		editor = slotEditor(h, "decisions");
		named(editor, "Decisions").texts[0].type("As written");
		named(editor, "Shape").dropdowns[0].pick("checklist");
		await flush();
		expect(h.settings().slots[1]).toMatchObject({ shape: "checklist", instruction: "As written" });
		named(slotEditor(h, "decisions"), "Decisions").texts[0].type("Typed, then copied");
		named(section(h), "Decisions").buttons[1].click();
		await flush();
		expect(h.settings().slots.at(-1)).toMatchObject({ id: "decisions-copy", instruction: "Typed, then copied" });
	});

	it("edits a Slot's instruction, and keeps review and item format Pro, with presets and no format without {{text}}", async () => {
		const free = host(emptyIntelligence(), false);
		let editor = slotEditor(free, "tasks");
		named(editor, "Tasks").texts[0].type("Only my own tasks");
		await flush();
		expect(free.settings().slots[0].instruction).toBe("Only my own tasks");
		expect(named(editor, "Review new and dropped tasks (Pro)").toggles[0]).toMatchObject({ disabled: true });
		expect(named(editor, "Review new and dropped tasks (Pro)").toggles[0].getValue()).toBe(true);
		expect(named(editor, "Item format (Pro)").desc).toBe(TASKS_FORMAT);
		expect(named(slotEditor(free, "decisions"), "Decisions (Pro)").texts[0].disabled).toBe(true);

		const pro = host({ ...emptyIntelligence(), profiles: [{ id: "a", name: "A", description: "", template: null, slots: ["tasks"] }, { id: "b", name: "B", description: "", template: null, slots: ["tasks"] }] }, true);
		const el = new FakeEl();
		renderSlotEditor(el as unknown as HTMLElement, pro, "tasks");
		// Said first in the dialog, where it is read before anything is changed.
		expect(el.allText()[0]).toBe("Used by A, B: an edit here changes all of them.");
		named(slotEditor(pro, "tasks"), "Review new and dropped tasks").toggles[0].toggle(false);
		await flush();
		expect(pro.settings().slots[0].review).toBe(false);
		named(slotEditor(pro, "tasks"), "Item format").dropdowns[0].pick("Dataview");
		await flush();
		expect(pro.settings().slots[0].itemFormat).toBe("- [ ] {{text}} [due:: {{due}}]");
		editor = slotEditor(pro, "tasks");
		named(editor, "Item format").dropdowns[0].pick("");
		named(editor, "Item format").texts[0].type("- {{txt}}");
		await flush();
		expect(pro.settings().slots[0].itemFormat).toBe("- [ ] {{text}} [due:: {{due}}]");
		named(editor, "Item format").texts[0].type("- {{text}} #todo");
		await flush();
		expect(pro.settings().slots[0].itemFormat).toBe("- {{text}} #todo");
	});
});

describe("renderIntelligenceSection > own Slots (Pro)", () => {
	it("adds a Slot with a name and a Shape and opens it, and not without a name or without Pro", async () => {
		const h = host(emptyIntelligence(), true);
		let settings = section(h);
		const add = named(settings, "Add a slot");
		add.buttons[0].click();
		await flush();
		expect(h.settings().slots).toHaveLength(4);
		expect(h.dialogs).toEqual([]);
		add.texts[0].type("Ausgaben");
		add.dropdowns[0].pick("value");
		add.buttons[0].click();
		await flush();
		expect(h.settings().slots.at(-1)).toMatchObject({ id: "ausgaben", name: "Ausgaben", shape: "value", itemFormat: "", review: false });
		expect(h.dialogs.map((d) => d.title)).toEqual(["Edit slot"]);
		expect(lastDialog(h)[0].name).toBe("Ausgaben");
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

	it("lists a Slot on one line: its Shape, the Profiles that fill it, and whether it is reviewed", () => {
		const profiles = [
			{ id: "a", name: "A", description: "", template: null, slots: ["tasks", "summary"] },
			{ id: "b", name: "B", description: "", template: null, slots: ["tasks"] },
		];
		const settings = section(host({ ...emptyIntelligence(), profiles }, true));
		expect(named(settings, "Tasks").desc).toBe("Checklist · In A, B · Reviewed");
		expect(named(settings, "Summary").desc).toBe("Text · In A");
		expect(named(settings, "Decisions").desc).toBe("List · In no profile · Reviewed");
		const unreviewed = { ...emptyIntelligence(), slots: emptyIntelligence().slots.map((slot) => ({ ...slot, review: false })) };
		expect(named(section(host(unreviewed, true)), "Decisions").desc).toBe("List · In no profile");
		// Without Pro, review is always on (spec §11).
		expect(named(section(host(unreviewed, false)), "Decisions (Pro)").desc).toBe("List · In no profile · Reviewed");
	});

	it("duplicates under a name of its own, and deletes a Slot only once asked, taking it out of every Profile", async () => {
		const h = host({ ...emptyIntelligence(), profiles: [{ id: "p", name: "P", description: "", template: null, slots: ["tasks", "summary"] }] }, true, { confirm: true });
		const tasks = () => named(section(h), "Tasks");
		expect(tasks().buttons.map((b) => b.icon)).toEqual(["pencil", "copy", "trash"]);
		tasks().buttons[0].click();
		expect(h.dialogs.map((d) => d.title)).toEqual(["Edit slot"]);
		tasks().buttons[1].click();
		tasks().buttons[1].click();
		await flush();
		expect(h.settings().slots.slice(-2)).toMatchObject([
			{ id: "tasks-copy", name: "Tasks copy", used: false, shape: "checklist" },
			{ id: "tasks-copy-2", name: "Tasks copy 2" },
		]);
		const refused = host(h.settings(), true);
		named(section(refused), "Tasks").buttons[2].click();
		await flush();
		expect(refused.settings().slots.map((s) => s.id)).toContain("tasks");
		tasks().buttons[2].click();
		await flush();
		expect(h.settings().slots.map((s) => s.id)).not.toContain("tasks");
		expect(h.settings().profiles[0].slots).toEqual(["summary"]);
		expect(slotEditor(h, "tasks")).toEqual([]);
		const free = named(section(host(emptyIntelligence(), false)), "Tasks");
		expect(free.buttons.map((b) => [b.tooltip, b.disabled])).toEqual([
			["Edit", false],
			["Duplicate (Pro)", true],
			["Delete (Pro)", true],
		]);
	});

	it("changes a Shape until the Slot is used in a note, then keeps it fixed", async () => {
		const h = host(emptyIntelligence(), true);
		named(slotEditor(h, "decisions"), "Shape").dropdowns[0].pick("checklist");
		await flush();
		expect(h.settings().slots[1]).toMatchObject({ id: "decisions", shape: "checklist", instruction: "Decisions that were made, as written." });
		h.update({ ...h.settings(), slots: h.settings().slots.map((s) => (s.id === "tasks" ? { ...s, used: true } : s)) });
		const fixed = named(slotEditor(h, "tasks"), "Shape (fixed: duplicate to change it)");
		expect(fixed.dropdowns[0].disabled).toBe(true);
	});

	it("edits examples and counter-examples", async () => {
		const empty = emptyIntelligence();
		// The default Tasks Slot ships with two examples; this starts from none.
		const h = host({ ...empty, slots: empty.slots.map((slot, index) => (index === 0 ? { ...slot, examples: [] } : slot)) }, true);
		named(slotEditor(h, "tasks"), "Add an example").buttons[0].click();
		named(slotEditor(h, "tasks"), "Add an example").buttons[1].click();
		await flush();
		let settings = slotEditor(h, "tasks");
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
		settings = slotEditor(h, "tasks");
		named(settings, "Example").buttons[0].click();
		await flush();
		expect(h.settings().slots[0].examples).toEqual([{ input: "Bob will call", output: "", positive: false }]);
	});

	it("points a Value at a frontmatter property, or back into the body", async () => {
		const h = host(emptyIntelligence(), true);
		const property = named(slotEditor(h, "tags"), "Frontmatter property");
		expect(property.texts[0].getValue()).toBe("tags");
		property.texts[0].type(" ");
		await flush();
		expect(h.settings().slots[3].property).toBeUndefined();
		property.texts[0].type(" project ");
		await flush();
		expect(h.settings().slots[3].property).toBe("project");
		expect(named(slotEditor(host(emptyIntelligence(), false), "tags"), "Frontmatter property (Pro)").texts[0].disabled).toBe(true);
	});

	it("adds up to five fields, types them, gives a choice its options, and removes them", async () => {
		const h = host({ ...emptyIntelligence(), slots: [{ id: "x", name: "X", shape: "list", instruction: "", examples: [], fields: [], itemFormat: "- {{text}}", review: false }] }, true);
		for (let n = 0; n < 5; n++) {
			named(slotEditor(h, "x"), "Add a field").buttons[0].click();
			await flush();
		}
		expect(h.settings().slots[0].fields.map((f) => f.name)).toEqual(["field1", "field2", "field3", "field4", "field5"]);
		let settings = slotEditor(h, "x");
		expect(settings.some((s) => s.name === "Add a field")).toBe(false);
		const first = named(settings, "Field field1");
		first.texts[0].type(" owner ");
		first.dropdowns[0].pick("choice");
		await flush();
		settings = slotEditor(h, "x");
		named(settings, "Field owner").texts[1].type("Anna, Bob, ,Carl");
		await flush();
		expect(h.settings().slots[0].fields[0]).toEqual({ name: "owner", type: "choice", options: ["Anna", "Bob", "Carl"] });
		named(slotEditor(h, "x"), "Field owner").buttons[0].click();
		await flush();
		expect(h.settings().slots[0].fields).toHaveLength(4);
		const free = host({ ...emptyIntelligence(), slots: [{ ...h.settings().slots[0], fields: [{ name: "c", type: "choice" }] }] }, false);
		const locked = slotEditor(free, "x");
		expect(named(locked, "Field c (Pro)").texts[1].getValue()).toBe("");
		expect(named(locked, "Add a field (Pro)").buttons[0].disabled).toBe(true);
	});
});

describe("renderProfileEditor > what a Profile's Slots will do", () => {
	const profile = (template: string | null, slots: string[]) => ({ id: "p", name: "P", description: "", template, slots });

	it("says per Slot where the template puts it, and whether it is kept up to date", async () => {
		const TEMPLATE = "## To do\n{{ts.tasks}}\n\n## Notes\nToday: {{ts.summary}}\n";
		const withProperty = { ...emptyIntelligence(), profiles: [profile("T.md", ["tasks", "summary", "decisions", "tags"])] };
		const h = host(withProperty, true, { templates: { "T.md": TEMPLATE } });
		const settings = profileEditor(h, "p");
		await flush();
		expect(named(settings, "Tasks").desc).toBe('Under "To do", kept up to date.');
		expect(named(settings, "Summary").desc).toContain("Filled once");
		expect(named(settings, "Decisions").desc).toBe('Not in the template: it gets a "Decisions" heading at the end.');
		expect(named(settings, "Tags").desc).toBe("Frontmatter: tags.");
		const builtIn = profileEditor(host({ ...emptyIntelligence(), profiles: [profile(null, ["tasks"])] }, true), "p");
		await flush();
		expect(named(builtIn, "Tasks").desc).toBe("Its own heading in the built-in template.");
	});

	it("warns about many Slots on a local model, and not on a cloud one", () => {
		const many = { ...emptyIntelligence(), profiles: [profile(null, ["a", "b", "c", "d", "e", "f", "g", "h"])] };
		const notes = (settings: IntelligenceSettings) => {
			const el = new FakeEl();
			renderProfileEditor(el as unknown as HTMLElement, host(settings, true), "p");
			return el.allText().filter((text) => text.includes("slots on a local model"));
		};
		expect(notes({ ...many, backend: "sectionlocal" })).toEqual(["8 slots on a local model: expect some items to be missed. 7 or fewer read best."]);
		expect(notes({ ...many, backend: "sectioncloud" })).toEqual([]);
		expect(notes(many)).toEqual([]);
	});
});
