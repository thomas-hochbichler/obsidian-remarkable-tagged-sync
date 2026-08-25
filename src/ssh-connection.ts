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
	/**
	 * Every address that was tried, in order, because the transport quietly tries the cable when the
	 * configured address goes quiet. Naming only the last one told a user whose tablet sat on
	 * `192.168.178.76` that there was "no answer at 10.11.99.1" -- an address they never entered and
	 * cannot place, which reads as the plugin talking about someone else's device.
	 */
	readonly hosts: readonly string[];

	constructor(
		hosts: string | readonly string[],
		readonly reason: unknown,
	) {
		const tried = typeof hosts === "string" ? [hosts] : hosts;
		super(
			tried.length > 1
				? `No answer from your reMarkable — not at ${tried[0]}, and not over the USB cable.`
				: `No answer from your reMarkable at ${tried[0]}.`,
		);
		this.hosts = tried;
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
 * How many paths go into one request.
 *
 * Purely the step the progress report moves in -- the paths travel on standard input, so there is no
 * limit to work around. A first run is thousands of files and one unbroken command would say nothing
 * at all until every one of them was done.
 */
const HASH_BATCH = 250;

/**
 * Hashing a batch: a short, constant command, with the paths arriving on standard input.
 *
 * Both obvious alternatives were tried against a real tablet and both failed there, which is the
 * whole reason this is a named, tested function rather than a template string at the call site:
 *
 * - **`xargs -0`** -- this device's BusyBox rejects `-0` outright.
 * - **Passing the paths as arguments.** Works for a small batch and then stops: dropbear resets the
 *   connection on a command line around 19 kB, which is only a few hundred of these paths, and it
 *   presents as "unable to exec" rather than as anything about length.
 *
 * Standard input has neither limit, so the batch size below is free to be about progress alone. The
 * loop forks `sha256sum` per file, which sounds wasteful and is not: the whole library -- 747 files,
 * 185 MB -- measured 7.7 s on the device, where the reading dominates and the forks vanish into it.
 *
 * A newline in a path would end a line early and hash the wrong file, so it is refused. It cannot
 * occur -- every name under `xochitl/` is a uuid -- which is what makes the check cheap: if that
 * ever stops being true this says so instead of quietly returning a hash for something else.
 */
export function hashRequest(directory: string, paths: readonly string[]): { command: string; stdin: string } {
	for (const path of paths) {
		if (path.includes("\n")) throw new Error(`Cannot read a file whose name contains a newline: ${path}`);
	}
	return {
		// `IFS=` and `-r` keep the name exactly as it was written: no trimming, no backslash escapes.
		command: `cd ${directory} && while IFS= read -r p; do sha256sum "$p"; done`,
		stdin: paths.map((path) => `${path}\n`).join(""),
	};
}

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

	// Closed here on refusal, because this is the last point at which anybody can: the caller only
	// gets something to `close()` once the whole connection is built, so a rejection past this line
	// would leave an authenticated socket open with nothing holding a reference to it.
	const sftp = await new Promise<import("ssh2").SFTPWrapper>((resolve, reject) => {
		client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper)));
	}).catch((error: unknown) => {
		client.end();
		throw error;
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
				const request = hashRequest(XOCHITL_DIR, batch);
				const out = await exec(request.command, request.stdin);
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

/**
 * Anything that reads as "nobody answered" becomes the error the failover is allowed to act on.
 *
 * Exported for its own tests: every other branch of this module can be reached over a socket, but a
 * handshake timeout is fifteen seconds of waiting, and that one wording is the one that decides
 * whether a sleeping tablet falls over to the cloud or fails the run.
 */
export function asConnectionError(error: Error, credentials: SshCredentials): Error {
	const text = `${error.name}: ${error.message}`;
	// `etimedout` is its own case and not covered by `timeout`: node spells the code `ETIMEDOUT`, with
	// no `u` where the word has one. It is what a tablet that is simply off answers a connection with.
	if (/timed out|timeout|etimedout|ehostunreach|enetunreach|econnrefused|econnreset|enotfound|network/i.test(text)) {
		return new DeviceUnreachableError(credentials.host, error);
	}
	return error;
}
