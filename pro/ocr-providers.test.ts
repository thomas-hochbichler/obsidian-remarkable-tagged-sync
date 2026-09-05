import { describe, expect, it } from "vitest";
import { looksLikeVisionModel, PROVIDERS, resolveProviderEndpoint } from "./ocr-providers";

describe("PROVIDERS metadata", () => {
	it("lists every non-vision backend literal exactly once, in dropdown order", () => {
		expect(Object.keys(PROVIDERS)).toEqual(["anthropic", "openai", "gemini", "openrouter", "ollama", "lmstudio", "custom"]);
	});

	/**
	 * Which providers pin `temperature: 0` (#116). A wrong entry here is not a cosmetic slip: on the
	 * current Claude generation a non-default temperature is a 400 on **every** request, thinking or
	 * not, so flipping a cloud provider to `true` would lose whole syncs rather than degrade a hint.
	 * The three servers the user runs themselves take it, and take it there.
	 */
	it("pins the temperature only on the servers the user runs", () => {
		const pinned = Object.entries(PROVIDERS)
			.filter(([, meta]) => meta.deterministic)
			.map(([id]) => id);

		expect(pinned).toEqual(["ollama", "lmstudio", "custom"]);
	});

	it("keeps each entry's key matched to its own id", () => {
		for (const [id, meta] of Object.entries(PROVIDERS)) expect(meta.id).toBe(id);
	});

	it("uses the native adapter only for Anthropic; everyone else is OpenAI-compatible", () => {
		expect(PROVIDERS.anthropic.adapter).toBe("anthropic");
		for (const id of ["openai", "gemini", "openrouter", "ollama", "lmstudio", "custom"] as const) {
			expect(PROVIDERS[id].adapter).toBe("openai-compat");
		}
	});

	it("makes the base URL editable only for local + custom providers", () => {
		expect(PROVIDERS.ollama.editableURL).toBe(true);
		expect(PROVIDERS.lmstudio.editableURL).toBe(true);
		expect(PROVIDERS.custom.editableURL).toBe(true);
		for (const id of ["anthropic", "openai", "gemini", "openrouter"] as const) expect(PROVIDERS[id].editableURL).toBe(false);
	});

	it("leaves custom's base URL empty for the user to supply", () => {
		expect(PROVIDERS.custom.baseURL).toBe("");
	});

	// The rule this walk defends: the table shipped `gemini-2.0-flash` for ten weeks after Google shut
	// it down, and nothing here could see it. A model id has an expiry date this repo does not
	// control, so no provider seeds one -- and a provider added later cannot quietly seed one either,
	// because it fails this test on the day it is added.
	it("seeds no model id for any provider, since a shipped one ages into a dead one", () => {
		for (const [id, meta] of Object.entries(PROVIDERS)) expect(meta.defaultModel, id).toBe("");
	});
});


describe("resolveProviderEndpoint", () => {
	it("uses the preset base URL and an empty model when config is empty", () => {
		expect(resolveProviderEndpoint(PROVIDERS.openai, {})).toEqual({
			baseURL: "https://api.openai.com/v1",
			model: "",
			apiKey: null,
		});
	});

	it("prefers the user's model and key over the defaults", () => {
		expect(resolveProviderEndpoint(PROVIDERS.openai, { model: "gpt-4.1", apiKey: "sk-x" })).toEqual({
			baseURL: "https://api.openai.com/v1",
			model: "gpt-4.1",
			apiKey: "sk-x",
		});
	});

	it("honors a user base URL only for editable providers", () => {
		expect(resolveProviderEndpoint(PROVIDERS.ollama, { baseURL: "http://box:11434/v1" }).baseURL).toBe("http://box:11434/v1");
		// Cloud preset ignores a stray stored baseURL.
		expect(resolveProviderEndpoint(PROVIDERS.openai, { baseURL: "http://evil" }).baseURL).toBe("https://api.openai.com/v1");
	});

	it("treats a whitespace-only model or base URL as unset", () => {
		const resolved = resolveProviderEndpoint(PROVIDERS.ollama, { model: "   ", baseURL: "  " });
		expect(resolved.model).toBe("");
		expect(resolved.baseURL).toBe("http://localhost:11434/v1");
	});
});

describe("looksLikeVisionModel", () => {
	it("recognizes common vision model names", () => {
		for (const model of ["gpt-4o", "gpt-4o-mini", "llava:13b", "llama3.2-vision", "qwen2.5-vl:7b", "pixtral-12b", "moondream"]) {
			expect(looksLikeVisionModel(model)).toBe(true);
		}
	});

	it("does not flag plainly text-only models", () => {
		for (const model of ["gpt-3.5-turbo", "llama3.1:8b", "mistral-7b", "deepseek-coder"]) {
			expect(looksLikeVisionModel(model)).toBe(false);
		}
	});
});
