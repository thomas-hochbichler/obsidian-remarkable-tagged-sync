/**
 * Pairing a tablet: the one time a root password is typed, and the last time it is needed.
 *
 * The password buys exactly one thing -- a key of this vault's own in the device's
 * `authorized_keys` -- and is then dropped. It is never written to `data.json`, which matters more
 * here than it looks: that file travels between machines through Obsidian Sync, and a root password
 * riding along to every machine a vault is opened on is a different promise from a key that grants
 * one tablet on one LAN.
 *
 * The device generation the user has decides how much this can do for them. rM1 and rM2 answer SSH
 * out of the box; a Paper Pro or Paper Pure answers nothing at all until Developer Mode is turned
 * on, and turning it on **factory-resets the tablet**. No competitor says this in-product, and
 * finding it out afterwards is the worst possible moment, so {@link pairingGuidance} says it before
 * anyone types a password.
 */

import { Platform } from "obsidian";
import { type ParsedKey, utils as sshUtils } from "ssh2";
import {
	connectToDevice,
	type DeviceConnection,
	DeviceUnreachableError,
	type SshCredentials,
	USB_HOST,
} from "./ssh-connection";
import type { SshSettings } from "./ssh-transport";

/** How long to wait for a plain TCP answer before deciding nothing is there. */
const PROBE_TIMEOUT_MS = 2_000;

function nodeRequire(id: "crypto"): typeof import("crypto");
function nodeRequire(id: "net"): typeof import("net");
function nodeRequire(id: string): unknown {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: connecting to a device directly is desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: see local-ocr-runtime.
	const loaded: unknown = require(id);
	return loaded;
}

/**
 * Is anything listening for SSH there?
 *
 * A plain TCP dial rather than an SSH handshake: this is asked to decide *which* address to talk to
 * and, later, whether a background sync is worth starting at all, and neither wants to spend an
 * authentication on the answer.
 */
export function probeDevice(host: string, port = 22): Promise<boolean> {
	const net = nodeRequire("net");
	return new Promise((resolve) => {
		const socket = new net.Socket();
		const settle = (reachable: boolean) => {
			socket.destroy();
			resolve(reachable);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS);
		socket.once("connect", () => settle(true));
		socket.once("timeout", () => settle(false));
		socket.once("error", () => settle(false));
		socket.connect(port, host);
	});
}

/**
 * Which reMarkable this is, as far as pairing needs to care.
 *
 * `unknown` is the honest answer before anything has answered at all -- which is exactly when the
 * guidance is needed, because a tablet that says nothing may be an rM2 that is asleep or a Paper Pro
 * that will never answer until it has been erased.
 */
export type DeviceGeneration = "cable-or-wifi" | "developer-mode-required" | "unknown";

/**
 * The tablet's own hostname says which generation it is: `imx8mm-ferrari` is a Paper Pro,
 * `imx93-tatsu` a Paper Pure, and the older models report something else entirely.
 */
export function generationOf(hostname: string): DeviceGeneration {
	return /ferrari|tatsu/i.test(hostname) ? "developer-mode-required" : "cable-or-wifi";
}

/**
 * What to tell someone whose tablet did not answer.
 *
 * Split by generation because the two answers have nothing in common: one is "check the cable", the
 * other is "this costs you a factory reset, here is what happens". Pure, so the sentence that
 * carries the factory reset is pinned by a test rather than by whoever last edited the settings tab.
 */
export function pairingGuidance(generation: DeviceGeneration): string[] {
	if (generation === "unknown") {
		return [
			"Nothing answered on that address.",
			"If this is a reMarkable 1 or 2: connect it by USB cable, or make sure it is awake and on the same Wi-Fi network. SSH is on by default.",
			...pairingGuidance("developer-mode-required").map((line, index) =>
				index === 0 ? "If this is a Paper Pro or Paper Pure: SSH is only available in Developer Mode." : line,
			),
		];
	}
	if (generation === "developer-mode-required") {
		return [
			"Your reMarkable Paper Pro and Paper Pure only allow SSH in Developer Mode.",
			"Turning Developer Mode on erases the tablet. Your notes come back from the reMarkable cloud afterwards, but check they are synced first — and the tablet will show a warning screen at every start from then on.",
			"Settings → General → Software → Developer mode, then set the tablet up again.",
			"Afterwards the root password appears under Settings → General → Help → About → Copyrights and licenses, and the first connection has to be over the USB cable.",
		];
	}
	return [
		"Your reMarkable allows SSH out of the box — there is nothing to turn on.",
		"Connect it by USB cable, or make sure it is awake and on the same Wi-Fi network.",
		"The root password is under Settings → General → Help → About → Copyrights and licenses, at the end of the GPLv3 section.",
	];
}

