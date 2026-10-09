import { describe, expect, it } from "vitest";
import { calendarDay } from "./dates";
import { type FieldContext, FIELD_TYPES, parseNumber } from "./field-types";

const ctx: FieldContext = { pageDate: calendarDay(2026, 8, 28), transcript: "", source: null, dateOrder: "dmy", writtenSpanDays: null, userDateRules: false, unsure: false };

// The user's weekly daily log (2026-10-09): one entry per day, each headed by its date, synced weeks later.
const LOG = "Woche 40\n01/10/2026\nAngebot an Müller schicken bis Mo\n02/10/2026\nKunde angerufen\nbis FR Rechnung erstellen";
/** The date a due Field resolves to on the log, and whether it held the item back. */
function due(raw: Record<string, unknown>, over: Partial<FieldContext> = {}): [string | null, boolean] {
	const c: FieldContext = { ...ctx, pageDate: calendarDay(2026, 9, 21), transcript: LOG, source: "bis FR Rechnung erstellen", ...over, unsure: false };
	return [FIELD_TYPES.date.resolve({ words: "bis FR", anchor: null, anchor_date: null, date: null, ...raw }, def("date"), c), c.unsure];
}
const def = (type: "text" | "date" | "number" | "choice" | "link", options?: string[]) => ({ name: "f", type, options });

describe("parseNumber", () => {
	it("reads German and English decimals, thousands separators and currency noise", () => {
		expect(parseNumber("12,90 €")).toBe("12.9");
		expect(parseNumber("1.234,50")).toBe("1234.5");
		expect(parseNumber("1,234.50")).toBe("1234.5");
		expect(parseNumber("1.234")).toBe("1234");
		expect(parseNumber("8.45")).toBe("8.45");
		expect(parseNumber("62")).toBe("62");
		expect(parseNumber("-3,5")).toBe("-3.5");
	});

	it("gives null for words or a malformed number", () => {
		expect(parseNumber("viel")).toBeNull();
		expect(parseNumber("1-2")).toBeNull();
	});
});

