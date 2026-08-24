/**
 * One SSH connection to a tablet, as the {@link DeviceFiles} the rest of the transport reads.
 *
 * Everything device-specific and unpleasant is here: dropbear, a BusyBox userland whose `head` and
 * `stat` take different flags from a desktop's, host keys, and the fact that a tablet is a computer
 * that goes to sleep. Above this line nothing knows any of it.
 *
 * Two decisions worth naming:
 *
 * **Hashing happens on the device.** `sha256sum` is in BusyBox, the library is ~185 MB, and hashing
 * it here would mean transferring all of it on first pairing to learn numbers the tablet can compute
 * without sending a byte.
 *
 * **The host key is pinned on first pairing and strictly checked afterwards.** ssh2 accepts any host
 * key by default, which on a LAN is an invitation; a mismatch is refused rather than re-learned,
 * because the two things that cause one are a factory reset and somebody else answering.
 */

import { Platform } from "obsidian";
// Imported statically, unlike the node builtins the OCR runtimes pull in with `require`. Those are
// present wherever the plugin runs; this is a dependency, and a dependency that is not in `main.js`
// is not on the user's machine at all. The plugin is `isDesktopOnly`, so there is no environment
// this loads in where its own imports are missing.
import { Client } from "ssh2";
import type { DeviceFileStat, DeviceFiles } from "./device-api";

/** Where xochitl keeps everything. The one absolute path in this plugin. */
export const XOCHITL_DIR = "/home/root/.local/share/remarkable/xochitl";

/** The address a tablet answers on over USB, whatever its Wi-Fi situation is. */
export const USB_HOST = "10.11.99.1";

export interface SshCredentials {
	readonly host: string;
	readonly port: number;
	/** The durable credential, installed during pairing. */
	readonly privateKey: string | null;
	/** Used for the one connection that installs the key, and never stored. */
	readonly password?: string;
	/** Trust on first use: `null` while pairing, pinned afterwards. */
	readonly hostKeyFingerprint: string | null;
}

/** The device did not answer -- asleep, unplugged, or on another network. Fails over; see `Transport`. */
export class DeviceUnreachableError extends Error {
	constructor(
		host: string,
		readonly reason: unknown,
	) {
		super(`No answer from your reMarkable at ${host}.`);
		this.name = "DeviceUnreachableError";
	}
}

/** The device answered with a different host key than the one this vault pinned. Never fails over. */
export class HostKeyMismatchError extends Error {
	constructor(readonly fingerprint: string) {
		super("The device presented a different host key than the one this vault trusts.");
		this.name = "HostKeyMismatchError";
	}
}

export interface DeviceConnection extends DeviceFiles {
	/** What the device presented, so pairing can pin it. */
	readonly hostKeyFingerprint: string;
	/** One command on the device. Pairing needs it; the sync path uses only the three above. */
	exec(command: string, stdin?: string): Promise<string>;
	close(): Promise<void>;
}

// Node modules are loaded the way the local OCR runtime loads them: at the point of use, behind the
// desktop check, so a static import cannot pull them in where they do not exist.
function nodeRequire(id: "crypto"): typeof import("crypto");
function nodeRequire(id: string): unknown {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: connecting to a device directly is desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: see local-ocr-runtime.
	const loaded: unknown = require(id);
	return loaded;
}

