import { beforeEach, describe, expect, it, vi } from "vitest";
import { entitlementOf, NO_LICENCE, type LicenceState } from "./licence-state";

// Only the connecting is faked. Everything this file reads off a device -- the stat lines, the hash
// request, the errors -- stays the real thing, and `ssh-connection.test.ts` runs the connecting
// itself against a real SSH server.
vi.mock("./ssh-connection", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ssh-connection")>()),
	connectToDevice: vi.fn(),
}));

import {
	connectToDevice,
	type DeviceConnection,
	DeviceUnreachableError,
	hashRequest,
	HostKeyMismatchError,
	parseHashLine,
	parseStatLine,
	USB_HOST,
} from "./ssh-connection";
import { PersistentHashCache, type StoredHashes } from "./ssh-hash-cache";
import {
	allowedTransports,
	DEFAULT_SSH_SETTINGS,
	isPaired,
	NOT_PAIRED_NOTICE,
	type SshSettings,
	SshTransport,
} from "./ssh-transport";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const PAIRED: SshSettings = { host: "192.168.1.9", port: 22, privateKey: "PEM", hostKeyFingerprint: "SHA256:abc" };
const BOUGHT: LicenceState = {
	...NO_LICENCE,
	key: "TSP-1234",
	activationId: "act-1",
	validatedAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
};

function transport(settings = PAIRED): SshTransport {
	return new SshTransport({ settings: () => settings, hashes: () => ({}), saveHashes: async () => {} });
}

describe("what counts as paired", () => {
	it("needs a key and a pinned host key, not just an address", () => {
		expect(isPaired(DEFAULT_SSH_SETTINGS)).toBe(false);
		expect(isPaired({ ...PAIRED, privateKey: null })).toBe(false);
		expect(isPaired({ ...PAIRED, hostKeyFingerprint: null })).toBe(false);
		expect(isPaired(PAIRED)).toBe(true);
	});

	it("refuses a run in its own words rather than the cloud's", () => {
		const status = transport(DEFAULT_SSH_SETTINGS).status();

		expect(status.connected).toBe(false);
		// "Connect to reMarkable first." would send someone hunting for a one-time code they do not need.
		expect(status.connectNotice).toBe(NOT_PAIRED_NOTICE);
	});

	it("names the address it is paired with, because a vault may have two sources", () => {
		expect(transport().status().summary).toContain("192.168.1.9");
	});
});

describe("what the user is told when the device says no", () => {
	it("tells someone whose tablet is asleep to wake it, and offers the cable", () => {
		const sentence = transport().explainError(new DeviceUnreachableError("192.168.1.9", null), "sync");

		expect(sentence).toContain("192.168.1.9");
		expect(sentence).toContain("cable");
	});

	it("names the address the user configured, not the cable it quietly tried as well", () => {
		// The transport falls back to the USB address on its own. Reporting only the last attempt told
		// someone whose tablet sits on 192.168.178.76 that nothing answered at 10.11.99.1 -- an address
		// they never entered and cannot place, which reads as the plugin describing someone else's device.
		const both = transport().explainError(new DeviceUnreachableError(["192.168.1.9", "10.11.99.1"], null), "sync") ?? "";

		expect(both).toContain("192.168.1.9");
		expect(both).toContain("USB cable");
		expect(both).not.toContain("10.11.99.1");
	});

	it("explains a changed host key as a reset rather than as a failure to connect", () => {
		const sentence = transport().explainError(new HostKeyMismatchError("SHA256:zzz"), "sync") ?? "";

		expect(sentence).toContain("factory reset");
		expect(sentence).toContain("Pair again");
	});

	it("says a stored key that cannot be read is a key to replace, not a reMarkable problem", () => {
		// `data.json` travels between machines through Obsidian Sync, so an unreadable key is possible.
		// It used to fall through to the sentence about reMarkable changing their service, which sends
		// the user to look at entirely the wrong thing.
		const sentence = transport().explainError(new Error("Cannot parse privateKey: Unsupported key format"), "sync") ?? "";

		expect(sentence).toContain("Pair again");
	});

	it("sends a refused key to re-pairing, and names the reset that causes it", () => {
		const sentence = transport().explainError(new Error("All configured authentication methods failed"), "sync") ?? "";

		expect(sentence).toContain("pair again");
		expect(sentence).toContain("Developer Mode");
	});

	it("leaves a vault name conflict to the neutral wording", () => {
		expect(transport().explainError(new Error("File already exists."), "sync")).toBeNull();
	});
});

