import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemarkableAuth, type AuthStore } from "./remarkable-auth";

vi.mock("rmapi-js", () => ({
	register: vi.fn(),
	auth: vi.fn(),
}));

import { auth, register } from "rmapi-js";

beforeEach(() => {
	vi.clearAllMocks();
});

function createStore(initial: string | null = null): AuthStore & { token: string | null } {
	return {
		token: initial,
		getDeviceToken() {
			return this.token;
		},
		async setDeviceToken(token: string | null) {
			this.token = token;
		},
	};
}

describe("RemarkableAuth", () => {
	it("is not connected without a device token", () => {
		const remarkableAuth = new RemarkableAuth(createStore());

		expect(remarkableAuth.isConnected()).toBe(false);
	});

	it("is connected once a device token is stored", () => {
		const remarkableAuth = new RemarkableAuth(createStore("device-token"));

		expect(remarkableAuth.isConnected()).toBe(true);
	});

	it("connects by registering the code and persisting the device token", async () => {
		vi.mocked(register).mockResolvedValue("device-token");
		const store = createStore();
		const remarkableAuth = new RemarkableAuth(store);

		await remarkableAuth.connect("abcdefgh");

		expect(register).toHaveBeenCalledWith("abcdefgh");
		expect(store.token).toBe("device-token");
		expect(remarkableAuth.isConnected()).toBe(true);
	});

	it("disconnects by clearing the stored device token", async () => {
		const store = createStore("device-token");
		const remarkableAuth = new RemarkableAuth(store);

		await remarkableAuth.disconnect();

		expect(store.token).toBeNull();
		expect(remarkableAuth.isConnected()).toBe(false);
	});

	it("obtains a fresh session token from the persisted device token", async () => {
		vi.mocked(auth).mockResolvedValue("session-jwt");
		const store = createStore("device-token");
		const remarkableAuth = new RemarkableAuth(store);

		const sessionToken = await remarkableAuth.session();

		expect(auth).toHaveBeenCalledWith("device-token");
		expect(sessionToken).toBe("session-jwt");
	});

	it("re-calls auth on every session request instead of caching", async () => {
		vi.mocked(auth).mockResolvedValueOnce("first-jwt").mockResolvedValueOnce("second-jwt");
		const remarkableAuth = new RemarkableAuth(createStore("device-token"));

		const first = await remarkableAuth.session();
		const second = await remarkableAuth.session();

		expect(first).toBe("first-jwt");
		expect(second).toBe("second-jwt");
		expect(auth).toHaveBeenCalledTimes(2);
	});


	it("throws when requesting a session without connecting first", async () => {
		const remarkableAuth = new RemarkableAuth(createStore());

		await expect(remarkableAuth.session()).rejects.toThrow();
	});

	// Gap G31. Nothing in the suite ever made these mocks *reject* -- so every failure path of the one
	// module that talks to the reMarkable account ran nowhere, and the three assumptions this file's
	// `vi.mock` encodes were unverified in the direction that matters.
	describe("when the cloud says no", () => {
		it("does not store a device token when the one-time code is refused", async () => {
			// An expired or mistyped code. Storing anything here would leave the plugin believing it is
			// connected, and every later sync would fail somewhere further away from the cause.
			vi.mocked(register).mockRejectedValue(new Error("Request failed, status 401"));
			const store = createStore();
			const remarkableAuth = new RemarkableAuth(store);

			await expect(remarkableAuth.connect("expired1")).rejects.toThrow("401");
			expect(store.token).toBeNull();
			expect(remarkableAuth.isConnected()).toBe(false);
		});

		it("keeps an existing connection when a re-connect is refused", async () => {
			// Somebody re-pairs a vault that is already paired and mistypes the code. The old token has
			// to survive, or one typo disconnects a working vault.
			vi.mocked(register).mockRejectedValue(new Error("Request failed, status 401"));
			const store = createStore("old-device-token");
			const remarkableAuth = new RemarkableAuth(store);

			await expect(remarkableAuth.connect("wrongone")).rejects.toThrow();
			expect(store.token).toBe("old-device-token");
		});

		it("passes a revoked device token up rather than answering with a session it does not have", async () => {
			// What a user who removed the device in their reMarkable account meets. It has to reach
			// `explainError`, which turns it into "enter a new code" -- silently returning nothing would
			// make the next call fail on an undefined token instead.
			vi.mocked(auth).mockRejectedValue(new Error("Request failed, status 401"));
			const remarkableAuth = new RemarkableAuth(createStore("revoked-token"));

			await expect(remarkableAuth.session()).rejects.toThrow("401");
		});

		it("still reports connected after a failed session, because the token is what connection means", async () => {
			// A network blip is not a disconnection. Clearing the token here would make an offline
			// morning look like an unpaired vault, and the user would go hunting for a one-time code.
			vi.mocked(auth).mockRejectedValue(new Error("network error"));
			const store = createStore("device-token");
			const remarkableAuth = new RemarkableAuth(store);

			await expect(remarkableAuth.session()).rejects.toThrow();
			expect(store.token).toBe("device-token");
			expect(remarkableAuth.isConnected()).toBe(true);
		});

		it("passes a failed write up rather than reporting a connection that was never saved", async () => {
			// `setDeviceToken` writes `data.json`. If that write fails and the failure is swallowed, the
			// plugin reports connected for this session and forgets everything on restart.
			vi.mocked(register).mockResolvedValue("device-token");
			const store: AuthStore = {
				getDeviceToken: () => null,
				setDeviceToken: () => Promise.reject(new Error("ENOSPC: no space left on device")),
			};

			await expect(new RemarkableAuth(store).connect("abcdefgh")).rejects.toThrow("ENOSPC");
		});

		it("disconnects even when the write fails, or fails loudly -- never silently stays connected", async () => {
			// The one asymmetry worth stating: a user who asked to disconnect must not be left connected
			// without being told. Passing it up is what makes the settings tab say so.
			const store: AuthStore = {
				getDeviceToken: () => "device-token",
				setDeviceToken: () => Promise.reject(new Error("EACCES: permission denied")),
			};

			await expect(new RemarkableAuth(store).disconnect()).rejects.toThrow("EACCES");
		});
	});
});
