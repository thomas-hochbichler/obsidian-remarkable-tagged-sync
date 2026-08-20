import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkLicence, type LicenceApi } from "./licence-check";
import { CARRY_DAYS, CHECK_INTERVAL_DAYS, entitlementOf, type Entitlement, type LicenceState, NO_LICENCE, startTrial, TRIAL_DAYS } from "./licence-state";
import { ocrBackendEntries } from "./ocr-registry";
import { BACKEND_TIER, proCapabilities, TIER_READERS, undeclaredBackends } from "./pro-capabilities";
import { FREE_TAG_LIMIT } from "./tag-routing-view";

// The Pro capability walk. It exists because of a measurement, not a worry: setting
// `requiresLicence` to `false` for all four cloud providers passed all 996 tests, and so did
// deleting the gate block outright. A paywall that falls open is invisible from both sides -- the
// buyer cannot tell a paid feature from a free one, and nothing goes red.
//
// So the shape here is a **walk over a declared list**, not a test per gate: the way a paywall
// breaks is that somebody adds a feature and nobody adds its test.
//
// Every registration the plugin ships has to be in the registry for the walk to see it, which is why
// this drives `src/entry.ts` -- the same reason `ocr-backend-choice.test.ts` gives.
vi.mock("rmapi-js", () => ({ session: () => ({}) }));
await import("./entry");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-20T12:00:00.000Z");
const daysBefore = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const BOUGHT: LicenceState = { ...NO_LICENCE, key: "TSP-1234", activationId: "act-1", validatedAt: daysBefore(1) };

/** Ids of every capability that is **not** locked at this entitlement. Empty is the assertion. */
const openAt = (entitlement: Entitlement): string[] =>
	proCapabilities()
		.filter((capability) => !capability.locked(entitlement))
		.map((capability) => capability.id);

/** Ids of every capability that **is** locked. Empty is the assertion, in the other direction. */
const lockedAt = (entitlement: Entitlement): string[] =>
	proCapabilities()
		.filter((capability) => capability.locked(entitlement))
		.map((capability) => capability.id);

// The vacuity guard, and it comes first on purpose: every other assertion in this file has the shape
// "nothing is open", which an empty list satisfies perfectly.
describe("the list the walk walks", () => {
	it("is not empty, and holds the capabilities this build actually sells", () => {
		const ids = proCapabilities().map((capability) => capability.id);

		expect(ids).toContain("ocr-backend:anthropic");
		expect(ids).toContain("ocr-backend:openai");
		expect(ids).toContain("ocr-backend:gemini");
		expect(ids).toContain("ocr-backend:openrouter");
		expect(ids).toContain("tag-mappings-beyond-the-first");
		expect(ids.length).toBeGreaterThanOrEqual(5);
	});

	it("takes its membership from the declaration, never from the flag under test", () => {
		// The single most important line in the module. `.filter(entry => entry.requiresLicence)` is
		// the obvious form and it is worthless: the mutation that sets that flag to false would empty
		// the list, and an empty walk passes every assertion in it.
		const paidIds = Object.entries(BACKEND_TIER)
			.filter(([, tier]) => tier.paid)
			.map(([id]) => id);
		const registered = new Set(ocrBackendEntries().map((entry) => entry.id));

		for (const id of paidIds) {
			if (!registered.has(id)) continue;
			expect(proCapabilities().map((capability) => capability.id)).toContain(`ocr-backend:${id}`);
		}
	});
});

