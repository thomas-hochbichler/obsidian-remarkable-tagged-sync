/**
 * The Intelligence Engine's settings (spec §10): per tag mapping, the two modes and the Profile; then
 * the Page notes section -- device switch, extraction backend, Profiles and Slots. Profiles and Slots
 * are lists of one line each; each is edited in a dialog (`host.dialog`). Free vaults see
 * every Pro control, disabled and marked "(Pro)": a feature nobody can see is one nobody decides to buy.
 */

import { Setting } from "obsidian";
import type { BackendSettings } from "../ocr-registry";
import { extractionBackendEntries, extractionBackendEntry } from "./extraction-registry";
import { freeTag, isEngineDevice } from "./plugin-rules";
import { type FieldDef, type FieldType, genericProfile, type IntelligenceSettings, modesFor, type ProfileDef, setIntelligenceMode, type Shape, type SlotDef, slotIdFor, TASKS_FORMAT } from "./settings";
import { analyseTemplate, starterTemplate } from "./template";

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
	/** A template note's text, or null when there is none at that path. */
	readTemplate(path: string): Promise<string | null>;
	now(): Date;
	randomId(): string;
	/** The transcription backend's id: what extracts while no extraction backend is picked. */
	transcriptionBackend(): string;
	/** A provider's own settings: its address, key and model. */
	providerSettings(id: string): BackendSettings;
	/** Opens a dialog that `draw` fills, and fills again whenever the tab redraws. */
	dialog(title: string, draw: (containerEl: HTMLElement) => void): void;
}

const PRO = " (Pro)";
// Says what an empty field does, since an empty field is the default (asked about in the live test).
const MODEL_DESC = "Leave it empty to use the model set for this provider under Transcription.";

/**
 * Said under the extraction model when its server reports that it reasons unasked. It extracts --
 * the schema goes as a tool call, which lets it think first -- but takes 5–30 s a page where a model
 * that does not reason takes 2–4 s (five LM Studio models, 2026-10-02).
 */
function reasoningWarning(model: string): string {
	return `⚠ "${model}" reasons before answering — expect page notes to take several times longer. A model that doesn't reason (often the "-instruct" build) is faster.`;
}
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

/**
 * The two modes and the Profiles of one mapped tag, in its dialog: a row each, named. They were two
 * bare switches on the tag's line, told apart only by a tooltip -- which a phone does not show.
 */
