/**
 * The Pro licence lifecycle, as pure functions over the five fields kept in `data.json`.
 *
 * Two properties are not options (pro-release spec §5):
 *
 * - **A free user never causes a network call.** Nothing here decides to call anything on its own;
 *   `nextLicenceCall` is only ever asked on the path of a gated feature.
 * - **Silence is not revocation.** Only an explicit answer locks Pro. If Polar cannot be reached,
 *   the last verdict carries — after 30 days it says so, and still does not lock. A provider outage
 *   must not shut every paying customer at once a month later, which is the whole reason the buyer
 *   list exists.
 */

/** How long a self-serve trial runs. Per vault, because Obsidian gives a plugin storage per vault. */
export const TRIAL_DAYS = 14;

/** How often a licence is re-checked while it is being used. A valid verdict is remembered in between. */
export const CHECK_INTERVAL_DAYS = 7;

/** How long a *valid* verdict carries with no successful check before the settings tab says so. */
export const CARRY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What Polar said. Deliberately a small closed set rather than the HTTP response: the transport is
 * replaceable and, until the Polar account exists, its exact response shape is unverified — see
 * `licence-client.ts`.
 */
export type LicenceOutcome =
	/** The key is live and this activation is known. */
	| "valid"
	/** Polar has never heard of this key. At the paste field that means a typo. */
	| "unknown-key"
	/**
	 * The key exists and is no longer usable — withdrawn after a refund or a reversal.
	 *
	 * Identical to `unknown-key` for the stored state: both end the licence. It is a separate outcome
	 * only so the sentence can differ, and that matters at the paste field, where "check for a typo"
	 * sends a refunded buyer hunting for a mistake they did not make.
	 */
	| "withdrawn"
	/** The key is fine but this activation is gone — someone freed the slot. */
	| "unknown-activation"
	/** All 50 activations are in use. */
	| "activation-limit"
	/** No answer. Not a verdict. */
	| "unreachable";

/** The five fields this module owns inside `TaggedSyncData`. */
export interface LicenceState {
	/** The purchased key, as pasted. Saved even when it could not be activated yet. */
	key: string | null;
	/** Polar's id for this vault's activation. Null means "not activated yet, or the slot was freed". */
	activationId: string | null;
	/** ISO timestamp of the last successful `valid` answer. */
	validatedAt: string | null;
	/** ISO timestamp when the licence was found revoked, so the settings tab can name the day. */
	revokedAt: string | null;
	/** ISO timestamp the trial began. Never reset by the plugin — there is no restart button. */
	trialStartedAt: string | null;
	/**
	 * Set once the "your licence ended" notice has been shown, so it never nags again. Same shape as
	 * `ocrUnavailableNoticeShown`. A reminder on every sync was rejected: it would punish someone who
	 * got their money back, on every single run.
	 */
	endedNoticeShown: boolean;
}

export const NO_LICENCE: LicenceState = {
	key: null,
	activationId: null,
	validatedAt: null,
	revokedAt: null,
	trialStartedAt: null,
	endedNoticeShown: false,
};

/** What the user is entitled to right now. `stale` drives the permanent, non-blocking settings line. */
export type Entitlement =
	| { tier: "pro"; since: string; stale: boolean }
	| { tier: "trial"; endsAt: string }
	| { tier: "free"; reason: "never-bought" | "trial-ended" | "revoked" | "not-activated" };

/**
 * Reads the entitlement without calling anything. Every gate asks this, so it must be cheap and
 * total: an unparsable timestamp is treated as absent rather than throwing inside a sync.
 */