describe("with no licence", () => {
	// Every state `licence-state.ts` reports as free, from its own closed set of reasons -- so a gate
	// that only checks one of them is caught by the other three.
	const FREE_STATES: Record<string, LicenceState> = {
		"never bought": NO_LICENCE,
		"trial ended": { ...NO_LICENCE, trialStartedAt: daysBefore(TRIAL_DAYS + 26) },
		revoked: { ...BOUGHT, revokedAt: daysBefore(1) },
		"key pasted, never confirmed": { ...NO_LICENCE, key: "TSP-1234" },
	};

	it.each(Object.entries(FREE_STATES))("locks every gated capability -- %s", (_name, state) => {
		const entitlement = entitlementOf(state, NOW);

		expect(entitlement.tier).toBe("free");
		// Named by id, so a failure says which capability fell open rather than that a count moved.
		expect(openAt(entitlement)).toEqual([]);
	});

	it("says what happens instead, for every one of them -- never nothing", () => {
		// The failure this file is about is a gate that "closes" by doing nothing. There is no third
		// `LockedOutcome` member for exactly that reason, and this asserts the declared one is real.
		for (const capability of proCapabilities()) {
			expect(["falls-back-to-free", "refused-in-place"]).toContain(capability.whenLocked);
		}
	});

	it("does what it says it does, at the site that does it", () => {
		// Driven, not grepped. When this was designed both enforcement sites were inside `main.ts` and
		// could only be checked for the presence of an `if` -- which proves the gate is still written,
		// not that it still does the right thing. The `main.ts` cut moved both into importable modules,
		// so the gate is now run and its answer compared with what the capability promised.
		const entitlement = entitlementOf(NO_LICENCE, NOW);

		for (const capability of proCapabilities()) {
			expect(capability.enforcedAt.run(entitlement), `${capability.id} at ${capability.enforcedAt.site}`).toBe(
				capability.whenLocked,
			);
		}
	});
});

describe("with a licence that is working", () => {
	const PAID_STATES: Record<string, LicenceState> = {
		"bought and validated": BOUGHT,
		"trial running": startTrial(NO_LICENCE, new Date(NOW.getTime() - 2 * DAY_MS)),
		"validated a month ago, not since": { ...BOUGHT, validatedAt: daysBefore(CARRY_DAYS + 10) },
	};

	it.each(Object.entries(PAID_STATES))("locks nothing -- %s", (_name, state) => {
		const entitlement = entitlementOf(state, NOW);

		expect(entitlement.tier).not.toBe("free");
		// This is the direction a wrongly-strict gate fails in, and it is the one that costs a refund.
		expect(lockedAt(entitlement)).toEqual([]);
	});

	it("lets every enforcement site through, and not merely the predicate", () => {
		for (const capability of proCapabilities()) {
			expect(capability.enforcedAt.run(entitlementOf(BOUGHT, NOW)), capability.id).toBe("allowed");
		}
	});

	it("does not lock a licence that has merely gone unconfirmed", () => {
		// `CARRY_DAYS` says a valid verdict carries for a month before the settings tab mentions it,
		// and stale is not locked. A gate that read `stale` as free would take Pro away from somebody
		// whose only problem is a bad connection.
		const stale = entitlementOf({ ...BOUGHT, validatedAt: daysBefore(CARRY_DAYS + 10) }, NOW);

		expect(stale).toMatchObject({ tier: "pro", stale: true });
		expect(lockedAt(stale)).toEqual([]);
	});
});

// `licence-state.ts` states it as an invariant -- "Silence is not revocation ... A provider outage
// must not shut every paying customer at once a month later" -- and `licence-check.ts` repeats it.
// This is that paragraph, executed: the real `checkLicence`, with a real dead `LicenceApi`, from a
// state that is genuinely due a re-check, so the dead call actually happens.
describe("when the licence server cannot be reached", () => {
	const DUE_A_RECHECK: LicenceState = { ...BOUGHT, validatedAt: daysBefore(CHECK_INTERVAL_DAYS + 1) };
	const CONTEXT = { label: "My Vault", now: NOW, fallbackBackend: "vision" };

	const deadApi = (fail: () => never): LicenceApi => ({
		activate: async () => fail(),
		validate: async () => fail(),
		deactivate: async () => fail(),
	});

	it("locks nothing when the call throws", async () => {
		const result = await checkLicence(
			DUE_A_RECHECK,
			deadApi(() => {
				throw new Error("ECONNREFUSED");
			}),
			CONTEXT,
		);

		expect(lockedAt(result.entitlement)).toEqual([]);
		// The notice is what tells a user their licence ended. Firing it on an outage would be the
		// user-visible half of the same bug.
		expect(result.notice).toBeNull();
	});

	it("locks nothing when the answer is 'unreachable'", async () => {
		const result = await checkLicence(DUE_A_RECHECK, { ...deadApi(() => ({}) as never), validate: async () => "unreachable" }, CONTEXT);

		expect(lockedAt(result.entitlement)).toEqual([]);
		expect(result.notice).toBeNull();
	});

	it("locks nothing when the last good answer is four months old", async () => {
		const ancient: LicenceState = { ...BOUGHT, validatedAt: daysBefore(120) };

		const result = await checkLicence(
			ancient,
			deadApi(() => {
				throw new Error("ETIMEDOUT");
			}),
			CONTEXT,
		);

		expect(result.entitlement).toMatchObject({ tier: "pro", stale: true });
		expect(lockedAt(result.entitlement)).toEqual([]);
	});

	it("does not end a running trial either", async () => {
		const trialing = startTrial(NO_LICENCE, new Date(NOW.getTime() - 2 * DAY_MS));

		const result = await checkLicence(
			trialing,
			deadApi(() => {
				throw new Error("ECONNREFUSED");
			}),
			CONTEXT,
		);

		expect(result.entitlement.tier).toBe("trial");
		expect(lockedAt(result.entitlement)).toEqual([]);
	});
});

