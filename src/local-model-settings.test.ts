import { describe, expect, it } from "vitest";
import {
	ENOUGH_PAGES_TO_MEASURE,
	estimateLine,
	FIRST_PAGES_CAVEAT,
	humanDuration,
	readLocalModelSettings,
	recordPageDuration,
	reTranscribeCaveat,
	setBackgroundConsent,
	typicalPageSeconds,
} from "./local-model-settings";

describe("readLocalModelSettings", () => {
	it("defaults an empty blob to no consent and no measurements", () => {
		expect(readLocalModelSettings({})).toEqual({ backgroundConsent: false, recentPageMs: [] });
	});

	// The blob is opaque to the core and survives backend switches, so it can hold anything.
	it("survives a blob holding the wrong shapes", () => {
		expect(readLocalModelSettings({ backgroundConsent: "yes", recentPageMs: "nope" })).toEqual({
			backgroundConsent: false,
			recentPageMs: [],
		});
		expect(readLocalModelSettings({ recentPageMs: [1, "two", -3, 4] })).toEqual({
			backgroundConsent: false,
			recentPageMs: [1, 4],
		});
	});
});

describe("recordPageDuration", () => {
	it("writes through to the live blob so the next save persists it", () => {
		const blob = {};
		recordPageDuration(blob, 14_900);

		expect(readLocalModelSettings(blob).recentPageMs).toEqual([14_900]);
	});

	it("keeps only the most recent window", () => {
		const blob = {};
		for (let i = 1; i <= ENOUGH_PAGES_TO_MEASURE + 5; i++) recordPageDuration(blob, i * 1000);

		const recent = readLocalModelSettings(blob).recentPageMs;
		expect(recent).toHaveLength(ENOUGH_PAGES_TO_MEASURE);
		expect(recent[recent.length - 1]).toBe((ENOUGH_PAGES_TO_MEASURE + 5) * 1000);
	});

	it("ignores a nonsense duration rather than poisoning the window", () => {
		const blob = {};
		recordPageDuration(blob, 0);
		recordPageDuration(blob, -5);
		recordPageDuration(blob, Number.NaN);

		expect(readLocalModelSettings(blob).recentPageMs).toEqual([]);
	});
});

describe("typicalPageSeconds", () => {
	/**
	 * "Enough" is ten pages -- one short notebook. Small enough to retire the derived figure quickly,
	 * large enough that one slow page does not set the number.
	 */
	it("says nothing until there are enough pages", () => {
		const blob = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE - 1; i++) recordPageDuration(blob, 15_000);

		expect(typicalPageSeconds(blob)).toBeNull();
	});

	it("quotes this machine's figure once there are", () => {
		const blob = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE; i++) recordPageDuration(blob, 15_000);

		expect(typicalPageSeconds(blob)).toBe(15);
	});

	/**
	 * The window that first fills is exactly the contaminated one: the release gate's own first pass
	 * over ten pages had **three** at 392-600 s while the system indexed the new model, and 14.97 s on
	 * every later pass. A mean turns that into ~160 s/page and quotes it as measured, so the moment the
	 * derived figure retires is the moment the number becomes wrong.
	 */
	it("is not moved by the slow pages of the first pass after a download", () => {
		const blob = {};
		for (const ms of [392_000, 600_000, 500_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000]) {
			recordPageDuration(blob, ms);
		}

		expect(typicalPageSeconds(blob)).toBe(15);
	});
});

describe("estimateLine", () => {
	/**
	 * Neither platform's figure is this user's figure before they run a page: Windows is derived from
	 * research rather than measured (map constraint 5) and macOS's 14.9 s came from an M2 Max, which
	 * the map fixes as the *top* of the range.
	 */
	it("quotes the derived macOS figure before any page has run", () => {
		const line = estimateLine("darwin", {});

		expect(line).toContain("15 seconds a page");
		expect(line).toContain("40-page notebook");
	});

	it("marks the Windows figure as never measured on Windows hardware", () => {
		const line = estimateLine("win32", {});

		expect(line).toContain("Estimated, never measured on Windows hardware");
	});

	/**
	 * The release gate measured 392-600 s on three pages immediately after the 5.5 GB landed, against
	 * 14.97 s once it had settled. A user who reads "about 15 seconds a page" and then watches the
	 * first page take ten minutes has been told the wrong thing by copy that was otherwise honest.
	 */
	it("warns that the pages right after a download are far slower", () => {
		for (const platform of ["darwin", "win32"] as const) {
			expect(estimateLine(platform, {})).toContain(FIRST_PAGES_CAVEAT);
		}
	});

	// It settles, and by the time this machine has its own figure the caveat is a lie about the number
	// standing next to it.
	it("drops the caveat once this machine's own figure stands", () => {
		const blob = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE; i++) recordPageDuration(blob, 9_000);

		expect(estimateLine("darwin", blob)).not.toContain(FIRST_PAGES_CAVEAT);
	});

	// What makes the derived figure honest is that it is provisional by construction, not by
	// disclaimer: this machine overwrites it.
	it("replaces the derived figure with this machine's own once it has one", () => {
		const blob = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE; i++) recordPageDuration(blob, 9_000);

		const line = estimateLine("win32", blob);
		expect(line).toContain("9 seconds a page");
		expect(line).toContain("on this machine");
		expect(line).not.toContain("Estimated, never measured");
	});
});

describe("humanDuration", () => {
	it("rounds to a unit somebody can act on", () => {
		expect(humanDuration(45)).toBe("about a minute");
		expect(humanDuration(600)).toBe("about 10 minutes");
		expect(humanDuration(3_189)).toBe("about 50 minutes");
		expect(humanDuration(7_200)).toBe("about 2 hours");
		expect(humanDuration(5_400)).toBe("about 1.5 hours");
	});
});

describe("reTranscribeCaveat", () => {
	/**
	 * `main.ts` appends a cost caveat for a metered backend and says nothing about time, because
	 * Vision runs at 400 ms a page. This backend is 14.9 s a page and is the only way back from an
	 * `unavailable` unit, so the time is the fact that decides the answer.
	 */
	it("names the total time for the notes actually being re-transcribed", () => {
		const blob = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE; i++) recordPageDuration(blob, 14_900);

		expect(reTranscribeCaveat(blob, 214)).toBe(" and takes about 50 minutes on this machine");
	});

	// Before there is a measurement there is no honest number, and an invented one is worse than none.
	it("says nothing until this machine has been measured", () => {
		expect(reTranscribeCaveat({}, 214)).toBeNull();
	});

	it("says nothing for no notes at all", () => {
		const blob = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE; i++) recordPageDuration(blob, 14_900);

		expect(reTranscribeCaveat(blob, 0)).toBeNull();
	});
});

describe("setBackgroundConsent", () => {
	it("writes through to the live blob", () => {
		const blob = {};
		setBackgroundConsent(blob, true);

		expect(readLocalModelSettings(blob).backgroundConsent).toBe(true);
	});
});
