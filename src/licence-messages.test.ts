import { describe, expect, it } from "vitest";
import {
	gatedBackendMessage,
	licenceEndedNotice,
	licenceStatusText,
	MONEY_BACK_MESSAGE,
	onDay,
	TAG_CAP_MESSAGE,
	trialDaysLeft,
} from "./licence-messages";
import { entitlementOf, startTrial, NO_LICENCE, type LicenceState } from "./licence-state";

const NOW = new Date("2026-08-14T10:00:00.000Z");
const active: LicenceState = {
	key: "TSP-AAAA-BBBB-4f2a",
	activationId: "act_1",
	validatedAt: "2026-08-13T09:00:00.000Z",
	revokedAt: null,
	trialStartedAt: null,
};

const textOf = (state: LicenceState, now = NOW) => licenceStatusText(entitlementOf(state, now), state);

describe("licenceStatusText", () => {
	it("identifies an active licence by its key suffix, never by an email address", () => {
		const { heading, body } = textOf(active);
		expect(heading).toBe("Active");
		expect(body).toContain("4F2A");
		expect(body).not.toContain("TSP-AAAA");
		expect(body).not.toContain("@");
	});

	// Silence must be visible without being alarming: Pro still works, and the line says why.
	it("says an unconfirmed licence still works", () => {
		const stale = { ...active, validatedAt: "2026-06-01T00:00:00.000Z" };
		const { heading, body } = textOf(stale);
		expect(heading).toContain("not confirmed since 2026-06-01");
		expect(body).toContain("Pro keeps working");
	});

	// An ended licence must read as an ended licence, never as a broken plugin.
	it("tells a refunded user what still works, in the same breath", () => {
		const revoked = { ...active, revokedAt: "2026-08-14T10:00:00.000Z" };
		const { heading, body } = textOf(revoked);
		expect(heading).toContain("refunded");
		expect(body).toContain("Refunded on 2026-08-14");
		expect(body).toContain("keeps syncing");
	});

	it("tells an ended trial that nothing was touched", () => {
		const ended = startTrial(NO_LICENCE, new Date("2026-07-01T00:00:00.000Z"));
		expect(textOf(ended).body).toContain("untouched");
	});

	it("names the price to someone who has never bought", () => {
		expect(textOf(NO_LICENCE).body).toContain("€24");
	});

	it("promises a saved-but-unconfirmed key that it will go out", () => {
		const pasted = { ...NO_LICENCE, key: "TSP-1234" };
		expect(textOf(pasted).body).toContain("next time you are online");
	});
});

describe("the messages that appear once", () => {
	it("names the backend transcription fell back to", () => {
		expect(licenceEndedNotice("revoked", "Apple Vision")).toContain("Apple Vision");
		expect(licenceEndedNotice("trial-ended", "Apple Vision")).toContain("trial has ended");
	});

	it("is honest when there is nothing to fall back to", () => {
		expect(gatedBackendMessage("OpenRouter", "Apple Vision")).toBe(
			"OpenRouter needs Tagged Sync Pro. Using Apple Vision instead.",
		);
		expect(gatedBackendMessage("OpenRouter", null)).toContain("Nothing will be transcribed");
	});
});

describe("the shipped text this edits", () => {
	// The code gates *adding* a mapping; the sentence must keep saying an existing one is never removed.
	it("keeps the tag cap's promise that an existing mapping stays", () => {
		expect(TAG_CAP_MESSAGE).toContain("Remove the current mapping");
		expect(TAG_CAP_MESSAGE).toContain("unlimited tags with Tagged Sync Pro");
	});

	it("states the money-back promise and the device count together", () => {
		expect(MONEY_BACK_MESSAGE).toContain("14 days, no questions asked");
		expect(MONEY_BACK_MESSAGE).toContain("50 devices");
	});
});

describe("dates and counting", () => {
	it("writes a date that means the same day on every continent", () => {
		expect(onDay("2026-03-04T23:30:00.000Z")).toBe("2026-03-04");
	});

	it("counts trial days down to zero and no further", () => {
		const trialing = startTrial(NO_LICENCE, NOW);
		expect(trialDaysLeft(trialing, NOW)).toBe(14);
		expect(trialDaysLeft(trialing, new Date("2026-08-27T10:00:00.000Z"))).toBe(1);
		expect(trialDaysLeft(trialing, new Date("2026-09-30T10:00:00.000Z"))).toBe(0);
		expect(trialDaysLeft(NO_LICENCE, NOW)).toBe(0);
	});
});
