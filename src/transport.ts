/**
 * Where the notes come from, as the rest of the plugin sees it.
 *
 * The pipeline already had a seam -- `SyncApi` is a structural `Pick`, so anything shaped like it
 * feeds the engine -- and that seam stays exactly as it was. What it never had was a home for the
 * three things *around* the fetching that differ per source: how a connection is opened, what
 * "connected" means, and how a failure is worded. Those lived in `main.ts` as calls to
 * `RemarkableAuth` and in `explain-error.ts` as sentences about "the reMarkable cloud", and both
 * assumed there was only ever one source.
 *
 * So this interface is deliberately small: it holds the parts a second source (SSH to the tablet)
 * genuinely answers differently, and nothing else. The engine, the sync index and the cloud wire
 * path are untouched by it.
 *
 * There is no registry here and that is a decision. Two transports dispatch as a two-way branch in
 * `main.ts`; a registry with self-registering entries is the right shape at three, and introducing
 * it early would be machinery standing in for a switch.
 */

import { type ErrorContext, explainError } from "./explain-error";
import type { SyncApi } from "./sync-engine";

export type TransportId = "cloud" | "ssh";

/**
 * What a transport knows about itself *without touching the network*.
 *
 * Synchronous on purpose: `claimRun` takes the one-run-at-a-time lock in a single synchronous step,
 * so anything it consults has to answer without an await. That fixes the meaning of `connected` to
 * "fully configured" rather than "reachable" -- a stored cloud token, or a paired device. Whether
 * the thing at the other end answers is only learned by {@link Transport.open}, and for the SSH
 * transport that gap is real (a sleeping tablet is configured and unreachable). The auto-sync
 * reachability probe in `auto-sync-gates` is what covers it.
 */
export interface TransportStatus {
	readonly connected: boolean;
	/** The settings row's second line: "Connected." / "root@10.11.99.1 · host key pinned". */
	readonly summary: string;
	/** How a pre-flight refuses when this transport is not configured -- "Connect to reMarkable first." */
	readonly connectNotice: string;
}

/**
 * An open connection. `api` is the whole of what the pipeline may use; `close` is the caller's to
 * call, always in a `finally`.
 *
 * The cloud's `close` is a no-op -- it is a stateless HTTPS client -- and that is the point: the
 * lifetime exists because a socket-based transport needs it, and paying it on both sides is cheaper
 * than two shapes of call site.
 */
export interface TransportSession {
	readonly api: SyncApi;
	close(): Promise<void>;
}

export interface Transport {
	readonly id: TransportId;
	/** Names this source in settings rows and in failover notices. */
	readonly label: string;

	status(): TransportStatus;

	/**
	 * Connect, authenticate, and hand back the pipeline surface. Throws rather than returning a
	 * half-open session, so a caller sees the failure where the old `auth.session()` threw it.
	 */
	open(): Promise<TransportSession>;

	/**
	 * This transport's own wording for a failure, or `null` for one it does not recognise -- which
	 * falls through to the transport-neutral sentences in `explain-error`.
	 */
	explainError(error: unknown, context: ErrorContext): string | null;

	/**
	 * Is this failure "the other end was not there"?
	 *
	 * Only these fail over to the secondary transport. A rejected credential is *not* one of them:
	 * quietly syncing over the other source would hide a connection the user has to repair, and they
	 * would find out weeks later. See `transport-chain`.
	 */
	isUnreachable(error: unknown): boolean;
}

/**
 * The transport's own wording, or the neutral one. Two layers rather than one because most failures
 * -- a vault name conflict, a truncated page -- mean the same thing whichever source the bytes came
 * from, and only a transport can word the ones that do not.
 */
export function explainTransportError(transport: Transport, error: unknown, context: ErrorContext): string {
	// The neutral layer is told which source it is talking about, so its last-resort sentence names the
	// tablet when the tablet is what answered strangely.
	return transport.explainError(error, context) ?? explainError(error, context, transport.label);
}
