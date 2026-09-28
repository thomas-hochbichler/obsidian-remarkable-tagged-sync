import { describe, expect, it } from "vitest";
import { calendarDay } from "./dates";
import { FIELD_TYPES, parseNumber } from "./field-types";

const ctx = { pageDate: calendarDay(2026, 8, 28) };
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

	it("resolves a date from the copied words, falling back to the class", () => {
		expect(FIELD_TYPES.date.resolve({ words: "bis Freitag", rel: "none" }, def("date"), ctx)).toBe("2026-10-02");
		expect(FIELD_TYPES.date.resolve({ words: 3, rel: "tomorrow" }, def("date"), ctx)).toBe("2026-09-29");
		expect(FIELD_TYPES.date.resolve({ words: "demain", rel: "sometime" }, def("date"), ctx)).toBeNull();
		expect(FIELD_TYPES.date.resolve(null, def("date"), ctx)).toBeNull();
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
