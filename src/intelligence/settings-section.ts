/**
 * The Intelligence Engine's settings (spec §10): per tag mapping, the two modes and the Profile; then
 * the Intelligence section -- device switch, extraction backend, Profiles and Slots. Free vaults see
 * every Pro control, disabled and marked "(Pro)": a feature nobody can see is one nobody decides to buy.
 */

import { Setting } from "obsidian";
import { extractionBackendEntries } from "./extraction-registry";
import { freeTag, isEngineDevice } from "./plugin-rules";
import { type FieldDef, type FieldType, genericProfile, type IntelligenceSettings, modesFor, type ProfileDef, setIntelligenceMode, type Shape, type SlotDef, slotIdFor, TASKS_FORMAT } from "./settings";
import { starterTemplate } from "./template";

export interface IntelligenceSettingsHost {
	settings(): IntelligenceSettings;
	update(next: IntelligenceSettings): void;
	tagFolderMap(): Record<string, string>;
	pro: boolean;
	/** Persists `data.json` and redraws the tab: for a change that alters what the tab shows. */
	saveAndRedraw(): Promise<void>;
	/** Persists `data.json` only: for a keystroke in a text field, which must keep its focus. */
	save(): Promise<void>;
	/** This install's device id; minted when `mint`. */
	deviceId(mint: boolean): Promise<string | null>;
	confirm(title: string, text: string, cta: string): Promise<boolean>;
	/** Where "Create template" writes: core Templates' folder, else Templater's, else the vault root. */
	templateFolder(): Promise<string>;
	/** Creates a vault note at the first free path from `path`, and returns where it went. */
	createTemplate(path: string, content: string): Promise<string>;
	now(): Date;
	randomId(): string;
}

const PRO = " (Pro)";
const FREE_SLOTS = new Set(["tasks", "summary"]);
const ITEM_FORMAT_PRESETS: Record<string, string> = { Tasks: TASKS_FORMAT, Dataview: "- [ ] {{text}} [due:: {{due}}]", Plain: "- [ ] {{text}}" };

async function withSettings(host: IntelligenceSettingsHost, change: (settings: IntelligenceSettings) => IntelligenceSettings): Promise<void> {
	host.update(change(host.settings()));
	await host.saveAndRedraw();
}

/** For text fields: saved as typed, drawn again only when the tab is next opened. */
async function typed(host: IntelligenceSettingsHost, change: (settings: IntelligenceSettings) => IntelligenceSettings): Promise<void> {
	host.update(change(host.settings()));
	await host.save();
}

/** The first device to switch Intelligence Mode on runs the engine (spec §9). */
async function claimIfUnclaimed(host: IntelligenceSettingsHost): Promise<void> {
	if (host.settings().engineDeviceId !== null) return;
	const id = await host.deviceId(true);
	host.update({ ...host.settings(), engineDeviceId: id });
}

/** The two modes and the Profile of one mapped tag, on its row in Tag routing. */
export function renderTagModes(row: Setting, tag: string, host: IntelligenceSettingsHost): void {
	const settings = host.settings();
	const modes = modesFor(settings, host.tagFolderMap(), tag);
	const free = freeTag(settings, host.tagFolderMap());
	const locked = !host.pro && free !== null && free !== tag;
	row.addToggle((toggle) =>
		toggle
			.setTooltip("Transcript note: one note per notebook, as always")
			.setValue(modes.transcript)
			.onChange(async (on) => withSettings(host, (s) => ({ ...s, mappings: { ...s.mappings, [tag]: { ...modesFor(s, host.tagFolderMap(), tag), transcript: on } } }))),
	);
	row.addToggle((toggle) =>
		toggle
			.setTooltip(locked ? `Page notes on more than one tag${PRO}` : "Page notes: one note per page, with its tasks and a summary")
			.setValue(modes.intelligence)
			.setDisabled(locked && !modes.intelligence)
			.onChange(async (on) => {
				host.update(setIntelligenceMode(host.settings(), tag, on, host.now()));
				if (on) await claimIfUnclaimed(host);
				await host.saveAndRedraw();
			}),
	);
	// The Profile only matters, and is only offered, where page notes are on.
	if (!modes.intelligence) return;
	row.addDropdown((dropdown) => {
		dropdown.addOption("", genericProfile(host.pro).name);
		for (const profile of settings.profiles) dropdown.addOption(profile.id, profile.name);
		dropdown.setValue(modes.profiles[0] ?? "");
		dropdown.onChange(async (id) => withSettings(host, (s) => ({ ...s, mappings: { ...s.mappings, [tag]: { ...modesFor(s, host.tagFolderMap(), tag), profiles: id === "" ? [] : [id] } } })));
	});
	if (!modes.transcript && modes.intelligence) row.setDesc("Transcript off: search the full text in the reMarkable app; Obsidian holds only what the engine extracted.");
}

