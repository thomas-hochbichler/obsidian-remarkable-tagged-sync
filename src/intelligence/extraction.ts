/**
 * What the extraction asks for and how the answer is read. One JSON schema is assembled from the
 * Profile's Slots plus a hidden `page_date_text`; item keys are ordered evidence → reason → value
 * (`source`, `reason`, then `text`), because a model that has copied the words first invents less.
 *
 * The answer is read defensively: whatever the backend enforced, this is the boundary where model
 * output becomes typed data, so every field is checked here and nothing downstream re-checks.
 */

import { calendarDay, resolveWrittenDate } from "./dates";
import { FIELD_TYPES } from "./field-types";
import type { Fields, ModelItem } from "./merge";
import type { ProfileDef, SlotDef } from "./settings";

export const PAGE_DATE_KEY = "page_date_text";

/** A known item passed back to the model so it can keep its id and wording. */
export interface KnownItem {
	id: string;
	text: string;
}

export type SlotResult = { kind: "items"; items: ModelItem[] } | { kind: "text"; text: string } | { kind: "value"; value: string | string[] | null };

export interface ExtractionResult {
	slots: Record<string, SlotResult>;
	/** The date written on the page, if any, else the fallback: the reference every due date was resolved against. */
	pageDate: Date;
	writtenDate: Date | null;
}

const isList = (slot: SlotDef) => slot.shape === "list" || slot.shape === "checklist";

function itemSchema(slot: SlotDef): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		source: { type: "string", description: "The words on the page this item comes from, copied exactly" },
		reason: { type: "string", description: "Why this belongs in the Slot, in a few words" },
		id: { type: "string", description: "The id of the known item this is, or 'new'" },
		text: { type: "string" },
	};
	for (const field of slot.fields) properties[field.name] = FIELD_TYPES[field.type].schema(field);
	if (slot.shape === "checklist") properties.done = { type: "boolean", description: "Ticked on the page" };
	return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function valueSchema(slot: SlotDef): Record<string, unknown> {
	const choice = slot.fields.find((field) => field.type === "choice");
	const one = choice ? { type: "string", enum: choice.options ?? [] } : { type: "string" };
	return slot.property === "tags" ? { type: "array", items: one } : { anyOf: [one, { type: "null" }] };
}

/** The strict JSON schema for one page under one Profile. */
export function buildSchema(slots: readonly SlotDef[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		[PAGE_DATE_KEY]: { anyOf: [{ type: "string", description: "A date written at the top of the page, copied exactly" }, { type: "null" }] },
	};
	for (const slot of slots) {
		properties[slot.id] = isList(slot) ? { type: "array", items: itemSchema(slot) } : slot.shape === "text" ? { type: "string" } : valueSchema(slot);
	}
	return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describeSlot(slot: SlotDef, known: readonly KnownItem[]): string {
	const lines = [`### ${slot.id} (${slot.name}) — ${slot.shape}`, slot.instruction];
	for (const field of slot.fields) lines.push(`- field \`${field.name}\`: ${field.type}${field.options?.length ? ` (one of: ${field.options.join(", ")})` : ""}`);
	for (const example of slot.examples) lines.push(`${example.positive ? "Example" : "Not this"}: "${example.input}" → ${example.positive ? example.output : "nothing"}`);
	if (isList(slot)) lines.push("An empty list is valid.");
	if (known.length > 0) {
		lines.push("Known items (keep the id and wording of a known item; use 'new' for anything else):");
		for (const item of known) lines.push(`- ${item.id}: ${item.text}`);
	}
	return lines.join("\n");
}

/** The one-call prompt (cloud). The local two-call prompts live with the local backend. */
export function buildPrompt(input: { profile: ProfileDef; slots: readonly SlotDef[]; transcript: string; referenceDate: Date; known: Record<string, readonly KnownItem[]> }): { system: string; user: string } {
	const day = input.referenceDate;
	const system = [
		"You extract structured information from one handwritten notebook page.",
		"The page text below came from handwriting recognition and may contain recognition errors.",
		"Only extract what is written on the page. Never invent items. Copy `source` exactly from the page text.",
		"For dates, copy the words as written and pick the closest `rel` class; do not compute dates.",
	].join("\n");
	const user = [
		`Page type: ${input.profile.description}`,
		`The page was first seen on ${WEEKDAYS[day.getUTCDay()]}, ${day.toISOString().slice(0, 10)}.`,
		"",
		"## Slots",
		...input.slots.map((slot) => describeSlot(slot, input.known[slot.id] ?? [])),
		"",
		"## Page text",
		input.transcript,
	].join("\n");
	return { system, user };
}

const NONE = /^(none|n\/a|nothing|keine?|nichts|-+|—)$/i;

function readItem(raw: unknown, slot: SlotDef, pageDate: Date): ModelItem | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const text = typeof r.text === "string" ? r.text.trim() : "";
	if (text === "" || NONE.test(text)) return null;
	const fields: Fields = {};
	for (const field of slot.fields) fields[field.name] = FIELD_TYPES[field.type].resolve(r[field.name], field, { pageDate });
	const id = typeof r.id === "string" && r.id !== "new" && r.id.trim() !== "" ? r.id : null;
	const source = typeof r.source === "string" && r.source.trim() !== "" ? r.source : null;
	const item: ModelItem = { id, text, fields, source };
	if (slot.shape === "checklist") item.done = r.done === true;
	return item;
}

