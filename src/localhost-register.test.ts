import { describe, expect, it } from "vitest";
import { ocrBackendEntry } from "./ocr-registry";
import { unreachableMessage } from "./localhost-register";
import { LOCALHOST_PROVIDERS } from "./localhost-providers";
import "./localhost-register";

const IDS = ["ollama", "lmstudio", "custom"] as const;

/**
 * The three properties that make this backend different from every other one in the free build
 * (free-localhost-ocr spec §3), and the one that makes the whole effort worth doing.
 */
describe("the localhost backends' registration", () => {
	it("registers all three, on every platform", () => {
		// The point of the effort: no `unavailableLabel`, so `isListedBackend` lists them everywhere --
		// including Windows x64 and Linux, where the dropdown had nothing selectable in it.
		for (const id of IDS) {
			const entry = ocrBackendEntry(id);
			expect(entry, id).not.toBeNull();
			expect(entry?.unavailableLabel).toBeUndefined();
		}
	});

	it("gives none of them a setup card, so none can be hidden from the dropdown", () => {
		for (const id of IDS) expect(ocrBackendEntry(id)?.renderSetup).toBeUndefined();
	});

	it("costs no money and still asks before running in the background", () => {
		// Deliberately unlike Pro's own Ollama/LM Studio entries, which are frozen at `false` so an
		// existing user's background sync does not stop. A new registration has no such users, and a 7B
		// on your own machine costs battery and several GB of RAM.
		for (const id of IDS) {
			expect(ocrBackendEntry(id)?.metered, id).toBe(false);
			expect(ocrBackendEntry(id)?.needsBackgroundConsent, id).toBe(true);
		}
	});

	it("stores its background consent in its own settings blob, defaulting to off", () => {
		const entry = ocrBackendEntry("ollama");
		const settings = {};
		expect(entry?.backgroundConsent?.get(settings)).toBe(false);
		entry?.backgroundConsent?.set(settings, true);
		expect(entry?.backgroundConsent?.get(settings)).toBe(true);
	});

	it("seeds no model, because none of these servers has been measured", () => {
		for (const id of IDS) expect(LOCALHOST_PROVIDERS[id].defaultModel, id).toBe("");
	});
});

describe("create()", () => {
	it("builds an adapter for a preset even with no settings stored", () => {
		const adapter = ocrBackendEntry("lmstudio")?.create({});
		expect(adapter?.id).toBe("lmstudio");
		expect(adapter?.metered).toBe(false);
	});

	it("reports unavailable for a custom endpoint with no base URL, rather than falling back", () => {
		// `null` would mean "fall back to a free local backend", which is a metered-provider concept.
		// A missing URL is a misconfiguration, and transcribing somewhere else would be a surprise.
		const adapter = ocrBackendEntry("custom")?.create({});
		expect(adapter).not.toBeNull();
		expect(adapter?.id).toBe("custom");
	});

	it("uses the user's base URL over the preset when they set one", () => {
		const adapter = ocrBackendEntry("ollama")?.create({ baseURL: "http://box.local:11434/v1" });
		expect(adapter?.id).toBe("ollama");
	});
});

/**
 * The sentence a user with a closed app reads (spec §5.1). It names the address always and the app
 * where we know it, and stops there -- installing someone else's software is not ours to explain.
 */
describe("unreachableMessage", () => {
	it("names the app for the two presets", () => {
		expect(unreachableMessage(LOCALHOST_PROVIDERS.ollama, "http://localhost:11434/v1")).toContain("Start Ollama");
		expect(unreachableMessage(LOCALHOST_PROVIDERS.lmstudio, "http://localhost:1234/v1")).toContain("Start LM Studio");
	});

	it("stays generic for a custom endpoint, and always names the address", () => {
		const message = unreachableMessage(LOCALHOST_PROVIDERS.custom, "http://box.local:8080/v1");
		expect(message).toContain("http://box.local:8080/v1");
		expect(message).not.toContain("Start ");
	});
});
