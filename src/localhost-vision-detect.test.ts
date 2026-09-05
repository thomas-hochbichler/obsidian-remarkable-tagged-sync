import { describe, expect, it, vi } from "vitest";
import { detectLocalhostVisionCapability } from "./localhost-vision-detect";

function jsonResponse(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/**
 * The vision half alone. The probe answers a pair since #116 -- vision plus whether the model reasons
 * before answering -- and every case below predates the second half and is about the first.
 */
const visionOf = async (input: Parameters<typeof detectLocalhostVisionCapability>[0]): Promise<string> => (await detectLocalhostVisionCapability(input)).vision;

describe("detectLocalhostVisionCapability", () => {
	it("reads Ollama's capabilities off the native /api/show surface", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { capabilities: ["completion", "vision"] }));

		const verdict = await visionOf({
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

		const verdict = await visionOf({
			provider: "ollama",
			model: "llama3.2",
			baseURL: "http://localhost:11434/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("unsupported");
	});

	it("reads LM Studio's model type off /api/v0/models", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: "qwen2.5-vl-7b", type: "vlm" }] }));

		const verdict = await visionOf({
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

		const verdict = await visionOf({
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

		const verdict = await visionOf({
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
			await visionOf({
				provider: "custom",
				model: "qwen2.5-vl-7b",
				baseURL: "http://box.local/v1",
				fetchFn: fetchFn as unknown as typeof fetch,
			}),
		).toBe("supported");

		expect(
			await visionOf({
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

		const verdict = await visionOf({
			provider: "ollama",
			model: "   ",
			baseURL: "http://localhost:11434/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(verdict).toBe("unconfirmed-name");
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

/**
 * The second half of the probe (#116). A settings pane that says nothing about a model which reasons
 * before answering is the whole of that issue: the reporter's syncs ran ~50x slower and lost pages,
 * and every fact needed to warn him was already in a response the plugin was fetching.
 */
describe("detectLocalhostVisionCapability, the thinking half", () => {
	it("reads Ollama's thinking capability out of the same array as vision, in the same request", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { capabilities: ["completion", "vision", "thinking"] }));

		const caps = await detectLocalhostVisionCapability({
			provider: "ollama",
			model: "qwen3-vl:4b",
			baseURL: "http://localhost:11434/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps).toEqual({ vision: "supported", thinking: "on" });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	/**
	 * On Ollama the support flag IS the default flag: the server turns thinking on for any model
	 * carrying the capability when the request omits `think`, and this plugin never sends it. So the
	 * array's `"thinking"` means "reasons on every page we send it", not "could if asked".
	 */
	it("calls a model without the capability an authoritative no, not an unknown", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { capabilities: ["completion", "vision"] }));

		const caps = await detectLocalhostVisionCapability({
			provider: "ollama",
			model: "qwen2.5vl:7b",
			baseURL: "http://localhost:11434/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps.thinking).toBe("off");
	});

	it("reads LM Studio's reasoning default off /api/v1/models, which /api/v0/models cannot answer", async () => {
		const fetchFn = vi.fn(async (url: string) =>
			url.endsWith("/api/v1/models")
				? jsonResponse(200, { models: [{ key: "google/gemma-4-12b", capabilities: { vision: true, reasoning: { allowed_options: ["off", "on"], default: "on" } } }] })
				: jsonResponse(200, { data: [{ id: "google/gemma-4-12b", type: "vlm", capabilities: ["tool_use"] }] }),
		);

		const caps = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "google/gemma-4-12b",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps).toEqual({ vision: "supported", thinking: "on" });
		// The vision half stays on v0: the two surfaces agree model for model, so migrating it would
		// buy no accuracy and put the working half behind the version floor below.
		expect(fetchFn.mock.calls.map((call) => call[0])).toEqual(["http://localhost:1234/api/v0/models", "http://localhost:1234/api/v1/models"]);
	});

	it("reads a reasoning default of off as off", async () => {
		const fetchFn = vi.fn(async (url: string) =>
			url.endsWith("/api/v1/models")
				? jsonResponse(200, { models: [{ key: "m", capabilities: { vision: true, reasoning: { allowed_options: ["off", "on"], default: "off" } } }] })
				: jsonResponse(200, { data: [{ id: "m", type: "vlm" }] }),
		);

		const caps = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "m",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps.thinking).toBe("off");
	});

	/**
	 * The finding that decided against migrating the vision half: LM Studio answers an unknown path
	 * with **HTTP 200 and an error body** (measured: `GET /api/v2/models` → 200). A build older than
	 * 0.4.0 has no v1 router, so `!response.ok` never fires and the body shape is the version check.
	 * Getting that wrong must cost a missing line, never the vision verdict beside it.
	 */
	it("stays silent, and keeps the vision verdict, on an LM Studio too old to have the v1 endpoint", async () => {
		const fetchFn = vi.fn(async (url: string) =>
			url.endsWith("/api/v1/models")
				? jsonResponse(200, { error: "Unexpected endpoint or method. (GET /api/v1/models)" })
				: jsonResponse(200, { data: [{ id: "qwen2.5-vl-7b", type: "vlm" }] }),
		);

		const caps = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "qwen2.5-vl-7b",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps).toEqual({ vision: "supported", thinking: "unknown" });
	});

	it("keeps the vision verdict when only the thinking request fails", async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url.endsWith("/api/v1/models")) throw new Error("socket hang up");
			return jsonResponse(200, { data: [{ id: "m", type: "vlm" }] });
		});

		const caps = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "m",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps).toEqual({ vision: "supported", thinking: "unknown" });
	});

	/** A model the server does not list has no reasoning config to read, and we do not guess from a name. */
	it("says unknown for a model LM Studio does not list", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { models: [], data: [] }));

		const caps = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "qwen2.5-vl-7b",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps.thinking).toBe("unknown");
	});

	/** A 404 from a build that has the route but refuses it, or an auth failure: silence, not a guess. */
	it("says unknown when the v1 listing answers with an error status", async () => {
		const fetchFn = vi.fn(async (url: string) =>
			url.endsWith("/api/v1/models") ? jsonResponse(403, { error: "forbidden" }) : jsonResponse(200, { data: [{ id: "m", type: "vlm" }] }),
		);

		const caps = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "m",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps).toEqual({ vision: "supported", thinking: "unknown" });
	});

	/**
	 * The vision half keeps its own failure mode: a listing that answers with an error status is a
	 * server that cannot be asked, which for a localhost provider reads as "the app is not running".
	 */
	it("says unreachable when the model listing answers with an error status", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));

		const caps = await detectLocalhostVisionCapability({
			provider: "lmstudio",
			model: "m",
			baseURL: "http://localhost:1234/v1",
			fetchFn: fetchFn as unknown as typeof fetch,
		});

		expect(caps).toEqual({ vision: "unreachable", thinking: "unknown" });
	});

	it("says unknown for a custom endpoint, which has no flag to query for either half", async () => {
		const caps = await detectLocalhostVisionCapability({
			provider: "custom",
			model: "qwen2.5-vl-7b",
			baseURL: "http://box.local/v1",
			fetchFn: vi.fn() as unknown as typeof fetch,
		});

		expect(caps).toEqual({ vision: "supported", thinking: "unknown" });
	});
});