export function renderIntelligenceSection(containerEl: HTMLElement, host: IntelligenceSettingsHost): void {
	const settings = host.settings();
	new Setting(containerEl).setName("Intelligence").setHeading();
	containerEl.createDiv({
		cls: "tagged-sync-note",
		text: "A tag with page notes on turns every page you write from then on into its own note, from your template, with its tasks and a summary. Pages written before are left alone.",
	});

	new Setting(containerEl)
		.setName("Run page extraction on this device")
		.setDesc("Sync and transcription run on every device; extraction runs on one, so two devices never write the same page note.")
		.addToggle((toggle) => {
			void host.deviceId(false).then((id) => toggle.setValue(isEngineDevice(host.settings(), id)));
			toggle.onChange(async (on) => {
				const id = await host.deviceId(true);
				const holder = host.settings().engineDeviceId;
				if (on && holder !== null && holder !== id && !(await host.confirm("Run the engine here", "Another device extracts pages for this vault. Extract here instead? That device stops extracting.", "Run it here"))) {
					await host.saveAndRedraw();
					return;
				}
				await withSettings(host, (s) => ({ ...s, engineDeviceId: on ? id : s.engineDeviceId === id ? null : s.engineDeviceId }));
			});
		});

	new Setting(containerEl)
		.setName("Extraction backend")
		.setDesc("What reads tasks and summaries out of a page's text. Unset, the transcription backend is used when it can.")
		.addDropdown((dropdown) => {
			dropdown.addOption("", "Same as transcription");
			for (const entry of extractionBackendEntries()) {
				dropdown.addOption(entry.id, `${entry.label}${entry.requiresLicence && !host.pro ? PRO : ""}${entry.measured ? "" : " — not measured"}`);
			}
			dropdown.setValue(settings.backend ?? "");
			dropdown.onChange(async (id) => withSettings(host, (s) => ({ ...s, backend: id === "" ? null : id })));
		});
	new Setting(containerEl)
		.setName("Extraction model")
		.setDesc("Empty: the model set for that provider.")
		.addText((text) =>
			text
				.setValue(settings.model ?? "")
				.setPlaceholder("Model name")
				.onChange(async (model) => typed(host, (s) => ({ ...s, model: model.trim() === "" ? null : model.trim() }))),
		);

	// The same two questions automatic sync asks the transcription backend (spec §6), each its own row.
	new Setting(containerEl)
		.setName("Extract in automatic syncs with a paid backend")
		.setDesc("Off: an automatic sync with a paid extraction backend transcribes, and the pages wait for a sync you start.")
		.addToggle((toggle) => toggle.setValue(settings.autoExtractMetered).onChange(async (on) => withSettings(host, (s) => ({ ...s, autoExtractMetered: on }))));
	new Setting(containerEl)
		.setName("Extract in automatic syncs with the local model")
		.setDesc("Off: the local model extracts only in a sync you start, so it never runs unattended.")
		.addToggle((toggle) => toggle.setValue(settings.autoExtractLocal).onChange(async (on) => withSettings(host, (s) => ({ ...s, autoExtractLocal: on }))));

	renderProfiles(containerEl, host);
	renderSlots(containerEl, host);
}

function renderProfiles(containerEl: HTMLElement, host: IntelligenceSettingsHost): void {
	const settings = host.settings();
	new Setting(containerEl).setName("Profiles").setHeading();
	const canAdd = host.pro || settings.profiles.length === 0;
	new Setting(containerEl)
		.setName(canAdd ? "Add a profile" : `Add a profile${PRO}`)
		.setDesc("A profile is a template and the slots it fills. A tag uses the generic profile until you pick one.")
		.addButton((button) =>
			button
				.setButtonText("Add")
				.setDisabled(!canAdd)
				.onClick(async () => {
					const profile: ProfileDef = { id: host.randomId().slice(0, 8), name: "My pages", description: "Handwritten notes", template: null, slots: [...genericProfile(false).slots] };
					await withSettings(host, (s) => ({ ...s, profiles: [...s.profiles, profile] }));
				}),
		);
	for (const profile of settings.profiles) renderProfile(containerEl, host, profile);
}

