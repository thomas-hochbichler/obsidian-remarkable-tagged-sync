import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatOcrBackend } from "./openai-compat-ocr-backend";
import type { RmPage } from "./rm-parser";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function chatResponse(content: string): Response {
	return jsonResponse(200, { choices: [{ message: { role: "assistant", content } }] });
}

function page(): RmPage {
	return {
		formatVersion: 6,
		layers: [
			{
				id: "layer-1",
				name: null,
				strokes: [
					{
						layerId: "layer-1",
						id: "stroke-1",
						timestamp: "0001",
						penType: 0,
						color: 0,
						brushSize: 2,
						points: [
							{ x: 10, y: 10, speed: 0, width: 0, direction: 0, pressure: 0 },
							{ x: 20, y: 20, speed: 0, width: 0, direction: 0, pressure: 0 },
						],
					},
				],
			},
		],
	};
}

function requestBody(): { model: string; messages: { content: { type: string; image_url?: { url: string } }[] }[] } {
	return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe("OpenAiCompatOcrBackend", () => {
	beforeEach(() => {
		fetchMock.mockReset();
	});

	it("carries the provider id through as its backend id", () => {
		const backend = new OpenAiCompatOcrBackend({ id: "openrouter", baseURL: "http://x/v1", model: "m", fetchFn: fetchMock });
		expect(backend.id).toBe("openrouter");
	});

	it("skips OCR for an empty page list without making a request", async () => {
		const backend = new OpenAiCompatOcrBackend({ id: "openai", baseURL: "http://x/v1", model: "m", fetchFn: fetchMock });

		const result = await backend.recognize([]);

		expect(result).toEqual({ status: "skipped", pages: [], text: "", confidence: null });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts to {baseURL}/chat/completions with a Bearer key and reads choices[0].message.content", async () => {
		fetchMock.mockResolvedValue(chatResponse("Hello world"));
		const backend = new OpenAiCompatOcrBackend({ id: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4o", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result).toEqual({ status: "ok", pages: [{ status: "ok", text: "Hello world" }], text: "Hello world", confidence: null });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.openai.com/v1/chat/completions");
		expect(init.method).toBe("POST");
		expect(init.headers["authorization"]).toBe("Bearer sk-test");

		const body = requestBody();
		expect(body.model).toBe("gpt-4o");
		const content = body.messages[0].content;
		expect(content[0].type).toBe("text");
		expect(content[1].type).toBe("image_url");
		expect(content[1].image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("tolerates a trailing slash on the base URL (Gemini compat endpoint)", async () => {
		fetchMock.mockResolvedValue(chatResponse("x"));
		const backend = new OpenAiCompatOcrBackend({
			id: "gemini",
			baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
			apiKey: "k",
			model: "gemini-2.0-flash",
			fetchFn: fetchMock,
		});

		await backend.recognize([page()]);

		expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
	});

	it("omits the Authorization header when no key is set (local servers)", async () => {
		fetchMock.mockResolvedValue(chatResponse("x"));
		const backend = new OpenAiCompatOcrBackend({ id: "lmstudio", baseURL: "http://localhost:1234/v1", model: "m", fetchFn: fetchMock });

		await backend.recognize([page()]);

		expect(fetchMock.mock.calls[0][1].headers["authorization"]).toBeUndefined();
	});

	it("merges provider extra headers (OpenRouter attribution)", async () => {
		fetchMock.mockResolvedValue(chatResponse("x"));
		const backend = new OpenAiCompatOcrBackend({
			id: "openrouter",
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: "k",
			model: "openai/gpt-4o",
			extraHeaders: { "X-Title": "Obsidian Tagged Sync" },
			fetchFn: fetchMock,
		});

		await backend.recognize([page()]);

		expect(fetchMock.mock.calls[0][1].headers["X-Title"]).toBe("Obsidian Tagged Sync");
	});

	// One image per call is the only shape where the page boundary comes from the request array --
	// something we control -- rather than from the model agreeing to mark it. It also fits the local
	// servers this adapter serves: Ollama's default context cannot hold forty page images at once.
	it("sends one page per call, as a single image_url part", async () => {
		fetchMock.mockResolvedValue(chatResponse("text"));
		const backend = new OpenAiCompatOcrBackend({ id: "openai", baseURL: "http://x/v1", apiKey: "k", model: "m", fetchFn: fetchMock });

		const result = await backend.recognize([page(), page(), page()]);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(result.pages).toHaveLength(3);
		for (const call of fetchMock.mock.calls) {
			const content = JSON.parse(call[1].body).messages[0].content;
			expect(content.length).toBe(2); // 1 prompt + 1 image
			expect(content[1].type).toBe("image_url");
		}
	});

	it("reports failed on a non-ok status", async () => {
		fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
		const backend = new OpenAiCompatOcrBackend({ id: "openai", baseURL: "http://x/v1", apiKey: "bad", model: "m", fetchFn: fetchMock });

		expect(await backend.recognize([page()])).toEqual({ status: "failed", pages: [{ status: "failed", text: "" }], text: "", confidence: null });
	});

	it("reports failed and never throws when the request itself fails", async () => {
		fetchMock.mockRejectedValue(new Error("connection refused"));
		const backend = new OpenAiCompatOcrBackend({ id: "ollama", baseURL: "http://localhost:11434/v1", model: "m", fetchFn: fetchMock });

		expect(await backend.recognize([page()])).toEqual({ status: "failed", pages: [{ status: "failed", text: "" }], text: "", confidence: null });
	});

	// The prompt tells the model to output nothing for a page with no legible text, so an empty
	// response is that page reporting itself blank -- not a failure. It used to be reported as one.
	it("reports a page with no usable text as skipped, not failed", async () => {
		fetchMock.mockResolvedValue(chatResponse("   "));
		const backend = new OpenAiCompatOcrBackend({ id: "openai", baseURL: "http://x/v1", apiKey: "k", model: "m", fetchFn: fetchMock });

		expect(await backend.recognize([page()])).toEqual({ status: "skipped", pages: [{ status: "skipped", text: "" }], text: "", confidence: null });
	});

	// A truncated page used to come back `ok` over a transcript that stopped mid-sentence, and the
	// sync would never revisit it: the device hash is unchanged, so the loss was permanent.
	it("reports a truncated response as failed", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "half a page" }, finish_reason: "length" }] }));
		const backend = new OpenAiCompatOcrBackend({ id: "openai", baseURL: "http://x/v1", apiKey: "k", model: "m", fetchFn: fetchMock });

		expect((await backend.recognize([page()])).pages).toEqual([{ status: "failed", text: "" }]);
	});

	it("retries a rate-limited page and gives up after three attempts", async () => {
		const rateLimited = { ...jsonResponse(429, {}), headers: { get: () => null } } as unknown as Response;
		fetchMock.mockResolvedValue(rateLimited);
		const backend = new OpenAiCompatOcrBackend({ id: "openai", baseURL: "http://x/v1", apiKey: "k", model: "m", fetchFn: fetchMock, sleepFn: async () => {} });

		expect((await backend.recognize([page()])).pages).toEqual([{ status: "failed", text: "" }]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	// A 502 or 503 is transient too and is still not retried: each added code is another failure mode
	// to reason about, and a failed page is already a graceful, visible outcome.
	it("does not retry anything but a 429", async () => {
		fetchMock.mockResolvedValue(jsonResponse(503, { error: "provider_overloaded" }));
		const backend = new OpenAiCompatOcrBackend({ id: "openrouter", baseURL: "http://x/v1", apiKey: "k", model: "m", fetchFn: fetchMock, sleepFn: async () => {} });

		await backend.recognize([page()]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// The auto-sync money-safety gate reads `metered` off the resolved adapter, so a wrong answer here
// either blocks a free background sync or lets a paid one run without consent.
describe("metered", () => {
	const compat = (id: string) => new OpenAiCompatOcrBackend({ id: id as never, baseURL: "http://x/v1", model: "m", fetchFn: fetchMock });

	it("is true for the cloud providers", () => {
		expect(compat("openai").metered).toBe(true);
		expect(compat("gemini").metered).toBe(true);
		expect(compat("openrouter").metered).toBe(true);
	});

	it("is false for local providers and a self-hosted custom endpoint", () => {
		expect(compat("ollama").metered).toBe(false);
		expect(compat("lmstudio").metered).toBe(false);
		expect(compat("custom").metered).toBe(false);
	});

	it("treats an id nobody listed as metered, which is the safe direction for a money gate", () => {
		// The lookup this replaced defaulted an unknown id to *free*. Blocking a free background sync
		// is recoverable; billing one silently is not.
		expect(compat("some-future-provider").metered).toBe(true);
	});
});

/**
 * The silence this ends (free-localhost-ocr spec §5.2). A refused connection used to reach a
 * `console.warn` and nowhere else: the note shipped with no transcript and the user was told nothing.
 * For a server they run themselves, "it isn't running" is the single most likely failure there is.
 */
describe("the not-running warning", () => {
	beforeEach(() => {
		fetchMock.mockReset();
	});

	it("names the address and the page count when nothing answers", async () => {
		fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1234"));
		const backend = new OpenAiCompatOcrBackend({ id: "lmstudio", baseURL: "http://localhost:1234/v1", model: "m", fetchFn: fetchMock });

		const result = await backend.recognize([page(), page()]);

		expect(result.status).toBe("failed");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings?.[0]).toContain("http://localhost:1234/v1");
		expect(result.warnings?.[0]).toContain("2 pages were not transcribed");
	});

	it("says it once per unit, not once per page", async () => {
		fetchMock.mockRejectedValue(new Error("fetch failed"));
		const backend = new OpenAiCompatOcrBackend({ id: "ollama", baseURL: "http://localhost:11434/v1", model: "m", fetchFn: fetchMock });

		const result = await backend.recognize([page(), page(), page()]);

		expect(result.warnings).toHaveLength(1);
	});

	it("stays quiet when the server answered and simply refused", async () => {
		// A 401 or a 404 is a different sentence, and inventing "is it running?" for it would send the
		// user to check something that is already fine.
		fetchMock.mockResolvedValue(jsonResponse(401, { error: "no" }));
		const backend = new OpenAiCompatOcrBackend({ id: "lmstudio", baseURL: "http://localhost:1234/v1", model: "m", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result.status).toBe("failed");
		expect(result.warnings).toBeUndefined();
	});

	it("stays quiet when every page succeeded", async () => {
		fetchMock.mockResolvedValue(chatResponse("# Notes"));
		const backend = new OpenAiCompatOcrBackend({ id: "ollama", baseURL: "http://localhost:11434/v1", model: "m", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result.status).toBe("ok");
		expect(result.warnings).toBeUndefined();
	});
});
