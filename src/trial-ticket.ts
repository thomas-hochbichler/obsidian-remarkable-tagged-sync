/**
 * The trial ticket: the trial's start date, signed by taggedsync.com.
 *
 * Until 1.8 the trial was a plain timestamp in `data.json`, and deleting that one line started it
 * again. The pro-release spec accepted that while Pro was cloud transcription on the tester's own
 * API bill; Zotero write-back and frontmatter cost nothing to run, so an endless trial became a free
 * Pro. The fix keeps the shape the website promises -- one click, no key, no email -- and moves the
 * one fact a restart needs, *when this vault's trial began*, to a place the vault cannot edit:
 *
 * - The click sends a 12-hex hash of the vault's Obsidian id to `taggedsync.com/trial`, nothing else.
 * - The server answers with the start date and an ECDSA P-256 signature over `<hash>|<date>`. A
 *   vault it has seen before gets its *original* date back, so a deleted ticket only restores the
 *   trial that was already running.
 * - The plugin verifies the signature against the public key below on receipt and again on every
 *   load. An unsigned or mis-signed `trialStartedAt` is treated as no trial at all.
 *
 * What this does not stop: a new vault id (re-adding the vault, another device) is a new trial, and
 * a patched `main.js` can skip the check -- as it can skip every gate in this plugin. The bar moves
 * from "delete one line" to "set up a new vault every fortnight", and no higher.
 *
 * This is the one network call the plugin makes for a user who has not bought: once, on the click,
 * never on load and never on sync. It is disclosed in the README and in PRIVACY.md as the store's
 * developer policies ask.
 */

import { withTimeout } from "./licence-client";
import type { LicenceState } from "./licence-state";

export const TRIAL_TICKET_URL = "https://taggedsync.com/trial";

/** How long the issuing call may take before the click reports "no connection". */
export const TRIAL_ISSUE_TIMEOUT_MS = 10_000;

/**
 * The public half of the key taggedsync.com signs tickets with. Public by nature: it can only verify.
 * The private half lives as a secret on the Worker and nowhere in this repository.
 */
export const TRIAL_PUBLIC_KEY: JsonWebKey = {
	kty: "EC",
	crv: "P-256",
	x: "xXf9_tSsVHhFbbVh_LBVcC_OD13Zc1jbz2ozH7w6ZqA",
	y: "0VvMf92QCNcB-asIxuuI1hKsmjcKvnVpHv1UiS_yiyY",
};

export interface TrialTicket {
	/** ISO timestamp the server says this vault's trial began. */
	startedAt: string;
	/** Base64url, raw r||s, over `ticketMessage(vault, startedAt)`. */
	signature: string;
}

/** The one seam to the server, so the settings tab can be tested without it. */
export interface TrialIssuer {
	/** Resolves with a ticket, or rejects -- no connection, a refusal, a malformed answer. */
	issue(vault: string): Promise<TrialTicket>;
}

export type TrialStartFailure = "no-vault-id" | "unreachable" | "bad-ticket";

export class TrialStartError extends Error {
	constructor(readonly reason: TrialStartFailure) {
		super(`trial not started: ${reason}`);
	}
}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

/** The vault as the server knows it: the first 12 hex of SHA-256 over Obsidian's per-vault id. */
export async function vaultHashOf(appId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appId));
	return hex(new Uint8Array(digest)).slice(0, 12);
}

/** The bytes both sides sign. `|` cannot appear in either half, so the split is unambiguous. */
export function ticketMessage(vault: string, startedAt: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(new TextEncoder().encode(`${vault}|${startedAt}`));
}

export async function verifyTicket(
	vault: string,
	ticket: TrialTicket,
	publicKey: JsonWebKey = TRIAL_PUBLIC_KEY,
): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey("jwk", publicKey, ECDSA, false, ["verify"]);
		return await crypto.subtle.verify(SIGN, key, fromBase64url(ticket.signature), ticketMessage(vault, ticket.startedAt));
	} catch {
		// A signature that is not even base64url, or a runtime without the curve. Either way: not proven.
		return false;
	}
}

/**
 * Starts the trial: asks the server for this vault's ticket, checks it, and records it. Throws a
 * `TrialStartError` with the reason to show; the state is untouched on every failure.
 */
export async function startTrial(
	state: LicenceState,
	vault: string | null,
	issuer: TrialIssuer,
	publicKey: JsonWebKey = TRIAL_PUBLIC_KEY,
): Promise<LicenceState> {
	if (vault === null) throw new TrialStartError("no-vault-id");
	let ticket: TrialTicket;
	try {
		ticket = await issuer.issue(vault);
	} catch {
		throw new TrialStartError("unreachable");
	}
	if (!(await verifyTicket(vault, ticket, publicKey))) throw new TrialStartError("bad-ticket");
	return { ...state, trialStartedAt: ticket.startedAt, trialSignature: ticket.signature, trialVault: vault };
}

/**
 * What every load runs over the stored state: a trial the server did not sign for *this* vault is
 * no trial. That is the whole enforcement -- `entitlementOf` keeps reading `trialStartedAt`, and
 * this is what decides whether the field is allowed to be there.
 *
 * Returns the same object when nothing changed, so the caller can skip the write.
 */
export async function attestTrial(
	state: LicenceState,
	vault: string | null,
	publicKey: JsonWebKey = TRIAL_PUBLIC_KEY,
): Promise<LicenceState> {
	// No id, no verdict: the plugin can neither prove nor obtain a ticket here, so it leaves what it
	// found. Every Obsidian this plugin runs on has an id; this branch is the test double's.
	if (state.trialStartedAt === null || vault === null) return state;
	const proven =
		state.trialSignature !== null &&
		(await verifyTicket(vault, { startedAt: state.trialStartedAt, signature: state.trialSignature }, publicKey));
	if (proven) return state;
	return { ...state, trialStartedAt: null, trialSignature: null, trialVault: null };
}

/** The real issuer: one POST, a JSON body with the hash, a JSON answer with the ticket. */
export function createTrialIssuer(fetchFn: typeof fetch = fetch): TrialIssuer {
	return {
		async issue(vault) {
			// `withTimeout`, not an `AbortSignal`: inside the bundle `fetch` is Obsidian's `requestUrl`,
			// which ignores the signal. Same reasoning as the licence check.
			const response = await withTimeout(
				fetchFn(TRIAL_TICKET_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ vault }),
				}),
				TRIAL_ISSUE_TIMEOUT_MS,
			);
			if (!response.ok) throw new Error(`taggedsync.com answered ${response.status}`);
			const body = (await response.json()) as Partial<TrialTicket>;
			if (typeof body.startedAt !== "string" || typeof body.signature !== "string") {
				throw new Error("taggedsync.com answered without a ticket");
			}
			return { startedAt: body.startedAt, signature: body.signature };
		},
	};
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