/** OpenSSH's own fingerprint spelling, so what the plugin shows matches what `ssh` showed. */
function fingerprintOf(key: Buffer): string {
	const digest = nodeRequire("crypto").createHash("sha256").update(key).digest("base64");
	return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Splits `<size> <mtime> <path>` without breaking a path that has spaces in it. */
export function parseStatLine(line: string): DeviceFileStat | null {
	const match = /^(\d+) (\d+) (.+)$/.exec(line.trim());
	if (match === null) return null;
	const path = match[3].replace(/^\.\//, "");
	// Seconds on this userland, milliseconds in the cache key -- see the freshness window in
	// `ssh-hash-cache`, which is what keeps a same-second rewrite from being served from cache.
	return { path, size: Number(match[1]), mtimeMs: Number(match[2]) * 1000 };
}

/** `sha256sum` writes `<hash>  <path>`; the separator is two spaces, and a path may contain more. */
export function parseHashLine(line: string): { path: string; hash: string } | null {
	const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trimEnd());
	if (match === null) return null;
	return { hash: match[1], path: match[2].replace(/^\.\//, "") };
}

/**
 * How many paths go into one `xargs` batch.
 *
 * Not an arg-length limit -- paths are fed through stdin precisely so there is none -- but the step
 * the progress report moves in: the first run of a full library is thousands of files, and one
 * unbroken command would say nothing at all until every one of them was done.
 */
const HASH_BATCH = 250;

export async function connectToDevice(credentials: SshCredentials): Promise<DeviceConnection> {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: connecting to a device directly is desktop-only");
	const client = new Client();
	let fingerprint = "";

	await new Promise<void>((resolve, reject) => {
		client.on("ready", resolve);
		client.on("error", (error) => reject(asConnectionError(error, credentials)));
		client.connect({
			host: credentials.host,
			port: credentials.port,
			username: "root",
			...(credentials.privateKey === null ? {} : { privateKey: credentials.privateKey }),
			...(credentials.password === undefined ? {} : { password: credentials.password }),
			// A sleeping tablet accepts the TCP connection and then says nothing, so without this the
			// sync would hang rather than fail.
			readyTimeout: 15_000,
			keepaliveInterval: 10_000,
			hostVerifier: (key: Buffer) => {
				fingerprint = fingerprintOf(key);
				return credentials.hostKeyFingerprint === null || credentials.hostKeyFingerprint === fingerprint;
			},
		});
	}).catch((error: unknown) => {
		client.end();
		// The verifier's refusal surfaces as an ordinary connection error, so it is named here while
		// the fingerprint that caused it is still in hand.
		if (credentials.hostKeyFingerprint !== null && fingerprint !== "" && credentials.hostKeyFingerprint !== fingerprint) {
			throw new HostKeyMismatchError(fingerprint);
		}
		throw error;
	});

	const exec = (command: string, stdin?: string): Promise<string> =>
		new Promise((resolve, reject) => {
			client.exec(command, (error, stream) => {
				if (error) {
					reject(error);
					return;
				}
				let out = "";
				let err = "";
				stream.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
				stream.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
				stream.on("close", (code: number) =>
					code === 0 ? resolve(out) : reject(new Error(`\`${command}\` failed on the device: ${err.trim()}`)),
				);
				if (stdin !== undefined) stream.end(stdin);
			});
		});

	const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
		client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)));
	});

	return {
		hostKeyFingerprint: fingerprint,
		exec,

		async list(): Promise<DeviceFileStat[]> {
			// One walk for names, sizes and times together, over a shell rather than over SFTP -- the one
			// place this transport does not use the SFTP subsystem, and worth the exception: a recursive
			// SFTP listing is a round trip per directory, and a real library is a directory per document
			// plus one per page that carries a picture. One command replaces hundreds.
			//
			// BusyBox `find` has no `-printf`, so `stat -c` does the formatting; `-exec … +` batches
			// rather than forking per file. Both are BusyBox applets the device ships.
			const out = await exec(`cd ${XOCHITL_DIR} && find . -type f -exec stat -c '%s %Y %n' {} +`);
			const stats: DeviceFileStat[] = [];
			for (const line of out.split("\n")) {
				const stat = parseStatLine(line);
				if (stat !== null) stats.push(stat);
			}
			return stats;
		},

		read(path: string): Promise<Uint8Array> {
			return new Promise((resolve, reject) => {
				sftp.readFile(`${XOCHITL_DIR}/${path}`, (error, buffer) =>
					error ? reject(error) : resolve(new Uint8Array(buffer)),
				);
			});
		},

		async hash(
			paths: readonly string[],
			onProgress?: (done: number, total: number) => void,
		): Promise<Map<string, string>> {
			const hashes = new Map<string, string>();
			for (let start = 0; start < paths.length; start += HASH_BATCH) {
				onProgress?.(start, paths.length);
				const batch = paths.slice(start, start + HASH_BATCH);
				// NUL-separated through stdin: no quoting to get wrong, and no command-line length limit
				// to hit on an account with thousands of pages.
				const out = await exec(`cd ${XOCHITL_DIR} && xargs -0 sha256sum`, `${batch.join("\0")}\0`);
				for (const line of out.split("\n")) {
					const parsed = parseHashLine(line);
					if (parsed !== null) hashes.set(parsed.path, parsed.hash);
				}
			}
			onProgress?.(paths.length, paths.length);
			return hashes;
		},

		async close(): Promise<void> {
			client.end();
		},
	};
}

/** Anything that reads as "nobody answered" becomes the error the failover is allowed to act on. */
function asConnectionError(error: Error, credentials: SshCredentials): Error {
	const text = `${error.name}: ${error.message}`;
	if (/timed out|timeout|ehostunreach|enetunreach|econnrefused|econnreset|enotfound|network/i.test(text)) {
		return new DeviceUnreachableError(credentials.host, error);
	}
	return error;
}
