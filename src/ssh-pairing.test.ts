import { createServer, type Server } from "node:net";
import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDeviceKey, installKeyCommand, pairDevice, pairingGuidance } from "./ssh-pairing";

vi.mock("./ssh-connection", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ssh-connection")>()),
	connectToDevice: vi.fn(),
}));

import { connectToDevice } from "./ssh-connection";

// Key generation is node `crypto`, which this plugin only ever loads on desktop -- the same guard
// the OCR runtimes use, and the same way their tests satisfy it.
beforeEach(() => {
	Platform.isDesktop = true;
});

describe("what the user is told when nothing answers", () => {
	it("says out loud that Developer Mode erases the tablet, and that notes come back from the cloud", () => {
		const said = pairingGuidance("developer-mode-required").join(" ");

		expect(said).toContain("erases the tablet");
		expect(said).toContain("reMarkable cloud");
		// The warning screen is permanent and nobody mentions it anywhere; finding out afterwards is
		// the worst possible moment.
		expect(said).toContain("warning screen");
	});

	it("does not frighten an rM1 or rM2 owner, who has nothing to turn on", () => {
		const said = pairingGuidance("cable-or-wifi").join(" ");

		expect(said).not.toContain("erases");
		expect(said).toContain("out of the box");
	});

	it("says where the root password is, for either kind of tablet", () => {
		for (const generation of ["cable-or-wifi", "developer-mode-required"] as const) {
			expect(pairingGuidance(generation).join(" ")).toContain("Copyrights");
		}
	});
});

describe("the key this vault installs on the tablet", () => {
	it("is an ECDSA key, because the older tablets' SSH server predates ed25519", () => {
		const { privateKey, authorizedKeysLine } = generateDeviceKey();

		expect(privateKey).toContain("BEGIN EC PRIVATE KEY");
		// A key the device cannot read fails after the password has already been accepted, which is the
		// least debuggable moment pairing has.
		expect(authorizedKeysLine.startsWith("ecdsa-sha2-nistp256 ")).toBe(true);
	});

	it("is a different key every time, so two vaults never share one", () => {
		expect(generateDeviceKey().privateKey).not.toBe(generateDeviceKey().privateKey);
	});

	it("says who put it there, for whoever reads authorized_keys later", () => {
		expect(generateDeviceKey().authorizedKeysLine.endsWith(" tagged-sync")).toBe(true);
	});
});

describe("installing it", () => {
	it("appends without disturbing any other key, and without adding its own twice", () => {
		const command = installKeyCommand("ecdsa-sha2-nistp256 AAAA tagged-sync");

		// `>>`, never `>`: a user may have their own key on that tablet, and pairing must not be the
		// thing that locks them out of their own device.
		expect(command).toContain(">> /home/root/.ssh/authorized_keys");
		// `>>` only: replacing the file would lock a user out of a tablet they had their own key on.
		expect(command.replace(/>>/g, "")).not.toContain("> /home/root/.ssh/authorized_keys");
		expect(command).toContain("grep -qxF");
	});

	it("creates the directory with the permissions an SSH server insists on", () => {
		const command = installKeyCommand("ecdsa-sha2-nistp256 AAAA tagged-sync");

		// dropbear silently ignores an authorized_keys it considers too readable, which looks exactly
		// like a refused key.
		expect(command).toContain("chmod 700 /home/root/.ssh");
		expect(command).toContain("chmod 600 /home/root/.ssh/authorized_keys");
	});
});


/** A tablet that answers TCP, so the reachability probe is satisfied without a real SSH server. */
function listeningTablet(): Promise<{ port: number; close: () => void }> {
	return new Promise((resolve) => {
		const server: Server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			resolve({ port, close: () => server.close() });
		});
	});
}

describe("pairing, end to end", () => {
	let tablet: { port: number; close: () => void };
	const commands: string[] = [];

	beforeEach(async () => {
		tablet = await listeningTablet();
		commands.length = 0;
		vi.mocked(connectToDevice).mockReset();
	});
	afterEach(() => tablet.close());

	/** Every connection the flow makes, in order, so the test can answer them differently. */
	function device(answers: { exec?: (command: string) => string } = {}) {
		return {
			hostKeyFingerprint: "SHA256:abc",
			exec: async (command: string) => {
				commands.push(command);
				return answers.exec?.(command) ?? "";
			},
			list: async () => [],
			read: async () => new Uint8Array(),
			hash: async () => new Map<string, string>(),
			close: async () => {},
		};
	}

	const request = (over: Partial<Parameters<typeof pairDevice>[0]> = {}) => ({
		host: "127.0.0.1",
		port: tablet.port,
		password: "hunter2",
		confirmHostKey: async () => true,
		...over,
	});

	it("keeps nothing of the password, and stores the key it installed", async () => {
		vi.mocked(connectToDevice).mockResolvedValue(device() as never);

		const settings = await pairDevice(request());

		expect(settings.privateKey).toContain("BEGIN EC PRIVATE KEY");
		expect(settings.hostKeyFingerprint).toBe("SHA256:abc");
		// The password bought one thing and is gone. `data.json` travels between machines through
		// Obsidian Sync, and a root password riding along is a different promise from a key.
		expect(JSON.stringify(settings)).not.toContain("hunter2");
	});

	it("checks the key actually works before reporting success", async () => {
		// First connection is the password one and installs fine; the second -- the one with nothing but
		// the new key -- is refused, which is exactly what a rejected `authorized_keys` looks like.
		vi.mocked(connectToDevice)
			.mockResolvedValueOnce(device() as never)
			.mockRejectedValueOnce(new Error("All configured authentication methods failed"));

		await expect(pairDevice(request())).rejects.toThrow("authentication");
		// Without this check the failure surfaces as "pairing worked" and then every sync being refused,
		// long after the password that could have fixed it was forgotten.
		expect(vi.mocked(connectToDevice)).toHaveBeenCalledTimes(2);
	});

	it("does not open SSH over Wi-Fi unless the user said yes", async () => {
		vi.mocked(connectToDevice).mockResolvedValue(device() as never);

		await pairDevice(request({ confirmWifi: async () => false }));

		// It leaves a service listening on whatever network the tablet joins, so it is offered and not
		// assumed -- pairing over a cable must be allowed to stay cable-only.
		expect(commands.some((command) => command.includes("rm-ssh-over-wlan"))).toBe(false);
	});

	it("opens it, and takes the address back off the device, when they did", async () => {
		vi.mocked(connectToDevice).mockResolvedValue(
			device({ exec: (command) => (command.startsWith("ip ") ? "2: wlan0    inet 192.168.1.9/24 brd" : "") }) as never,
		);

		const settings = await pairDevice(request({ confirmWifi: async () => true }));

		expect(commands).toContain("rm-ssh-over-wlan on");
		// Read back rather than asked for: the user should not have to go and find their tablet's IP.
		expect(settings.host).toBe("192.168.1.9");
	});

	it("stops when the device's key is not trusted", async () => {
		vi.mocked(connectToDevice).mockResolvedValue(device() as never);

		await expect(pairDevice(request({ confirmHostKey: async () => false }))).rejects.toThrow("not trusted");
		expect(commands).toEqual([]);
	});
});
