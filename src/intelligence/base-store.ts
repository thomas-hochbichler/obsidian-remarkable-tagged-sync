/**
 * The Base: a hidden per-page record of what the engine last wrote -- items with ids, tombstones,
 * pending proposals, the page transcript, the extraction state. Stored at
 * `${manifest.dir}/base/<noteId>.json`: never keyed by `syncKey`, which holds `:` and maybe `/`
 * (illegal in Windows file names) and changes when a mapped tag is renamed.
 *
 * Obsidian Sync does not copy the plugin folder, so a base can be missing on any device that did not
 * write it. That is survivable by design: {@link rebuildBase} reads the note back as the base.
 */

import type { ItemFormat } from "./item-format";
import type { ListBase, Proposal } from "./merge";
import { findRegion, parseRegion, type Heading } from "./regions";
import type { Shape } from "./settings";

export const BASE_VERSION = 1;

export interface TextSlotBase {
	shape: "text";
	heading: Heading;
	text: string;
	proposals: Proposal[];
}

export interface ListSlotBase {
	shape: "list" | "checklist";
	heading: Heading;
	/** The Item format this note's lines were written with; an edited format never loses old fields. */
	itemFormat: string;
	list: ListBase;
}

export type SlotBase = TextSlotBase | ListSlotBase;

export interface ExtractionState {
	/** Failed attempts since the page's hash last changed. */
	attempts: number;
	reason: string | null;
	/** The page hash the failures were recorded against; a different hash resets the count. */
	failedHash: string | null;
}

export interface PageBase {
	version: number;
	noteId: string;
	syncKey: string;
	/** Equals `syncKey` in 1.9.0; the seam for a later "one note per day across pages". */
	unitKey: string;
	/** The page transcript. Its one home: never read back from the note. Null after a rebuild. */
	transcript: string | null;
	slots: Record<string, SlotBase>;
	/**
	 * Slots this note ever had that are not merged regions: filled once at creation, or a region the
	 * user deleted. Either way the engine never adds them again.
	 */
	settled: string[];
	extraction: ExtractionState;
}

export interface BaseFiles {
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export interface BaseStore {
	/** Null when absent, unreadable or written in another shape -- all mean "rebuild". */
	load(noteId: string): Promise<PageBase | null>;
	save(base: PageBase): Promise<void>;
	discard(noteId: string): Promise<void>;
}

export const NO_FAILURES: Readonly<ExtractionState> = Object.freeze({ attempts: 0, reason: null, failedHash: null });

export function basePath(dir: string, noteId: string): string {
	return `${dir}/base/${noteId}.json`;
}

function isPageBase(value: unknown): value is PageBase {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Partial<PageBase>;
	return v.version === BASE_VERSION && typeof v.noteId === "string" && typeof v.syncKey === "string" && typeof v.slots === "object" && v.slots !== null && Array.isArray(v.settled) && typeof v.extraction === "object";
}

export function createBaseStore(files: BaseFiles, dir: string): BaseStore {
	return {
		async load(noteId) {
			const text = await files.read(basePath(dir, noteId));
			if (text === null) return null;
			try {
				const parsed: unknown = JSON.parse(text);
				return isPageBase(parsed) && parsed.noteId === noteId ? parsed : null;
			} catch {
				return null;
			}
		},
		save: (base) => files.write(basePath(dir, base.noteId), JSON.stringify(base)),
		discard: (noteId) => files.remove(basePath(dir, noteId)),
	};
}

export interface RebuildSlot {
	id: string;
	shape: Shape;
	heading: Heading;
	format: ItemFormat;
	itemFormat: string;
}

/**
 * The note read back as the base, for a base that went missing (reinstall, another engine device).
 * Items get fresh ids and no source span: the engine does not own them until the model returns them
 * with one, so none of them can be removed as "dropped" on the first run after a rebuild. A region
 * whose heading is gone is left out -- the engine will not write where it cannot find its place.
 * Rejected proposals may come back once; documented.
 */
export function rebuildBase(input: { lines: readonly string[]; slots: readonly RebuildSlot[]; noteId: string; syncKey: string; newId: () => string }): PageBase {
	const slots: Record<string, SlotBase> = {};
	const settled: string[] = [];
	for (const slot of input.slots) {
		const region = findRegion(input.lines, slot.heading, slot.format);
		if (slot.shape === "value") continue;
		if (region === null) {
			settled.push(slot.id);
			continue;
		}
		if (slot.shape === "text") {
			// An empty base, not the region's text: whatever stands there may be the user's own words, and
			// a Text region untouched since its base is replaced outright. With "" as the base, text in the
			// note reads as edited, so a new summary becomes a proposal instead of overwriting it.
			slots[slot.id] = { shape: "text", heading: slot.heading, text: "", proposals: [] };
			continue;
		}
		const items = parseRegion(input.lines, region, slot.format).map((line) => ({
			id: input.newId(),
			text: line.text,
			fields: { ...line.fields },
			done: line.checkbox === "x" || line.checkbox === "X",
			source: null,
			origin: "engine" as const,
		}));
		slots[slot.id] = { shape: slot.shape, heading: slot.heading, itemFormat: slot.itemFormat, list: { items, tombstones: [], proposals: [] } };
	}
	return { version: BASE_VERSION, noteId: input.noteId, syncKey: input.syncKey, unitKey: input.syncKey, transcript: null, slots, settled, extraction: { ...NO_FAILURES } };
}
