import { describe, expect, it } from "vitest";
import { calendarDay, isoDay, resolveDue, resolveWrittenDate } from "./dates";

// Monday, 28 September 2026.
const MON = calendarDay(2026, 8, 28);
const due = (words: string | null, rel: Parameters<typeof resolveDue>[1] = null, ref = MON) => resolveDue(words, rel, ref);

describe("resolveDue > absolute dates", () => {
	it("reads ISO, German day-month with and without year, and month names in both languages", () => {
		expect(due("2026-10-05")).toBe("2026-10-05");
		expect(due("bis 30.09. !! wichtig")).toBe("2026-09-30");
		expect(due("bis 5.10")).toBe("2026-10-05");
		expect(due("am 1.10.26")).toBe("2026-10-01");
		expect(due("1.10.2027")).toBe("2027-10-01");
		expect(due("5. Oktober")).toBe("2026-10-05");
		expect(due("3. März 2027")).toBe("2027-03-03");
		expect(due("by Oct 5th")).toBe("2026-10-05");
		expect(due("October 5, 2027")).toBe("2027-10-05");
	});

	it("puts a due date without a year into next year when this year's is long past", () => {
		expect(due("bis 15.1.", null, calendarDay(2026, 11, 20))).toBe("2027-01-15");
		expect(due("bis 20.9.")).toBe("2026-09-20");
	});

	it("reads nothing from a time or an impossible date", () => {
		expect(due("um 14.30")).toBeNull();
		expect(due("31.2.")).toBeNull();
		expect(due("2026-02-31")).toBeNull();
		expect(due("30. Februar")).toBeNull();
	});
});

describe("resolveDue > relative words", () => {
	it("reads today, tomorrow and the day after in German and English", () => {
		expect(due("heute")).toBe("2026-09-28");
		expect(due("heute morgen")).toBe("2026-09-28");
		expect(due("morgen")).toBe("2026-09-29");
		expect(due("übermorgen")).toBe("2026-09-30");
		expect(due("tomorrow")).toBe("2026-09-29");
		expect(due("the day after tomorrow")).toBe("2026-09-30");
	});

	it("reads a weekday as its next occurrence after the page's date", () => {
		expect(due("bis Freitag")).toBe("2026-10-02");
		expect(due("by friday")).toBe("2026-10-02");
		expect(due("Montag")).toBe("2026-10-05");
		expect(due("Fr.")).toBe("2026-10-02");
		expect(due("do")).toBe("2026-10-01");
	});

	it("does not read an English word as a German weekday abbreviation", () => {
		expect(due("do it so the team can start")).toBeNull();
	});

	it("reads this week and next week as their Friday, and month ends as the last day", () => {
		expect(due("diese Woche")).toBe("2026-10-02");
		expect(due("bis nächste Woche")).toBe("2026-10-09");
		expect(due("next week")).toBe("2026-10-09");
		expect(due("Monatsende")).toBe("2026-09-30");
		expect(due("next month")).toBe("2026-10-31");
	});

	it("reads in N days, weeks and months, in digits or words", () => {
		expect(due("in 6 Wochen")).toBe("2026-11-09");
		expect(due("in drei Tagen")).toBe("2026-10-01");
		expect(due("in two weeks")).toBe("2026-10-12");
		expect(due("in einem Monat", null, calendarDay(2026, 0, 31))).toBe("2026-02-28");
	});

	it("reads someday as no date", () => {
		expect(due("Fenster putzen, irgendwann")).toBeNull();
		expect(due("someday")).toBeNull();
	});
});

describe("resolveDue > fallback to the model's class", () => {
	it("uses the class only for words no language table reads", () => {
		expect(due("la semaine prochaine", "next-week")).toBe("2026-10-09");
		expect(due("demain", "tomorrow")).toBe("2026-09-29");
		expect(due("aujourd'hui", "today")).toBe("2026-09-28");
		expect(due("cette semaine", "this-week")).toBe("2026-10-02");
		expect(due("fin du mois", "end-of-month")).toBe("2026-09-30");
		expect(due("le mois prochain", "next-month")).toBe("2026-10-31");
		expect(due("bis Freitag", "tomorrow")).toBe("2026-10-02");
	});

	it("gives no date when neither the words nor the class name one", () => {
		expect(due("un jour", "none")).toBeNull();
		expect(due(null, null)).toBeNull();
		expect(due("", "tomorrow")).toBe("2026-09-29");
	});
});

describe("resolveWrittenDate", () => {
	it("reads the date written on the page, preferring the past for a date without a year", () => {
		expect(isoDay(resolveWrittenDate("Mo 28.9.", MON)!)).toBe("2026-09-28");
		expect(isoDay(resolveWrittenDate("30.12.", calendarDay(2027, 0, 3))!)).toBe("2026-12-30");
	});

	it("reads nothing relative or missing", () => {
		expect(resolveWrittenDate("heute", MON)).toBeNull();
		expect(resolveWrittenDate(null, MON)).toBeNull();
	});
});