export function entitlementOf(state: LicenceState, now: Date): Entitlement {
	if (state.revokedAt !== null) return { tier: "free", reason: "revoked" };

	if (state.key !== null && state.validatedAt !== null) {
		const since = msOf(state.validatedAt);
		if (since !== null) {
			return { tier: "pro", since: state.validatedAt, stale: now.getTime() - since > CARRY_DAYS * DAY_MS };
		}
	}

	const trialEnd = trialEndsAt(state);
	if (trialEnd !== null) {
		if (now.getTime() < trialEnd.getTime()) return { tier: "trial", endsAt: trialEnd.toISOString() };
		return { tier: "free", reason: "trial-ended" };
	}

	// A key that has never been confirmed does not unlock anything. Granting Pro on an unchecked
	// string would make the paste field the gate, and the trial already exists for judging Pro
	// without paying.
	if (state.key !== null) return { tier: "free", reason: "not-activated" };

	return { tier: "free", reason: "never-bought" };
}

/** The end of the trial, or null if none was ever started. */
export function trialEndsAt(state: LicenceState): Date | null {
	const started = msOf(state.trialStartedAt);
	if (started === null) return null;
	return new Date(started + TRIAL_DAYS * DAY_MS);
}

/**
 * What to do before using a gated feature. Asked only on that path, never on load.
 *
 * `activate` when there is a key but no activation — including after an activation was found gone,
 * which is the **one silent re-activation** the spec requires: `deactivate` is unauthenticated at
 * Polar, so a stranger who knows a key can free its slots, and without this the owner would be
 * locked out of their own licence.
 */
export function nextLicenceCall(state: LicenceState, now: Date): "none" | "activate" | "validate" {
	if (state.key === null || state.revokedAt !== null) return "none";
	if (state.activationId === null) return "activate";

	const last = msOf(state.validatedAt);
	if (last === null) return "validate";
	return now.getTime() - last >= CHECK_INTERVAL_DAYS * DAY_MS ? "validate" : "none";
}

/**
 * Folds an answer into the stored state. Returns the same object when nothing changed, so a caller
 * can skip the write.
 *
 * `unreachable` deliberately changes nothing at all — see the note on silence at the top.
 */
export function applyOutcome(state: LicenceState, outcome: LicenceOutcome, now: Date): LicenceState {
	switch (outcome) {
		// A licence that comes back arms the notice again, so a second revocation is announced too.
		case "valid":
			return { ...state, validatedAt: now.toISOString(), revokedAt: null, endedNoticeShown: false };
		// A key Polar no longer knows is a withdrawn key. The distinction between "refunded" and
		// "never existed" only matters when someone has just pasted one, and that path reports the
		// outcome itself rather than storing it.
		case "unknown-key":
		case "withdrawn":
			return { ...state, revokedAt: now.toISOString() };
		case "unknown-activation":
			return { ...state, activationId: null };
		case "activation-limit":
		case "unreachable":
			return state;
	}
}

/** Records a successful activation. `label` is the vault name, so Polar's own device list is readable. */
export function withActivation(state: LicenceState, activationId: string, now: Date): LicenceState {
	return { ...state, activationId, validatedAt: now.toISOString(), revokedAt: null, endedNoticeShown: false };
}

/** Saves a pasted key. Kept even if the activation call cannot go out yet — see `licence-messages`. */
export function withKey(state: LicenceState, key: string): LicenceState {
	return {
		...state,
		key: key.trim(),
		activationId: null,
		validatedAt: null,
		revokedAt: null,
		endedNoticeShown: false,
	};
}

/** Forgets the licence on this vault, freeing its slot at Polar. The trial is not restored. */
export function withoutLicence(state: LicenceState): LicenceState {
	return { ...state, key: null, activationId: null, validatedAt: null, revokedAt: null };
}

/**
 * Starts the trial, once. A second call is ignored: deleting the field by hand restarts it, which is
 * accepted (a tester pays their own API bill, so the trial costs nothing to give) — but the plugin
 * must not offer a restart button, or the purchase becomes a donation.
 */
export function startTrial(state: LicenceState, now: Date): LicenceState {
	if (state.trialStartedAt !== null) return state;
	return { ...state, trialStartedAt: now.toISOString() };
}

function msOf(iso: string | null): number | null {
	if (iso === null) return null;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}
