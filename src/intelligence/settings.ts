/**
 * The `intelligence` block of `data.json`: which tag mappings run Intelligence Mode, the Profiles and
 * Slots they use, and the extraction backend.
 *
 * `tagFolderMap` stays `Record<tag, folder>` on purpose: an older install sharing this file through
 * Obsidian Sync must keep resolving folders, and an object per tag would break it. Everything new
 * lives here instead, and the reader follows `settings-store.ts`: total, idempotent, and it never
 * writes -- a timestamp it has to invent lives in memory until the next save.
 */

export type Shape = "text" | "value" | "list" | "checklist";
export type FieldType = "text" | "date" | "number" | "choice" | "link";

export interface FieldDef {
	name: string;
	type: FieldType;
	/** The closed option list of a Choice field. */
	options?: string[];
}

export interface SlotExample {
	input: string;
	output: string;
	/** false = a counter-example: this input yields nothing for the Slot. */
	positive: boolean;
}

export interface SlotDef {
	id: string;
	name: string;
	shape: Shape;
	instruction: string;
	examples: SlotExample[];
	fields: FieldDef[];
	/** List/Checklist only: how one item is written as a Markdown line. */
	itemFormat: string;
	/** List/Checklist only: new and dropped items go through the review Modal. */
	review: boolean;
	/** Value only: a frontmatter property instead of the note body. */
	property?: string;
	/** Written into a page note at least once: its Shape is fixed from then on (spec §5.3). */
	used?: boolean;
}

export interface ProfileDef {
	id: string;
	name: string;
	/** One line; the classifier's class text and context in the extraction prompt. */
	description: string;
	/** Vault path of the template note; null = the built-in default template. */
	template: string | null;
	/** Slot ids in order. This list, not the template, decides which Slots run. */
	slots: string[];
}

export interface MappingModes {
	transcript: boolean;
	intelligence: boolean;
	/** Allowed Profile ids; empty = the Generic Profile. */
	profiles: string[];
	/** ISO time Intelligence Mode was last switched on: the seen-set's anchor. */
	enabledAt?: string;
	/** ISO time it was first switched on, never cleared: picks the free tag after a Pro lapse. */
	firstEnabledAt?: string;
}

export interface IntelligenceSettings {
	mappings: Record<string, MappingModes>;
	profiles: ProfileDef[];
	slots: SlotDef[];
	/** Extraction backend id; null = derived from the transcription backend (§6). */
	backend: string | null;
	model: string | null;
	/** The device that runs the engine; synced, compared with a device-local id. */
	engineDeviceId: string | null;
	/** Consent to extract with a paid backend in a background sync (spec §6); off by default. */
	autoExtractMetered: boolean;
	/** Consent to run the local model for extraction in a background sync; off by default. */
	autoExtractLocal: boolean;
	/** Notices the engine gives once and never again, by key. */
	saidOnce: string[];
}

export const DEFAULT_MODES: Readonly<MappingModes> = Object.freeze({ transcript: true, intelligence: false, profiles: [] as string[] });

export const TASKS_FORMAT = "- [ ] {{text}} 📅 {{due}}";

/** The four default Slots. Editable and duplicable; written only into a block that has none yet. */
export function defaultSlots(): SlotDef[] {
	return [
		{
			id: "tasks",
			name: "Tasks",
			shape: "checklist",
			instruction: "Things the writer has to do. Not things other people do, not ideas, not questions.",
			examples: [],
			fields: [{ name: "due", type: "date" }],
			itemFormat: TASKS_FORMAT,
			review: true,
		},
		{ id: "decisions", name: "Decisions", shape: "list", instruction: "Decisions that were made, as written.", examples: [], fields: [], itemFormat: "- {{text}}", review: true },
		{ id: "summary", name: "Summary", shape: "text", instruction: "Two or three sentences on what the page is about.", examples: [], fields: [], itemFormat: "", review: false },
		{ id: "tags", name: "Tags", shape: "value", instruction: "Topics of the page, from the allowed list only.", examples: [], fields: [{ name: "tags", type: "choice", options: [] }], itemFormat: "", review: false, property: "tags" },
	];
}

/** The built-in fallback for a mapping with Intelligence Mode on and no Profile. */
export function genericProfile(pro: boolean): ProfileDef {
	return { id: "generic", name: "Generic", description: "Any handwritten page.", template: null, slots: pro ? ["tasks", "summary", "tags"] : ["tasks", "summary"] };
}

