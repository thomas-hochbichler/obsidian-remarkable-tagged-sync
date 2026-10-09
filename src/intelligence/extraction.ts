/**
 * What the extraction asks for and how the answer is read. One JSON schema is assembled from the
 * Profile's Slots plus a hidden `page_date_text`; item keys are ordered evidence → reason → value
 * (`source`, `reason`, then `text`), because a model that has copied the words first invents less.
 *
 * The answer is read defensively: whatever the backend enforced, this is the boundary where model
 * output becomes typed data, so every field is checked here and nothing downstream re-checks.
 */

import { calendarDay, type DateOrder, resolveWrittenDate } from "./dates";
import { type FieldContext, FIELD_TYPES } from "./field-types";
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

/** What due dates are read against, beyond the page itself -- see `FieldContext`. */
export interface DateReading {
	order: DateOrder;
	writtenSpanDays: number | null;
	userRules: boolean;
}

export const PLAIN_DATES: DateReading = { order: "dmy", writtenSpanDays: null, userRules: false };

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

const DAY_MS = 86_400_000;

/**
 * Every day from a week before the earliest date on the page to five weeks after the latest, the
 * reference included, each with its weekday: a model that looks a weekday up instead of counting gets
 * it right far more often (research 32). Bounded, so a stray year on the page cannot blow it up.
 */
export function calendarFor(transcript: string, reference: Date, order: DateOrder): string {
	const found = transcript.split("\n").map((line) => resolveWrittenDate(line, reference, order)).filter((date): date is Date => date !== null);
	const times = [reference, ...found].map((date) => date.getTime()).filter((time) => Math.abs(time - reference.getTime()) <= 120 * DAY_MS);
	const days: string[] = [];
	for (let time = Math.min(...times) - 7 * DAY_MS; time <= Math.max(...times) + 35 * DAY_MS; time += DAY_MS) {
		const day = new Date(time);
		days.push(`${WEEKDAYS[day.getUTCDay()].slice(0, 3)} ${day.toISOString().slice(0, 10)}`);
	}
	return days.join(", ");
}

/** The rules for a due date, when a Slot asks for one: anchor, conventions, calendar, and the user's own words. */
export function dateRules(input: { profile: ProfileDef; slots: readonly SlotDef[]; transcript: string; referenceDate: Date; dates?: DateReading }): string[] {
	if (!input.slots.some((slot) => slot.fields.some((field) => field.type === "date"))) return [];
	const order = (input.dates ?? PLAIN_DATES).order;
	return [
		"",
		"## Due dates",
		`Dates on this device are written ${order === "mdy" ? "month/day" : "day/month"}. The page may have been written days or weeks before it was first seen.`,
		"For each due date, find its anchor: the date written on the page that the due words count from -- usually the date of the day, entry or section the item stands under. A date that names an event, an appointment or a deadline is not an anchor. Copy the anchor exactly, and null if the page gives none: then count from the day the page was first seen.",
		"A weekday means its next occurrence after the anchor; the same weekday means a week later. \"Next week\" without a day, or a week number, means the Friday of that week. A time alone names no day.",
		...(input.profile.dates?.trim() ? [`About dates on these pages, from the user: ${input.profile.dates.trim()}`] : []),
		`Calendar: ${calendarFor(input.transcript, input.referenceDate, order)}`,
	];
}

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

export const TASK_CRITERIA = [
	"How to recognise a task in handwritten notes. Notes are terse, so a task rarely looks like a full sentence. A line is a task when it says what someone should still do:",
	"- it starts with or contains a verb of doing (check, fix, ask, run, deploy, test, create, merge, switch, move, prepare, send, call, plan, analyse, restart, upgrade, prüfen, schicken, anrufen, erledigen, ...), even if misspelled;",
	'- or it assigns a piece of work to a person with an arrow, colon or dash ("Backup -> Anna", "Max: Rollout-Plan");',
	"- or it is a numbered step or an item under a heading such as To do, Plan, Prepare, Sprint planning, Don't forget, Next.",
	"A line is NOT a task when it records a decision or agreement (\"Entsch.:\", \"Decision:\", \"decided:\", \"beschlossen\") -- what was decided is not left to do, even when it names an amount or a date.",
	"A line is NOT a task when it is a status or result (\"done\", \"deployed at 14:00\", a tick mark), an observation, an insight or a question, a heading, or one of several names/components listed under a task line (those belong to the task above; do not list them one by one).",
];

