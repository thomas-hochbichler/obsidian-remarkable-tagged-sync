/**
 * The five Field types as one table: what the model is asked for (schema), and how its answer
 * becomes the string written into the note (resolve). Adding a type is a row here, never a branch
 * spread over schema builder, parser and renderer.
 */

import { type DateRel, resolveDue } from "./dates";
import type { FieldDef, FieldType } from "./settings";

export interface FieldContext {
	/** The page's date, the reference for relative due words. */
	pageDate: Date;
}

interface FieldTypeRow {
	schema(def: FieldDef): Record<string, unknown>;
	resolve(raw: unknown, def: FieldDef, ctx: FieldContext): string | null;
}

const DATE_RELS: DateRel[] = ["today", "tomorrow", "this-week", "next-week", "end-of-month", "next-month", "none"];

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const text = (raw: unknown) => (typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null);

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
	// The model copies the words off the page and a coarse class; code computes the date (research 10).
	date: {
		schema: () =>
			nullable({
				type: "object",
				properties: { words: { type: "string", description: "The due words exactly as written, e.g. 'bis Freitag'" }, rel: { type: "string", enum: DATE_RELS } },
				required: ["words", "rel"],
				additionalProperties: false,
			}),
		resolve: (raw, _def, ctx) => {
			if (typeof raw !== "object" || raw === null) return null;
			const { words, rel } = raw as { words?: unknown; rel?: unknown };
			return resolveDue(typeof words === "string" ? words : null, DATE_RELS.includes(rel as DateRel) ? (rel as DateRel) : null, ctx.pageDate);
		},
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
