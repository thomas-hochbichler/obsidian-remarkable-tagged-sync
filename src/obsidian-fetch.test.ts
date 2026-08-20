import { beforeEach, describe, expect, it, vi } from "vitest";
import { obsidianFetch } from "./obsidian-fetch";

// Gap G30. This is the single point every cloud request in the plugin passes through -- reMarkable,
// Polar, and every LLM provider -- and it had no test file and 0 % coverage.
//
// It exists because reMarkable's API sends no CORS headers, so the renderer's own `fetch` is blocked
// before the request leaves. esbuild rewrites every free `fetch` in the bundle to this function at
// build time, which means a mistake here is not one broken feature: it is every request the plugin
// makes, in every vault, and it would look like the cloud being down.

const requested = vi.hoisted(() => ({
	calls: [] as { url: string; method: string; headers: Record<string, string>; body: unknown; throw: boolean }[],
	answer: {
		status: 200,
		headers: {} as Record<string, string>,
		arrayBuffer: new TextEncoder().encode("hello").buffer as ArrayBuffer,
	},
}));

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		// The real stub throws on purpose, so a unit test that reached the network would be caught.
		// Replaced here because this file is *about* the call, and every answer is scripted.
		requestUrl: (options: { url: string; method: string; headers: Record<string, string>; body: unknown; throw: boolean }) => {
			requested.calls.push(options);
			return Promise.resolve(requested.answer);
		},
	};
});

beforeEach(() => {
	requested.calls.length = 0;
	requested.answer = { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode("hello").buffer as ArrayBuffer };
});

const lastCall = () => requested.calls.at(-1)!;

describe("what reaches requestUrl", () => {
	it("takes the URL out of a string, a URL, and a Request alike", async () => {
		// `input.toString()` looks right and is wrong for one of the three: a `Request` stringifies to
		// "[object Object]", which would fail as a malformed URL rather than as anything diagnosable.
		await obsidianFetch("https://example.test/a");
		expect(lastCall().url).toBe("https://example.test/a");

		await obsidianFetch(new URL("https://example.test/b?q=1"));
		expect(lastCall().url).toBe("https://example.test/b?q=1");

		await obsidianFetch(new Request("https://example.test/c"));
		expect(lastCall().url).toBe("https://example.test/c");
	});

	it("flattens headers from every shape the caller may hand them in", async () => {
		// rmapi-js passes a plain object today. A `Headers` or an entry array is a caller this shim
		// would silently send *unauthenticated* if it only read own properties -- and an unauthenticated
		// reMarkable request answers 401, which reads to the user as a broken connection.
		await obsidianFetch("https://example.test/", { headers: { Authorization: "Bearer t", "X-One": "1" } });
		expect(lastCall().headers).toEqual({ authorization: "Bearer t", "x-one": "1" });

		await obsidianFetch("https://example.test/", { headers: new Headers({ Authorization: "Bearer h" }) });
		expect(lastCall().headers).toEqual({ authorization: "Bearer h" });

		await obsidianFetch("https://example.test/", { headers: [["authorization", "Bearer a"]] });
		expect(lastCall().headers).toEqual({ authorization: "Bearer a" });
	});

	it("defaults to GET, and never lets requestUrl throw on an HTTP error", async () => {
		// `throw: false` is what makes this a `fetch`: a 404 is a Response with a status, not a
		// rejection. Without it every 404 in the plugin would surface as an exception, and the code
		// reading `response.status` would never run.
		await obsidianFetch("https://example.test/");

		expect(lastCall().method).toBe("GET");
		expect(lastCall().throw).toBe(false);
	});

	it("passes the method through when there is one", async () => {
		await obsidianFetch("https://example.test/", { method: "POST" });

		expect(lastCall().method).toBe("POST");
	});
});

