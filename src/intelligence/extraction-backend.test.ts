import { describe, expect, it, vi } from "vitest";
import { OcrTimeoutError } from "../llm-transcript";
import { calendarDay } from "./dates";
import { type Complete, type CompletionRequest, type CompletionOutcome, notesAreEmpty, oneCallBackend, openAiCompatComplete, twoCallBackend } from "./extraction-backend";
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

describe("classify", () => {
	const profiles = [
		{ id: "meeting", description: "Meeting notes" },
		{ id: "journal", description: "Personal journal" },
	];
	it("asks one question under a schema whose only answers are the Profile ids, and reads the pick", async () => {
		let seen: Parameters<Complete>[0] | null = null;
		const backend = oneCallBackend("x", true, async (request) => ((seen = request), { kind: "ok", text: '{"profile":"journal"}' }));
		expect(await backend.classify!({ transcript: "Dear diary", profiles })).toEqual({ kind: "ok", id: "journal" });
		expect(seen!.schema).toEqual({ type: "object", properties: { profile: { type: "string", enum: ["meeting", "journal"] } }, required: ["profile"], additionalProperties: false });
		expect(seen!.user).toContain("- journal: Personal journal");
	});

	it("fails on an unknown pick, a cut-off or failed call, and prose", async () => {
		const answer = (outcome: Awaited<ReturnType<Complete>>) => oneCallBackend("x", true, async () => outcome).classify!({ transcript: "", profiles });
		expect(await answer({ kind: "ok", text: '{"profile":"other"}' })).toEqual({ kind: "failed", reason: "The answer named no known profile." });
		expect(await answer({ kind: "ok", text: "journal" })).toMatchObject({ kind: "failed" });
		expect(await answer({ kind: "truncated" })).toEqual({ kind: "failed", reason: "The answer was cut off." });
		expect(await answer({ kind: "failed", reason: "down" })).toEqual({ kind: "failed", reason: "down" });
		expect(twoCallBackend("l", false, async () => ({ kind: "failed", reason: "" })).classify).toBeUndefined();
	});
});