/** A keypair for this vault, in the two shapes the two ends need it in. */
export function generateDeviceKey(): { privateKey: string; authorizedKeysLine: string } {
	// ECDSA P-256 rather than ed25519: the older tablets run a dropbear that predates ed25519 support,
	// and a key the device cannot read fails at the least debuggable moment -- after the password has
	// already been accepted.
	const { privateKey } = nodeRequire("crypto").generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
		privateKeyEncoding: { type: "sec1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const key: ParsedKey | Error = sshUtils.parseKey(privateKey);
	if (key instanceof Error) throw key;
	return {
		privateKey,
		// Labelled so a user reading `authorized_keys` on their own device knows what put it there.
		authorizedKeysLine: `${key.type} ${key.getPublicSSH().toString("base64")} tagged-sync`,
	};
}

/** The command that adds our key without disturbing any other, and without adding it twice. */
export function installKeyCommand(authorizedKeysLine: string): string {
	return [
		"mkdir -p /home/root/.ssh",
		"chmod 700 /home/root/.ssh",
		"touch /home/root/.ssh/authorized_keys",
		"chmod 600 /home/root/.ssh/authorized_keys",
		// Appended only if it is not already there, so re-pairing the same vault does not grow the file.
		// Braced so the `||` binds to the grep alone: without them a failure anywhere earlier in the
		// chain would also fall through to the append.
		`{ grep -qxF "${authorizedKeysLine}" /home/root/.ssh/authorized_keys || echo "${authorizedKeysLine}" >> /home/root/.ssh/authorized_keys; }`,
	].join(" && ");
}

/** The first address that answers: whatever the user gave, else the cable. */
export async function reachableHost(preferred: string | null, port = 22): Promise<string | null> {
	if (preferred !== null && preferred !== "" && (await probeDevice(preferred, port))) return preferred;
	return (await probeDevice(USB_HOST, port)) ? USB_HOST : null;
}

export interface PairingRequest {
	/** What the user typed, or `null` to go straight for the cable. */
	readonly host: string | null;
	readonly port?: number;
	readonly password: string;
	/**
	 * Ask the user whether to trust the key the device presented. Trust on first use: there is no
	 * authority to check a tablet's key against, so the honest thing is to show it and pin the answer.
	 */
	confirmHostKey(fingerprint: string): Promise<boolean>;
	report?(step: string): void;
}

export class PairingRefusedError extends Error {}

/**
 * Password once, key afterwards.
 *
 * Ends by asking the device to keep SSH open over Wi-Fi, because the alternative is a feature that
 * only works while the tablet is plugged in -- and by reading back the Wi-Fi address, because the
 * user should not have to find it themselves.
 */
export async function pairDevice(request: PairingRequest): Promise<SshSettings> {
	const port = request.port ?? 22;
	const host = await reachableHost(request.host, port);
	if (host === null) throw new DeviceUnreachableError(request.host ?? USB_HOST, null);

	request.report?.("Connecting…");
	const credentials: SshCredentials = { host, port, privateKey: null, password: request.password, hostKeyFingerprint: null };
	const connection = await connectToDevice(credentials);
	try {
		if (!(await request.confirmHostKey(connection.hostKeyFingerprint))) {
			throw new PairingRefusedError("Pairing stopped: the device's key was not trusted.");
		}

		request.report?.("Installing this vault's key…");
		const { privateKey, authorizedKeysLine } = generateDeviceKey();
		await connection.exec(installKeyCommand(authorizedKeysLine));

		request.report?.("Allowing SSH over Wi-Fi…");
		const wifiHost = await enableWifiAccess(connection);

		return {
			// The Wi-Fi address when the device has one: a cable is how pairing starts, not how syncing
			// should have to continue. `SshTransport` probes the cable anyway when this stops answering.
			host: wifiHost ?? host,
			port,
			privateKey,
			hostKeyFingerprint: connection.hostKeyFingerprint,
		};
	} finally {
		await connection.close();
	}
}

/**
 * Turns on SSH over Wi-Fi and reads back the address, or answers `null` if this tablet has neither.
 *
 * Deliberately not fatal: a device on a network the user does not want it reachable on is still a
 * perfectly good cable-paired device, and failing the whole pairing over the optional half would be
 * the wrong trade.
 */
async function enableWifiAccess(connection: DeviceConnection): Promise<string | null> {
	try {
		await connection.exec("rm-ssh-over-wlan on");
		const out = await connection.exec("ip -4 -o addr show wlan0");
		return /inet (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
	} catch {
		return null;
	}
}

/** The tablet's hostname, for {@link generationOf} -- asked before a password is, so it can guide. */
export async function readGeneration(connection: DeviceConnection): Promise<DeviceGeneration> {
	return generationOf((await connection.exec("uname -n")).trim());
}