describe("the body it forwards", () => {
	it("sends a string as it is, and nothing at all for no body", async () => {
		await obsidianFetch("https://example.test/", { method: "POST", body: '{"a":1}' });
		expect(lastCall().body).toBe('{"a":1}');

		await obsidianFetch("https://example.test/");
		expect(lastCall().body).toBeUndefined();
	});

	it("slices a Uint8Array to its own window, not to the whole buffer behind it", async () => {
		// The failure this prevents is silent and specific: a view onto a larger buffer -- which is
		// what a chunked read produces -- would otherwise send the *whole* buffer, so an upload would
		// carry bytes from whatever else shared it.
		const backing = new Uint8Array([0, 0, 1, 2, 3, 0, 0]);
		const view = backing.subarray(2, 5);

		await obsidianFetch("https://example.test/", { method: "PUT", body: view });

		expect(lastCall().body).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(lastCall().body as ArrayBuffer)]).toEqual([1, 2, 3]);
	});

	it("forwards an ArrayBuffer untouched", async () => {
		const buffer = new Uint8Array([9, 8, 7]).buffer;

		await obsidianFetch("https://example.test/", { method: "PUT", body: buffer });

		expect(lastCall().body).toBe(buffer);
	});

	it("refuses a body shape it was not written for, rather than sending an empty one", async () => {
		// `requestUrl` takes `string | ArrayBuffer` only. A `FormData` or a `Blob` would arrive as
		// nothing, and the request would go out with an empty body and a success status -- the worst
		// possible outcome for an upload.
		await expect(obsidianFetch("https://example.test/", { method: "POST", body: new URLSearchParams({ a: "1" }) })).rejects.toThrow(
			TypeError,
		);
		await expect(obsidianFetch("https://example.test/", { method: "POST", body: new Blob(["x"]) })).rejects.toThrow(
			/cannot forward a Blob/,
		);
	});
});

describe("the Response it hands back", () => {
	it("carries the status, the headers and the bytes", async () => {
		requested.answer = {
			status: 201,
			headers: { "content-type": "application/json" },
			arrayBuffer: new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer,
		};

		const response = await obsidianFetch("https://example.test/");

		expect(response.status).toBe(201);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(await response.json()).toEqual({ ok: true });
	});

	it("gives an HTTP error back as a Response, because that is what fetch does", async () => {
		requested.answer = { status: 404, headers: {}, arrayBuffer: new TextEncoder().encode("nope").buffer as ArrayBuffer };

		const response = await obsidianFetch("https://example.test/");

		expect(response.ok).toBe(false);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("nope");
	});

	// The `Response` constructor **throws** on a body for these statuses. `requestUrl` hands back an
	// `arrayBuffer` regardless, so without the null-body rule every one of them would surface as a
	// TypeError from inside the shim -- and a 304 is what a conditional request gets on a good day.
	it.each([204, 205, 304])("gives status %i a null body rather than throwing", async (status) => {
		requested.answer = { status, headers: {}, arrayBuffer: new TextEncoder().encode("should not be here").buffer as ArrayBuffer };

		const response = await obsidianFetch("https://example.test/");

		expect(response.status).toBe(status);
		expect(await response.text()).toBe("");
	});

	// Characterisation, and a small correction to the list above it. `Response` refuses **any** status
	// below 200, body or no body -- so for 101 and 103 the null-body rule cannot help and the shim
	// throws a RangeError either way. Neither is reachable through `requestUrl` on an ordinary HTTPS
	// request (a 101 needs an upgrade the shim never asks for, and a 103 is an early hint the transport
	// consumes), so this is written down rather than handled: a guard for an unreachable case that
	// cannot work is worse than no guard, because it reads as one that does.
	it.each([101, 103])("cannot hand back status %i at all, whatever the body says", async (status) => {
		requested.answer = { status, headers: {}, arrayBuffer: new ArrayBuffer(0) };

		await expect(obsidianFetch("https://example.test/")).rejects.toThrow(RangeError);
	});

	it("keeps the body for a status that is allowed one, including a 200 with nothing in it", async () => {
		requested.answer = { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) };

		expect(await (await obsidianFetch("https://example.test/")).text()).toBe("");
	});
});