function renderProfile(containerEl: HTMLElement, host: IntelligenceSettingsHost, profile: ProfileDef): void {
	const replace = (next: ProfileDef) => (s: IntelligenceSettings) => ({ ...s, profiles: s.profiles.map((p) => (p.id === profile.id ? next : p)) });
	// Text fields edit the Profile as it stands now, not as it was drawn: several keystrokes, one field each.
	const edit = (patch: Partial<ProfileDef>) => (s: IntelligenceSettings) => ({ ...s, profiles: s.profiles.map((p) => (p.id === profile.id ? { ...p, ...patch } : p)) });
	new Setting(containerEl)
		.setName(profile.name)
		.setDesc(profile.description)
		.addText((text) => text.setValue(profile.name).onChange(async (name) => typed(host, edit({ name }))))
		.addText((text) => text.setValue(profile.description).setPlaceholder("One line: what these pages are").onChange(async (description) => typed(host, edit({ description }))))
		.addButton((button) =>
			button.setButtonText("Remove").onClick(async () =>
				withSettings(host, (s) => ({
					...s,
					profiles: s.profiles.filter((p) => p.id !== profile.id),
					mappings: Object.fromEntries(Object.entries(s.mappings).map(([tag, m]) => [tag, { ...m, profiles: m.profiles.filter((id) => id !== profile.id) }])),
				})),
			),
		);
	new Setting(containerEl)
		.setName("Template")
		.setDesc("Any note. Each slot fills its own heading; a template change reaches new page notes only.")
		.addText((text) => text.setValue(profile.template ?? "").setPlaceholder("Templates/Page.md").onChange(async (path) => typed(host, edit({ template: path.trim() === "" ? null : path.trim() }))))
		.addButton((button) =>
			button.setButtonText("Create template").onClick(async () => {
				const slots = profile.slots.flatMap((id) => host.settings().slots.filter((slot) => slot.id === id));
				const folder = await host.templateFolder();
				const path = await host.createTemplate(`${folder === "" ? "" : `${folder}/`}${profile.name}.md`, starterTemplate(slots));
				await withSettings(host, replace({ ...profile, template: path }));
			}),
		);
	for (const slot of host.settings().slots) {
		const pro = !host.pro && !FREE_SLOTS.has(slot.id);
		new Setting(containerEl).setName(`Fills ${slot.name}${pro ? PRO : ""}`).addToggle((toggle) =>
			toggle
				.setValue(profile.slots.includes(slot.id))
				.setDisabled(pro)
				.onChange(async (on) => withSettings(host, replace({ ...profile, slots: on ? [...profile.slots, slot.id] : profile.slots.filter((id) => id !== slot.id) }))),
		);
	}
}

const SHAPES: Record<Shape, string> = { text: "Text", value: "Value", list: "List", checklist: "Checklist" };
const FIELD_TYPES: Record<FieldType, string> = { text: "Text", date: "Date", number: "Number", choice: "Choice", link: "Link" };
const MAX_FIELDS = 5;

function newSlot(name: string, shape: Shape, taken: readonly string[]): SlotDef {
	const list = shape === "list" || shape === "checklist";
	return { id: slotIdFor(name, taken), name, shape, instruction: "", examples: [], fields: [], itemFormat: shape === "checklist" ? "- [ ] {{text}}" : list ? "- {{text}}" : "", review: list };
}

function renderSlots(containerEl: HTMLElement, host: IntelligenceSettingsHost): void {
	new Setting(containerEl).setName("Slots").setHeading();
	let draft: { name: string; shape: Shape } = { name: "", shape: "list" };
	new Setting(containerEl)
		.setName(host.pro ? "Add a slot" : `Add a slot${PRO}`)
		.setDesc("A slot is one thing to take out of a page. Profiles share slots: an edit reaches every profile that uses it.")
		.addText((text) => text.setPlaceholder("Name").setDisabled(!host.pro).onChange((name) => void (draft = { ...draft, name })))
		.addDropdown((dropdown) => {
			for (const [shape, label] of Object.entries(SHAPES)) dropdown.addOption(shape, label);
			dropdown.setValue(draft.shape).setDisabled(!host.pro).onChange((shape) => void (draft = { ...draft, shape: shape as Shape }));
		})
		.addButton((button) =>
			button
				.setButtonText("Add")
				.setDisabled(!host.pro)
				.onClick(async () => {
					if (draft.name.trim() === "") return;
					await withSettings(host, (s) => ({ ...s, slots: [...s.slots, newSlot(draft.name.trim(), draft.shape, s.slots.map((slot) => slot.id))] }));
				}),
		);
	for (const slot of host.settings().slots) renderSlot(containerEl, host, slot);
}

