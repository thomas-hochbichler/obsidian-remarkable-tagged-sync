import { describe, expect, it } from "vitest";
import { explainError } from "./explain-error";

const OFFLINE = "No connection to the reMarkable cloud. Check your internet connection.";
const BAD_CODE = "That code was not accepted. Codes expire after a few minutes — get a fresh one from my.remarkable.com and try again.";
const BAD_TOKEN = "Your reMarkable connection is no longer valid. Open Settings → Connect and enter a new code.";

describe("explainError", () => {
	it("names a network failure first, in either context", () => {
		expect(explainError(new TypeError("Failed to fetch"), "sync")).toBe(OFFLINE);
		expect(explainError(new Error("getaddrinfo ENOTFOUND api.remarkable.com"), "connect")).toBe(OFFLINE);
		expect(explainError(new Error("connect ECONNREFUSED 1.2.3.4:443"), "sync")).toBe(OFFLINE);
	});

	it("blames the one-time code when connecting, whatever the cloud said", () => {
		expect(explainError(new Error("Request failed with status 400"), "connect")).toBe(BAD_CODE);
		expect(explainError(new Error("401 Unauthorized"), "connect")).toBe(BAD_CODE);
	});

	it("points a rejected token at reconnecting", () => {
		expect(explainError(new Error("HTTP 401 Unauthorized"), "sync")).toBe(BAD_TOKEN);
		expect(explainError(new Error("request failed: 403"), "sync")).toBe(BAD_TOKEN);
		expect(explainError(new Error("invalid_token"), "sync")).toBe(BAD_TOKEN);
	});

	// The reverse-engineered API is unversioned, so this is the plugin's whole answer to a firmware
	// break -- it must never fall through to raw rmapi-js text.
	it("explains an unexpected answer as a possible service change", () => {
		const message = explainError(new Error("Unexpected token < in JSON at position 0"), "sync");
		expect(message).toContain("reMarkable changes their service");
		expect(message).not.toContain("Unexpected token");
	});

	it("never leaks the raw error, including from a non-Error throw", () => {
		expect(explainError("kaboom", "sync")).not.toContain("kaboom");
		expect(explainError({ status: 500 }, "sync")).toContain("did not expect");
		expect(explainError(undefined, "connect")).toBe(BAD_CODE);
	});
});
