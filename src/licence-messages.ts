/**
 * Every sentence the licence says to a user, in one place.
 *
 * Deliberately *not* a third context in `explainError()`: that function is about the reMarkable
 * cloud, and its regexes match rmapi-js and Electron text. The voice is the same — one plain
 * sentence saying what happened, then what to do — but the subject is not.
 *
 * The rule these are written to: an ended licence must read as an ended licence, never as a broken
 * plugin. So every locking message says what still works, in the same breath as what stopped.
 */

import type { Entitlement, LicenceOutcome, LicenceState } from "./licence-state";
import { trialEndsAt } from "./licence-state";

/** What a licence costs, said in one place so the settings tab and the README cannot drift apart. */
export const PRO_PRICE = "€24";

/** The activation ceiling, which is Polar's limit rather than a judgement about fair use. */
export const ACTIVATION_LIMIT = 50;

/**
 * `YYYY-MM-DD`, from an ISO timestamp.
 *
 * Left open by the purchase-flow ticket and settled here: a locale-formatted date reads as
 * `03/04/2026`, which means two different days on two continents, and these dates appear next to
 * money. An unformatted ISO timestamp would put a clock time on a refund, which is noise.
 */
export function onDay(iso: string): string {
	return iso.slice(0, 10);
}

/** The permanent settings row. `heading` is the state; `body` says what it means and what to do. */
export interface LicenceStatusText {
	heading: string;
	body: string;
}

export function licenceStatusText(entitlement: Entitlement, state: LicenceState): LicenceStatusText {
	switch (entitlement.tier) {
		case "pro":
			if (!entitlement.stale) {
				return {
					heading: "Active",
					body: `Key ending ${keySuffix(state.key)}. This vault is activated.`,
				};
			}
			return {
				heading: `Active — not confirmed since ${onDay(entitlement.since)}`,
				body: "Pro keeps working. This is almost always a network problem, not a problem with your licence.",
			};

		case "trial": {
			const until = `Everything in Pro is unlocked until ${onDay(entitlement.endsAt)}.`;
			// A key saved during a running trial is the one state where Pro works and the licence does
			// not. Without this line the row says "Trial" and nothing else, so someone who has just
			// pasted a key that failed sees the paid features working and concludes it took.
			if (state.key !== null) {
				return { heading: "Trial", body: `${until} Your licence key is saved but not confirmed yet — the trial is what is unlocking Pro.` };
			}
			return { heading: "Trial", body: until };
		}

		case "free":
			switch (entitlement.reason) {
				case "revoked":
					return {
						heading: "Not active — this licence was refunded",
						body:
							`Refunded on ${onDay(state.revokedAt ?? "")}, so the key was withdrawn. Cloud transcription ` +
							"is off and tag mappings are capped at one. Every folder you already mapped keeps syncing.",
					};
				case "trial-ended":
					return {
						heading: "Trial ended",
						body:
							"Cloud transcription is off and tag mappings are capped at one again. Your notes and " +
							"folders are untouched.",
					};
				case "not-activated":
					return {
						heading: "Not active — your key is saved, but not yet confirmed",
						body: "It will be activated the next time you are online.",
					};
				case "never-bought":
					return {
						heading: "Not active",
						body: `${PRO_PRICE}, once. Cloud transcription and unlimited tag mappings.`,
					};
			}
	}
}

/**
 * The one-time notice when a licence stops. Shown once and never again — the precedent is
 * `ocrUnavailableNoticeShown`.
 *
 * It exists because a revocation lands during a background check: without it, someone would discover
 * it by noticing that transcription had quietly changed engines, which is the "reads as a broken
 * plugin" failure. A reminder on every sync was rejected — it punishes someone who got their money
 * back, on every single run.
 */
export function licenceEndedNotice(reason: "revoked" | "trial-ended", fallbackBackend: string): string {
	const lead =
		reason === "revoked"
			? "Your Tagged Sync Pro licence was withdrawn after the refund."
			: "Your Tagged Sync Pro trial has ended.";
	return `${lead} Transcription has fallen back to ${fallbackBackend}.`;
}

/** A key that Polar does not know, reported at the moment it is pasted rather than stored. */
export const WRONG_KEY_MESSAGE =
	"That key was not recognised. Check for a typo, or paste it again from your purchase page.";