// The half that makes *forgetting* loud. A design where forgetting is silent has failed however
// elegant it is, so each of these is written against a way of forgetting.
describe("nothing gated escapes the list", () => {
	it("declares every backend this build registers, paid or free", () => {
		// There is no fallback value: an id nobody wrote down is an error, not a free backend. A new
		// cloud provider registered with `requiresLicence` left at the `false` a developer writes to
		// satisfy the interface fails **here**, by id, before any question of gating comes up.
		expect(undeclaredBackends()).toEqual([]);
	});

	it("keeps the entry flag and the declaration saying the same thing", () => {
		// The two can disagree in both directions, and each is a different bug: a paid backend whose
		// flag says free is given away, and a free one whose flag says paid is refused to somebody who
		// owes nothing.
		for (const entry of ocrBackendEntries()) {
			expect(entry.requiresLicence, entry.id).toBe(BACKEND_TIER[entry.id]?.paid ?? "undeclared");
		}
	});

	it("pins which backends are paid, so the declaration is checked against something", () => {
		// Without this, "what Pro sells" could change by editing one line. With it, it changes by
		// editing one line **and** a test somebody has to read.
		const paid = Object.entries(BACKEND_TIER)
			.filter(([, tier]) => tier.paid)
			.map(([id]) => id)
			.sort();

		expect(paid).toEqual(["anthropic", "gemini", "openai", "openrouter"]);
	});

	it("makes opting out cost a sentence somebody can disagree with", () => {
		// `paid: false` is a claim, not an absence. A placeholder does not survive this by accident.
		for (const [id, tier] of Object.entries(BACKEND_TIER)) {
			expect(tier.because.length, id).toBeGreaterThan(20);
			expect(tier.because.trim().endsWith("."), id).toBe(true);
		}
	});

	it("lets no other file read the entitlement tier", () => {
		// The census above only sees backends. A gated capability that is not a backend cannot be
		// enumerated by anything -- it does not exist until somebody writes it. What *can* be
		// enumerated is the act of gating, and gating means reading the tier.
		//
		// The **count** is what makes this bite in a file that is already allowed: a second
		// hand-written gate beside the first moves 4 to 5 and this names the file.
		expect(tierReadsAcrossProduction()).toEqual(
			Object.fromEntries(Object.entries(TIER_READERS).map(([file, { reads }]) => [file, reads])),
		);
	});
});

/** Every non-test file under `src/` and `pro/` that reads `.tier`, and how often, comments stripped. */
function tierReadsAcrossProduction(): Record<string, number> {
	const counts: Record<string, number> = {};
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
			// The declaration file is where the census itself lives; its own mentions are not gates.
			if (full.endsWith("pro-capabilities.ts")) continue;
			const source = readFileSync(full, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			const reads = source.match(/\.tier\b/g)?.length ?? 0;
			if (reads > 0) counts[full.replace(`${process.cwd()}/`, "")] = reads;
		}
	};
	walk(join(process.cwd(), "src"));
	walk(join(process.cwd(), "pro"));
	return counts;
}

describe("the tag cap's own number", () => {
	it("is one, and the gate is phrased in the quantity rather than in the tier", () => {
		// Both phrasings agree today and only one can see the mutation: with `FREE_TAG_LIMIT = Infinity`
		// a tier test would still cheerfully report "free means locked", while the capability's
		// `tagLimitFor(...) < 2` reads the number that moved.
		expect(FREE_TAG_LIMIT).toBe(1);

		const free = entitlementOf(NO_LICENCE, NOW);
		expect(lockedAt(free)).toContain("tag-mappings-beyond-the-first");
	});
});
