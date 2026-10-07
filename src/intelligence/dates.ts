/**
 * Dates are resolved in code, not by the model: a 7-8B model normalises relative dates badly, and on
 * the measured date page a small rule parser over the copied surface words got 6 of 6 where the
 * model's own class got 4 of 6 (research 10). The model copies the words ("bis Freitag") and a coarse
 * `rel` class; this module turns them into an ISO date, relative to the page's date.
 *
 * Languages are a table. A language without an entry falls back to the model's `rel` class, which is
 * less reliable -- documented, not hidden.
 */

export type DateRel = "today" | "tomorrow" | "this-week" | "next-week" | "end-of-month" | "next-month" | "none";

interface Locale {
	/** Index 0 = Sunday, as `Date.getUTCDay`. Each entry lists the forms that name that day. */
	weekdays: string[][];
	/** Index 0 = January. */
	months: string[][];
	today: string[];
	tomorrow: string[];
	dayAfterTomorrow: string[];
	thisWeek: string[];
	nextWeek: string[];
	endOfMonth: string[];
	nextMonth: string[];
	never: string[];
	/** "in 3 Tagen" / "in 3 days": the unit words, each mapped to days or months. */
	units: { words: string[]; days?: number; months?: number }[];
	numbers: Record<string, number>;
}

export const DATE_LOCALES: Record<string, Locale> = {
	de: {
		weekdays: [["sonntag", "so"], ["montag", "mo"], ["dienstag", "di"], ["mittwoch", "mi"], ["donnerstag", "do"], ["freitag", "fr"], ["samstag", "sa", "sonnabend"]],
		months: [["januar", "jan", "jänner"], ["februar", "feb"], ["märz", "mär", "maerz"], ["april", "apr"], ["mai"], ["juni", "jun"], ["juli", "jul"], ["august", "aug"], ["september", "sep", "sept"], ["oktober", "okt"], ["november", "nov"], ["dezember", "dez"]],
		today: ["heute"],
		tomorrow: ["morgen"],
		dayAfterTomorrow: ["übermorgen"],
		thisWeek: ["diese woche", "ende der woche", "wochenende"],
		nextWeek: ["nächste woche", "nächster woche", "kommende woche"],
		endOfMonth: ["ende des monats", "monatsende", "ende monat"],
		nextMonth: ["nächsten monat", "nächster monat", "kommenden monat"],
		never: ["irgendwann", "demnächst", "bei gelegenheit"],
		units: [{ words: ["tag", "tage", "tagen"], days: 1 }, { words: ["woche", "wochen"], days: 7 }, { words: ["monat", "monate", "monaten"], months: 1 }],
		numbers: { ein: 1, einem: 1, einer: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10 },
	},
	en: {
		weekdays: [["sunday", "sun"], ["monday", "mon"], ["tuesday", "tue", "tues"], ["wednesday", "wed"], ["thursday", "thu", "thurs"], ["friday", "fri"], ["saturday", "sat"]],
		months: [["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"], ["may"], ["june", "jun"], ["july", "jul"], ["august", "aug"], ["september", "sep", "sept"], ["october", "oct"], ["november", "nov"], ["december", "dec"]],
		today: ["today", "tonight"],
		tomorrow: ["tomorrow"],
		dayAfterTomorrow: ["day after tomorrow"],
		thisWeek: ["this week", "end of the week", "end of week", "weekend"],
		nextWeek: ["next week"],
		endOfMonth: ["end of the month", "end of month", "month end"],
		nextMonth: ["next month"],
		never: ["someday", "sometime", "eventually"],
		units: [{ words: ["day", "days"], days: 1 }, { words: ["week", "weeks"], days: 7 }, { words: ["month", "months"], months: 1 }],
		numbers: { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 },
	},
};

const DAY = 86_400_000;

/** A calendar day, as UTC midnight, so no time zone or DST shift can move it. */
export function calendarDay(year: number, month: number, day: number): Date {
	return new Date(Date.UTC(year, month, day));
}

export function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
const lastOfMonth = (year: number, month: number) => calendarDay(year, month + 1, 0);
const fridayOf = (date: Date) => addDays(date, (5 - date.getUTCDay() + 7) % 7);

function addMonths(date: Date, months: number): Date {
	const target = calendarDay(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
	return calendarDay(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), lastOfMonth(target.getUTCFullYear(), target.getUTCMonth()).getUTCDate()));
}

