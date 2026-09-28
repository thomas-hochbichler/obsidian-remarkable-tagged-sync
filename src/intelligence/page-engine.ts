/**
 * One page through the engine: extract, then either create the note from the template or merge into
 * the note the user already has. No I/O: the sync side hands in the unit, the base, the note's text
 * and the Profile; this hands back the note's new text and the new base.
 *
 * Value Slots (frontmatter) are phase 2 of 1.9.0 and are skipped here on purpose.
 */

import { type BaseItem } from "./merge";
import { NO_FAILURES, BASE_VERSION, type ListSlotBase, type PageBase, type SlotBase } from "./base-store";
import { calendarDay, isoDay } from "./dates";
import type { ExtractionBackend } from "./extraction-backend";
import type { ExtractionResult, SlotResult } from "./extraction";
import { compileItemFormat, type ItemFormat } from "./item-format";
import { mergeList, mergeText } from "./merge";
import { applyListOps, findRegion, parseRegion, readTextRegion, setProposalCallout, writeTextRegion, type Heading } from "./regions";
import type { ProfileDef, SlotDef } from "./settings";
import { analyseTemplate, renderTemplate } from "./template";

/** The only thing the engine reads from the sync side (§14). A Supernote source would produce the same record. */
export interface ExtractionUnit {
	/** `syncKey` in 1.9.0; the seam for a later unit spanning pages. */
	key: string;
	pageHash: string | null;
	transcript: string;
	/** The page's frozen first-seen `modifed`, epoch ms; null when the page had none. */
	firstSeen: number | null;
}

export interface PageRun {
	unit: ExtractionUnit;
	noteId: string;
	base: PageBase | null;
	/** The note's current text; null = no note yet, create it from the template. */
	note: string | null;
	profile: ProfileDef;
	/** The Profile's Slots in order, with any Free-tier locks already applied. */
	slots: readonly SlotDef[];
	template: string;
	backend: ExtractionBackend;
	syncedAt: Date;
	/** The new note's name, from the page's date; asked only on creation. */
	title: (pageDate: Date) => string;
	/** `{{ts.page.link}}`: a link to the page render. */
	pageLink: string;
	/** `{{ts.page.png}}`: the page render embedded. */
	pageEmbed: string;
	reviewLink: string;
	formatDate: (format: string | null) => string;
	formatTime: (format: string | null) => string;
	newId: () => string;
}

export type PageOutcome =
	| { kind: "failed"; reason: string; base: PageBase }
	| {
			kind: "written";
			/** The note's new text; null when nothing in it changed. */
			content: string | null;
			created: boolean;
			base: PageBase;
			/** Pending proposals on this page after the run. */
			proposals: number;
			pageDate: Date;
			/** Slots whose region could not be found: nothing was written there, the user gets a notice. */
			missingRegions: string[];
	  };

const localDay = (date: Date) => calendarDay(date.getFullYear(), date.getMonth(), date.getDate());

const isList = (slot: SlotDef) => slot.shape === "list" || slot.shape === "checklist";

// `parseExtraction` builds each Slot's result from the Slot's own shape, so a Text Slot always holds
// text and a List Slot items; these read that guarantee instead of re-checking it.
const textOf = (got: SlotResult) => (got as Extract<SlotResult, { kind: "text" }>).text;
const itemsOf = (got: SlotResult) => (got as Extract<SlotResult, { kind: "items" }>).items;

function freshBase(run: PageRun): PageBase {
	return { version: BASE_VERSION, noteId: run.noteId, syncKey: run.unit.key, unitKey: run.unit.key, transcript: null, slots: {}, settled: [], extraction: { ...NO_FAILURES } };
}

function knownItems(base: PageBase | null): Record<string, { id: string; text: string }[]> {
	const known: Record<string, { id: string; text: string }[]> = {};
	for (const [id, slot] of Object.entries(base?.slots ?? {})) if (slot.shape !== "text") known[id] = slot.list.items.map((item) => ({ id: item.id, text: item.text }));
	return known;
}

function renderItems(format: ItemFormat, items: readonly BaseItem[]): string {
	return items.map((item) => format.render({ text: item.text, fields: item.fields, checkbox: item.done ? "x" : " " })).join("\n");
}