describe("which failures may quietly go to the other source", () => {
	it("fails over when nobody answered", () => {
		expect(transport().isUnreachable(new DeviceUnreachableError("h", null))).toBe(true);
	});

	it("never fails over on a refused key or a changed host key", () => {
		// Syncing over the cloud instead would hide a pairing the user has to repair, and they would
		// find out weeks later from a note that stopped updating.
		expect(transport().isUnreachable(new HostKeyMismatchError("SHA256:zzz"))).toBe(false);
		expect(transport().isUnreachable(new Error("All configured authentication methods failed"))).toBe(false);
	});
});

/** A tablet that answers, with nothing on it -- enough for a session to open over. */
function connection(overrides: Partial<DeviceConnection> = {}): DeviceConnection {
	return {
		hostKeyFingerprint: "SHA256:abc",
		exec: async () => "",
		list: async () => [],
		read: async () => new Uint8Array(),
		hash: async () => new Map(),
		close: async () => {},
		...overrides,
	};
}

describe("reaching a tablet that has moved", () => {
	beforeEach(() => vi.mocked(connectToDevice).mockReset());

	/** Which address each attempt was made to, in order. */
	const addresses = (): string[] => vi.mocked(connectToDevice).mock.calls.map(([credentials]) => credentials.host);

	it("tries the cable when the address in the settings has gone quiet", async () => {
		vi.mocked(connectToDevice)
			.mockRejectedValueOnce(new DeviceUnreachableError("192.168.1.9", null))
			.mockResolvedValueOnce(connection());

		await transport().open();

		// A vault paired over Wi-Fi is unreachable the moment the tablet sleeps or joins another
		// network, and the answer is usually already in the user's hand.
		expect(addresses()).toEqual(["192.168.1.9", USB_HOST]);
	});

	it("does not ask the cable a question it has just asked the cable", async () => {
		vi.mocked(connectToDevice).mockRejectedValueOnce(new DeviceUnreachableError(USB_HOST, null));

		await expect(transport({ ...PAIRED, host: USB_HOST }).open()).rejects.toBeInstanceOf(DeviceUnreachableError);

		// A second attempt at the same address would double every timeout for no chance of an answer.
		expect(addresses()).toEqual([USB_HOST]);
	});

	it("names the address the user chose when neither it nor the cable answers", async () => {
		vi.mocked(connectToDevice)
			.mockRejectedValueOnce(new DeviceUnreachableError("192.168.1.9", null))
			.mockRejectedValueOnce(new DeviceUnreachableError(USB_HOST, null));

		const error = await transport().open().catch((caught: unknown) => caught);

		// The error the user is shown is built here, from two attempts. Until this test the sentence
		// was checked against an error written by hand, so nothing ran the fallback that produces it.
		expect((error as DeviceUnreachableError).hosts).toEqual(["192.168.1.9", USB_HOST]);
	});

	it("leaves a refused key where it happened, instead of asking the cable the same thing", async () => {
		const refused = new Error("All configured authentication methods failed");
		vi.mocked(connectToDevice).mockRejectedValueOnce(refused);

		await expect(transport().open()).rejects.toBe(refused);

		// The cable would refuse the same key. Trying is a wasted timeout and a worse error message.
		expect(addresses()).toEqual(["192.168.1.9"]);
	});

	it("says what the cable said when the cable had something better to say than silence", async () => {
		const mismatch = new HostKeyMismatchError("SHA256:zzz");
		vi.mocked(connectToDevice)
			.mockRejectedValueOnce(new DeviceUnreachableError("192.168.1.9", null))
			.mockRejectedValueOnce(mismatch);

		// Reporting "nothing answered" here would hide the one thing that did happen: a tablet on the
		// end of the cable presenting a host key this vault does not trust.
		await expect(transport().open()).rejects.toBe(mismatch);
	});
});

describe("what a session leaves behind", () => {
	beforeEach(() => vi.mocked(connectToDevice).mockReset());

	it("writes back only the hashes the device still has", async () => {
		const saved: StoredHashes[] = [];
		vi.mocked(connectToDevice).mockResolvedValue(connection());
		const store = {
			settings: () => PAIRED,
			hashes: (): StoredHashes => ({ "gone/0.rm|10|1755000000000": "deadbeef" }),
			saveHashes: async (hashes: StoredHashes) => void saved.push(hashes),
		};

		const session = await new SshTransport(store).open();
		await session.close();

		// One entry per page ever deleted would otherwise pile up in `data.json` for the life of the
		// vault. The device listed nothing, so nothing was seen, so nothing is kept.
		expect(saved).toEqual([{}]);
	});

	it("closes the connection when the device's own listing cannot be read", async () => {
		let closed = false;
		vi.mocked(connectToDevice).mockResolvedValue(
			connection({
				list: () => Promise.reject(new Error("stat: applet not found")),
				close: async () => void (closed = true),
			}),
		);

		await expect(transport().open()).rejects.toThrow("applet not found");

		// The caller has nothing to close -- it never received a session -- so an open connection here
		// is one nobody holds a reference to.
		expect(closed).toBe(true);
	});

	it("closes the connection when the session is done with it", async () => {
		let closed = false;
		vi.mocked(connectToDevice).mockResolvedValue(connection({ close: async () => void (closed = true) }));

		const session = await transport().open();
		await session.close();

		expect(closed).toBe(true);
	});
});

