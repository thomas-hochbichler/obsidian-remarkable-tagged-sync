import { describe, expect, it } from "vitest";
import {
	applyOutcome,
	CARRY_DAYS,
	CHECK_INTERVAL_DAYS,
	entitlementOf,
	nextLicenceCall,
	NO_LICENCE,
	startTrial,
	TRIAL_DAYS,
	trialEndsAt,
	withActivation,
	withKey,
	withoutLicence,
	type LicenceState,
} from "./licence-state";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-14T10:00:00.000Z");
const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const daysAfter = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

const active: LicenceState = {
	key: "TSP-AAAA-BBBB-4F2A",
	activationId: "act_1",
	validatedAt: daysBefore(1),
	revokedAt: null,
	trialStartedAt: null,
	endedNoticeShown: false,
};

describe("entitlementOf", () => {
	it("gives a confirmed key Pro", () => {
		expect(entitlementOf(active, NOW)).toEqual({ tier: "pro", since: active.validatedAt, stale: false });
	});

	// Silence is not revocation: after the carry window Pro still works, it only says so.
	it("keeps Pro after the carry window, marking it stale rather than locking", () => {
		const old = { ...active, validatedAt: daysBefore(CARRY_DAYS + 1) };
		expect(entitlementOf(old, NOW)).toEqual({ tier: "pro", since: old.validatedAt, stale: true });
	});

	it("locks only on an explicit revocation", () => {
		const revoked = applyOutcome(active, "unknown-key", NOW);
		expect(entitlementOf(revoked, NOW)).toEqual({ tier: "free", reason: "revoked" });
	});

	// The paste field must not be the gate: an unchecked string unlocks nothing.
	it("does not unlock Pro on a key that has never been confirmed", () => {
		expect(entitlementOf(withKey(NO_LICENCE, "TSP-nonsense"), NOW)).toEqual({
			tier: "free",
			reason: "not-activated",
		});
	});

	it("runs the trial for its days and then ends it", () => {
		const trialing = startTrial(NO_LICENCE, NOW);
		expect(entitlementOf(trialing, NOW).tier).toBe("trial");
		expect(entitlementOf(trialing, daysAfter(TRIAL_DAYS - 0.5)).tier).toBe("trial");
		expect(entitlementOf(trialing, daysAfter(TRIAL_DAYS))).toEqual({ tier: "free", reason: "trial-ended" });
	});

	it("prefers a bought licence over an expired trial", () => {
		const both = { ...active, trialStartedAt: daysBefore(TRIAL_DAYS + 5) };
		expect(entitlementOf(both, NOW).tier).toBe("pro");
	});

	// Total by design: this is asked on the sync path, where throwing would read as a broken plugin.
	it("treats an unparsable timestamp as absent instead of throwing", () => {
		expect(entitlementOf({ ...active, validatedAt: "not a date" }, NOW)).toEqual({
			tier: "free",
			reason: "not-activated",
		});
		expect(trialEndsAt({ ...NO_LICENCE, trialStartedAt: "" })).toBeNull();
	});
});

describe("nextLicenceCall", () => {
	it("asks for nothing without a key, and nothing once revoked", () => {
		expect(nextLicenceCall(NO_LICENCE, NOW)).toBe("none");
		expect(nextLicenceCall(applyOutcome(active, "unknown-key", NOW), NOW)).toBe("none");
	});

	it("remembers a fresh verdict instead of calling again", () => {
		const justChecked = { ...active, validatedAt: NOW.toISOString() };
		expect(nextLicenceCall(justChecked, NOW)).toBe("none");
		expect(nextLicenceCall(justChecked, daysAfter(CHECK_INTERVAL_DAYS - 0.1))).toBe("none");
	});

	it("re-checks once the interval has passed since the last verdict", () => {
		const justChecked = { ...active, validatedAt: NOW.toISOString() };
		expect(nextLicenceCall(justChecked, daysAfter(CHECK_INTERVAL_DAYS))).toBe("validate");
		// The clock runs from the verdict, not from the call: a day-old verdict is due a day sooner.
		expect(nextLicenceCall(active, daysAfter(CHECK_INTERVAL_DAYS - 1))).toBe("validate");
	});

	it("activates a saved key that never got out", () => {
		expect(nextLicenceCall(withKey(NO_LICENCE, "TSP-1"), NOW)).toBe("activate");
	});
});

describe("applyOutcome", () => {
	it("clocks a valid answer to zero and clears an earlier revocation", () => {
		const revoked = applyOutcome(active, "unknown-key", NOW);
		const back = applyOutcome(revoked, "valid", NOW);
		expect(back.revokedAt).toBeNull();
		expect(back.validatedAt).toBe(NOW.toISOString());
	});

	it("treats a key Polar no longer knows as withdrawn", () => {
		expect(applyOutcome(active, "unknown-key", NOW).revokedAt).toBe(NOW.toISOString());
	});

	// deactivate is unauthenticated at Polar, so a stranger who knows a key can free its slots. The
	// owner must not be locked out of their own licence by that.
	it("re-activates silently when the activation is gone, without locking", () => {
		const freed = applyOutcome(active, "unknown-activation", NOW);
		expect(freed.revokedAt).toBeNull();
		expect(nextLicenceCall(freed, NOW)).toBe("activate");
		expect(entitlementOf(freed, NOW).tier).toBe("pro");
	});

	it("changes nothing at all when there was no answer", () => {
		expect(applyOutcome(active, "unreachable", NOW)).toBe(active);
		expect(applyOutcome(active, "activation-limit", NOW)).toBe(active);
	});
});

describe("the stored fields", () => {
	it("keeps a pasted key even before it can be activated", () => {
		const saved = withKey(NO_LICENCE, "  TSP-9999  ");
		expect(saved.key).toBe("TSP-9999");
		expect(saved.activationId).toBeNull();
	});

	it("records an activation as a confirmation too", () => {
		const done = withActivation(withKey(NO_LICENCE, "TSP-9999"), "act_7", NOW);
		expect(done.activationId).toBe("act_7");
		expect(entitlementOf(done, NOW).tier).toBe("pro");
	});

	// There is no restart button by decision: one would turn the purchase into a donation.
	it("starts the trial once and never again", () => {
		const first = startTrial(NO_LICENCE, NOW);
		expect(startTrial(first, daysAfter(30))).toBe(first);
	});

	it("does not hand back the trial when a licence is removed", () => {
		const used = withoutLicence({ ...active, trialStartedAt: daysBefore(TRIAL_DAYS + 1) });
		expect(entitlementOf(used, NOW)).toEqual({ tier: "free", reason: "trial-ended" });
	});
});
