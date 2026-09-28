import { describe, expect, it, vi } from "vitest";
import { OcrTimeoutError } from "../llm-transcript";
import { calendarDay } from "./dates";
import { type Complete, oneCallBackend, openAiCompatComplete } from "./extraction-backend";
import { defaultSlots, genericProfile } from "./settings";

const viaObsidian = vi.hoisted(() => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 })));
vi.mock("../obsidian-fetch", () => ({ obsidianFetch: viaObsidian }));

const [TASKS, , SUMMARY] = defaultSlots();
const INPUT = { profile: genericProfile(false), slots: [TASKS, SUMMARY], transcript: "call Bob", referenceDate: calendarDay(2026, 8, 28), known: {} };
const ANSWER = JSON.stringify({ page_date_text: null, tasks: [{ source: "call Bob", reason: "", id: "new", text: "Call Bob", due: null, done: false }], summary: "A call." });

function fakeFetch(respond: (body: Record<string, unknown>) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
	const fn = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		calls.push({ url, init, body });
		return respond(body);
	}) as unknown as typeof fetch;
	return { fn, calls };
}
const chat = (content: string | null, finish = "stop") => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });

describe("oneCallBackend", () => {
	it("sends one call under the strict schema and reads the answer", async () => {
		let seen: Parameters<Complete>[0] | null = null;
		const backend = oneCallBackend("openrouter", true, async (request) => {
			seen = request;
			return { kind: "ok", text: "```json\n" + ANSWER + "\n```" };
		});
		const outcome = await backend.extract(INPUT);
		expect(outcome).toMatchObject({ kind: "ok", result: { slots: { tasks: { items: [{ text: "Call Bob" }] }, summary: { text: "A call." } } } });
		expect(seen!.schema).toMatchObject({ required: ["page_date_text", "tasks", "summary"] });
		expect(seen!.maxTokens).toBe(4000);
	});

	it("fails a truncated, refused or unreadable answer, so the page is retried", async () => {
		expect(await oneCallBackend("x", true, async () => ({ kind: "truncated" })).extract(INPUT)).toEqual({ kind: "failed", reason: "The answer was cut off at the token limit." });
		expect(await oneCallBackend("x", true, async () => ({ kind: "failed", reason: "no" })).extract(INPUT)).toEqual({ kind: "failed", reason: "no" });
		expect(await oneCallBackend("x", true, async () => ({ kind: "ok", text: "Sure! Here are the tasks" })).extract(INPUT)).toMatchObject({ kind: "failed" });
	});
});

describe("openAiCompatComplete", () => {
	const request = { system: "sys", user: "page", schema: { type: "object" }, maxTokens: 4000 };

	it("posts system and user messages with the schema, the key, the cap and OpenRouter's routing guard", async () => {
		const { fn, calls } = fakeFetch(() => chat("{}"));
		const complete = openAiCompatComplete({ baseURL: "https://openrouter.ai/api/v1/", model: "m", apiKey: "k", extraHeaders: { "X-Title": "Tagged Sync" }, requireParameters: true, fetchFn: fn });
		expect(await complete(request)).toEqual({ kind: "ok", text: "{}" });
		expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(calls[0].init.headers).toEqual({ "content-type": "application/json", "X-Title": "Tagged Sync", authorization: "Bearer k" });
		expect(calls[0].body).toEqual({
			model: "m",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "page" },
			],
			max_tokens: 4000,
			response_format: { type: "json_schema", json_schema: { name: "extraction", strict: true, schema: { type: "object" } } },
			provider: { require_parameters: true },
		});
	});

	it("sends temperature 0 and no auth or schema to the user's own server when asked for free text", async () => {
		const { fn, calls } = fakeFetch(() => chat("free text"));
		await openAiCompatComplete({ baseURL: "http://localhost:8080/v1", model: "m", deterministic: true, fetchFn: fn })({ ...request, schema: null });
		expect(calls[0].body).toEqual({ model: "m", messages: expect.any(Array), max_tokens: 4000, temperature: 0 });
		expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
	});

	it("goes through Obsidian's requestUrl wrapper when no fetch is injected, never the global fetch", async () => {
		expect(await openAiCompatComplete({ baseURL: "https://x", model: "m" })(request)).toEqual({ kind: "ok", text: "{}" });
		expect(viaObsidian).toHaveBeenCalledWith("https://x/chat/completions", expect.objectContaining({ method: "POST" }));
	});

	it("names a missing model instead of sending a request", async () => {
		const { fn, calls } = fakeFetch(() => chat("{}"));
		expect(await openAiCompatComplete({ baseURL: "u", model: " ", fetchFn: fn })(request)).toMatchObject({ kind: "failed", reason: expect.stringMatching(/No extraction model/) });
		expect(calls).toHaveLength(0);
	});

	it("reports a cut-off answer as truncated and an empty one as failed", async () => {
		expect(await openAiCompatComplete({ baseURL: "u", model: "m", fetchFn: fakeFetch(() => chat("{", "length")).fn })(request)).toEqual({ kind: "truncated" });
		expect(await openAiCompatComplete({ baseURL: "u", model: "m", fetchFn: fakeFetch(() => chat(null)).fn })(request)).toEqual({ kind: "failed", reason: "The server sent an empty answer." });
		expect(await openAiCompatComplete({ baseURL: "u", model: "m", fetchFn: fakeFetch(() => new Response("{}", { status: 200 })).fn })(request)).toMatchObject({ kind: "failed" });
	});

	it("explains a refusal with the server's own message", async () => {
		const refuse = () => new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 });
		expect(await openAiCompatComplete({ baseURL: "https://x", model: "m", fetchFn: fakeFetch(refuse).fn })(request)).toEqual({ kind: "failed", reason: "The server at https://x answered 402: insufficient credits." });
	});

	it("turns a timeout, an unreachable server and any other throw into a reason", async () => {
		const throwing = (error: unknown) => (async () => Promise.reject(error)) as unknown as typeof fetch;
		expect(await openAiCompatComplete({ baseURL: "http://h", model: "m", fetchFn: throwing(new OcrTimeoutError()) })(request)).toEqual({ kind: "failed", reason: "The server at http://h did not answer in time." });
		expect(await openAiCompatComplete({ baseURL: "http://h", model: "m", fetchFn: throwing(new Error("connect ECONNREFUSED")) })(request)).toEqual({ kind: "failed", reason: "Could not reach the server at http://h. Is it running?" });
		expect(await openAiCompatComplete({ baseURL: "http://h", model: "m", fetchFn: throwing(new Error("boom")) })(request)).toEqual({ kind: "failed", reason: "boom" });
		expect(await openAiCompatComplete({ baseURL: "http://h", model: "m", fetchFn: throwing("odd") })(request)).toEqual({ kind: "failed", reason: "odd" });
	});
});
