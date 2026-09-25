import { describe, expect, it, vi } from "vitest";
import { createZoteroLocalConnection, memoryKeyStore } from "./zotero-local";

// `zotero-local.ts` reaches for `window.setTimeout`, which is Obsidian's rule for popout-window
// compatibility and does not exist under vitest.
vi.stubGlobal("window", {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const SERVER_ID = "1PUT74VpHXuE";
const GRANTED_KEY = "0123456789abcdef0123456789abcdef";

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

/**
 * A stand-in Zotero. `handle` answers everything except the no-op `GET /api/`, which always carries
 * the server id -- a real Zotero puts it on every response, including the 403 it sends when the local
 * API is switched off.
 */
function stubZotero(handle: (call: Call) => Response) {
	const calls: Call[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		const call = { url: String(input), method: init?.method ?? "GET", headers, body: init?.body === undefined ? null : String(init.body) };
		calls.push(call);
		if (call.url === "http://localhost:23119/api/") return new Response(null, { status: 200, headers: { "Zotero-Server-ID": SERVER_ID } });
		return handle(call);
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ANNOTATION = { type: "highlight" as const, parentKey: "ATT1", text: "x", color: "#ffd400", pageLabel: "1", sortIndex: "00000|000000|00080", position: '{"pageIndex":0,"rects":[]}' };

describe("getting in at all", () => {
	// ⚠️ Zotero *cancels* a request that looks like a browser -- no response, no status -- and
	// Electron's user agent starts with `Mozilla/`. Without this header a working Zotero is
	// indistinguishable from a closed one, and every request would fail as a network error.
	it("marks every request as one Zotero is allowed to answer", async () => {
		const { impl, calls } = stubZotero(() => json([]));
		await createZoteroLocalConnection(memoryKeyStore(), impl).attachments("user");
		expect(calls.every((call) => call.headers["zotero-allowed-request"] === "1")).toBe(true);
	});

	it("reads the database id once and sends it back on every request", async () => {
		const { impl, calls } = stubZotero(() => json([]));
		const api = createZoteroLocalConnection(memoryKeyStore(), impl);
		await api.attachments("user");
		await api.attachments("user");
		expect(calls.filter((call) => call.url === "http://localhost:23119/api/")).toHaveLength(1);
		expect(calls.filter((call) => call.url.includes("/users/0/")).every((call) => call.headers["zotero-server-id"] === SERVER_ID)).toBe(true);
	});

	// The two states a user has to tell apart to fix anything: Zotero is closed, or Zotero is open
	// with the setting off. One is not a thing to act on, the other is one checkbox.
	it("tells a closed Zotero apart from one with the setting switched off", async () => {
		const closed = (async () => {
			throw new TypeError("connection refused");
		}) as unknown as typeof fetch;
		const off = vi.fn(async () => new Response("Local API is not enabled", { status: 403, headers: { "Zotero-Server-ID": SERVER_ID } })) as unknown as typeof fetch;
		await expect(createZoteroLocalConnection(memoryKeyStore(), closed).attachments("user")).rejects.toMatchObject({ reason: "unreachable" });
		await expect(createZoteroLocalConnection(memoryKeyStore(), off).attachments("user")).rejects.toMatchObject({ reason: "not-enabled" });
	});

	it("asks the personal library, which is the only one this feature touches", async () => {
		const { impl, calls } = stubZotero(() => json([]));
		await createZoteroLocalConnection(memoryKeyStore(), impl).attachments("user");
		expect(calls[1].url).toBe("http://localhost:23119/api/users/0/items?itemType=attachment&limit=100&start=0");
	});
});

describe("the permission dialog", () => {
	const writing = (handle: (call: Call) => Response) => {
		const store = memoryKeyStore();
		const { impl, calls } = stubZotero(handle);
		return { api: createZoteroLocalConnection(store, impl), calls, store };
	};

	const authorized = (call: Call) => (call.url.endsWith("/local/authorize") ? json({ key: GRANTED_KEY, remember: true }) : json({ success: { "0": "NEW1" } }));

	// Reads need no key, so matching and the send picker work on a Zotero the user has never granted
	// anything to -- the dialog only ever appears for a write the user asked for.
	it("never opens for a read", async () => {
		const { api, calls } = writing(() => json([]));
		await api.attachments("user");
		expect(calls.some((call) => call.url.includes("authorize"))).toBe(false);
	});

	it("opens once for a write, and the granted key is kept for the next one", async () => {
		const { api, calls } = writing(authorized);
		await api.createAnnotations([ANNOTATION], "user");
		await api.createAnnotations([ANNOTATION], "user");
		expect(calls.filter((call) => call.url.endsWith("/local/authorize"))).toHaveLength(1);
		expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/users/0/items")).every((call) => call.headers["zotero-api-key"] === GRANTED_KEY)).toBe(true);
	});

	it("says what it is, so the user reads the plugin's name in Zotero's dialog", async () => {
		const { api, calls } = writing(authorized);
		await api.createAnnotations([ANNOTATION], "user");
		expect(JSON.parse(calls.find((call) => call.url.endsWith("/local/authorize"))?.body ?? "{}")).toEqual({ appName: "Tagged Sync for reMarkable" });
	});

	// ⚠️ "Allow" grants a key that serves exactly one request and then answers 401, and it is the
	// button next to the one we ask for. A 401 is therefore the ordinary outcome of the wrong click,
	// not a broken install -- so it re-asks once and the write still lands.
	it("re-asks after a key that was only good for one request", async () => {
		let granted = 0;
		const { api, calls } = writing((call) => {
			if (call.url.endsWith("/local/authorize")) return json({ key: `key-${++granted}`, remember: false });
			return call.headers["zotero-api-key"] === "key-2" ? json({ success: { "0": "NEW1" } }) : new Response("Invalid or expired API key", { status: 401 });
		});
		expect((await api.createAnnotations([ANNOTATION], "user")).keys).toEqual(["NEW1"]);
		expect(calls.filter((call) => call.url.endsWith("/local/authorize"))).toHaveLength(2);
	});

	it("gives up after the second refusal instead of asking again and again", async () => {
		let granted = 0;
		const { api, calls } = writing((call) => {
			if (call.url.endsWith("/local/authorize")) return json({ key: `key-${++granted}`, remember: false });
			return new Response("Invalid or expired API key", { status: 401 });
		});
		await expect(api.createAnnotations([ANNOTATION], "user")).rejects.toMatchObject({ reason: "unauthorized" });
		expect(calls.filter((call) => call.url.endsWith("/local/authorize"))).toHaveLength(2);
	});

	it("takes Deny for an answer", async () => {
		const { api } = writing((call) => (call.url.endsWith("/local/authorize") ? json({ denied: true }, 403) : json({})));
		await expect(api.createAnnotations([ANNOTATION], "user")).rejects.toMatchObject({ reason: "denied" });
	});
});

describe("the file on disk", () => {
	// The whole reason the desktop connection is worth having for send: no download, and it works for
	// a linked file that was never in Zotero's storage.
	it("hands back the real path, decoded", async () => {
		const { impl } = stubZotero(() => new Response("file:///Users/me/Zotero/storage/ATT1/Ma%C3%9F%20und%20Zahl.pdf"));
		expect(await createZoteroLocalConnection(memoryKeyStore(), impl).filePath("ATT1", "user")).toBe("/Users/me/Zotero/storage/ATT1/Maß und Zahl.pdf");
	});

	// Zotero uses the same URL on Windows, where simply stripping `file://` leaves an unusable `/C:/...` path.
	it("converts a Windows drive file URL to a native path", async () => {
		const { impl } = stubZotero(() => new Response("file:///C:/Users/me/Zotero%20Library/ATT1/paper.pdf"));
		const expected = process.platform === "win32" ? "C:\\Users\\me\\Zotero Library\\ATT1\\paper.pdf" : "/C:/Users/me/Zotero Library/ATT1/paper.pdf";
		expect(await createZoteroLocalConnection(memoryKeyStore(), impl).filePath("ATT1", "user")).toBe(expected);
	});

	it("answers nothing for an item that has no file, rather than failing the send", async () => {
		const { impl } = stubZotero(() => new Response("Not a file attachment", { status: 400 }));
		expect(await createZoteroLocalConnection(memoryKeyStore(), impl).filePath("ITEM1", "user")).toBeNull();
	});

	it("hands out no bytes, because the caller reads the path itself", async () => {
		const { impl } = stubZotero(() => json([]));
		expect(await createZoteroLocalConnection(memoryKeyStore(), impl).fileBytes("ATT1", "user")).toBeNull();
	});
});

describe("which library this is", () => {
	// The local API answers `/users/0/` whoever is signed in, so the numeric id -- which the note's web
	// link needs -- can only come out of an item Zotero returns.
	it("reads the numeric library id off an item, since the path never says it", async () => {
		const { impl } = stubZotero(() => json([{ library: { type: "user", id: 1597773 } }]));
		expect(await createZoteroLocalConnection(memoryKeyStore(), impl).libraryId()).toBe(1597773);
	});

	it("says it does not know, on a library with nothing in it", async () => {
		const { impl } = stubZotero(() => json([]));
		expect(await createZoteroLocalConnection(memoryKeyStore(), impl).libraryId()).toBeNull();
	});
});

describe("group libraries (ticket 26)", () => {
	// The same shape zotero.org uses, so the reads and writes stay written once.
	it("asks a group on its own prefix", async () => {
		const { impl, calls } = stubZotero(() => json([]));
		await createZoteroLocalConnection(memoryKeyStore(), impl).attachments({ group: 4711 });
		expect(calls[1].url).toBe("http://localhost:23119/api/groups/4711/items?itemType=attachment&limit=100&start=0");
	});

	it("lists the groups this database holds under the personal prefix", async () => {
		const { impl, calls } = stubZotero(() => json([{ id: 4711, data: { id: 4711, name: "Lab reading group" } }]));
		expect(await createZoteroLocalConnection(memoryKeyStore(), impl).groups()).toEqual([{ id: 4711, name: "Lab reading group" }]);
		expect(calls[1].url).toBe("http://localhost:23119/api/users/0/groups?limit=100&start=0");
	});

	// `Write access denied` is what the desktop answers for a library that is not editable here.
	it("reports a group it may only read as read-only when written into", async () => {
		const { impl } = stubZotero((call) => (call.url.endsWith("/local/authorize") ? json({ key: GRANTED_KEY, remember: true }) : new Response("Write access denied", { status: 403 })));
		await expect(createZoteroLocalConnection(memoryKeyStore(), impl).createAnnotations([ANNOTATION], { group: 4711 })).rejects.toMatchObject({ reason: "read-only" });
	});
});
