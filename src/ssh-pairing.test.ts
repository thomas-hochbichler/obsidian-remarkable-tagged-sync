import { Platform } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { generateDeviceKey, generationOf, installKeyCommand, pairingGuidance } from "./ssh-pairing";

// Key generation is node `crypto`, which this plugin only ever loads on desktop -- the same guard
// the OCR runtimes use, and the same way their tests satisfy it.
beforeEach(() => {
	Platform.isDesktop = true;
});

describe("which reMarkable this is", () => {
	it("reads a Paper Pro and a Paper Pure off their hostnames", () => {
		// The two devices whose SSH costs a factory reset. Naming them by hostname is what lets the
		// warning appear before the user is asked for a password rather than after.
		expect(generationOf("imx8mm-ferrari")).toBe("developer-mode-required");
		expect(generationOf("imx93-tatsu")).toBe("developer-mode-required");
	});

	it("treats everything else as a tablet that already answers", () => {
		expect(generationOf("reMarkable")).toBe("cable-or-wifi");
	});
});

describe("what the user is told before they type a password", () => {
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
