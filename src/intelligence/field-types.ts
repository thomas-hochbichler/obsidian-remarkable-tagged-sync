/**
 * The five Field types as one table: what the model is asked for (schema), and how its answer
 * becomes the string written into the note (resolve). Adding a type is a row here, never a branch
 * spread over schema builder, parser and renderer.
 */

import { type DateOrder, isoDay, namesOwnDay, readDue, resolveWrittenDate } from "./dates";
import { normaliseText } from "./matcher";
import type { FieldDef, FieldType } from "./settings";

export interface FieldContext {
	/** The page's date: what relative due words count from when the item has no anchor on the page. */
	pageDate: Date;
	/** The page's text, where an anchor has to stand -- above the item's own words. */
	transcript: string;
	/** The item's words on the page, copied by the model; null when it gave none. */
	source: string | null;
	dateOrder: DateOrder;
	/**
	 * How many days the page's new writing may span: from when its last version was seen to its last
	 * change on the device. Null when unknown. Beyond a day, "bis Fr" with nothing on the page to count
	 * from could mean either Friday.
	 */
	writtenSpanDays: number | null;
	/** The Profile carries the user's own rules for dates, so a model that disagrees with the tables may be following them. */
	userDateRules: boolean;
	/** Set by a Field whose value is not sure enough to be written without asking: the item becomes a proposal. */
	unsure: boolean;
}

interface FieldTypeRow {
	schema(def: FieldDef): Record<string, unknown>;
	resolve(raw: unknown, def: FieldDef, ctx: FieldContext): string | null;
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const text = (raw: unknown) => (typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null);
/** A model's string, unless it is empty or says "NONE" -- a local format pass writes the notes' NONE through (research 22). */
const given = (raw: unknown) => { const value = text(raw); return value === null || /^none$/i.test(value) ? null : value; };
/** A real calendar day as `YYYY-MM-DD`, or null. */
function isoOf(raw: unknown): string | null {
	const match = typeof raw === "string" ? /(\d{4})-(\d{2})-(\d{2})/.exec(raw) : null;
	if (!match) return null;
	const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	return date.getUTCMonth() === Number(match[2]) - 1 ? isoDay(date) : null;
}

/** Where `span` starts in the page's text, both normalised; -1 when it is not there. */
function positionIn(span: string, transcript: string): number {
	const needle = normaliseText(span);
	return needle === "" ? -1 : normaliseText(transcript).indexOf(needle);
}

/**
 * Whether a date heading -- a short line that is a date, as "03/10/2026" heads the next daily-log
 * entry -- stands between the anchor and the item: then the model skipped the nearer entry's date.
 * A line that merely mentions a date ("Zahnarzt am 14.10. um 9:00") is no heading.
 */
function nearerHeading(anchor: string, source: string | null, ctx: FieldContext): boolean {
	if (source === null) return false;
	const lines = ctx.transcript.split("\n");
	const lineOf = (span: string) => lines.findIndex((line) => normaliseText(line).includes(normaliseText(span)));
	const from = lineOf(anchor);
	const to = lineOf(source);
	if (from === -1 || to === -1) return false;
	return lines.slice(from + 1, to).some((line) => line.trim().split(/\s+/).length <= 4 && resolveWrittenDate(line, ctx.pageDate, ctx.dateOrder) !== null);
}

/**
 * A due date (research 32, 33). The model copies the due words and the **anchor** -- the date on the
 * page they count from, such as the day heading the daily-log entry the task stands in -- and gives
 * both as dates too. Code then decides:
 *
 * - the anchor counts only when it stands on the page above the item's words, with no nearer date
 *   heading between them; a small model writes a date it computed instead of copying one, or takes the
 *   entry before, and that check is what catches it;
 * - the tables read the anchor and the words where they can, and their answer wins; elsewhere, in a
 *   language without a table, the model's date is taken;
 * - the item is held for review when the anchor failed the check, when the model disagrees with the
 *   tables on a Profile that has its own date rules, or when a relative date has no anchor and the
 *   page was written over more than a day.
 */
function resolveDate(raw: unknown, ctx: FieldContext): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	// No due words on the page, no due date: the managed 8B model wrote "NONE" and the anchor's own
	// date as the due date (end-to-end run, 2026-10-09).
	const words = given(r.words);
	if (words === null) return null;
	const modelDate = isoOf(r.date);

