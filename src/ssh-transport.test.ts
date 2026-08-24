import { describe, expect, it } from "vitest";
import { entitlementOf, NO_LICENCE, type LicenceState } from "./licence-state";
import { parseHashLine, parseStatLine, DeviceUnreachableError, HostKeyMismatchError } from "./ssh-connection";
import { PersistentHashCache } from "./ssh-hash-cache";
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

	it("explains a changed host key as a reset rather than as a failure to connect", () => {
		const sentence = transport().explainError(new HostKeyMismatchError("SHA256:zzz"), "sync") ?? "";

		expect(sentence).toContain("factory reset");
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
