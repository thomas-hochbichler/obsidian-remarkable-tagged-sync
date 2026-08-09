import { describe, expect, it, vi } from "vitest";
import { detectLocalhostVisionCapability } from "./localhost-vision-detect";

function jsonResponse(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("detectLocalhostVisionCapability", () => {
	it("reads Ollama's capabilities off the native /api/show surface", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { capabilities: ["completion", "vision"] }));

		const verdict = await detectLocalhostVisionCapability({
			provider: "ollama",
			model: "qwen2.5vl",
			baseURL: "http://localhost:11434/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("supported");
		// /v1 is the OpenAI-compat path; the capability flag only exists on the native one.
		expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:11434/api/show");
	});

	it("says unsupported when Ollama reports a text-only model", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { capabilities: ["completion"] }));

		const verdict = await detectLocalhostVisionCapability({
			provider: "ollama",
			model: "llama3.2",
			baseURL: "http://localhost:11434/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("unsupported");
	});

	it("reads LM Studio's model type off /api/v0/models", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: "qwen2.5-vl-7b", type: "vlm" }] }));

		const verdict = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "qwen2.5-vl-7b",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("supported");
		expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:1234/api/v0/models");
	});

	it("falls back to the name heuristic when LM Studio is reachable but doesn't list the model", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));

		const verdict = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "qwen2.5-vl-7b",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("supported");
	});

	/**
	 * The verdict this whole backend leans on (spec §5.1): for a server the user runs, "unreachable"
	 * is almost always "the app is not running", which is the most likely failure it has.
	 */
	it("says unreachable when nothing answers", async () => {
		const fetchFn = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1234"));

		const verdict = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "qwen2.5-vl-7b",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("unreachable");
	});

	it("uses the name heuristic for a custom endpoint, which has no flag to query", async () => {
		const fetchFn = vi.fn();

		expect(
			await detectLocalhostVisionCapability({
				provider: "custom",
				model: "qwen2.5-vl-7b",
				baseURL: "http://box.local/v1",
				fetchFn: fetchFn as unknown as typeof fetch,
			}),
		).toBe("supported");

		expect(
			await detectLocalhostVisionCapability({
				provider: "custom",
				model: "mistral-7b",
				baseURL: "http://box.local/v1",
				fetchFn: fetchFn as unknown as typeof fetch,
			}),
		).toBe("unconfirmed-name");

		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("does not query for an empty model name", async () => {
		const fetchFn = vi.fn();

		const verdict = await detectLocalhostVisionCapability({
			provider: "ollama",
			model: "   ",
			baseURL: "http://localhost:11434/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("unconfirmed-name");
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
