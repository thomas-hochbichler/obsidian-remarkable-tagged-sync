import { describe, expect, it } from "vitest";
import { compileItemFormat } from "./item-format";

const tasks = compileItemFormat("- [ ] {{text}} 📅 {{due}}");
const dataview = compileItemFormat("- [ ] {{text}} [due:: {{due}}]");
const list = compileItemFormat("- {{text}}");

describe("compileItemFormat > render", () => {
	it("writes an item through the format", () => {
		expect(tasks.render({ text: "Call Bob", fields: { due: "2026-10-01" } })).toBe("- [ ] Call Bob 📅 2026-10-01");
		expect(dataview.render({ text: "Call Bob", fields: { due: "2026-10-01" } })).toBe("- [ ] Call Bob [due:: 2026-10-01]");
	});

	it("drops a field together with the words that label it when the field is empty", () => {
		// Leaving the label behind would write "- [ ] Call Bob 📅" or "[due:: ]" -- a Tasks query
		// then reads a due date that is not there.
		expect(tasks.render({ text: "Call Bob", fields: {} })).toBe("- [ ] Call Bob");
		expect(dataview.render({ text: "Call Bob", fields: { due: null } })).toBe("- [ ] Call Bob");
	});

	it("writes the checkbox state it is given and keeps the trailing fields of the line it replaces", () => {
		expect(tasks.render({ text: "Call Bob", fields: {}, checkbox: "x", trailing: "✅ 2026-09-30" })).toBe("- [x] Call Bob ✅ 2026-09-30");
	});

	it("ignores a checkbox state for a format without a checkbox", () => {
		expect(list.render({ text: "Ship it", fields: {}, checkbox: "x" })).toBe("- Ship it");
	});

	it("leaves a second field in the same word empty when only the first has a value", () => {
		const money = compileItemFormat("- {{text}} {{amount}}{{currency}}");
		expect(money.render({ text: "Lunch", fields: { amount: "12" } })).toBe("- Lunch 12");
	});

	it("keeps literal words after the last placeholder", () => {
		expect(compileItemFormat("- {{text}} #task").render({ text: "Ship it", fields: {} })).toBe("- Ship it #task");
	});
});

describe("compileItemFormat > parse", () => {
	it("reads text and fields back from a line it wrote", () => {
		expect(tasks.parse("- [ ] Call Bob 📅 2026-10-01")).toEqual({ text: "Call Bob", fields: { due: "2026-10-01" }, checkbox: " ", trailing: "" });
		expect(dataview.parse("- [ ] Call Bob [due:: 2026-10-01]")).toEqual({ text: "Call Bob", fields: { due: "2026-10-01" }, checkbox: " ", trailing: "" });
	});

	it("reads a line whose optional field the user removed", () => {
		expect(tasks.parse("- [ ] Call Bob")).toEqual({ text: "Call Bob", fields: {}, checkbox: " ", trailing: "" });
	});

	it("treats the checkbox character as a wildcard", () => {
		expect(tasks.parse("- [x] Call Bob")?.checkbox).toBe("x");
		expect(tasks.parse("- [/] Call Bob")?.checkbox).toBe("/");
	});

	it("tolerates the trailing fields the Tasks plugin appends", () => {
		expect(tasks.parse("- [x] Call Bob 📅 2026-10-01 ⏫ 🔁 every week ✅ 2026-09-30")).toEqual({
			text: "Call Bob",
			fields: { due: "2026-10-01" },
			checkbox: "x",
			trailing: "⏫ 🔁 every week ✅ 2026-09-30",
		});
	});

	it("tolerates indentation and extra spaces", () => {
		expect(tasks.parse("   - [ ]   Call   Bob  📅 2026-10-01 ")?.text).toBe("Call   Bob");
	});

	it("returns null for a line that is not an item: prose, callouts, headings, blank lines", () => {
		for (const line of ["Some prose", "> [!todo] 2 proposals", "## Tasks", "", "- [ ] ", "- [ ]     "]) expect(tasks.parse(line)).toBeNull();
	});

	it("reads a line with a format's regex characters literally", () => {
		const odd = compileItemFormat("- {{text}} (${{amount}})");
		expect(odd.parse("- Lunch ($12)")).toEqual({ text: "Lunch", fields: { amount: "12" }, checkbox: null, trailing: "" });
	});

	it("names the fields a format places", () => {
		expect(dataview.fieldNames).toEqual(["due"]);
	});
});

describe("compileItemFormat > rejects", () => {
	it("a format without {{text}}", () => {
		expect(() => compileItemFormat("- [ ] {{due}}")).toThrow(/\{\{text\}\}/);
	});
});
