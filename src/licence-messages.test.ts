import { describe, expect, it } from "vitest";
import {
	ACTIVATED_MESSAGE,
	ACTIVATION_LIMIT_MESSAGE,
	activationMessage,
	gatedBackendMessage,
	licenceEndedNotice,
	licenceStatusText,
	MONEY_BACK_MESSAGE,
	OFFLINE_ACTIVATION_MESSAGE,
	onDay,
	TAG_CAP_MESSAGE,
	trialDaysLeft,
	WITHDRAWN_KEY_MESSAGE,
	WRONG_KEY_MESSAGE,
} from "./licence-messages";
import { entitlementOf, startTrial, NO_LICENCE, type LicenceOutcome, type LicenceState } from "./licence-state";

const NOW = new Date("2026-08-14T10:00:00.000Z");
const active: LicenceState = {
	key: "TSP-AAAA-BBBB-4f2a",
	activationId: "act_1",
	validatedAt: "2026-08-13T09:00:00.000Z",
	revokedAt: null,
	trialStartedAt: null,
	endedNoticeShown: false,
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

	// The one state where Pro works and the licence does not. Silence here reads as "the key took".
	it("says which of the two is unlocking Pro when both are present", () => {
		const trialing = startTrial(NO_LICENCE, NOW);
		expect(textOf(trialing).body).not.toContain("licence key");

		const withKey = { ...trialing, key: "TSP-9999" };
		const { heading, body } = textOf(withKey);
		expect(heading).toBe("Trial");
		expect(body).toContain("saved but not confirmed");
		expect(body).toContain("the trial is what is unlocking Pro");
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

// Gap G37. The four sentences below are argued for at length in the module and appeared **zero
// times** in any test file. `licence-client.test.ts` proves the five answers are told apart; this is
// the only place that decides which of them a buyer actually reads, so two swapped `case` arms were
// invisible to every test in the repo.
describe("activationMessage", () => {
	it("gives every outcome its own sentence", () => {
		expect(activationMessage("valid")).toBe(ACTIVATED_MESSAGE);
		expect(activationMessage("unknown-key")).toBe(WRONG_KEY_MESSAGE);
		expect(activationMessage("withdrawn")).toBe(WITHDRAWN_KEY_MESSAGE);
		expect(activationMessage("activation-limit")).toBe(ACTIVATION_LIMIT_MESSAGE);
		expect(activationMessage("unreachable")).toBe(OFFLINE_ACTIVATION_MESSAGE);
	});

	it("never says the same thing about two different answers", () => {
		const outcomes: LicenceOutcome[] = ["valid", "unknown-key", "withdrawn", "activation-limit", "unreachable"];
		expect(new Set(outcomes.map(activationMessage)).size).toBe(outcomes.length);
	});

	it("does not send a refunded buyer hunting for a typo", () => {
		// The one swap that is cruel rather than merely wrong. For the stored state `withdrawn` and
		// `unknown-key` are identical -- they are separate outcomes only so this sentence can differ.
		expect(activationMessage("withdrawn")).not.toBe(WRONG_KEY_MESSAGE);
		expect(activationMessage("withdrawn")).toContain("refunded or reversed");
	});

	it("reads an answer it has no arm for as a typo, not as a withdrawal", () => {
		// Nothing was ever active on a key being pasted for the first time, so there is nothing to
		// withdraw. The default has to be the harmless reading of the two.
		expect(activationMessage("something-polar-added-later" as LicenceOutcome)).toBe(WRONG_KEY_MESSAGE);
	});
});
