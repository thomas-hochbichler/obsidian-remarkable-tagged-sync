import { describe, expect, it } from "vitest";
import {
	autoSpendBlocked,
	backgroundConsentGiven,
	type BackgroundConditions,
	backgroundRunBlocked,
} from "./auto-sync-gates";

// The decisions, without a vault or a registry. `auto-sync-schedule.test.ts` is the other half: that
// the shipped `triggerAutoSync` asks these and obeys the answer.

const CLEAR: BackgroundConditions = { enabled: true, running: false, connected: true, backgroundConsent: true };

describe("backgroundRunBlocked", () => {
	it("lets a run through when every condition is clear", () => {
		expect(backgroundRunBlocked(CLEAR)).toBeNull();
	});

	it("blocks when the master switch is off", () => {
		expect(backgroundRunBlocked({ ...CLEAR, enabled: false })).toBe("auto-sync-off");
	});

	it("blocks when something is already running", () => {
		// Two runs would interleave rows in the one sync index. The same lock a manual sync respects.
		expect(backgroundRunBlocked({ ...CLEAR, running: true })).toBe("already-running");
	});

	it("blocks when no device token is stored", () => {
		expect(backgroundRunBlocked({ ...CLEAR, connected: false })).toBe("not-connected");
	});

	it("blocks when the backend may not run unattended", () => {
		expect(backgroundRunBlocked({ ...CLEAR, backgroundConsent: false })).toBe("no-background-consent");
	});

	it("names the master switch first when everything is wrong at once", () => {
		// Whichever it names is silent, so the order changes nothing a user sees. It is asserted so a
		// test that means to exercise one gate cannot pass because a different one fired.
		expect(backgroundRunBlocked({ enabled: false, running: true, connected: false, backgroundConsent: false })).toBe(
			"auto-sync-off",
		);
	});
});

describe("autoSpendBlocked", () => {
	it("blocks a paid backend the user has not consented to run unattended", () => {
		expect(autoSpendBlocked(true, false)).toBe("no-consent-to-spend");
	});

	it("lets a paid backend through once the consent is given", () => {
		expect(autoSpendBlocked(true, true)).toBeNull();
	});

	it("lets a free backend through whether or not the consent was ever given", () => {
		// The consent authorises spending. On a backend that spends nothing it authorises nothing, so
		// it cannot be what decides.
		expect(autoSpendBlocked(false, false)).toBeNull();
		expect(autoSpendBlocked(false, true)).toBeNull();
	});
});

describe("backgroundConsentGiven", () => {
	const asks = {
		needsBackgroundConsent: true,
		backgroundConsent: { get: (settings: Record<string, unknown>) => settings.consented === true },
	};

	it("treats a backend that does not ask as having consented", () => {
		// Most backends cost nothing but network, and asking about all of them would make the one that
		// matters unremarkable.
		expect(backgroundConsentGiven({ needsBackgroundConsent: false }, {})).toBe(true);
	});

	it("reads the answer out of the backend's own settings blob", () => {
		expect(backgroundConsentGiven(asks, { consented: true })).toBe(true);
		expect(backgroundConsentGiven(asks, { consented: false })).toBe(false);
	});

	it("treats a backend that has never been asked as not consented", () => {
		// The default is no. A consent that defaults to yes is not a consent.
		expect(backgroundConsentGiven(asks, {})).toBe(false);
	});

	it("does not block a backend this build does not have", () => {
		// It cannot run at all; refusing it here would name the wrong reason for the same silence.
		expect(backgroundConsentGiven(null, {})).toBe(true);
		expect(backgroundConsentGiven(undefined, {})).toBe(true);
	});

	it("ignores an accessor from a backend that never declared it needs one", () => {
		// The pair has to hold together, because the settings tab draws the consent row off the same two
		// fields: a backend gated on a flag it did not declare would have no control to turn the gate
		// off with, and its background syncs would simply stop with nothing on screen to explain it.
		const contradictory = { needsBackgroundConsent: false, backgroundConsent: { get: () => false } };

		expect(backgroundConsentGiven(contradictory, {})).toBe(true);
	});

	it("treats a backend that asks but offers no accessor as having consented", () => {
		// A half-declared entry. Blocking here would take a backend off the air over a registration
		// mistake, silently, in the background only.
		expect(backgroundConsentGiven({ needsBackgroundConsent: true }, {})).toBe(true);
	});
});