function renderSlot(containerEl: HTMLElement, host: IntelligenceSettingsHost, slot: SlotDef): void {
	const replace = (next: SlotDef) => (s: IntelligenceSettings) => ({ ...s, slots: s.slots.map((candidate) => (candidate.id === slot.id ? next : candidate)) });
	const edit = (patch: Partial<SlotDef>) => (s: IntelligenceSettings) => ({ ...s, slots: s.slots.map((candidate) => (candidate.id === slot.id ? { ...candidate, ...patch } : candidate)) });
	const usedBy = host.settings().profiles.filter((profile) => profile.slots.includes(slot.id)).map((profile) => profile.name);
	const proSlot = !host.pro && !FREE_SLOTS.has(slot.id);
	new Setting(containerEl)
		.setName(`${slot.name}${proSlot ? PRO : ""}`)
		.setDesc(usedBy.length > 1 ? `Used by ${usedBy.join(", ")}: an edit here changes all of them.` : "What to extract, in your words.")
		.addTextArea((text) => text.setValue(slot.instruction).setDisabled(proSlot).onChange(async (instruction) => typed(host, edit({ instruction }))))
		.addButton((button) =>
			button
				.setButtonText("Duplicate")
				.setDisabled(!host.pro)
				.onClick(async () =>
					withSettings(host, (s) => {
						const copy = { ...slot, id: slotIdFor(`${slot.name} copy`, s.slots.map((c) => c.id)), name: `${slot.name} copy`, used: false };
						return { ...s, slots: [...s.slots, copy] };
					}),
				),
		)
		.addButton((button) =>
			button
				.setButtonText("Delete")
				.setDisabled(!host.pro)
				.onClick(async () =>
					// Notes keep the regions it filled; they are no longer updated (spec §5.3).
					withSettings(host, (s) => ({ ...s, slots: s.slots.filter((c) => c.id !== slot.id), profiles: s.profiles.map((p) => ({ ...p, slots: p.slots.filter((id) => id !== slot.id) })) })),
				),
		);
	// The Shape is what code branches on; once a note holds this slot's region, it is fixed.
	new Setting(containerEl)
		.setName(`Shape${slot.used === true ? " (fixed: duplicate to change it)" : ""}`)
		.addDropdown((dropdown) => {
			for (const [shape, label] of Object.entries(SHAPES)) dropdown.addOption(shape, label);
			dropdown
				.setValue(slot.shape)
				.setDisabled(!host.pro || slot.used === true)
				.onChange(async (shape) => withSettings(host, replace({ ...newSlot(slot.name, shape as Shape, []), id: slot.id, instruction: slot.instruction, examples: slot.examples })));
		});
	renderExamples(containerEl, host, slot, edit);
	if (slot.shape === "value") {
		new Setting(containerEl)
			.setName(`Frontmatter property${host.pro ? "" : PRO}`)
			.setDesc("Empty: under its heading in the note. Otherwise the frontmatter property of that name.")
			.addText((text) => text.setValue(slot.property ?? "").setDisabled(!host.pro).onChange(async (property) => typed(host, edit({ property: property.trim() === "" ? undefined : property.trim() }))));
	}
	if (slot.shape !== "text") renderFields(containerEl, host, slot, edit);
	if (slot.shape !== "list" && slot.shape !== "checklist") return;
	// Free locks Tasks' review on and its format to the Tasks plugin's (spec §11).
	const freeLocked = !host.pro;
	new Setting(containerEl)
		.setName(`Review new and dropped ${slot.name.toLowerCase()}${freeLocked ? PRO : ""}`)
		.addToggle((toggle) => toggle.setValue(freeLocked || slot.review).setDisabled(freeLocked).onChange(async (review) => withSettings(host, replace({ ...slot, review }))));
	new Setting(containerEl)
		.setName(`Item format${freeLocked ? PRO : ""}`)
		.setDesc(freeLocked ? TASKS_FORMAT : slot.itemFormat)
		.addDropdown((dropdown) => {
			dropdown.addOption("", "Preset…");
			for (const name of Object.keys(ITEM_FORMAT_PRESETS)) dropdown.addOption(name, name);
			dropdown.setDisabled(freeLocked);
			dropdown.onChange(async (name) => {
				if (name !== "") await withSettings(host, replace({ ...slot, itemFormat: ITEM_FORMAT_PRESETS[name] }));
			});
		})
		.addText((text) =>
			text
				.setValue(slot.itemFormat)
				.setDisabled(freeLocked)
				.onChange(async (itemFormat) => {
					// Kept unsaved while it lacks {{text}}: a half-typed format must not reach a sync.
					if (itemFormat.includes("{{text}}")) await typed(host, edit({ itemFormat }));
				}),
		);
}

