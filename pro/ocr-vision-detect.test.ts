import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectVisionCapability } from "./ocr-vision-detect";
import { PROVIDERS } from "./ocr-providers";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("detectVisionCapability", () => {
	beforeEach(() => fetchMock.mockReset());

	it("returns none for Anthropic without any network call", async () => {
		expect(await detectVisionCapability({ provider: "anthropic", model: "claude-sonnet-5", baseURL: "x", fetchFn: fetchMock })).toBe("none");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	describe("heuristic providers (openai / custom)", () => {
		it("confirms a vision-looking model by name, no network", async () => {
			expect(await detectVisionCapability({ provider: "openai", model: "gpt-4o", baseURL: "x", fetchFn: fetchMock })).toBe("supported");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("flags a name that does not look vision-capable", async () => {
			expect(await detectVisionCapability({ provider: "openai", model: "gpt-3.5-turbo", baseURL: "x", fetchFn: fetchMock })).toBe("unconfirmed-name");
		});

		it("treats an empty model name as unconfirmed", async () => {
			expect(await detectVisionCapability({ provider: "custom", model: "", baseURL: "x", fetchFn: fetchMock })).toBe("unconfirmed-name");
		});
	});

	describe("openrouter (reported via /models)", () => {
		const base = PROVIDERS.openrouter.baseURL;

		it("reports supported when the catalog lists image input", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "openai/gpt-4o", architecture: { input_modalities: ["text", "image"] } }] }));

			expect(await detectVisionCapability({ provider: "openrouter", model: "openai/gpt-4o", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("supported");
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("https://openrouter.ai/api/v1/models");
			expect(init.headers["authorization"]).toBe("Bearer k");
		});

		it("reports unsupported when the model has no image modality", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "meta/llama", architecture: { input_modalities: ["text"] } }] }));

			expect(await detectVisionCapability({ provider: "openrouter", model: "meta/llama", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("unsupported");
		});

		it("falls back to the name heuristic for a model missing from the catalog", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

			// A non-vision-looking name → soft heuristic warning...
			expect(await detectVisionCapability({ provider: "openrouter", model: "ghost", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("unconfirmed-name");
			// ...a vision-looking one → supported.
			expect(await detectVisionCapability({ provider: "openrouter", model: "some/llava-next", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("supported");
		});

		it("is unreachable when the request throws", async () => {
			const throwing = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;

			expect(await detectVisionCapability({ provider: "openrouter", model: "openai/gpt-4o", baseURL: base, apiKey: "k", fetchFn: throwing })).toBe("unreachable");
		});
	});

	describe("ollama (reported via native /api/show)", () => {
		const base = PROVIDERS.ollama.baseURL;

		it("hits the native /api/show endpoint, not the /v1 path, and confirms vision", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { capabilities: ["completion", "vision"] }));

			expect(await detectVisionCapability({ provider: "ollama", model: "llama3.2-vision", baseURL: base, fetchFn: fetchMock })).toBe("supported");
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe("http://localhost:11434/api/show");
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body).name).toBe("llama3.2-vision");
		});

		it("reports unsupported for a text-only local model", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { capabilities: ["completion"] }));

			expect(await detectVisionCapability({ provider: "ollama", model: "llama3.1", baseURL: base, fetchFn: fetchMock })).toBe("unsupported");
		});

		it("is unreachable when Ollama isn't running", async () => {
			const throwing = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

			expect(await detectVisionCapability({ provider: "ollama", model: "llama3.2-vision", baseURL: base, fetchFn: throwing })).toBe("unreachable");
		});
	});

	describe("lmstudio (reported via native /api/v0/models)", () => {
		const base = PROVIDERS.lmstudio.baseURL;

		it("hits the native /api/v0/models endpoint, not the /v1 path, and confirms a vlm", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "qwen3.6-35b-a3b-ud-mlx", type: "vlm" }] }));

			expect(await detectVisionCapability({ provider: "lmstudio", model: "qwen3.6-35b-a3b-ud-mlx", baseURL: base, fetchFn: fetchMock })).toBe("supported");
			expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:1234/api/v0/models");
		});

		it("reports unsupported for a text-only (llm) model", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "meta-llama-3.1-8b-instruct", type: "llm" }] }));

			expect(await detectVisionCapability({ provider: "lmstudio", model: "meta-llama-3.1-8b-instruct", baseURL: base, fetchFn: fetchMock })).toBe("unsupported");
		});

		it("sends the bearer token when the user enabled an LM Studio API key", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [{ id: "m", type: "vlm" }] }));

			await detectVisionCapability({ provider: "lmstudio", model: "m", baseURL: base, apiKey: "tok", fetchFn: fetchMock });
			expect(fetchMock.mock.calls[0][1].headers["authorization"]).toBe("Bearer tok");
		});

		it("falls back to the name heuristic for a model that isn't loaded", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

			expect(await detectVisionCapability({ provider: "lmstudio", model: "ghost", baseURL: base, fetchFn: fetchMock })).toBe("unconfirmed-name");
			expect(await detectVisionCapability({ provider: "lmstudio", model: "some-llava", baseURL: base, fetchFn: fetchMock })).toBe("supported");
		});

		it("is unreachable when LM Studio isn't running", async () => {
			const throwing = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

			expect(await detectVisionCapability({ provider: "lmstudio", model: "m", baseURL: base, fetchFn: throwing })).toBe("unreachable");
		});
	});

	describe("gemini (partial — reachability only)", () => {
		const base = PROVIDERS.gemini.baseURL;

		it("returns partial when the endpoint is reachable", async () => {
			fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));

			expect(await detectVisionCapability({ provider: "gemini", model: "gemini-2.0-flash", baseURL: base, apiKey: "k", fetchFn: fetchMock })).toBe("partial");
			expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
		});

		it("is unreachable on a bad key / error status", async () => {
			fetchMock.mockResolvedValue(jsonResponse(403, { error: "forbidden" }));

			expect(await detectVisionCapability({ provider: "gemini", model: "gemini-2.0-flash", baseURL: base, apiKey: "bad", fetchFn: fetchMock })).toBe("unreachable");
		});
	});
});