describe("FIELD_TYPES", () => {
	it("makes every field nullable in the schema, a choice closed to its options", () => {
		for (const type of ["text", "date", "number", "choice", "link"] as const) expect(FIELD_TYPES[type].schema(def(type))).toHaveProperty("anyOf");
		expect(FIELD_TYPES.choice.schema(def("choice", ["gut", "ok"]))).toEqual({ anyOf: [{ type: "string", enum: ["gut", "ok"] }, { type: "null" }] });
		expect(FIELD_TYPES.choice.schema(def("choice"))).toEqual({ anyOf: [{ type: "string", enum: [] }, { type: "null" }] });
	});

	it("counts due words from the anchor the model copied: the date of the entry the item stands in", () => {
		// Synced on the 21st; "bis FR" under Friday 2 October is the Friday after.
		expect(due({ anchor: "02/10/2026", anchor_date: "2026-10-02", date: "2026-10-09" })).toEqual(["2026-10-09", false]);
		expect(due({ words: "bis Mo", anchor: "01/10/2026" }, { source: "Angebot an Müller schicken bis Mo" })).toEqual(["2026-10-05", false]);
	});

	it("holds the item back when the anchor is not on the page above it", () => {
		// A small model writes the date it computed instead of copying one (research 33).
		expect(due({ anchor: "2026-10-02", date: "2026-10-09" })).toEqual(["2026-10-23", true]);
		// The next entry's date is below the item, so it cannot be what the item counts from.
		expect(due({ words: "bis Mo", anchor: "02/10/2026" }, { source: "Angebot an Müller schicken bis Mo" })[1]).toBe(true);
	});

	it("holds the item back when a nearer date heading stands between the anchor and it, but not for a date merely mentioned", () => {
		// The managed 8B model took the entry before for "morgen Rasen mähen" (end-to-end run, 2026-10-09).
		const log = `${LOG}\n03/10/2026\nGarten\nmorgen Rasen mähen`;
		expect(due({ words: "morgen", anchor: "02/10/2026" }, { transcript: log, source: "morgen Rasen mähen" })).toEqual(["2026-10-03", true]);
		expect(due({ words: "morgen", anchor: "03/10/2026" }, { transcript: log, source: "morgen Rasen mähen" })).toEqual(["2026-10-04", false]);
		const visit = "07/10/2026\nZahnarzt am 14.10. um 9:00\nbis Montag Überweisung holen";
		expect(due({ words: "bis Montag", anchor: "07/10/2026" }, { transcript: visit, source: "bis Montag Überweisung holen" })).toEqual(["2026-10-12", false]);
	});

	it("takes the model's date where no table reads the words, from an anchor no table reads either", () => {
		const page = "Lundi 12 octobre\nEnvoyer le devis avant jeudi";
		const raw = { words: "avant jeudi", anchor: "Lundi 12 octobre", anchor_date: "2026-10-12", date: "2026-10-15" };
		expect(due(raw, { transcript: page, source: "Envoyer le devis avant jeudi" })).toEqual(["2026-10-15", false]);
		expect(due({ ...raw, date: "2026-02-31" }, { transcript: page, source: "Envoyer le devis avant jeudi" })).toEqual([null, false]);
	});

	it("lets the tables win a disagreement, and holds the item back when the Profile has date rules of its own", () => {
		const raw = { anchor: "02/10/2026", anchor_date: "2026-10-02", date: "2026-10-02" };
		expect(due(raw)).toEqual(["2026-10-09", false]);
		expect(due(raw, { userDateRules: true })).toEqual(["2026-10-09", true]);
	});

	it("holds back a relative date without an anchor once the page was written over more than a day", () => {
		const page = { transcript: "Einkauf\nbis Fr Paket abholen", source: "bis Fr Paket abholen", pageDate: calendarDay(2026, 9, 14) };
		expect(due({ words: "bis Fr" }, { ...page, writtenSpanDays: 0.5 })).toEqual(["2026-10-16", false]);
		expect(due({ words: "bis Fr" }, { ...page, writtenSpanDays: 5 })).toEqual(["2026-10-16", true]);
		expect(due({ words: "bis Fr" }, { ...page, writtenSpanDays: null })).toEqual(["2026-10-16", false]);
		// A date of its own needs nothing to count from.
		expect(due({ words: "bis 20.10." }, { ...page, writtenSpanDays: 5 })).toEqual(["2026-10-20", false]);
	});

	it("reads a slashed anchor month first when the user writes dates that way", () => {
		const page = "10/05/2026\nSend invoice to ACME by Thursday";
		expect(due({ words: "by Thursday", anchor: "10/05/2026" }, { transcript: page, source: "Send invoice to ACME by Thursday", dateOrder: "mdy" })).toEqual(["2026-10-08", false]);
	});

	it("gives no date for nothing, junk, a day that is none, or the NONE a local format pass copies", () => {
		expect(FIELD_TYPES.date.resolve(null, def("date"), { ...ctx })).toBeNull();
		expect(due({ words: 3 })).toEqual([null, false]);
		expect(due({ words: "irgendwann", date: "2026-10-30" })).toEqual([null, false]);
		expect(due({ words: " none ", date: null })).toEqual([null, false]);
		// A date with no words behind it is made up: the 8B model gave the anchor's own date.
		expect(due({ words: "NONE", anchor: "02/10/2026", date: "2026-10-02" })).toEqual([null, false]);
	});

	it("resolves text trimmed and empty text as null", () => {
		expect(FIELD_TYPES.text.resolve(" Anna ", def("text"), ctx)).toBe("Anna");
		expect(FIELD_TYPES.text.resolve("  ", def("text"), ctx)).toBeNull();
		expect(FIELD_TYPES.text.resolve(5, def("text"), ctx)).toBeNull();
	});

	it("resolves a number copied as text or given as a number", () => {
		expect(FIELD_TYPES.number.resolve("12,90 €", def("number"), ctx)).toBe("12.9");
		expect(FIELD_TYPES.number.resolve(7.2, def("number"), ctx)).toBe("7.2");
		expect(FIELD_TYPES.number.resolve(Number.NaN, def("number"), ctx)).toBeNull();
		expect(FIELD_TYPES.number.resolve(null, def("number"), ctx)).toBeNull();
	});

	it("keeps a choice only when it is one of the options", () => {
		expect(FIELD_TYPES.choice.resolve("gut", def("choice", ["gut", "ok"]), ctx)).toBe("gut");
		expect(FIELD_TYPES.choice.resolve("super", def("choice", ["gut", "ok"]), ctx)).toBeNull();
		expect(FIELD_TYPES.choice.resolve("gut", def("choice"), ctx)).toBeNull();
	});

	it("wraps a link in brackets whether or not the model already did", () => {
		expect(FIELD_TYPES.link.resolve("Anna", def("link"), ctx)).toBe("[[Anna]]");
		expect(FIELD_TYPES.link.resolve("[[Anna]]", def("link"), ctx)).toBe("[[Anna]]");
		expect(FIELD_TYPES.link.resolve("", def("link"), ctx)).toBeNull();
		expect(FIELD_TYPES.link.resolve(null, def("link"), ctx)).toBeNull();
	});
});