/**
 * What a mark on the page means for a task (research 31). The transcript keeps the marks, so they decide:
 * boxes and strike-through mean the same to everyone. Signs of a notation -- a Bullet Journal's dot,
 * cross, arrows and circle -- do not: a dot is a task there and a plain list bullet elsewhere, so their
 * meaning comes from the Profile ("Signs on these pages"), never from here.
 */
export function markRules(input: { profile: ProfileDef; slots: readonly SlotDef[] }): string[] {
	if (!input.slots.some((slot) => slot.id === "tasks")) return [];
	const signs = input.profile.signs?.trim();
	return [
		"",
		"Marks on the page decide. An empty checkbox before a line is an open task. A ticked or crossed checkbox is a task that is done: set done to true. Leave out a line that is struck through (~~like this~~ in the page text). Where one word is struck and another written beside it, use the word that is not struck.",
		...(signs ? [`The signs at the start of a line on these pages, from the user: ${signs}`] : []),
	];
}

/** Signs of the Bullet Journal (Ryder Carroll), offered in the Profile dialog; the measured wording of research 31. */
export const BULLET_JOURNAL_SIGNS =
	"Bullet Journal. A dot (•) before a line is an open task. An X before a line is a task that is done: set done to true. A line starting with > (migrated) or < (scheduled) is not open here: leave it out. A circle (○) before a line is an event and a dash (— or -) a note: neither is a task.";

/** The one-call prompt (cloud). The local two-call prompts live with the local backend. */
export function buildPrompt(input: { profile: ProfileDef; slots: readonly SlotDef[]; transcript: string; referenceDate: Date; known: Record<string, readonly KnownItem[]>; dates?: DateReading }): { system: string; user: string } {
	const day = input.referenceDate;
	const system = [
		"You extract structured information from one handwritten notebook page.",
		"The page text below came from handwriting recognition and may contain recognition errors.",
		"Only extract what is written on the page. Never invent items. Copy `source` exactly from the page text.",
		"For due dates, copy the words and their anchor as written, then give both as dates by the rules below.",
		"Write everything you phrase yourself, such as a summary, in the language the page is written in.",
		// Every path that fills the Tasks Slot gets the criteria, not only the local line pass: a model that
		// reasons skipped that pass and, with nothing else said, made "Entsch.: Klassenkasse 15 € pro Kind"
		// a payment to do and split a packing list into three tasks (live test, 2026-10-09; research 34).
		...(input.slots.some((slot) => slot.id === "tasks") ? ["", ...TASK_CRITERIA] : []),
		...markRules(input),
	].join("\n");
	const user = [
		`Page type: ${input.profile.description}`,
		`The page was first seen on ${WEEKDAYS[day.getUTCDay()]}, ${day.toISOString().slice(0, 10)}.`,
		...dateRules(input),
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

function readItem(raw: unknown, slot: SlotDef, page: Omit<FieldContext, "source" | "unsure">): ModelItem | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const text = typeof r.text === "string" ? r.text.trim() : "";
	if (text === "" || NONE.test(text)) return null;
	const id = typeof r.id === "string" && r.id !== "new" && r.id.trim() !== "" ? r.id : null;
	const source = typeof r.source === "string" && r.source.trim() !== "" ? r.source : null;
	const ctx: FieldContext = { ...page, source, unsure: false };
	const fields: Fields = {};
	for (const field of slot.fields) fields[field.name] = FIELD_TYPES[field.type].resolve(r[field.name], field, ctx);
	const item: ModelItem = { id, text, fields, source };
	if (ctx.unsure) item.unsure = true;
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

export function parseExtraction(raw: unknown, slots: readonly SlotDef[], fallbackDate: Date, transcript = "", dates: DateReading = PLAIN_DATES): ExtractionResult | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const answer = defuseTemplater(raw) as Record<string, unknown>;
	const writtenDate = resolveWrittenDate(typeof answer[PAGE_DATE_KEY] === "string" ? answer[PAGE_DATE_KEY] : null, fallbackDate, dates.order);
	const pageDate = writtenDate ?? calendarDay(fallbackDate.getUTCFullYear(), fallbackDate.getUTCMonth(), fallbackDate.getUTCDate());
	const page = { pageDate, transcript, dateOrder: dates.order, writtenSpanDays: dates.writtenSpanDays, userDateRules: dates.userRules };
	const result: Record<string, SlotResult> = {};
	for (const slot of slots) {
		const value = answer[slot.id];
		if (isList(slot)) {
			const items = (Array.isArray(value) ? value : []).map((item) => readItem(item, slot, page)).filter((item): item is ModelItem => item !== null);
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