export function renderTagModes(containerEl: HTMLElement, tag: string, host: IntelligenceSettingsHost): void {
	const settings = host.settings();
	const modes = modesFor(settings, host.tagFolderMap(), tag);
	const free = freeTag(settings, host.tagFolderMap());
	const locked = !host.pro && free !== null && free !== tag;
	new Setting(containerEl)
		.setName("Transcript note")
		.setDesc("One note per notebook, with the text of every page, as always.")
		.addToggle((toggle) =>
			toggle
				.setValue(modes.transcript)
				.onChange(async (on) => withSettings(host, (s) => ({ ...s, mappings: { ...s.mappings, [tag]: { ...modesFor(s, host.tagFolderMap(), tag), transcript: on } } }))),
		);
	new Setting(containerEl)
		.setName(locked ? `Page notes${PRO}` : "Page notes")
		.setDesc(
			!modes.transcript && modes.intelligence
				? "Transcript off: search the full text in the reMarkable app; Obsidian holds only what the engine extracted."
				: locked
					? "Page notes on more than one tag."
					: "One note per page, with its tasks and a summary.",
		)
		.addToggle((toggle) =>
			toggle
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
	const setProfiles = (profiles: string[]) => withSettings(host, (s) => ({ ...s, mappings: { ...s.mappings, [tag]: { ...modesFor(s, host.tagFolderMap(), tag), profiles } } }));
	if (!host.pro) {
		new Setting(containerEl).setName("Profile").addDropdown((dropdown) => {
			dropdown.addOption("", genericProfile(host.pro).name);
			for (const profile of settings.profiles) dropdown.addOption(profile.id, profile.name);
			dropdown.setValue(modes.profiles[0] ?? "");
			dropdown.onChange(async (id) => setProfiles(id === "" ? [] : [id]));
		});
		return;
	}
	// Pro: several Profiles per tag; with more than one, each new page is sorted by its description (spec §5.1).
	const row = new Setting(containerEl).setName("Profiles").setDesc("With more than one, each new page goes to the profile its description fits.");
	for (const id of modes.profiles) {
		const name = settings.profiles.find((profile) => profile.id === id)?.name ?? id;
		row.addButton((button) => button.setButtonText(`${name} ×`).setTooltip(`Stop offering ${name} for this tag`).onClick(async () => setProfiles(modes.profiles.filter((other) => other !== id))));
	}
	const addable = settings.profiles.filter((profile) => !modes.profiles.includes(profile.id));
	if (addable.length === 0) return;
	row.addDropdown((dropdown) => {
		dropdown.addOption("", modes.profiles.length === 0 ? `${genericProfile(host.pro).name}; add a profile…` : "Add a profile…");
		for (const profile of addable) dropdown.addOption(profile.id, profile.name);
		dropdown.setValue("");
		dropdown.onChange(async (id) => {
			if (id !== "") await setProfiles([...modes.profiles, id]);
		});
	});
}

/** What a mapped tag makes, in a few words, for its line in Tag routing. */
export function tagModesSummary(tag: string, host: IntelligenceSettingsHost): string {
	const settings = host.settings();
	const modes = modesFor(settings, host.tagFolderMap(), tag);
	const names = modes.profiles.map((id) => settings.profiles.find((profile) => profile.id === id)?.name ?? id);
	const parts = [
		...(modes.transcript ? ["Transcript note"] : []),
		...(modes.intelligence ? [`Page notes: ${names.length === 0 ? genericProfile(host.pro).name : names.join(", ")}`] : []),
	];
	return parts.length === 0 ? "Writes nothing" : parts.join(" · ");
}

export function renderIntelligenceSection(containerEl: HTMLElement, host: IntelligenceSettingsHost): void {
	const settings = host.settings();
	new Setting(containerEl).setName("Page notes").setHeading();
	containerEl.createDiv({
		cls: "tagged-sync-note",
		text: "A tag with page notes on turns every page you write from then on into its own note, from your template, with its tasks and a summary. Pages written before are left alone.",
	});

	new Setting(containerEl)
		.setName("Run page extraction on this device")
		.setDesc("Sync and transcription run on every device; extraction runs on one, so two devices never write the same page note.")
		.addToggle((toggle) => {
			// The handler goes on only once the value is set: Obsidian's `setValue` fires `onChange`, and
			// this handler redraws the tab, which set the value again -- the tab re-rendered without end
			// and every dropdown on it closed as soon as it opened (live test, 2026-09-29). `void` inside:
			// a component is a thenable (`BaseComponent.then`), see the placement hint below.
			void host.deviceId(false).then((id) => {
				toggle.setValue(isEngineDevice(host.settings(), id));
				toggle.onChange(onToggle);
			});
			const onToggle = async (on: boolean) => {
				const id = await host.deviceId(true);
				const holder = host.settings().engineDeviceId;
				if (on && holder !== null && holder !== id && !(await host.confirm("Run the engine here", "Another device extracts pages for this vault. Extract here instead? That device stops extracting.", "Run it here"))) {
					await host.saveAndRedraw();
					return;
				}
				await withSettings(host, (s) => ({ ...s, engineDeviceId: on ? id : s.engineDeviceId === id ? null : s.engineDeviceId }));
			};
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
	const modelRow = new Setting(containerEl).setName("Extraction model").setDesc(MODEL_DESC);
	// Its own line in the warning colour, like the thinking line under the transcription model
	// (`localhost-register.ts`); empty while there is nothing to say.
	const warningEl = modelRow.descEl.createDiv({ cls: "tagged-sync-verdict" });
	warningEl.addClass("mod-warning");
	// Asked of the backend that will extract: the picked one, else the transcription backend's. `void`
	// on purpose, as in `renderProfile`: a `Setting` has a `then` of its own.
	const entry = extractionBackendEntry(settings.backend ?? host.transcriptionBackend());
	const probeModel = async (): Promise<void> => {
		const reasoning = (await entry?.reasoningModel?.(host.providerSettings(entry.id), host.settings().model)) ?? null;
		warningEl.setText(reasoning === null ? "" : reasoningWarning(reasoning));
	};
	modelRow.addText((text) =>
		text
			.setValue(settings.model ?? "")
			.setPlaceholder("Model name")
			.onChange(async (model) => {
				await typed(host, (s) => ({ ...s, model: model.trim() === "" ? null : model.trim() }));
				await probeModel();
			}),
	);
	void probeModel();

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

/** `name`, or `name 2`, `name 3`…: five Profiles all called "My pages" could not be told apart in a tag's list. */
export function uniqueName(name: string, taken: readonly string[]): string {
	if (!taken.includes(name)) return name;
	for (let n = 2; ; n++) if (!taken.includes(`${name} ${n}`)) return `${name} ${n}`;
}

function openProfile(host: IntelligenceSettingsHost, id: string): void {
	host.dialog("Edit profile", (containerEl) => renderProfileEditor(containerEl, host, id));
}

function openSlot(host: IntelligenceSettingsHost, id: string): void {
	host.dialog("Edit slot", (containerEl) => renderSlotEditor(containerEl, host, id));
}

function renderProfiles(containerEl: HTMLElement, host: IntelligenceSettingsHost): void {
	const settings = host.settings();
	new Setting(containerEl).setName("Profiles").setHeading();
	const canAdd = host.pro || settings.profiles.length === 0;
	const add = (profile: Omit<ProfileDef, "id" | "name"> & { name: string }) => async () => {
		const id = host.randomId().slice(0, 8);
		await withSettings(host, (s) => ({ ...s, profiles: [...s.profiles, { ...profile, id, name: uniqueName(profile.name, s.profiles.map((p) => p.name)) }] }));
		openProfile(host, id);
	};
	new Setting(containerEl)
		.setName(canAdd ? "Add a profile" : `Add a profile${PRO}`)
		.setDesc("A profile is a template and the slots it fills. A tag uses the generic profile until you pick one.")
		.addButton((button) =>
			button
				.setButtonText("Add")
				.setDisabled(!canAdd)
				.onClick(add({ name: "My pages", description: "Handwritten notes", template: null, slots: [...genericProfile(false).slots] })),
		);
	for (const profile of settings.profiles) {
		new Setting(containerEl)
			.setName(profile.name)
			.setDesc(profileSummary(host, profile))
			.addExtraButton((button) => button.setIcon("pencil").setTooltip("Edit").onClick(() => openProfile(host, profile.id)))
			.addExtraButton((button) => button.setIcon("copy").setTooltip(host.pro ? "Duplicate" : `Duplicate${PRO}`).setDisabled(!host.pro).onClick(async () => {
				// As it stands now: the dialog saves typing without redrawing this list.
				const now = host.settings().profiles.find((p) => p.id === profile.id)!;
				await add({ ...now, name: `${now.name} copy` })();
			}))
			.addExtraButton((button) =>
				button
					.setIcon("trash")
					.setTooltip("Delete")
					.onClick(async () => {
						if (!(await host.confirm("Delete profile", `Delete "${profile.name}"? Tags that use it go back to the generic profile; page notes already made stay as they are.`, "Delete"))) return;
						await withSettings(host, (s) => ({
							...s,
							profiles: s.profiles.filter((p) => p.id !== profile.id),
							mappings: Object.fromEntries(Object.entries(s.mappings).map(([tag, m]) => [tag, { ...m, profiles: m.profiles.filter((id) => id !== profile.id) }])),
						}));
					}),
			);
	}
}

/** A Profile's line in the list: its Slots, its template, the tags that use it. */
function profileSummary(host: IntelligenceSettingsHost, profile: ProfileDef): string {
	const settings = host.settings();
	const slots = profile.slots.flatMap((id) => settings.slots.filter((slot) => slot.id === id).map((slot) => slot.name));
	const tags = Object.keys(host.tagFolderMap()).filter((tag) => settings.mappings[tag]?.intelligence === true && settings.mappings[tag].profiles.includes(profile.id));
	return [
		slots.length === 0 ? "Fills nothing" : slots.join(", "),
		profile.template ?? "Built-in template",
		tags.length === 0 ? "No tag uses it" : `Used by ${tags.join(", ")}`,
	].join(" · ");
}

/** One Profile, whole, in its dialog. Empty once the Profile is gone. */
export function renderProfileEditor(containerEl: HTMLElement, host: IntelligenceSettingsHost, id: string): void {
	const profile = host.settings().profiles.find((p) => p.id === id);
	if (profile === undefined) return;
	// Every control edits the Profile as it stands now, not as it was drawn: a text field saves without
	// a redraw, so the drawn `profile` is behind as soon as one was typed in.
	const change = (next: (now: ProfileDef) => ProfileDef) => (s: IntelligenceSettings) => ({ ...s, profiles: s.profiles.map((p) => (p.id === id ? next(p) : p)) });
	const edit = (patch: Partial<ProfileDef>) => change((now) => ({ ...now, ...patch }));
	new Setting(containerEl).setName("Name").addText((text) => text.setValue(profile.name).onChange(async (name) => typed(host, edit({ name }))));
	new Setting(containerEl)
		.setName("Description")
		.setDesc("With several profiles on a tag, a new page goes to the one this fits.")
		.addText((text) => text.setValue(profile.description).setPlaceholder("One line: what these pages are").onChange(async (description) => typed(host, edit({ description }))));
	new Setting(containerEl)
		.setName("Template")
		.setDesc("Any note. Each slot fills its own heading; a template change reaches new page notes only.")
		.addText((text) => text.setValue(profile.template ?? "").setPlaceholder("Templates/Page.md").onChange(async (path) => typed(host, edit({ template: path.trim() === "" ? null : path.trim() }))))
		.addButton((button) =>
			button.setButtonText("Create template").onClick(async () => {
				const now = host.settings().profiles.find((p) => p.id === id)!;
				const slots = now.slots.flatMap((slotId) => host.settings().slots.filter((slot) => slot.id === slotId));
				const folder = await host.templateFolder();
				const path = await host.createTemplate(`${folder === "" ? "" : `${folder}/`}${now.name}.md`, starterTemplate(slots));
				await withSettings(host, edit({ template: path }));
			}),
		);
	new Setting(containerEl).setName("Fills").setHeading();
	// A small model loses tasks when asked for many things at once (research 15): warned, never refused.
	const backend = extractionBackendEntries().find((entry) => entry.id === host.settings().backend);
	if (backend !== undefined && !backend.metered && profile.slots.length > LOCAL_SLOT_WARNING) {
		containerEl.createDiv({ cls: "tagged-sync-note", text: `${profile.slots.length} slots on a local model: expect some items to be missed. ${LOCAL_SLOT_WARNING} or fewer read best.` });
	}
	for (const slot of host.settings().slots) {
		const pro = !host.pro && !FREE_SLOTS.has(slot.id);
		const row = new Setting(containerEl)
			.setName(`${slot.name}${pro ? PRO : ""}`)
			.addToggle((toggle) =>
				toggle
					.setValue(profile.slots.includes(slot.id))
					.setDisabled(pro)
					.onChange(async (on) => withSettings(host, change((now) => ({ ...now, slots: on ? [...now.slots, slot.id] : now.slots.filter((other) => other !== slot.id) })))),
			)
			.addExtraButton((button) => button.setIcon("pencil").setTooltip(`Edit the ${slot.name} slot`).onClick(() => openSlot(host, slot.id)));
		// Where the template puts it decides whether it is ever updated (spec §5.4), so the row says so.
		// `void` on purpose: a `Setting` has a `then` of its own, so returning it from the callback would
		// make the promise adopt it -- and `Setting.then` calls straight back, forever.
		if (profile.slots.includes(slot.id)) void placementHint(host, profile, slot).then((hint) => void row.setDesc(hint));
	}
}

const LOCAL_SLOT_WARNING = 7;

async function placementHint(host: IntelligenceSettingsHost, profile: ProfileDef, slot: SlotDef): Promise<string> {
	if (slot.shape === "value" && slot.property !== undefined) return `Frontmatter: ${slot.property}.`;
	return hintFor(slot, profile.template === null ? null : await host.readTemplate(profile.template));
}

// Apart from the async half on purpose: V8 counts a branch right after an `await` wrongly (negative),
// and a coverage ratchet then reports a tested line as untested.
function hintFor(slot: SlotDef, template: string | null): string {
	if (template === null) return "Its own heading in the built-in template.";
	const placement = analyseTemplate(template, [slot.id])[slot.id];
	if (placement.kind === "region") return `Under "${placement.heading.text}", kept up to date.`;
	if (placement.kind === "once") return "Filled once when the note is made, never updated: give it a heading of its own to keep it current.";
	return `Not in the template: it gets a "${slot.name}" heading at the end.`;
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
					const slot = newSlot(draft.name.trim(), draft.shape, host.settings().slots.map((c) => c.id));
					await withSettings(host, (s) => ({ ...s, slots: [...s.slots, slot] }));
					openSlot(host, slot.id);
				}),
		);
	for (const slot of host.settings().slots) {
		const proSlot = !host.pro && !FREE_SLOTS.has(slot.id);
		new Setting(containerEl)
			.setName(`${slot.name}${proSlot ? PRO : ""}`)
			.setDesc(slotSummary(host, slot))
			.addExtraButton((button) => button.setIcon("pencil").setTooltip("Edit").onClick(() => openSlot(host, slot.id)))
			.addExtraButton((button) =>
				button
					.setIcon("copy")
					.setTooltip(host.pro ? "Duplicate" : `Duplicate${PRO}`)
					.setDisabled(!host.pro)
					.onClick(async () =>
						withSettings(host, (s) => {
							const name = uniqueName(`${slot.name} copy`, s.slots.map((c) => c.name));
							const copy = { ...s.slots.find((c) => c.id === slot.id)!, id: slotIdFor(name, s.slots.map((c) => c.id)), name, used: false };
							return { ...s, slots: [...s.slots, copy] };
						}),
					),
			)
			.addExtraButton((button) =>
				button
					.setIcon("trash")
					.setTooltip(host.pro ? "Delete" : `Delete${PRO}`)
					.setDisabled(!host.pro)
					.onClick(async () => {
						if (!(await host.confirm("Delete slot", `Delete "${slot.name}"? Every profile stops filling it; what page notes already hold stays, no longer updated.`, "Delete"))) return;
						// Notes keep the regions it filled; they are no longer updated (spec §5.3).
						await withSettings(host, (s) => ({ ...s, slots: s.slots.filter((c) => c.id !== slot.id), profiles: s.profiles.map((p) => ({ ...p, slots: p.slots.filter((id) => id !== slot.id) })) }));
					}),
			);
	}
}

function usedBy(host: IntelligenceSettingsHost, slot: SlotDef): string[] {
	return host.settings().profiles.filter((profile) => profile.slots.includes(slot.id)).map((profile) => profile.name);
}

/** A Slot's line in the list: its Shape, the Profiles that fill it, whether its items are reviewed. */
function slotSummary(host: IntelligenceSettingsHost, slot: SlotDef): string {
	const profiles = usedBy(host, slot);
	const list = slot.shape === "list" || slot.shape === "checklist";
	return [
		SHAPES[slot.shape],
		profiles.length === 0 ? "In no profile" : `In ${profiles.join(", ")}`,
		...(list && (slot.review || !host.pro) ? ["Reviewed"] : []),
	].join(" · ");
}

/** One Slot, whole, in its dialog. Empty once the Slot is gone. */
export function renderSlotEditor(containerEl: HTMLElement, host: IntelligenceSettingsHost, id: string): void {
	const slot = host.settings().slots.find((c) => c.id === id);
	if (slot === undefined) return;
	// As in `renderProfileEditor`: the Slot as it stands now, not as it was drawn.
	const change = (next: (now: SlotDef) => SlotDef) => (s: IntelligenceSettings) => ({ ...s, slots: s.slots.map((candidate) => (candidate.id === id ? next(candidate) : candidate)) });
	const edit = (patch: Partial<SlotDef>) => change((now) => ({ ...now, ...patch }));
	const profiles = usedBy(host, slot);
	const proSlot = !host.pro && !FREE_SLOTS.has(slot.id);
	// Said first, where it is read before anything is changed.
	if (profiles.length > 1) containerEl.createDiv({ cls: "tagged-sync-note", text: `Used by ${profiles.join(", ")}: an edit here changes all of them.` });
	new Setting(containerEl)
		.setName(`${slot.name}${proSlot ? PRO : ""}`)
		.setDesc("What to extract, in your words.")
		.addTextArea((text) => text.setValue(slot.instruction).setDisabled(proSlot).onChange(async (instruction) => typed(host, edit({ instruction }))));
	// The Shape is what code branches on; once a note holds this slot's region, it is fixed.
	new Setting(containerEl)
		.setName(`Shape${slot.used === true ? " (fixed: duplicate to change it)" : ""}`)
		.addDropdown((dropdown) => {
			for (const [shape, label] of Object.entries(SHAPES)) dropdown.addOption(shape, label);
			dropdown
				.setValue(slot.shape)
				.setDisabled(!host.pro || slot.used === true)
				.onChange(async (shape) => withSettings(host, change((now) => ({ ...newSlot(now.name, shape as Shape, []), id: now.id, instruction: now.instruction, examples: now.examples }))));
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
		.addToggle((toggle) => toggle.setValue(freeLocked || slot.review).setDisabled(freeLocked).onChange(async (review) => withSettings(host, edit({ review }))));
	new Setting(containerEl)
		.setName(`Item format${freeLocked ? PRO : ""}`)
		.setDesc(freeLocked ? TASKS_FORMAT : slot.itemFormat)
		.addDropdown((dropdown) => {
			dropdown.addOption("", "Preset…");
			for (const name of Object.keys(ITEM_FORMAT_PRESETS)) dropdown.addOption(name, name);
			dropdown.setDisabled(freeLocked);
			dropdown.onChange(async (name) => {
				if (name !== "") await withSettings(host, edit({ itemFormat: ITEM_FORMAT_PRESETS[name] }));
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
