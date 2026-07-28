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
});
