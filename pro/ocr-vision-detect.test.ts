import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectVisionCapability } from "./ocr-vision-detect";
import { PROVIDERS } from "./ocr-providers";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/**
 * The vision half alone. The probe answers a pair since #116 -- vision plus whether the model reasons
 * before answering -- and every case below predates the second half and is about the first.
 */
const visionOf = async (input: Parameters<typeof detectVisionCapability>[0]): Promise<string> => (await detectVisionCapability(input)).vision;

describe("detectVisionCapability", () => {
	beforeEach(() => fetchMock.mockReset());

	it("returns none for Anthropic without any network call", async () => {
		expect(await visionOf({ provider: "anthropic", model: "claude-sonnet-5", baseURL: "x", fetchFn: fetchMock })).toBe("none");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	describe("heuristic providers (openai / custom)", () => {
		it("confirms a vision-looking model by name, no network", async () => {
			expect(await visionOf({ provider: "openai", model: "gpt-4o", baseURL: "x", fetchFn: fetchMock })).toBe("supported");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("flags a name that does not look vision-capable", async () => {
			expect(await visionOf({ provider: "openai", model: "gpt-3.5-turbo", baseURL: "x", fetchFn: fetchMock })).toBe("unconfirmed-name");
		});

		it("treats an empty model name as unconfirmed", async () => {
			expect(await visionOf({ provider: "custom", model: "", baseURL: "x", fetchFn: fetchMock })).toBe("unconfirmed-name");
		});
	});

	describe("openrouter (reported via /models)", () => {
		const base = PROVIDERS.openrouter.baseURL;

		it("reports supported when the catalog lists image input", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "openai/gpt-4o", architecture: { input_modalities: ["text", "image"] } }] }));

			expect(await visionOf({ provider: "openrouter", model: "openai/gpt-4o", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("supported");
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("https://openrouter.ai/api/v1/models");
			expect(init.headers["authorization"]).toBe("Bearer k");
		});

		it("reports unsupported when the model has no image modality", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "meta/llama", architecture: { input_modalities: ["text"] } }] }));

			expect(await visionOf({ provider: "openrouter", model: "meta/llama", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("unsupported");
		});

		it("falls back to the name heuristic for a model missing from the catalog", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

			// A non-vision-looking name → soft heuristic warning...
			expect(await visionOf({ provider: "openrouter", model: "ghost", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("unconfirmed-name");
			// ...a vision-looking one → supported.
			expect(await visionOf({ provider: "openrouter", model: "some/llava-next", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("supported");
		});

		it("is unreachable when the request throws", async () => {
			const throwing = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;

			expect(await visionOf({ provider: "openrouter", model: "openai/gpt-4o", baseURL: base, apiKey: "k", fetchFn: throwing })).toBe("unreachable");
		});
	});

	describe("ollama (reported via native /api/show)", () => {
		const base = PROVIDERS.ollama.baseURL;

		it("hits the native /api/show endpoint, not the /v1 path, and confirms vision", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { capabilities: ["completion", "vision"] }));

			expect(await visionOf({ provider: "ollama", model: "llama3.2-vision", baseURL: base, fetchFn: fetchMock })).toBe("supported");
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("http://localhost:11434/api/show");
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body).name).toBe("llama3.2-vision");
		});

		it("reports unsupported for a text-only local model", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { capabilities: ["completion"] }));

			expect(await visionOf({ provider: "ollama", model: "llama3.1", baseURL: base, fetchFn: fetchMock })).toBe("unsupported");
		});

		it("is unreachable when Ollama isn't running", async () => {
			const throwing = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

			expect(await visionOf({ provider: "ollama", model: "llama3.2-vision", baseURL: base, fetchFn: throwing })).toBe("unreachable");
		});
	});

	describe("lmstudio (reported via native /api/v0/models)", () => {
		const base = PROVIDERS.lmstudio.baseURL;

		it("hits the native /api/v0/models endpoint, not the /v1 path, and confirms a vlm", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "qwen3.6-35b-a3b-ud-mlx", type: "vlm" }] }));

			expect(await visionOf({ provider: "lmstudio", model: "qwen3.6-35b-a3b-ud-mlx", baseURL: base, fetchFn: fetchMock })).toBe("supported");
			expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/api/v0/models");
		});

		it("reports unsupported for a text-only (llm) model", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "meta-llama-3.1-8b-instruct", type: "llm" }] }));

			expect(await visionOf({ provider: "lmstudio", model: "meta-llama-3.1-8b-instruct", baseURL: base, fetchFn: fetchMock })).toBe("unsupported");
		});

		it("sends the bearer token when the user enabled an LM Studio API key", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "m", type: "vlm" }] }));

			await visionOf({ provider: "lmstudio", model: "m", baseURL: base, apiKey: "tok", fetchFn: fetchMock });
			expect(fetchMock.mock.calls[0][1].headers["authorization"]).toBe("Bearer tok");
		});

		it("falls back to the name heuristic for a model that isn't loaded", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

			expect(await visionOf({ provider: "lmstudio", model: "ghost", baseURL: base, fetchFn: fetchMock })).toBe("unconfirmed-name");
			expect(await visionOf({ provider: "lmstudio", model: "some-llava", baseURL: base, fetchFn: fetchMock })).toBe("supported");
		});

		it("is unreachable when LM Studio isn't running", async () => {
			const throwing = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

			expect(await visionOf({ provider: "lmstudio", model: "m", baseURL: base, fetchFn: throwing })).toBe("unreachable");
		});
	});

	describe("gemini (partial — reachability only)", () => {
		const base = PROVIDERS.gemini.baseURL;

		it("returns partial when the endpoint is reachable", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

			expect(await visionOf({ provider: "gemini", model: "gemini-2.0-flash", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("partial");
			expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
		});

		it("is unreachable on a bad key / error status", async () => {
			fetchMock.mockResolvedValue(jsonResponse(403, { error: "forbidden" }));

			expect(await visionOf({ provider: "gemini", model: "gemini-2.0-flash", baseURL: base, apiKey: "bad", fetchFn: fetchMock })).toBe("unreachable");
		});
	});
});