function readValue(raw: unknown, slot: SlotDef): string | string[] | null {
	const choice = slot.fields.find((field) => field.type === "choice");
	const allowed = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !NONE.test(value) && (!choice || (choice.options ?? []).includes(value));
	if (slot.property === "tags") return Array.isArray(raw) ? [...new Set(raw.filter(allowed))] : [];
	return allowed(raw) ? raw : null;
}

/**
 * Reads one answer. Null when it is not an object at all -- a failure outcome, retried on the next
 * sync. A Slot missing from an otherwise good answer reads as empty.
 */
/**
 * Templater runs every `<%` in a note it creates as a command (spec §5.4), and what the model read off
 * the page is part of that note. A zero-width space splits the tag, so the text still reads as
 * written but never runs. `source` stays as read: it is matched against the transcript, never written.
 */
export function defuseTemplater(value: unknown, key = ""): unknown {
	if (typeof value === "string") return key === "source" ? value : value.split("<%").join("<\u200B%");
	if (Array.isArray(value)) return value.map((item) => defuseTemplater(item));
	if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, defuseTemplater(v, k)]));
	return value;
}

export function parseExtraction(raw: unknown, slots: readonly SlotDef[], fallbackDate: Date): ExtractionResult | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const answer = defuseTemplater(raw) as Record<string, unknown>;
	const writtenDate = resolveWrittenDate(typeof answer[PAGE_DATE_KEY] === "string" ? answer[PAGE_DATE_KEY] : null, fallbackDate);
	const pageDate = writtenDate ?? calendarDay(fallbackDate.getUTCFullYear(), fallbackDate.getUTCMonth(), fallbackDate.getUTCDate());
	const result: Record<string, SlotResult> = {};
	for (const slot of slots) {
		const value = answer[slot.id];
		if (isList(slot)) {
			const items = (Array.isArray(value) ? value : []).map((item) => readItem(item, slot, pageDate)).filter((item): item is ModelItem => item !== null);
			result[slot.id] = { kind: "items", items };
		} else if (slot.shape === "text") {
			const text = typeof value === "string" && !NONE.test(value.trim()) ? value.trim() : "";
			result[slot.id] = { kind: "text", text };
		} else {
			result[slot.id] = { kind: "value", value: readValue(value, slot) };
		}
	}
	return { slots: result, pageDate, writtenDate };
}
