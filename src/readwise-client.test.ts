import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReadwiseClient, MAX_PUSH_BATCH, ReadwiseError, type ReadwiseItem } from "./readwise-client";

// The timeout reaches for `window.setTimeout`, which is Obsidian's rule for popout-window
// compatibility and does not exist under vitest.
vi.stubGlobal("window", {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const TOKEN = "rw-test-token-0123456789";
const API = "https://readwise.io/api/v2";

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

/** Answers each request in turn, and records what was asked. */
function stubFetch(...responses: (Response | Error)[]) {
	const calls: Call[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
		const next = responses.shift();
		if (next === undefined) throw new Error(`unexpected extra request to ${String(input)}`);
		if (next instanceof Error) throw next;
		return next;
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: 200, ...init });
const status = (code: number, headers?: Record<string, string>) => new Response(code === 204 ? null : "{}", { status: code, headers });
const page = (results: unknown[], next: string | null = null) => json({ count: results.length, next, previous: null, results });

let slept: number[] = [];
const sleep = async (ms: number) => {
	slept.push(ms);
};

beforeEach(() => {
	slept = [];
});

const client = (impl: typeof fetch, timeoutMs?: number) => createReadwiseClient(TOKEN, impl, sleep, timeoutMs);

const item = (overrides: Partial<ReadwiseItem> = {}): ReadwiseItem => ({
	title: "Thinking in Systems",
	author: "Donella Meadows",
	text: "A system is **more than the sum** of its parts.",
	location: 4,
	url: "obsidian://tagged-sync?highlight=doc-1/page-1:1a2b",
	...overrides,
});

describe("asking readwise.io about the token", () => {
	it("sends the token and says connected on 204", async () => {
		const { impl, calls } = stubFetch(status(204));
		expect(await client(impl).check()).toBe("ok");
		expect(calls[0].url).toBe(`${API}/auth/`);
		expect(calls[0].headers.authorization).toBe(`Token ${TOKEN}`);
	});

	it.each([
		["401", status(401), "rejected"],
		["403", status(403), "no-api"],
		["500", status(500), "unreachable"],
		["a network failure", new TypeError("net::ERR_INTERNET_DISCONNECTED"), "unreachable"],
	] as const)("tells the Connection line what %s means", async (_case, answer, expected) => {
		const { impl } = stubFetch(answer);
		expect(await client(impl).check()).toBe(expected);
	});

	it("stops waiting for a server that never answers", async () => {
		const impl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		expect(await client(impl, 5).check()).toBe("unreachable");
	});
});

describe("listing our books", () => {
	it("asks only for books made with our source, and follows every page", async () => {
		const { impl, calls } = stubFetch(
			page([{ id: 1, title: "A", author: "Ann" }], `${API}/books/?page=2&page_size=1000&source=tagged_sync`),
			page([{ id: 2, title: "B", author: null }]),
		);
		expect(await client(impl).ourBooks()).toEqual([
			{ id: 1, title: "A", author: "Ann" },
			{ id: 2, title: "B", author: null },
		]);
		expect(calls.map((call) => call.url)).toEqual([`${API}/books/?source=tagged_sync&page_size=1000`, `${API}/books/?page=2&page_size=1000&source=tagged_sync`]);
	});

	// A shorter list would mark the missing books deleted in Readwise (spec §11 P24).
	it("fails the whole listing when a later page fails, never answering a shorter list", async () => {
		const { impl } = stubFetch(page([{ id: 1, title: "A", author: null }], `${API}/books/?page=2`), status(500));
		await expect(client(impl).ourBooks()).rejects.toMatchObject({ kind: "unreachable" });
	});

	it("does not follow a next page that leads away from readwise.io, so the token stays there", async () => {
		const { impl, calls } = stubFetch(page([], "https://example.com/books/?page=2"));
		await expect(client(impl).ourBooks()).rejects.toMatchObject({ kind: "unreachable" });
		expect(calls).toHaveLength(1);
	});

	it.each([
		["an answer that is not a listing", json({ detail: "maintenance" })],
		["a book without an id", page([{ title: "A", author: null }])],
	])("fails on %s", async (_case, answer) => {
		const { impl } = stubFetch(answer);
		await expect(client(impl).ourBooks()).rejects.toMatchObject({ kind: "unreachable" });
	});

	it("gives up on a server that never stops paging", async () => {
		const { impl, calls } = stubFetch(...Array.from({ length: 100 }, () => page([], `${API}/books/?page=2`)));
		await expect(client(impl).ourBooks()).rejects.toMatchObject({ kind: "unreachable" });
		expect(calls).toHaveLength(100);
	});
});

describe("pushing highlights", () => {
	it("sends each item as a page-located highlight of a book from our source, leaving out what is absent", async () => {
		const { impl, calls } = stubFetch(json([]));
		await client(impl).push([item({ note: "Compare ch. 2" }), item({ author: undefined, url: "obsidian://tagged-sync?highlight=doc-1/page-2:page" })]);
		expect(calls[0]).toMatchObject({ url: `${API}/highlights/`, method: "POST" });
		expect(calls[0].headers["content-type"]).toBe("application/json");
		expect(calls[0].body).toEqual({
			highlights: [
				{
					text: "A system is **more than the sum** of its parts.",
					title: "Thinking in Systems",
					author: "Donella Meadows",
					note: "Compare ch. 2",
					category: "books",
					source_type: "tagged_sync",
					location: 4,
					location_type: "page",
					highlight_url: "obsidian://tagged-sync?highlight=doc-1/page-1:1a2b",
				},
				{
					text: "A system is **more than the sum** of its parts.",
					title: "Thinking in Systems",
					category: "books",
					source_type: "tagged_sync",
					location: 4,
					location_type: "page",
					highlight_url: "obsidian://tagged-sync?highlight=doc-1/page-2:page",
				},
			],
		});
	});

	it("maps the ids of a book back to the items in send order when the counts match", async () => {
		const first = item({ url: "u1" });
		const second = item({ url: "u2" });
		const other = item({ title: "Other", author: undefined, url: "u3" });
		const { impl } = stubFetch(
			json([
				{ id: 10, title: "Thinking in Systems", author: "Donella Meadows", modified_highlights: [101, 102] },
				{ id: 11, title: "Other", author: null, modified_highlights: [103] },
			]),
		);
		const result = await client(impl).push([first, other, second]);
		expect(result).toEqual({
			kind: "pushed",
			books: [
				{ id: 10, title: "Thinking in Systems", author: "Donella Meadows", highlightIds: [101, 102] },
				{ id: 11, title: "Other", author: null, highlightIds: [103] },
			],
			ids: new Map([
				["u1", 101],
				["u2", 102],
				["u3", 103],
			]),
		});
	});

	// An identical re-push is left out of `modified_highlights` (ticket 10), so order says nothing then.
	it("maps no ids for a book whose modified highlights are fewer than the items sent", async () => {
		const { impl } = stubFetch(json([{ id: 10, title: "Thinking in Systems", author: "Donella Meadows", modified_highlights: [102] }]));
		const result = await client(impl).push([item({ url: "u1" }), item({ url: "u2" })]);
		expect(result).toMatchObject({ kind: "pushed", books: [{ id: 10, highlightIds: [102] }] });
		expect(result.kind === "pushed" && result.ids.size).toBe(0);
	});

	it("skips a book entry it cannot read, and takes missing modified highlights as none", async () => {
		const { impl } = stubFetch(json([{ title: "No id" }, { id: 10, title: "Thinking in Systems", author: "Donella Meadows" }]));
		expect(await client(impl).push([item({ url: "u1" })])).toEqual({
			kind: "pushed",
			books: [{ id: 10, title: "Thinking in Systems", author: "Donella Meadows", highlightIds: [] }],
			ids: new Map(),
		});
	});

	it("still counts as pushed when the answer cannot be read", async () => {
		const { impl } = stubFetch(new Response("<html>", { status: 200 }));
		expect(await client(impl).push([item()])).toEqual({ kind: "pushed", books: [], ids: new Map() });
	});

	it("names the items Readwise refused, so the rest can be sent again", async () => {
		const { impl } = stubFetch(json([{}, { text: ["Ensure this field has no more than 8191 characters."] }, {}], { status: 400 }));
		const result = await client(impl).push([item({ url: "u1" }), item({ url: "u2" }), item({ url: "u3" })]);
		expect(result).toEqual({ kind: "refused", urls: ["u2"] });
	});

	// Readwise answers a call of one item with that item's errors alone, not a list of one (ticket 15).
	it("names the one item of a single-item call that Readwise refused", async () => {
		const { impl } = stubFetch(json({ note: ["This field may not be blank."] }, { status: 400 }));
		expect(await client(impl).push([item({ url: "u1" })])).toEqual({ kind: "refused", urls: ["u1"] });
	});

	it.each([
		["names no field", { detail: "Bad request" }],
		["is not an object", "Bad request"],
	])("reports a 400 on a single-item call that %s as its own failure", async (_case, body) => {
		const { impl } = stubFetch(json(body, { status: 400 }));
		await expect(client(impl).push([item()])).rejects.toMatchObject({ kind: "bad-request" });
	});

	it.each([
		["no list at all", { detail: "Bad request" }],
		["a list of another length", [{}, { text: ["bad"] }]],
		["a list that refuses nothing", [{}, {}, {}]],
	])("reports a 400 with %s as its own failure", async (_case, body) => {
		const { impl } = stubFetch(json(body, { status: 400 }));
		await expect(client(impl).push([item({ url: "u1" }), item({ url: "u2" }), item({ url: "u3" })])).rejects.toMatchObject({ kind: "bad-request" });
	});

	it.each([
		[401, "rejected"],
		[403, "no-api"],
		[502, "unreachable"],
	])("stops on %i as %s", async (code, kind) => {
		const { impl } = stubFetch(status(code));
		await expect(client(impl).push([item()])).rejects.toMatchObject({ kind });
	});

	it("refuses a batch over the limit before sending anything", async () => {
		const { impl, calls } = stubFetch();
		const items = Array.from({ length: MAX_PUSH_BATCH + 1 }, (_value, index) => item({ url: `u${index}` }));
		await expect(client(impl).push(items)).rejects.toThrow(RangeError);
		expect(calls).toHaveLength(0);
	});
});

describe("finding a book's highlights", () => {
	it("lists one book's highlights over every page as id and url", async () => {
		const { impl, calls } = stubFetch(
			page([{ id: 101, url: "u1", text: "…" }], `${API}/highlights/?book_id=10&page=2&page_size=1000`),
			page([{ id: 102, url: null, text: "…" }]),
		);
		expect(await client(impl).bookHighlights(10)).toEqual([
			{ id: 101, url: "u1" },
			{ id: 102, url: null },
		]);
		expect(calls[0].url).toBe(`${API}/highlights/?book_id=10&page_size=1000`);
	});

	it("fails on a highlight without an id", async () => {
		const { impl } = stubFetch(page([{ url: "u1" }]));
		await expect(client(impl).bookHighlights(10)).rejects.toBeInstanceOf(ReadwiseError);
	});
});

describe("deleting a highlight", () => {
	it.each([204, 404])("counts %i as gone", async (code) => {
		const { impl, calls } = stubFetch(status(code));
		await expect(client(impl).remove(101)).resolves.toBeUndefined();
		expect(calls[0]).toMatchObject({ url: `${API}/highlights/101/`, method: "DELETE" });
	});

	it("reports any other answer", async () => {
		const { impl } = stubFetch(status(500));
		await expect(client(impl).remove(101)).rejects.toMatchObject({ kind: "unreachable" });
	});
});

describe("putting back a book's names", () => {
	it("sets the title and author the user gave the book, as overrides", async () => {
		const { impl, calls } = stubFetch(json({ id: 10 }));
		await client(impl).rename(10, { title: "Smith 2019", author: "Jane Smith" });
		expect(calls[0]).toMatchObject({ url: `${API}/books/10/`, method: "PATCH", body: { title_override: "Smith 2019", author_override: "Jane Smith" } });
	});

	it("leaves out a name that is not to change", async () => {
		const { impl, calls } = stubFetch(json({ id: 10 }));
		await client(impl).rename(10, { author: "Jane Smith" });
		expect(calls[0].body).toEqual({ author_override: "Jane Smith" });
	});

	it("reports a rename Readwise did not take", async () => {
		const { impl } = stubFetch(status(404));
		await expect(client(impl).rename(10, { title: "Smith 2019" })).rejects.toMatchObject({ kind: "unreachable" });
	});
});

describe("being asked to slow down", () => {
	it.each([429, 503])("waits out a short Retry-After on %i once and asks again", async (code) => {
		const { impl, calls } = stubFetch(status(code, { "Retry-After": "12" }), status(204));
		expect(await client(impl).check()).toBe("ok");
		expect(slept).toEqual([12_000]);
		expect(calls).toHaveLength(2);
	});

	it.each([
		["without Retry-After", {}],
		["with a Retry-After over half a minute", { "Retry-After": "60" }],
	])("reports a 429 %s at once", async (_case, headers) => {
		const { impl, calls } = stubFetch(status(429, headers));
		await expect(client(impl).push([item()])).rejects.toMatchObject({ kind: "unreachable" });
		expect(slept).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("reports a second 429 instead of waiting again", async () => {
		const { impl, calls } = stubFetch(status(429, { "Retry-After": "1" }), status(429, { "Retry-After": "1" }));
		await expect(client(impl).remove(101)).rejects.toMatchObject({ kind: "unreachable" });
		expect(calls).toHaveLength(2);
	});
});
