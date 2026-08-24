/**
 * Trying the other source when the first one is not there.
 *
 * This is only safe because the two transports emit the same hashes: a run that falls over to the
 * tablet reads the vault's existing sync index and finds it valid, so nothing re-renders and nothing
 * is transcribed twice. Without that, a silent failover would be an expensive surprise rather than a
 * convenience.
 *
 * The rule that carries the weight is which failures qualify. **Only "nobody answered".** A refused
 * credential does not: syncing happily over the other source would hide a connection the user has to
 * repair, and they would find out weeks later, from a stale note. So a rejected token or a rejected
 * key stops the run and says so, exactly as it did when there was one transport.
 */

import type { Transport, TransportSession } from "./transport";

export interface TransportChain {
	readonly primary: Transport;
	/** `null` means "then it failed", which is what a vault with one source configured wants. */
	readonly fallback: Transport | null;
}

export interface OpenedTransport {
	/** Whichever one answered -- the caller words its errors and closes its session. */
	readonly transport: Transport;
	readonly session: TransportSession;
	/** Set when the fallback answered, so the run can say so once. */
	readonly failedOverFrom: Transport | null;
}

/**
 * Opens the primary, or the fallback when the primary was simply not there.
 *
 * A fallback that is not configured is not tried: "not paired" is not a connection problem, and
 * reporting it in place of the real failure would send the user to the wrong screen.
 */
export async function openTransportChain(chain: TransportChain): Promise<OpenedTransport> {
	try {
		return { transport: chain.primary, session: await chain.primary.open(), failedOverFrom: null };
	} catch (error) {
		const { fallback } = chain;
		if (fallback === null || !chain.primary.isUnreachable(error) || !fallback.status().connected) throw error;
		return { transport: fallback, session: await fallback.open(), failedOverFrom: chain.primary };
	}
}

/** Said once, when a run went somewhere other than where the user pointed it. */
export function failoverNotice(from: Transport, to: Transport): string {
	return `Could not reach ${from.label} — synced from ${to.label} instead.`;
}