describe("twoCallBackend", () => {
	function scripted(...answers: CompletionOutcome[]) {
		const requests: CompletionRequest[] = [];
		const complete: Complete = async (request) => {
			requests.push(request);
			return answers.shift()!;
		};
		return { complete, requests };
	}

	it("writes free-text notes first, line by line, then formats them under the schema with the page beside them", async () => {
		const { complete, requests } = scripted({ kind: "ok", text: "call Bob => TASK\n\n## tasks\n- Call Bob | SOURCE: call Bob | due: NONE\n## summary\nA call." }, { kind: "ok", text: ANSWER });
		const outcome = await twoCallBackend("local", false, complete).extract(INPUT);
		expect(outcome).toMatchObject({ kind: "ok", result: { slots: { tasks: { items: [{ text: "Call Bob" }] } } } });
		expect(requests.map((r) => [r.schema === null, r.maxTokens])).toEqual([
			[true, 3000],
			[false, 4000],
		]);
		// Research 22's pass 1: the line pass, started for the model, then one heading per Slot.
		expect(requests[0].prefill).toBe("LINES:\n");
		expect(requests[0].system).toContain("Profile: Generic: Any handwritten page.");
		expect(requests[0].system).toContain("Page date: Monday, 2026-09-28.");
		expect(requests[0].system).toContain('Step 1. Write "LINES:"');
		expect(requests[0].system).toContain('Under "## tasks" write one line per line you marked TASK: "- <text> | SOURCE: <the transcript line, copied exactly> | due: <date words as written, or NONE>".');
		expect(requests[0].system).toContain('Under "## summary" write one or two sentences.');
		expect(requests[0].user).toBe("Transcript:\n<<<\ncall Bob\n>>>");
		// Pass 2 sees the notes from the first heading on, not the line verdicts.
		expect(requests[1].user).toBe("Notes:\n## tasks\n- Call Bob | SOURCE: call Bob | due: NONE\n## summary\nA call.\n\nOriginal transcript (for verbatim source spans):\n<<<\ncall Bob\n>>>");
		expect(requests[1].system).toContain("Slot definitions:\n### tasks (Tasks)");
	});

	it("asks for no line pass without a tasks Slot, and lists items and values per Slot", async () => {
		const [, DECISIONS, , TAGS] = defaultSlots();
		const { complete, requests } = scripted({ kind: "ok", text: "## decisions\nNONE\n## tags\nNONE" });
		const owned = { ...DECISIONS, fields: [{ name: "owner", type: "text" as const }] };
		await twoCallBackend("local", false, complete).extract({ ...INPUT, slots: [owned, { ...TAGS, property: undefined }] });
		expect(requests[0].prefill).toBeUndefined();
		expect(requests[0].system).not.toContain("LINES");
		expect(requests[0].system).toContain('Under "## decisions" write one line per item: "- <text> | SOURCE: <the transcript line, copied exactly> | owner: <value, or NONE>".');
		expect(requests[0].system).toContain('Under "## tags" write the value.');
	});

	it("skips the format pass when the notes found nothing, so a small model cannot invent items there", async () => {
		const { complete, requests } = scripted({ kind: "ok", text: "call Bob => NO\n## tasks\nNONE\n\n## summary\n- none" });
		expect(await twoCallBackend("local", false, complete).extract(INPUT)).toMatchObject({ kind: "ok", result: { slots: { tasks: { items: [] }, summary: { text: "" } } } });
		expect(requests).toHaveLength(1);
	});

	it("fails on a cut-off or failed pass and on an answer that is not JSON", async () => {
		const notes: CompletionOutcome = { kind: "ok", text: "- Call Bob | SOURCE: call Bob" };
		expect(await twoCallBackend("l", false, scripted({ kind: "truncated" }).complete).extract(INPUT)).toEqual({ kind: "failed", reason: "The notes pass was cut off at the token limit." });
		expect(await twoCallBackend("l", false, scripted({ kind: "failed", reason: "down" }).complete).extract(INPUT)).toEqual({ kind: "failed", reason: "down" });
		expect(await twoCallBackend("l", false, scripted(notes, { kind: "truncated" }).complete).extract(INPUT)).toEqual({ kind: "failed", reason: "The answer was cut off at the token limit." });
		expect(await twoCallBackend("l", false, scripted(notes, { kind: "failed", reason: "oom" }).complete).extract(INPUT)).toEqual({ kind: "failed", reason: "oom" });
		expect(await twoCallBackend("l", false, scripted(notes, { kind: "ok", text: "tasks: Call Bob" }).complete).extract(INPUT)).toMatchObject({ kind: "failed" });
	});
});

describe("notesAreEmpty", () => {
	it("treats a one-word item as a find, not as a heading", () => {
		expect(notesAreEmpty("- Milk", ["tasks"])).toBe(false);
		expect(notesAreEmpty("Tasks:\n- NONE.", ["tasks"])).toBe(true);
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

	it("sends temperature 0 and no auth or schema to the user's own server when asked for free text, and a prefill as the assistant's turn", async () => {
		const { fn, calls } = fakeFetch(() => chat("free text"));
		await openAiCompatComplete({ baseURL: "http://localhost:8080/v1", model: "m", deterministic: true, fetchFn: fn })({ ...request, schema: null });
		expect(calls[0].body).toEqual({ model: "m", messages: expect.any(Array), max_tokens: 4000, temperature: 0 });
		expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
		await openAiCompatComplete({ baseURL: "http://localhost:8080/v1", model: "m", fetchFn: fn })({ ...request, prefill: "LINES:\n" });
		expect((calls[1].body as { messages: unknown[] }).messages.at(-1)).toEqual({ role: "assistant", content: "LINES:\n" });
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
