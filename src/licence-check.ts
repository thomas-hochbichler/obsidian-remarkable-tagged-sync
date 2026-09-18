/**
 * When to ask Polar, and what to do with the answer.
 *
 * Deliberately separate from the transport. Everything here is decided by the stored state and the
 * clock; `LicenceApi` is the one seam, so the wire format can be written against a real Polar
 * account without any of these rules being re-derived or re-tested.
 */

import { licenceEndedNotice } from "./licence-messages";
import {
	applyOutcome,
	entitlementOf,
	type Entitlement,
	type LicenceOutcome,
	type LicenceState,
	nextLicenceCall,
	withActivation,
	withKey,
} from "./licence-state";

/** An activation either succeeds with an id, or fails with a reason. */
export type ActivationResult =
	| { outcome: "valid"; activationId: string }
	| { outcome: Exclude<LicenceOutcome, "valid"> };

/**
 * The three customer-portal calls. None of them needs a secret: the bundle carries only the public
 * organization id, which is why this can ship inside a plugin at all.
 */
export interface LicenceApi {
	/** `label` is the vault name, so the buyer recognises the row in Polar's own device list. */
	activate(key: string, label: string): Promise<ActivationResult>;
	validate(key: string, activationId: string): Promise<LicenceOutcome>;
	deactivate(key: string, activationId: string): Promise<void>;
}

export interface LicenceContext {
	/** The vault name, used as the activation label. */
	label: string;
	now: Date;
	/** What transcription falls back to, or null where there is none — Windows without a local server. */
	fallbackBackend: string | null;
}

export interface LicenceCheck {
	state: LicenceState;
	entitlement: Entitlement;
	/** Shown once, then never again. Null when there is nothing new to say. */
	notice: string | null;
	/** True when `state` differs from the one passed in and has to be persisted. */
	changed: boolean;
}

/**
 * Called on the path of a gated feature and nowhere else — never on load, and never for someone who
 * has not bought and is not trialling. That is the whole answer to "does this plugin phone home".
 *
 * A failure inside the API is treated as `unreachable`, i.e. as silence, which never locks Pro. A
 * thrown error here would surface as a broken sync, and the one thing an ended licence must never
 * look like is a broken plugin.
 */
export async function checkLicence(state: LicenceState, api: LicenceApi, ctx: LicenceContext): Promise<LicenceCheck> {
	let next = state;

	const call = nextLicenceCall(next, ctx.now);
	if (call === "activate") {
		next = await activateOnce(next, api, ctx);
	} else if (call === "validate" && next.key !== null && next.activationId !== null) {
		const { key, activationId } = next;
		const outcome = await attempt(() => api.validate(key, activationId));
		next = applyOutcome(next, outcome, ctx.now);
		// The one silent re-activation: someone freed this slot, and `deactivate` needs no
		// authentication at Polar, so that someone need not have been the owner. Re-activating before
		// anything locks is what stops a stranger with the key from locking the buyer out.
		if (outcome === "unknown-activation") next = await activateOnce(next, api, ctx);
	}

	return finish(state, next, ctx);
}

/**
 * Saves a pasted key and tries to activate it immediately.
 *
 * A key pasted with no connection is never refused: it is stored and activated the next time a gated
 * feature is used. Refusing it would throw away the one thing the buyer just paid for, over a
 * network blip.
 */
export async function activateKey(
	state: LicenceState,
	key: string,
	api: LicenceApi,
	ctx: LicenceContext,
): Promise<LicenceCheck & { outcome: LicenceOutcome }> {
	const saved = withKey(state, key);
	const result = await attemptActivation(() => api.activate(key.trim(), ctx.label));
	const next = result.outcome === "valid" ? withActivation(saved, result.activationId, ctx.now) : saved;
	// A key Polar has never heard of is a typo, reported as one. It is *not* folded into the state as
	// a revocation: nothing was ever active, so there is nothing to withdraw.
	return { ...finish(state, next, ctx), outcome: result.outcome };
}

/** Frees this vault's slot at Polar, then forgets the licence locally even if the call failed. */
export async function deactivateHere(state: LicenceState, api: LicenceApi): Promise<void> {
	if (state.key === null || state.activationId === null) return;
	try {
		await api.deactivate(state.key, state.activationId);
	} catch {
		// The slot stays used at Polar, and the buyer frees it themselves in their own portal --
		// `enable_customer_admin` is on for exactly this. Refusing to forget the key locally would be
		// worse: it would leave a licence on a machine whose owner asked for it to be gone.
	}
}

async function activateOnce(state: LicenceState, api: LicenceApi, ctx: LicenceContext): Promise<LicenceState> {
	const { key } = state;
	if (key === null) return state;
	const result = await attemptActivation(() => api.activate(key, ctx.label));
	if (result.outcome === "valid") return withActivation(state, result.activationId, ctx.now);
	return applyOutcome(state, result.outcome, ctx.now);
}

/**
 * Decides what to say, and whether the state has to be written.
 *
 * The notice fires on the *transition* into an ended licence, not on the state itself, because a
 * revocation lands during a background check: without it, someone would discover it by noticing that
 * transcription had quietly changed engines.
 */
function finish(before: LicenceState, after: LicenceState, ctx: LicenceContext): LicenceCheck {
	const entitlement = entitlementOf(after, ctx.now);
	const ended =
		entitlement.tier === "free" && (entitlement.reason === "revoked" || entitlement.reason === "trial-ended")
			? entitlement.reason
			: null;

	if (ended !== null && !after.endedNoticeShown) {
		return {
			state: { ...after, endedNoticeShown: true },
			entitlement,
			notice: licenceEndedNotice(ended, ctx.fallbackBackend ?? "no transcription"),
			changed: true,
		};
	}

	return { state: after, entitlement, notice: null, changed: after !== before };
}

async function attempt(call: () => Promise<LicenceOutcome>): Promise<LicenceOutcome> {
	try {
		return await call();
	} catch {
		return "unreachable";
	}
}

async function attemptActivation(call: () => Promise<ActivationResult>): Promise<ActivationResult> {
	try {
		return await call();
	} catch {
		return { outcome: "unreachable" };
	}
}