/**
 * The second half of the probe (#116). Three of the four cloud providers can say something about
 * whether the chosen model reasons before answering; the fourth says nothing, and silence is what
 * that has to look like.
 */
describe("detectVisionCapability, the thinking half", () => {
	beforeEach(() => fetchMock.mockReset());

	describe("anthropic (a list, not a probe)", () => {
		/**
		 * `/v1/models` cannot answer this: it reports `capabilities.thinking.supported`, which is true
		 * for every current Claude model including the ones where thinking defaults off. So the answer
		 * comes from Anthropic's own table, and it comes without a request -- this provider has no probe.
		 */
		it("warns for a model that reasons unasked, with no network call at all", async () => {
			const caps = await detectVisionCapability({ provider: "anthropic", model: "claude-opus-5", baseURL: "x", fetchFn: fetchMock });

			expect(caps).toEqual({ vision: "none", thinking: "on" });
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("matches the dated ids that are the normal shape", async () => {
			expect((await detectVisionCapability({ provider: "anthropic", model: "claude-sonnet-5-20260214", baseURL: "x", fetchFn: fetchMock })).thinking).toBe("on");
		});

		/**
		 * A generation whose thinking defaults off must not light the warning -- and it is `unknown`
		 * rather than `off`, because the list says which models reason, not which ones do not.
		 */
		it("stays silent for a model that is not on the list", async () => {
			expect((await detectVisionCapability({ provider: "anthropic", model: "claude-opus-4-8", baseURL: "x", fetchFn: fetchMock })).thinking).toBe("unknown");
		});
	});

	describe("openrouter (reported on the entry already fetched)", () => {
		const base = PROVIDERS.openrouter.baseURL;
		const withReasoning = (reasoning: unknown): Response =>
			jsonResponse(200, { data: [{ id: "m", architecture: { input_modalities: ["text", "image"] }, reasoning }] });

		it("warns when the catalog says reasoning is on by default, in the request vision already made", async () => {
			fetchMock.mockResolvedValue(withReasoning({ mandatory: false, default_enabled: true }));

			const caps = await detectVisionCapability({ provider: "openrouter", model: "m", baseURL: base, apiKey: "k", fetchFn: fetchMock });

			expect(caps).toEqual({ vision: "supported", thinking: "on" });
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		/** The state no other provider reports at all: reasoning that cannot be switched off. */
		it("warns when reasoning is mandatory", async () => {
			fetchMock.mockResolvedValue(withReasoning({ mandatory: true }));

			expect((await detectVisionCapability({ provider: "openrouter", model: "m", baseURL: base, fetchFn: fetchMock })).thinking).toBe("on");
		});

		it("is quiet when the catalog documents reasoning as off by default", async () => {
			fetchMock.mockResolvedValue(withReasoning({ mandatory: false, default_enabled: false }));

			expect((await detectVisionCapability({ provider: "openrouter", model: "m", baseURL: base, fetchFn: fetchMock })).thinking).toBe("off");
		});

		it("treats a model with no reasoning object as one that does not reason", async () => {
			fetchMock.mockResolvedValue(withReasoning(undefined));

			expect((await detectVisionCapability({ provider: "openrouter", model: "m", baseURL: base, fetchFn: fetchMock })).thinking).toBe("off");
		});

		/** `{mandatory: false}` alone documents no default -- 78 of 431 entries when this was measured. */
		it("says unknown when reasoning exists but no default is documented", async () => {
			fetchMock.mockResolvedValue(withReasoning({ mandatory: false }));

			expect((await detectVisionCapability({ provider: "openrouter", model: "m", baseURL: base, fetchFn: fetchMock })).thinking).toBe("unknown");
		});
	});

	it("says unknown for Gemini, which reports support but never the default", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, {}));

		const caps = await detectVisionCapability({ provider: "gemini", model: "gemini-3-pro", baseURL: PROVIDERS.gemini.baseURL, apiKey: "k", fetchFn: fetchMock });

		expect(caps).toEqual({ vision: "partial", thinking: "unknown" });
	});

	it("says unknown for a custom endpoint, which has no flag to query for either half", async () => {
		expect((await detectVisionCapability({ provider: "custom", model: "qwen2.5-vl-7b", baseURL: "x", fetchFn: fetchMock })).thinking).toBe("unknown");
	});
});
