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

import { namesInCloudFolder, sendToCloud } from "./cloud-send";
import { isOfflineError } from "./explain-error";
import type { RemarkableAuth } from "./remarkable-auth";
import { openSession } from "./remarkable-session";
import { NOT_CONNECTED_NOTICE } from "./sync-guards";
import type { Transport, TransportSession, TransportStatus } from "./transport";
import type { SendDocument, SendTransport } from "./zotero-send";

export const CLOUD_TRANSPORT_LABEL = "reMarkable's cloud";

export class CloudTransport implements Transport, SendTransport {
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

	/**
	 * Send's whole surface here (spec §2.4). A session of its own rather than the one `open()` hands
	 * out: that one is a {@link SyncApi}, six read methods, and widening it so a send could borrow it
	 * would put `putPdf` within reach of the sync engine -- which must never write anything at all.
	 */
	async putPdf(document: SendDocument): Promise<{ docId: string }> {
		return await sendToCloud(openSession(await this.auth.session()), document);
	}

	async namesIn(folder: string): Promise<string[]> {
		return await namesInCloudFolder(openSession(await this.auth.session()), folder);
	}

	explainError(): string | null {
		return null;
	}

	isUnreachable(error: unknown): boolean {
		return isOfflineError(error);
	}
}
