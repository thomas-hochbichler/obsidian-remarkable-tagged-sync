/**
 * The tablet itself as a {@link Transport} -- Pro, and the reason this seam exists.
 *
 * It reads `xochitl/` over SFTP and answers with the cloud's own hashes (`sync15-hash`), so a vault
 * can be pointed at either source, or fail over between them, without re-rendering anything it has
 * already got.
 *
 * The wording here is its own, because everything that goes wrong with a tablet goes wrong
 * differently from a cloud: it is asleep rather than down, and a refused key means "re-pair" rather
 * than "get a new code".
 */

import { openDeviceApi } from "./device-api";
import type { ErrorContext } from "./explain-error";
import { PersistentHashCache, type StoredHashes } from "./ssh-hash-cache";
import {
	connectToDevice,
	DeviceUnreachableError,
	HostKeyMismatchError,
	type SshCredentials,
	USB_HOST,
} from "./ssh-connection";
import type { Entitlement } from "./licence-state";
import type { Transport, TransportId, TransportSession, TransportStatus } from "./transport";

export const SSH_TRANSPORT_LABEL = "your reMarkable";

/** What pairing writes and a sync reads. Lives in `data.json` beside the cloud's device token. */
export interface SshSettings {
	/** Where the device answers: its Wi-Fi address after pairing, or the USB one. */
	host: string;
	port: number;
	/** Installed during pairing. The root password is used once, there, and never stored. */
	privateKey: string | null;
	/** Pinned on first pairing; a later mismatch is refused rather than re-learned. */
	hostKeyFingerprint: string | null;
}

export const DEFAULT_SSH_SETTINGS: SshSettings = {
	host: USB_HOST,
	port: 22,
	privateKey: null,
	hostKeyFingerprint: null,
};

/**
 * Which sources an entitlement may sync from.
 *
 * A function rather than an `if` at the call site, and phrased as "what may this vault read from"
 * rather than "is this user free", so `proCapabilities` can drive the real gate instead of a copy of
 * it -- the same move the tag cap makes with its limit. The cloud is never gated: the free plugin
 * has to keep working exactly as it did.
 */
export function allowedTransports(entitlement: Entitlement): TransportId[] {
	return entitlement.tier === "free" ? ["cloud"] : ["cloud", "ssh"];
}

/** A paired device is one this vault holds a key and a pinned host key for. */
export function isPaired(settings: SshSettings): boolean {
	return settings.privateKey !== null && settings.hostKeyFingerprint !== null && settings.host !== "";
}

export const NOT_PAIRED_NOTICE = "Pair with your reMarkable first (Settings → Connect device).";

/** How the plugin reaches the two pieces of state this transport owns, without owning `data.json`. */
export interface SshTransportStore {
	settings(): SshSettings;
	hashes(): StoredHashes;
	/** Called after a run with the pruned cache, so the next sync costs a listing. */
	saveHashes(hashes: StoredHashes): Promise<void>;
	/** Where to say what the device is doing while it does it -- the status bar, in the plugin. */
	report?(message: string): void;
}

export class SshTransport implements Transport {
	readonly id = "ssh" as const;
	readonly label = SSH_TRANSPORT_LABEL;

	constructor(private readonly store: SshTransportStore) {}

	status(): TransportStatus {
		const settings = this.store.settings();
		const paired = isPaired(settings);
		return {
			connected: paired,
			// Named rather than "Connected.": with two transports configured, which one this row is
			// about is the thing a reader needs, and the address is how they tell USB from Wi-Fi.
			summary: paired ? `Paired · root@${settings.host} · host key pinned` : "Not paired.",
			connectNotice: NOT_PAIRED_NOTICE,
		};
	}

	async open(): Promise<TransportSession> {
		const settings = this.store.settings();
		const connection = await this.connect(settings);
		const cache = new PersistentHashCache(this.store.hashes());
		try {
			const api = await openDeviceApi(connection, cache, (message) => this.store.report?.(message));
			return {
				api,
				close: async () => {
					await connection.close();
					await this.store.saveHashes(cache.pruned());
				},
			};
		} catch (error) {
			await connection.close();
			throw error;
		}
	}

	/**
	 * The configured address, then the cable.
	 *
	 * A vault paired over Wi-Fi is unreachable the moment the tablet sleeps or moves network, and the
	 * user's answer to that is usually already in their hand -- so a plugged-in tablet syncs rather
	 * than reporting that the address in the settings did not answer.
	 */
	private async connect(settings: SshSettings) {
		const credentials: SshCredentials = {
			host: settings.host,
			port: settings.port,
			privateKey: settings.privateKey,
			hostKeyFingerprint: settings.hostKeyFingerprint,
		};
		try {
			return await connectToDevice(credentials);
		} catch (error) {
			if (!(error instanceof DeviceUnreachableError) || settings.host === USB_HOST) throw error;
			try {
				return await connectToDevice({ ...credentials, host: USB_HOST });
			} catch (overCable) {
				// Both silent: report it as the one thing that happened, naming the address the user
				// actually configured. Letting the cable's own error through would tell them nothing
				// answered at an address they never chose.
				if (overCable instanceof DeviceUnreachableError) {
					throw new DeviceUnreachableError([settings.host, USB_HOST], overCable.reason);
				}
				// Anything else over the cable -- a refused key, a host key that changed -- is more
				// informative than the silence over Wi-Fi, so it surfaces as itself.
				throw overCable;
			}
		}
	}

	explainError(error: unknown, context: ErrorContext): string | null {
		if (error instanceof HostKeyMismatchError) {
			return (
				"Your reMarkable presented a different host key than the one this vault trusts. That happens " +
				"after a factory reset — or it is a different device. Pair again in Settings to trust the new key."
			);
		}
		if (error instanceof DeviceUnreachableError) {
			return error.hosts.length > 1
				? `${error.message} Wake it up, or plug it in, and try again.`
				: `${error.message} Wake it up, or connect it by cable, and try again.`;
		}
		const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		if (/cannot parse privatekey|unsupported key format|no key/i.test(text)) {
			// The stored key itself is unreadable, which `data.json` travelling between machines through
			// Obsidian Sync makes possible. Without this it fell through to the sentence about reMarkable
			// changing their service, which sends the user to look at entirely the wrong thing.
			return "The key this vault stored for your reMarkable cannot be read. Pair again in Settings to make a new one.";
		}
		if (/all configured authentication methods failed|authentication|permission denied/i.test(text)) {
			return (
				"Your reMarkable refused the key this vault stored. A factory reset (including the one that " +
				"turns on Developer Mode) clears it — pair again in Settings."
			);
		}
		if (context === "connect") {
			return "Could not reach your reMarkable over SSH. Check the address, and that the tablet is awake.";
		}
		if (/econnreset|epipe|socket|closed by|disconnect|timed out|timeout/i.test(text)) {
			// Claimed here so it never reaches the neutral layer, whose offline sentence talks about the
			// cloud and an internet connection -- neither of which is what happened to a tablet on a desk.
			return (
				"The connection to your reMarkable dropped part-way through. It may have gone to sleep — " +
				"the next sync carries on from where this one stopped."
			);
		}
		return null;
	}

	isUnreachable(error: unknown): boolean {
		return error instanceof DeviceUnreachableError;
	}
}
