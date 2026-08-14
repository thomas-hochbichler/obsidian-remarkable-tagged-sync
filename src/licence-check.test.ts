import { describe, expect, it, vi } from "vitest";
import { activateKey, checkLicence, deactivateHere, type LicenceApi, type LicenceContext } from "./licence-check";
import { CHECK_INTERVAL_DAYS, NO_LICENCE, startTrial, type LicenceState } from "./licence-state";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-14T10:00:00.000Z");
const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const ctx: LicenceContext = { label: "Work vault", now: NOW, fallbackBackend: "Apple Vision" };

const active: LicenceState = {
	...NO_LICENCE,
	key: "TSP-4F2A",
	activationId: "act_1",
	validatedAt: daysBefore(CHECK_INTERVAL_DAYS + 1),
};

function api(overrides: Partial<LicenceApi> = {}): LicenceApi {
	return {
		activate: vi.fn(async () => ({ outcome: "valid" as const, activationId: "act_new" })),
		validate: vi.fn(async () => "valid" as const),
		deactivate: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("checkLicence", () => {
	it("asks nothing of someone who never bought", async () => {
		const polar = api();
		const result = await checkLicence(NO_LICENCE, polar, ctx);
		expect(polar.validate).not.toHaveBeenCalled();
		expect(polar.activate).not.toHaveBeenCalled();
		expect(result.changed).toBe(false);
	});

	it("asks nothing while the last verdict is still fresh", async () => {
		const polar = api();
		await checkLicence({ ...active, validatedAt: NOW.toISOString() }, polar, ctx);
		expect(polar.validate).not.toHaveBeenCalled();
	});

	it("re-checks a due licence and clocks it to zero", async () => {
		const polar = api();
		const result = await checkLicence(active, polar, ctx);
		expect(polar.validate).toHaveBeenCalledWith("TSP-4F2A", "act_1");
		expect(result.state.validatedAt).toBe(NOW.toISOString());
		expect(result.entitlement.tier).toBe("pro");
	});

	// Silence is not revocation. A provider outage must not shut every paying customer at once.
	it("keeps Pro when the call fails, and says nothing", async () => {
		const polar = api({
			validate: vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND api.polar.sh");
			}),
		});
		const result = await checkLicence(active, polar, ctx);
		expect(result.entitlement.tier).toBe("pro");
		expect(result.notice).toBeNull();
		expect(result.changed).toBe(false);
	});

	it("locks on an explicit revocation and announces it once", async () => {
		const polar = api({ validate: vi.fn(async () => "revoked" as const) });
		const first = await checkLicence(active, polar, ctx);
		expect(first.entitlement).toEqual({ tier: "free", reason: "revoked" });
		expect(first.notice).toContain("withdrawn after the refund");
		expect(first.notice).toContain("Apple Vision");

		const again = await checkLicence(first.state, polar, ctx);
		expect(again.notice).toBeNull();
	});

	it("says what happens on a machine with nothing to fall back to", async () => {
		const polar = api({ validate: vi.fn(async () => "revoked" as const) });
		const result = await checkLicence(active, polar, { ...ctx, fallbackBackend: null });
		expect(result.notice).toContain("no transcription");
	});

	// deactivate needs no authentication at Polar, so the someone who freed the slot need not be the
	// owner. Re-activating before anything locks is what stops a stranger from locking them out.
	it("re-activates once when the activation is gone, without locking", async () => {
		const polar = api({ validate: vi.fn(async () => "unknown-activation" as const) });
		const result = await checkLicence(active, polar, ctx);
		expect(polar.activate).toHaveBeenCalledWith("TSP-4F2A", "Work vault");
		expect(result.state.activationId).toBe("act_new");
		expect(result.entitlement.tier).toBe("pro");
		expect(result.notice).toBeNull();
	});

	it("activates a key that was saved while offline", async () => {
		const polar = api();
		const saved = { ...NO_LICENCE, key: "TSP-9999" };
		const result = await checkLicence(saved, polar, ctx);
		expect(polar.activate).toHaveBeenCalledOnce();
		expect(result.entitlement.tier).toBe("pro");
	});

	it("announces an ended trial once, without any call at all", async () => {
		const polar = api();
		const ended = startTrial(NO_LICENCE, new Date("2026-07-01T00:00:00.000Z"));
		const result = await checkLicence(ended, polar, ctx);
		expect(polar.validate).not.toHaveBeenCalled();
		expect(result.notice).toContain("trial has ended");
		expect((await checkLicence(result.state, polar, ctx)).notice).toBeNull();
	});

	it("arms the notice again for a licence that comes back", async () => {
		const revoked = await checkLicence(active, api({ validate: vi.fn(async () => "revoked" as const) }), ctx);
		const bought = await activateKey(revoked.state, "TSP-NEW1", api(), ctx);
		expect(bought.state.endedNoticeShown).toBe(false);
		expect(bought.entitlement.tier).toBe("pro");
	});
});

describe("activateKey", () => {
	it("never loses a key pasted with no connection", async () => {
		const polar = api({
			activate: vi.fn(async () => {
				throw new Error("Failed to fetch");
			}),
		});
		const result = await activateKey(NO_LICENCE, "  TSP-1234  ", polar, ctx);
		expect(result.outcome).toBe("unreachable");
		expect(result.state.key).toBe("TSP-1234");
		expect(result.entitlement).toEqual({ tier: "free", reason: "not-activated" });
	});

	// Nothing was ever active, so there is nothing to withdraw: a typo must not read as a refund.
	it("reports an unknown key without recording a revocation", async () => {
		const polar = api({ activate: vi.fn(async () => ({ outcome: "unknown-key" as const })) });
		const result = await activateKey(NO_LICENCE, "TSP-typo", polar, ctx);
		expect(result.outcome).toBe("unknown-key");
		expect(result.state.revokedAt).toBeNull();
		expect(result.notice).toBeNull();
	});

	it("reports a full licence as full", async () => {
		const polar = api({ activate: vi.fn(async () => ({ outcome: "activation-limit" as const })) });
		expect((await activateKey(NO_LICENCE, "TSP-1234", polar, ctx)).outcome).toBe("activation-limit");
	});
});

describe("deactivateHere", () => {
	it("frees the slot at Polar", async () => {
		const polar = api();
		await deactivateHere({ ...active }, polar);
		expect(polar.deactivate).toHaveBeenCalledWith("TSP-4F2A", "act_1");
	});

	it("does not throw when the slot cannot be freed", async () => {
		const polar = api({
			deactivate: vi.fn(async () => {
				throw new Error("offline");
			}),
		});
		await expect(deactivateHere({ ...active }, polar)).resolves.toBeUndefined();
	});

	it("calls nothing when there is nothing to free", async () => {
		const polar = api();
		await deactivateHere(NO_LICENCE, polar);
		expect(polar.deactivate).not.toHaveBeenCalled();
	});
});
