import { beforeEach, describe, expect, it, vi } from "vitest";
import { createZoteroWebConnection } from "./zotero-web";

// `zotero-web.ts` reaches for `window.setTimeout`, which is Obsidian's rule for popout-window
// compatibility and does not exist under vitest.
vi.stubGlobal("window", {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const KEY = "P9c46b0lkV2XzAoUTqPmPuGZ";

interface Call {
	url: string;
	headers: Record<string, string>;
	method: string;
}

/** Answers each request in turn, and records what was asked. */
function stubFetch(...responses: Response[]) {
	const calls: Call[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		calls.push({ url: String(input), headers, method: init?.method ?? "GET" });
		const next = responses.shift();
		if (next === undefined) throw new Error(`unexpected extra request to ${String(input)}`);
		return next;
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: 200, ...init });
const whoami = () => json({ userID: 1597773, username: "someone" });
const attachments = () => json([{ data: { key: "ATT1", contentType: "application/pdf", filename: "paper.pdf", md5: "abc" } }]);

let slept: number[] = [];
const sleep = async (ms: number) => {
	slept.push(ms);
};

beforeEach(() => {
	slept = [];
});

describe("talking to zotero.org", () => {
	it("asks whose key this is once, and scopes every later path to that user", async () => {
		const { impl, calls } = stubFetch(whoami(), attachments(), attachments());
		const api = createZoteroWebConnection(KEY, impl, sleep);
		await api.attachments("user");
		await api.attachments("user");
		expect(calls[0].url).toBe("https://api.zotero.org/keys/current");
		expect(calls[1].url).toBe("https://api.zotero.org/users/1597773/items?itemType=attachment&limit=100&start=0");
		expect(calls.filter((call) => call.url.endsWith("/keys/current"))).toHaveLength(1);
	});

	it("sends the key and pins the API version on every request", async () => {
		const { impl, calls } = stubFetch(whoami(), attachments());
		await createZoteroWebConnection(KEY, impl, sleep).attachments("user");
		expect(calls.every((call) => call.headers["zotero-api-key"] === KEY)).toBe(true);
		expect(calls.every((call) => call.headers["zotero-api-version"] === "3")).toBe(true);
	});

	it("says the key was rejected rather than that Zotero is down", async () => {
		const { impl } = stubFetch(new Response("Invalid key", { status: 403 }));
		await expect(createZoteroWebConnection(KEY, impl, sleep).attachments("user")).rejects.toMatchObject({ reason: "unauthorized" });
	});

	// A key pasted into the settings while Obsidian is running has to work without a restart, so a
	// failed lookup is not what gets cached.
	it("asks again after a rejected key, so a corrected one works at once", async () => {
		const { impl, calls } = stubFetch(new Response("Invalid key", { status: 403 }), whoami(), attachments());
		const api = createZoteroWebConnection(KEY, impl, sleep);
		await api.attachments("user").catch(() => undefined);
		await api.attachments("user");
		expect(calls.filter((call) => call.url.endsWith("/keys/current"))).toHaveLength(2);
	});

	it("reports a network failure as the one thing the other connection may be tried for", async () => {
		const impl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		await expect(createZoteroWebConnection(KEY, impl, sleep).attachments("user")).rejects.toMatchObject({ reason: "unreachable" });
	});
});

describe("when zotero.org asks us to slow down", () => {
	it("waits as long as it was told, once, and then asks again", async () => {
		const { impl, calls } = stubFetch(whoami(), new Response(null, { status: 429, headers: { "Retry-After": "2" } }), attachments());
		await createZoteroWebConnection(KEY, impl, sleep).attachments("user");
		expect(slept).toEqual([2000]);
		expect(calls).toHaveLength(3);
	});

	// Once, not in a loop: write-back is add-and-refresh, so reporting and picking it up next sync
	// costs nothing, while a retry loop against a rate limit costs the user their API access.
	it("reports rather than retrying a second time", async () => {
		const busy = () => new Response(null, { status: 429, headers: { "Retry-After": "1" } });
		const { impl } = stubFetch(whoami(), busy(), busy());
		await expect(createZoteroWebConnection(KEY, impl, sleep).attachments("user")).rejects.toMatchObject({ reason: "rate-limited" });
	});

	it("does not sit out a wait longer than the sync can afford", async () => {
		const { impl } = stubFetch(whoami(), new Response(null, { status: 503, headers: { "Retry-After": "600" } }));
		await expect(createZoteroWebConnection(KEY, impl, sleep).attachments("user")).rejects.toMatchObject({ reason: "rate-limited" });
		expect(slept).toEqual([]);
	});

	// `Backoff` is Zotero asking for room *before the next* request, not for this one -- so it is paid
	// on the way into the following call, where a wait costs nothing that has already been answered.
	it("keeps a Backoff for the next request instead of the one that carried it", async () => {
		const { impl } = stubFetch(whoami(), json([], { headers: { Backoff: "3" } }), attachments());
		const api = createZoteroWebConnection(KEY, impl, sleep);
		await api.attachments("user");
		expect(slept).toEqual([]);
		await api.attachments("user");
		expect(slept).toHaveLength(1);
		expect(slept[0]).toBeGreaterThan(2000);
	});
});

describe("the PDF itself", () => {
	it("hands back the bytes Zotero has online", async () => {
		const { impl, calls } = stubFetch(whoami(), new Response(new Uint8Array([37, 80, 68, 70])));
		expect(await createZoteroWebConnection(KEY, impl, sleep).fileBytes("ATT1", "user")).toEqual(new Uint8Array([37, 80, 68, 70]));
		expect(calls[1].url).toBe("https://api.zotero.org/users/1597773/items/ATT1/file");
	});

	// A linked file, or one the free tier never synced: 404 is the answer, and it is the one the send
	// command turns into "Zotero has no copy of this PDF online. Pick the file."
	it("answers nothing, not an error, when Zotero has no copy online", async () => {
		const { impl } = stubFetch(whoami(), new Response(null, { status: 404 }));
		expect(await createZoteroWebConnection(KEY, impl, sleep).fileBytes("ATT1", "user")).toBeNull();
	});

	it("knows no path on disk, which is what the desktop connection is for", async () => {
		const { impl } = stubFetch();
		expect(await createZoteroWebConnection(KEY, impl, sleep).filePath("ATT1", "user")).toBeNull();
	});
});

describe("group libraries (ticket 26)", () => {
	it("asks a group under its own prefix, which needs no account lookup at all", async () => {
		const { impl, calls } = stubFetch(attachments());
		await createZoteroWebConnection(KEY, impl, sleep).attachments({ group: 4711 });
		expect(calls[0].url).toBe("https://api.zotero.org/groups/4711/items?itemType=attachment&limit=100&start=0");
	});

	it("lists the key's groups under the account the key belongs to", async () => {
		const { impl, calls } = stubFetch(whoami(), json([{ id: 4711, version: 3, data: { id: 4711, name: "Lab reading group" } }]));
		expect(await createZoteroWebConnection(KEY, impl, sleep).groups()).toEqual([{ id: 4711, name: "Lab reading group" }]);
		expect(calls[1].url).toBe("https://api.zotero.org/users/1597773/groups?limit=100&start=0");
	});

	it("downloads a group's PDF from the group's own path", async () => {
		const { impl, calls } = stubFetch(new Response(new Uint8Array([1]), { status: 200 }));
		await createZoteroWebConnection(KEY, impl, sleep).fileBytes("ATT1", { group: 4711 });
		expect(calls[0].url).toBe("https://api.zotero.org/groups/4711/items/ATT1/file");
	});
});