/**
 * A key that exists and has been withdrawn. Kept apart from {@link WRONG_KEY_MESSAGE} because
 * telling a refunded buyer to look for a typo sends them hunting for a mistake they did not make,
 * and then to the support address anyway — one round trip later and less kindly.
 */
export const WITHDRAWN_KEY_MESSAGE =
	"This licence is no longer active. A licence is withdrawn when the purchase was refunded or " +
	"reversed. If you think that is wrong, write to support@hochbichler.com.";

export const ACTIVATION_LIMIT_MESSAGE =
	`This licence is already active on ${ACTIVATION_LIMIT} devices. Free one in your account, then activate again.`;

/**
 * A key pasted with no connection is never refused. Refusing it would throw away the one thing the
 * buyer just paid for, over a network blip.
 */
export const OFFLINE_ACTIVATION_MESSAGE =
	"No connection to Polar. Your key is saved and will be activated as soon as you are online.";

/**
 * A Pro backend that is present in the bundle but not permitted. It falls back to the best free
 * backend *with* a message — never silently, and never by vanishing from the settings list, or
 * nobody would learn Pro exists.
 *
 * `fallbackBackend` is null on a machine with no free transcription at all, which is the ordinary
 * case on Windows and Linux without a local server. That message has to be honest about it.
 */
export function gatedBackendMessage(backendLabel: string, fallbackBackend: string | null): string {
	if (fallbackBackend === null) {
		return (
			`${backendLabel} needs Tagged Sync Pro. Nothing will be transcribed — no local transcription is ` +
			"set up on this machine."
		);
	}
	return `${backendLabel} needs Tagged Sync Pro. Using ${fallbackBackend} instead.`;
}

/**
 * The free tag cap. This edits a message that already ships: the existing sentence must keep saying
 * that an existing mapping is never removed, because the code gates *adding* only.
 */
export const TAG_CAP_MESSAGE =
	"The free version syncs one tag. Remove the current mapping to choose a different one, or unlock " +
	"unlimited tags with Tagged Sync Pro.";

/**
 * The money-back promise, in the fine print under the Pro section and repeated on the product page.
 * It only prevents chargebacks if it is read *before* the bank is called: a lost dispute costs more
 * than two refunds.
 */
export const MONEY_BACK_MESSAGE =
	`14 days, no questions asked — just write to me. One person, up to ${ACTIVATION_LIMIT} devices.`;

/**
 * The last four characters of the key, which identify a licence without exposing it.
 *
 * The buyer's email was the old plan and is dropped: it is unverified whether Polar's validate
 * response even returns one, in a synced vault the address would then sit in `data.json` on every
 * machine, and the measure is friction rather than security — not worth that.
 */
function keySuffix(key: string | null): string {
	if (key === null || key.length === 0) return "—";
	return key.slice(-4).toUpperCase();
}

/** How long is left, for the day-15 screen. Never negative; zero means the trial is over. */
export function trialDaysLeft(state: LicenceState, now: Date): number {
	const end = trialEndsAt(state);
	if (end === null) return 0;
	return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * What to say when someone has just pressed Activate.
 *
 * The router is the point, not the sentences: `licence-client.ts` already tells the five answers
 * apart, and this is the only place that decides which of them reaches the user. Two swapped arms
 * are invisible to every test about the outcomes -- and one particular swap is the cruelty the
 * sentences above were written to avoid, since `unknown-key` and `withdrawn` are identical for the
 * stored state and differ only here.
 */
export function activationMessage(outcome: LicenceOutcome): string {
	switch (outcome) {
		case "valid":
			return ACTIVATED_MESSAGE;
		case "activation-limit":
			return ACTIVATION_LIMIT_MESSAGE;
		case "unreachable":
			return OFFLINE_ACTIVATION_MESSAGE;
		case "withdrawn":
			return WITHDRAWN_KEY_MESSAGE;
		// Nothing was ever active here, so an unrecognised key is a typo rather than a withdrawal.
		default:
			return WRONG_KEY_MESSAGE;
	}
}

/** The one sentence in this file that is good news. */
export const ACTIVATED_MESSAGE = "Tagged Sync Pro is active in this vault.";
