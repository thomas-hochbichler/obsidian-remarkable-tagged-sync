/**
 * The reMarkable cloud as a {@link Transport}.
 *
 * Everything here already existed and is only being named: the two-step `auth.session()` +
 * `openSession(token)` the three call sites used to do inline, and the connection state the settings
 * tab and both pre-flights used to read straight off `RemarkableAuth`.
 *
 * `explainError` answers `null` on purpose. The sentences in `explain-error` were written for this
 * transport when it was the only one, so the neutral layer *is* the cloud's wording; claiming errors
 * here as well would be two copies of one paragraph.
 */

import { isOfflineError } from "./explain-error";
import type { RemarkableAuth } from "./remarkable-auth";
import { openSession } from "./remarkable-session";
import { NOT_CONNECTED_NOTICE } from "./sync-guards";
import type { Transport, TransportSession, TransportStatus } from "./transport";

export const CLOUD_TRANSPORT_LABEL = "reMarkable's cloud";

export class CloudTransport implements Transport {
	readonly id = "cloud" as const;
	readonly label = CLOUD_TRANSPORT_LABEL;

	constructor(private readonly auth: RemarkableAuth) {}

	status(): TransportStatus {
		const connected = this.auth.isConnected();
		return {
			connected,
			summary: connected ? "Connected." : "Not connected.",
			connectNotice: NOT_CONNECTED_NOTICE,
		};
	}

	async open(): Promise<TransportSession> {
		const api = openSession(await this.auth.session());
		// Nothing to tear down: rmapi-js talks HTTPS per request and holds no socket of its own.
		return { api, close: async () => {} };
	}

	explainError(): string | null {
		return null;
	}

	isUnreachable(error: unknown): boolean {
		return isOfflineError(error);
	}
}