const word = (text: string, phrase: string) => new RegExp(`(^|[^\\p{L}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(text);
const any = (text: string, phrases: string[]) => phrases.some((phrase) => word(text, phrase));

/**
 * A day and month without a year: the year of `ref`, unless that lands more than half a year away,
 * then the neighbouring year. `bias` -1 prefers the past (a page's written date), +1 the future (a due date).
 */
function nearestYear(month: number, day: number, ref: Date, bias: 1 | -1): Date | null {
	if (month < 0 || month > 11 || day < 1 || day > 31) return null;
	let date = calendarDay(ref.getUTCFullYear(), month, day);
	if (date.getUTCMonth() !== month) return null;
	const halfYear = 183 * DAY;
	if (bias > 0 && date.getTime() < ref.getTime() - halfYear) date = calendarDay(ref.getUTCFullYear() + 1, month, day);
	if (bias < 0 && date.getTime() > ref.getTime() + 31 * DAY) date = calendarDay(ref.getUTCFullYear() - 1, month, day);
	return date;
}

function withYear(year: string, month: number, day: number): Date | null {
	const full = year.length === 2 ? 2000 + Number(year) : Number(year);
	const date = calendarDay(full, month, day);
	return date.getUTCMonth() === month ? date : null;
}

/** An absolute date in the words: ISO, `dd.mm.(yy)yy`, or a day with a month name. */
function absolute(text: string, ref: Date, bias: 1 | -1): Date | null {
	const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
	if (iso) return withYear(iso[1], Number(iso[2]) - 1, Number(iso[3]));
	const dotted = /(?:^|[^\d])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}(?!\d))?)?(?![\d.])/.exec(text);
	if (dotted) return dotted[3] ? withYear(dotted[3], Number(dotted[2]) - 1, Number(dotted[1])) : nearestYear(Number(dotted[2]) - 1, Number(dotted[1]), ref, bias);
	for (const locale of Object.values(DATE_LOCALES)) {
		for (const [month, names] of locale.months.entries()) {
			for (const name of names) {
				const dayFirst = new RegExp(`(\\d{1,2})\\.?\\s*${name}\\b\\.?(?:\\s*(\\d{4}))?`, "u").exec(text);
				const monthFirst = new RegExp(`\\b${name}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4}))?`, "u").exec(text);
				const hit = dayFirst ?? monthFirst;
				if (hit) return hit[2] ? withYear(hit[2], month, Number(hit[1])) : nearestYear(month, Number(hit[1]), ref, bias);
			}
		}
	}
	return null;
}

const locales = Object.values(DATE_LOCALES);
const phrases = (key: "today" | "tomorrow" | "dayAfterTomorrow" | "thisWeek" | "nextWeek" | "endOfMonth" | "nextMonth" | "never") => locales.flatMap((locale) => locale[key]);

/**
 * Which weekday the words name. Full names first, in every language; a short form ("Fr", "do") only
 * with a dot or as the whole text -- "do" and "so" are English words too.
 */
function weekdayIn(text: string): number | null {
	for (let day = 0; day < 7; day++) if (any(text, locales.map((locale) => locale.weekdays[day][0]))) return day;
	for (let day = 0; day < 7; day++) {
		for (const short of locales.flatMap((locale) => locale.weekdays[day].slice(1))) {
			if (text === short || word(text, `${short}.`)) return day;
		}
	}
	return null;
}

/** What the words say relative to `ref`, in any known language. `undefined` = the words say nothing we can read. */
function relative(text: string, ref: Date): Date | null | undefined {
	if (any(text, phrases("never"))) return null;
	if (any(text, phrases("dayAfterTomorrow"))) return addDays(ref, 2);
	if (any(text, phrases("today"))) return ref;
	if (any(text, phrases("tomorrow"))) return addDays(ref, 1);
	if (any(text, phrases("nextWeek"))) return fromRel("next-week", ref);
	if (any(text, phrases("thisWeek"))) return fromRel("this-week", ref);
	if (any(text, phrases("endOfMonth"))) return fromRel("end-of-month", ref);
	if (any(text, phrases("nextMonth"))) return fromRel("next-month", ref);
	for (const locale of locales) {
		const numberWords = Object.keys(locale.numbers).join("|");
		for (const unit of locale.units) {
			const hit = new RegExp(`(?:^|\\s)(?:in|within|innerhalb)\\s+(\\d+|${numberWords})\\s+(?:${unit.words.join("|")})(?![\\p{L}])`, "u").exec(text);
			if (!hit) continue;
			const n = /^\d+$/.test(hit[1]) ? Number(hit[1]) : locale.numbers[hit[1]];
			return unit.months ? addMonths(ref, n * unit.months) : addDays(ref, n * unit.days!);
		}
	}
	const weekday = weekdayIn(text);
	if (weekday === null) return undefined;
	return addDays(ref, (weekday - ref.getUTCDay() + 7) % 7 || 7);
}

/** The fallback for words no locale table reads: the model's coarse class. */
function fromRel(rel: DateRel, ref: Date): Date | null {
	switch (rel) {
		case "today":
			return ref;
		case "tomorrow":
			return addDays(ref, 1);
		case "this-week":
			return fridayOf(ref);
		case "next-week":
			return fridayOf(addDays(ref, 7 - ((ref.getUTCDay() + 6) % 7)));
		case "end-of-month":
			return lastOfMonth(ref.getUTCFullYear(), ref.getUTCMonth());
		case "next-month":
			return lastOfMonth(ref.getUTCFullYear(), ref.getUTCMonth() + 1);
		case "none":
			return null;
	}
}

/**
 * A due date from the words the model copied off the page, relative to the page's date. Null when
 * the words name no date ("irgendwann") or none can be read and the class says nothing either.
 */
export function resolveDue(words: string | null, rel: DateRel | null, pageDate: Date): string | null {
	const text = (words ?? "").toLowerCase().trim();
	if (text !== "") {
		const date = absolute(text, pageDate, 1);
		if (date) return isoDay(date);
		const rel2 = relative(text, pageDate);
		if (rel2 !== undefined) return rel2 === null ? null : isoDay(rel2);
	}
	const fallback = rel ? fromRel(rel, pageDate) : null;
	return fallback ? isoDay(fallback) : null;
}

/** The date written on the page ("Mo 28.9."), read against the page's first-seen or sync time. Absolute dates only. */
export function resolveWrittenDate(words: string | null, ref: Date): Date | null {
	const text = (words ?? "").toLowerCase().trim();
	return text === "" ? null : absolute(text, ref, -1);
}