function pendingCount(slot: SlotBase): number {
	return slot.shape === "text" ? slot.proposals.length : slot.list.proposals.length;
}

/** A new Slot's region, placed right after the region of the Slot before it in the Profile, else at the end. */
function insertRegion(lines: string[], heading: Heading, body: string, after: Heading | null, format: ItemFormat): string[] {
	const block = ["", `${"#".repeat(heading.level)} ${heading.text}`, ...(body === "" ? [] : body.split("\n"))];
	const region = after ? findRegion(lines, after, format) : null;
	let at = region ? region.end : lines.length;
	while (at > 0 && lines[at - 1].trim() === "") at--;
	return [...lines.slice(0, at), ...block, ...lines.slice(at)];
}

export async function processPage(run: PageRun): Promise<PageOutcome> {
	const referenceDate = localDay(run.unit.firstSeen === null ? run.syncedAt : new Date(run.unit.firstSeen));
	const previous = run.base ?? freshBase(run);
	const runSlots = run.slots.filter((slot) => slot.shape !== "value");

	const outcome = await run.backend.extract({ profile: run.profile, slots: runSlots, transcript: run.unit.transcript, referenceDate, known: knownItems(run.base) });
	if (outcome.kind === "failed") {
		const sameHash = previous.extraction.failedHash === run.unit.pageHash;
		const attempts = (sameHash ? previous.extraction.attempts : 0) + 1;
		return { kind: "failed", reason: outcome.reason, base: { ...previous, transcript: run.unit.transcript, extraction: { attempts, reason: outcome.reason, failedHash: run.unit.pageHash } } };
	}
	const { result } = outcome;
	const results = result.slots;
	const transcript = run.unit.transcript;

	if (run.note === null) return create(run, runSlots, result, transcript);

	let lines = run.note.split("\n");
	const slots: Record<string, SlotBase> = { ...previous.slots };
	const settled = [...previous.settled];
	const missingRegions: string[] = [];
	const placements = analyseTemplate(run.template, runSlots.map((slot) => slot.id));

	for (const [index, slot] of runSlots.entries()) {
		const got = results[slot.id];
		const stored = slots[slot.id];
		if (stored === undefined) {
			if (settled.includes(slot.id)) continue;
			// A Slot added to the Profile after this note was made: its region arrives with this change.
			const placement = placements[slot.id];
			if (placement.kind === "once") {
				settled.push(slot.id);
				continue;
			}
			const heading = placement.kind === "region" ? placement.heading : { level: 2, text: slot.name };
			const format = compileItemFormat(isList(slot) ? slot.itemFormat : "- {{text}}");
			const fresh = createSlotBase(slot, heading, got, transcript, run.newId);
			const existing = placement.kind === "region" ? findRegion(lines, heading, format) : null;
			if (existing === null) {
				const before = runSlots.slice(0, index).reverse().find((other) => slots[other.id] !== undefined);
				lines = insertRegion(lines, heading, fresh.body, before ? slots[before.id].heading : null, format);
				slots[slot.id] = fresh.base;
				continue;
			}
			// The template's heading is already in the note, left empty when the note was made: the Slot
			// adopts it. Empty → written like a first extraction; the user wrote there → merged, never overwritten.
			if (fresh.base.shape === "text") {
				const current = readTextRegion(lines, existing);
				const merged = mergeText({ base: current === "" ? null : "", note: current, model: fresh.base.text, proposals: [], newId: run.newId });
				if (merged.write !== null) lines = writeTextRegion(lines, existing, merged.write);
				slots[slot.id] = { shape: "text", heading, text: merged.base, proposals: merged.proposals };
			} else {
				const items = parseRegion(lines, existing, format);
				const merged = mergeList({ base: items.length === 0 ? null : { items: [], tombstones: [], proposals: [] }, note: items, model: itemsOf(got), transcript, review: slot.review, newId: run.newId });
				lines = applyListOps(lines, existing, items, merged.ops, format);
				slots[slot.id] = { ...fresh.base, list: merged.base };
			}
			lines = setProposalCallout(lines, findRegion(lines, heading, format)!, pendingCount(slots[slot.id]), run.reviewLink);
			continue;
		}
		const format = compileItemFormat(stored.shape === "text" ? "- {{text}}" : stored.itemFormat);
		const region = findRegion(lines, stored.heading, format, stored.shape === "text" ? [] : stored.list.items.map((item) => item.text));
		if (region === null) {
			missingRegions.push(slot.id);
			continue;
		}
		const heading = { level: stored.heading.level, text: lines[region.heading].replace(/^#+\s+/, "").trim() };
		if (stored.shape === "text") {
			const merged = mergeText({ base: stored.text, note: readTextRegion(lines, region), model: textOf(got), proposals: stored.proposals, newId: run.newId });
			if (merged.write !== null) lines = writeTextRegion(lines, region, merged.write);
			slots[slot.id] = { shape: "text", heading, text: merged.base, proposals: merged.proposals };
		} else {
			const items = parseRegion(lines, region, format);
			const merged = mergeList({ base: stored.list, note: items, model: itemsOf(got), transcript, review: slot.review, newId: run.newId });
			lines = applyListOps(lines, region, items, merged.ops, format);
			slots[slot.id] = { ...stored, heading, list: merged.base };
		}
		const after = findRegion(lines, heading, format)!;
		lines = setProposalCallout(lines, after, pendingCount(slots[slot.id]), run.reviewLink);
	}

	const content = lines.join("\n");
	const base: PageBase = { ...previous, transcript, slots, settled, extraction: { ...NO_FAILURES } };
	const proposals = Object.values(slots).reduce((sum, slot) => sum + pendingCount(slot), 0);
	return { kind: "written", content: content === run.note ? null : content, created: false, base, proposals, pageDate: result.pageDate, missingRegions };
}

function createSlotBase(slot: SlotDef, heading: Heading, got: SlotResult, transcript: string, newId: () => string): { base: SlotBase; body: string } {
	if (slot.shape === "text") {
		const merged = mergeText({ base: null, note: "", model: textOf(got), proposals: [], newId });
		return { base: { shape: "text", heading, text: merged.base, proposals: [] }, body: merged.base };
	}
	const merged = mergeList({ base: null, note: [], model: itemsOf(got), transcript, review: slot.review, newId });
	const base: ListSlotBase = { shape: slot.shape as ListSlotBase["shape"], heading, itemFormat: slot.itemFormat, list: merged.base };
	return { base, body: renderItems(compileItemFormat(slot.itemFormat), merged.base.items) };
}

function create(run: PageRun, runSlots: readonly SlotDef[], result: ExtractionResult, transcript: string): PageOutcome {
	const { slots: results, pageDate } = result;
	// The Profile's Slot list decides what runs; the template only decides where. A Slot the template
	// does not place gets its own heading at the end.
	let template = run.template;
	const absent = runSlots.filter((slot) => !template.includes(`{{ts.${slot.id}}}`));
	if (absent.length > 0) template = `${template.replace(/\s*$/, "")}\n${absent.map((slot) => `\n## ${slot.name}\n{{ts.${slot.id}}}`).join("\n")}\n`;
	const placements = analyseTemplate(template, runSlots.map((slot) => slot.id));

	const ts: Record<string, string> = {
		"page.link": run.pageLink,
		"page.png": run.pageEmbed,
		"date.written": result.writtenDate ? isoDay(result.writtenDate) : "",
		"date.firstSeen": run.unit.firstSeen === null ? "" : isoDay(localDay(new Date(run.unit.firstSeen))),
		"date.synced": isoDay(localDay(run.syncedAt)),
	};
	const slots: Record<string, SlotBase> = {};
	const settled: string[] = [];
	for (const slot of runSlots) {
		const placement = placements[slot.id];
		const heading = placement.kind === "region" ? placement.heading : { level: 2, text: slot.name };
		const fresh = createSlotBase(slot, heading, results[slot.id], transcript, run.newId);
		ts[slot.id] = fresh.body;
		if (placement.kind === "region") slots[slot.id] = fresh.base;
		else settled.push(slot.id);
	}
	const content = renderTemplate(template, { ts, title: run.title(pageDate), formatDate: run.formatDate, formatTime: run.formatTime });
	const base: PageBase = { ...freshBase(run), transcript, slots, settled };
	return { kind: "written", content, created: true, base, proposals: 0, pageDate, missingRegions: [] };
}