type SlotEdit = (patch: Partial<SlotDef>) => (s: IntelligenceSettings) => IntelligenceSettings;

/** Examples: a line from a page and what the slot takes from it -- or, as a counter-example, nothing. */
function renderExamples(containerEl: HTMLElement, host: IntelligenceSettingsHost, slot: SlotDef, edit: SlotEdit): void {
	const current = () => host.settings().slots.find((c) => c.id === slot.id)!.examples;
	slot.examples.forEach((example, index) => {
		const patch = (next: Partial<typeof example>) => edit({ examples: current().map((e, i) => (i === index ? { ...e, ...next } : e)) });
		new Setting(containerEl)
			.setName(example.positive ? "Example" : "Counter-example")
			.addText((text) => text.setValue(example.input).setPlaceholder("From the page").onChange(async (input) => typed(host, patch({ input }))))
			.addText((text) => text.setValue(example.output).setPlaceholder("Taken out").setDisabled(!example.positive).onChange(async (output) => typed(host, patch({ output }))))
			.addButton((button) => button.setButtonText("Remove").onClick(async () => withSettings(host, edit({ examples: current().filter((_, i) => i !== index) }))));
	});
	new Setting(containerEl)
		.setName("Add an example")
		.addButton((button) => button.setButtonText("Example").onClick(async () => withSettings(host, edit({ examples: [...current(), { input: "", output: "", positive: true }] }))))
		.addButton((button) => button.setButtonText("Counter-example").onClick(async () => withSettings(host, edit({ examples: [...current(), { input: "", output: "", positive: false }] }))));
}

/** Up to five typed fields per item (Pro): what each item carries besides its text. */
function renderFields(containerEl: HTMLElement, host: IntelligenceSettingsHost, slot: SlotDef, edit: SlotEdit): void {
	const current = () => host.settings().slots.find((c) => c.id === slot.id)!.fields;
	slot.fields.forEach((field, index) => {
		const patch = (next: Partial<FieldDef>) => edit({ fields: current().map((f, i) => (i === index ? { ...f, ...next } : f)) });
		const row = new Setting(containerEl)
			.setName(`Field ${field.name}${host.pro ? "" : PRO}`)
			.addText((text) => text.setValue(field.name).setDisabled(!host.pro).onChange(async (name) => typed(host, patch({ name: name.trim() }))))
			.addDropdown((dropdown) => {
				for (const [type, label] of Object.entries(FIELD_TYPES)) dropdown.addOption(type, label);
				dropdown
					.setValue(field.type)
					.setDisabled(!host.pro)
					.onChange(async (type) => withSettings(host, patch({ type: type as FieldType })));
			});
		if (field.type === "choice") {
			row.addText((text) =>
				text
					.setValue((field.options ?? []).join(", "))
					.setPlaceholder("Options, comma-separated")
					.setDisabled(!host.pro)
					.onChange(async (options) => typed(host, patch({ options: options.split(",").map((o) => o.trim()).filter((o) => o !== "") }))),
			);
		}
		row.addButton((button) => button.setButtonText("Remove").setDisabled(!host.pro).onClick(async () => withSettings(host, edit({ fields: current().filter((_, i) => i !== index) }))));
	});
	if (slot.fields.length >= MAX_FIELDS) return;
	new Setting(containerEl).setName(`Add a field${host.pro ? "" : PRO}`).addButton((button) =>
		button
			.setButtonText("Add")
			.setDisabled(!host.pro)
			.onClick(async () => withSettings(host, edit({ fields: [...current(), { name: `field${current().length + 1}`, type: "text" }] }))),
	);
}