	const anchor = given(r.anchor);
	const at = anchor === null ? -1 : positionIn(anchor, ctx.transcript);
	const itemAt = ctx.source === null ? -1 : positionIn(ctx.source, ctx.transcript);
	const anchored = anchor !== null && at !== -1 && (itemAt === -1 || at < itemAt);
	if (anchor !== null && (!anchored || nearerHeading(anchor, ctx.source, ctx))) ctx.unsure = true;
	const anchorIso = anchored ? isoOf(r.anchor_date) : null;
	const from = anchored ? (resolveWrittenDate(anchor, ctx.pageDate, ctx.dateOrder) ?? (anchorIso === null ? null : new Date(`${anchorIso}T00:00:00Z`))) : null;

	const read = readDue(words, from ?? ctx.pageDate, ctx.dateOrder);
	const value = read === undefined ? modelDate : read === null ? null : isoDay(read);
	if (read && modelDate !== null && modelDate !== value && ctx.userDateRules) ctx.unsure = true;
	if (value !== null && from === null && !namesOwnDay(words, ctx.pageDate, ctx.dateOrder) && (ctx.writtenSpanDays ?? 0) > 1) ctx.unsure = true;
	return value;
}

/** "12,90 €", "1.234,5", "62" → a plain decimal string; null for anything that is not one number. */
export function parseNumber(raw: string): string | null {
	const cleaned = raw.replace(/[^\d.,-]/g, "");
	if (!/\d/.test(cleaned)) return null;
	const lastComma = cleaned.lastIndexOf(",");
	const lastDot = cleaned.lastIndexOf(".");
	// The later separator is the decimal one when both appear; a lone comma is German decimal, a
	// lone dot followed by exactly three digits is a thousands separator ("1.234").
	let normalised: string;
	if (lastComma !== -1 && lastDot !== -1) normalised = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
	else if (lastComma !== -1) normalised = cleaned.replace(/\./g, "").replace(",", ".");
	else if (lastDot !== -1 && /^\d{1,3}(\.\d{3})+$/.test(cleaned.replace(/^-/, ""))) normalised = cleaned.replace(/\./g, "");
	else normalised = cleaned;
	const value = Number(normalised);
	return Number.isFinite(value) ? String(value) : null;
}

export const FIELD_TYPES: Record<FieldType, FieldTypeRow> = {
	text: {
		schema: () => nullable({ type: "string" }),
		resolve: text,
	},
	// Evidence first, then the dates: a model that has copied the words and the anchor invents less.
	date: {
		schema: () =>
			nullable({
				type: "object",
				properties: {
					words: { type: "string", description: "The due words exactly as written, e.g. 'bis Freitag'" },
					anchor: { anyOf: [{ type: "string", description: "The date written on the page these words count from, copied exactly -- usually the date of the entry the item stands in; null if the page gives none" }, { type: "null" }] },
					anchor_date: { anyOf: [{ type: "string", description: "The anchor as YYYY-MM-DD" }, { type: "null" }] },
					date: { anyOf: [{ type: "string", description: "The due date as YYYY-MM-DD" }, { type: "null" }] },
				},
				required: ["words", "anchor", "anchor_date", "date"],
				additionalProperties: false,
			}),
		resolve: (raw, _def, ctx) => resolveDate(raw, ctx),
	},
	// Asked as a string: "12,90 €" copied is safer than a number the model had to convert.
	number: {
		schema: () => nullable({ type: "string", description: "The amount as written" }),
		resolve: (raw) => (typeof raw === "string" ? parseNumber(raw) : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null),
	},
	choice: {
		schema: (def) => nullable({ type: "string", enum: def.options ?? [] }),
		resolve: (raw, def) => (typeof raw === "string" && (def.options ?? []).includes(raw) ? raw : null),
	},
	// The model returns a plain name (it drifts between "Name" and "[[Name]]"); code adds the brackets.
	link: {
		schema: () => nullable({ type: "string", description: "A plain name, without brackets" }),
		resolve: (raw) => {
			const name = text(typeof raw === "string" ? raw.replace(/^\[\[|\]\]$/g, "") : raw);
			return name === null ? null : `[[${name}]]`;
		},
	},
};