describe("who may sync straight from the device", () => {
	it("keeps the cloud free and the device Pro", () => {
		expect(allowedTransports(entitlementOf(NO_LICENCE, NOW))).toEqual(["cloud"]);
		expect(allowedTransports(entitlementOf(BOUGHT, NOW))).toContain("ssh");
	});
});

describe("reading what the device's shell wrote", () => {
	it("takes size, time and a path that has spaces in it", () => {
		expect(parseStatLine("225394 1787055950 ./doc-1/my page.rm")).toEqual({
			path: "doc-1/my page.rm",
			size: 225_394,
			mtimeMs: 1_787_055_950_000,
		});
	});

	it("splits a sha256sum line on its two spaces, not on the first one", () => {
		const hash = "a".repeat(64);

		expect(parseHashLine(`${hash}  ./doc-1/my page.rm`)).toEqual({ hash, path: "doc-1/my page.rm" });
	});

	it("ignores a line that is not one of those", () => {
		expect(parseStatLine("")).toBeNull();
		expect(parseHashLine("sha256sum: can't open 'x'")).toBeNull();
	});
});

describe("asking the device to hash files", () => {
	const paths = Array.from({ length: 400 }, (_, index) => `${"a".repeat(36)}/${index}.rm`);

	it("sends the paths on standard input, not on the command line", () => {
		const request = hashRequest("/x", paths);

		// Both obvious alternatives were tried against a real tablet and both failed there: its BusyBox
		// rejects `xargs -0`, and passing the paths as arguments resets the connection at around 19 kB
		// -- which presents as "unable to exec" and says nothing about length.
		expect(request.command.length).toBeLessThan(120);
		expect(request.command).not.toContain(paths[0]);
		expect(request.stdin.split("\n").filter(Boolean)).toHaveLength(400);
	});

	it("keeps the name exactly as it was written", () => {
		// `IFS=` and `-r`: no trimming, no backslash escapes. A page name is a uuid, but a name the
		// shell had quietly edited would hash a file that does not exist and report it as missing.
		expect(hashRequest("/x", []).command).toContain("while IFS= read -r p");
		expect(hashRequest("/x", ["a b.rm"]).command).toContain('sha256sum "$p"');
	});

	it("refuses a name with a newline in it rather than hashing the wrong file", () => {
		// It cannot happen -- every name under xochitl is a uuid -- which is what makes the check cheap.
		// If that ever stops being true this says so instead of silently returning someone else's hash.
		expect(() => hashRequest("/x", ["fine.rm", "two\nlines.rm"])).toThrow("newline");
	});
});

describe("the hash cache", () => {
	it("answers for a file whose size and time both still match", () => {
		const cache = new PersistentHashCache({ "a.rm|10|1000": "hash-a" }, () => 9_000_000);

		expect(cache.get({ path: "a.rm", size: 10, mtimeMs: 1_000 })).toBe("hash-a");
		expect(cache.get({ path: "a.rm", size: 11, mtimeMs: 1_000 })).toBeUndefined();
		expect(cache.get({ path: "a.rm", size: 10, mtimeMs: 2_000 })).toBeUndefined();
	});

	it("does not write down a hash for a file the device only just touched", () => {
		// This userland reports whole seconds, so a file rewritten twice inside one second keeps both
		// its size and its timestamp -- and a hash stored for it would be served forever for bytes that
		// had moved on. That is a page that never updates again, which is the failure this refuses.
		const cache = new PersistentHashCache({}, () => 10_000);
		cache.set({ path: "a.rm", size: 10, mtimeMs: 9_500 }, "too-fresh");

		expect(cache.pruned()).toEqual({});
	});

	it("keeps only what this run actually saw, so deleted pages do not pile up forever", () => {
		const cache = new PersistentHashCache({ "gone.rm|1|1000": "old", "here.rm|2|1000": "kept" }, () => 9_000_000);
		cache.get({ path: "here.rm", size: 2, mtimeMs: 1_000 });

		expect(cache.pruned()).toEqual({ "here.rm|2|1000": "kept" });
	});
});
