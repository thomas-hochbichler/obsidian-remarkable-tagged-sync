/**
 * Templates are any Markdown note. The engine fills `{{ts.*}}` and the core variables itself; neither
 * core Templates nor Templater is required (Templater, when installed, gets the rendered string).
 *
 * Where a Slot's placeholder sits decides what the engine may do with it later: alone under its own
 * heading it becomes a merged Region; anywhere else (a sentence, a callout, a table, two under one
 * heading) it is filled once at creation and never touched again -- there is no region to find.
 */

import { headings, type Heading } from "./regions";

export type Placement = { kind: "region"; heading: Heading } | { kind: "once" } | { kind: "absent" };

const slotPlaceholder = (id: string) => `{{ts.${id}}}`;

/** Where each Slot's body placeholder sits in the template. */
export function analyseTemplate(template: string, slotIds: readonly string[]): Record<string, Placement> {
	const lines = template.split("\n");
	const all = headings(lines);
	const result: Record<string, Placement> = {};
	for (const id of slotIds) {
		const needle = slotPlaceholder(id);
		const at = lines.findIndex((line) => line.includes(needle));
		if (at === -1) {
			result[id] = { kind: "absent" };
			continue;
		}
		const owner = [...all].reverse().find((h) => h.line < at);
		const next = all.find((h) => h.line > at);
		const body = owner ? lines.slice(owner.line + 1, next ? next.line : lines.length).filter((line) => line.trim() !== "") : [];
		result[id] = owner && body.length === 1 && body[0].trim() === needle ? { kind: "region", heading: { level: owner.level, text: owner.text } } : { kind: "once" };
	}
	return result;
}

export interface TemplateValues {
	/** `ts.date.written` etc., and `ts.<slotId>` with the Slot's rendered body. */
	ts: Record<string, string>;
	title: string;
	/** Formats `{{date}}` / `{{date:FORMAT}}` and `{{time}}` / `{{time:FORMAT}}`; the default format when none is given. */
	formatDate: (format: string | null) => string;
	formatTime: (format: string | null) => string;
}

/**
 * Fills the template. An unknown `{{ts.*}}` is left as written, so a typo shows in the note instead of
 * vanishing; a Slot with nothing extracted fills in as an empty region under its heading.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
	return template.replace(/\{\{\s*(ts\.[\w.-]+|title|date|time)(?::([^}]*))?\s*\}\}/g, (whole, name: string, format: string | undefined) => {
		if (name === "title") return values.title;
		if (name === "date") return values.formatDate(format ?? null);
		if (name === "time") return values.formatTime(format ?? null);
		const value = values.ts[name.slice(3)];
		return value === undefined ? whole : value;
	});
}

/** The built-in default template, and the starter "Create template" writes: one heading and placeholder per Slot, plus the page link. */
export function starterTemplate(slots: readonly { id: string; name: string }[]): string {
	return [...slots.flatMap((slot) => [`## ${slot.name}`, slotPlaceholder(slot.id), ""]), "## Page", "{{ts.page.link}}", ""].join("\n");
}