export function emptyIntelligence(): IntelligenceSettings {
	return { mappings: {}, profiles: [], slots: defaultSlots(), backend: null, model: null, engineDeviceId: null, autoExtractMetered: false, autoExtractLocal: false, saidOnce: [] };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOr = <T>(value: unknown, fallback: T): string | T => (typeof value === "string" ? value : fallback);

function readModes(raw: unknown, now: string): MappingModes {
	const stored = isRecord(raw) ? raw : {};
	const modes: MappingModes = {
		transcript: typeof stored.transcript === "boolean" ? stored.transcript : DEFAULT_MODES.transcript,
		intelligence: typeof stored.intelligence === "boolean" ? stored.intelligence : DEFAULT_MODES.intelligence,
		profiles: Array.isArray(stored.profiles) ? stored.profiles.filter((id): id is string => typeof id === "string") : [],
	};
	const enabledAt = stringOr(stored.enabledAt, undefined);
	const firstEnabledAt = stringOr(stored.firstEnabledAt, undefined);
	if (enabledAt !== undefined) modes.enabledAt = enabledAt;
	if (firstEnabledAt !== undefined) modes.firstEnabledAt = firstEnabledAt;
	// Hand-edited or pre-release data: on, but never stamped. Stamped with the load time in memory;
	// the next save persists it.
	if (modes.intelligence && modes.enabledAt === undefined) modes.enabledAt = now;
	if (modes.intelligence && modes.firstEnabledAt === undefined) modes.firstEnabledAt = modes.enabledAt;
	return modes;
}

/**
 * Reads the stored block. Total (any input gives a complete block) and idempotent. Profiles and
 * Slots are carried as stored -- a newer install may have written fields this one does not know,
 * and dropping them here would drop them on every device at the next save.
 */
export function readIntelligence(saved: unknown, now: Date): IntelligenceSettings {
	if (!isRecord(saved)) return emptyIntelligence();
	const stamp = now.toISOString();
	const mappings: Record<string, MappingModes> = {};
	if (isRecord(saved.mappings)) for (const [tag, raw] of Object.entries(saved.mappings)) mappings[tag] = readModes(raw, stamp);
	return {
		mappings,
		profiles: Array.isArray(saved.profiles) ? (saved.profiles.filter(isRecord) as unknown as ProfileDef[]) : [],
		slots: Array.isArray(saved.slots) ? (saved.slots.filter(isRecord) as unknown as SlotDef[]) : defaultSlots(),
		backend: stringOr(saved.backend, null),
		model: stringOr(saved.model, null),
		engineDeviceId: stringOr(saved.engineDeviceId, null),
		autoExtractMetered: saved.autoExtractMetered === true,
		autoExtractLocal: saved.autoExtractLocal === true,
		saidOnce: Array.isArray(saved.saidOnce) ? saved.saidOnce.filter((key): key is string => typeof key === "string") : [],
	};
}

/** A mapping's modes. An entry whose tag left `tagFolderMap` is ignored: the mapping was removed. */
export function modesFor(settings: IntelligenceSettings, tagFolderMap: Record<string, string>, tag: string): MappingModes {
	const stored = tagFolderMap[tag] === undefined ? undefined : settings.mappings[tag];
	return stored ?? { ...DEFAULT_MODES, profiles: [] };
}

/** Switches Intelligence Mode for one tag. On stamps `enabledAt` every time, `firstEnabledAt` once. */
export function setIntelligenceMode(settings: IntelligenceSettings, tag: string, on: boolean, now: Date): IntelligenceSettings {
	const current = settings.mappings[tag] ?? { ...DEFAULT_MODES, profiles: [] };
	const next: MappingModes = { ...current, intelligence: on };
	if (on) {
		next.enabledAt = now.toISOString();
		next.firstEnabledAt = current.firstEnabledAt ?? next.enabledAt;
	}
	return { ...settings, mappings: { ...settings.mappings, [tag]: next } };
}

const INTELLIGENCE_FINGERPRINT_VERSION = 1;

/**
 * The index's second fingerprint. Over the mappings including `enabledAt`, not Profiles or Slots: a
 * Profile edit reaches a note only when its page next changes. Key order is normalised, as in
 * `mappingFingerprint`, because `data.json` is merged and hand-edited. An entry equal to the
 * defaults is left out: writing one changes nothing a sync does, so it must not open every notebook.
 */
export function intelligenceFingerprint(mappings: Record<string, MappingModes>): string {
	const isDefault = (m: MappingModes) => m.transcript && !m.intelligence && m.profiles.length === 0 && m.enabledAt === undefined;
	const entries = Object.entries(mappings)
		.filter(([, m]) => !isDefault(m))
		// Object keys are unique, so there is no tie to break. Not localeCompare: a print must not depend on the locale.
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([tag, m]) => [tag, m.transcript, m.intelligence, [...m.profiles], m.enabledAt ?? null]);
	return `${INTELLIGENCE_FINGERPRINT_VERSION}:${JSON.stringify(entries)}`;
}

/** What an index written before this block existed is taken to hold: the empty block's print, so an upgrade costs no scan. */
export const EMPTY_INTELLIGENCE_FINGERPRINT = intelligenceFingerprint({});

/** Marks Slots as used in notes, which locks their Shape. Unchanged settings come back as they were. */
export function markSlotsUsed(settings: IntelligenceSettings, ids: readonly string[]): IntelligenceSettings {
	if (!settings.slots.some((slot) => ids.includes(slot.id) && slot.used !== true)) return settings;
	return { ...settings, slots: settings.slots.map((slot) => (ids.includes(slot.id) ? { ...slot, used: true } : slot)) };
}

/** A new Slot's id from its name: lowercase words joined, made unique against the Slots there are. */
export function slotIdFor(name: string, taken: readonly string[]): string {
	const stem = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "slot";
	let id = stem;
	for (let n = 2; taken.includes(id); n++) id = `${stem}-${n}`;
	return id;
}

/** Records notices as said, so they are never said again. Unchanged settings come back as they were. */
export function markSaid(settings: IntelligenceSettings, keys: readonly string[]): IntelligenceSettings {
	const fresh = [...new Set(keys)].filter((key) => !settings.saidOnce.includes(key));
	return fresh.length === 0 ? settings : { ...settings, saidOnce: [...settings.saidOnce, ...fresh] };
}
