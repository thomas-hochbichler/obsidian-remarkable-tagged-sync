import { describe, expect, it } from "vitest";
import { ocrBackendEntries, ocrBackendEntry } from "../src/ocr-registry";
import "../src/vision-register";
import "./llm-register";

/**
 * The regression this file exists to guard, named by the managed-local-LLM spec §6.4.
 *
 * A local model costs no money and still costs battery, fans and several GB of RAM, so it needs the
 * user's say-so before it runs in the background. The tempting way to express that is to redefine
 * `metered` as "needs consent" -- and doing so would flip Ollama and LM Studio from `false` to `true`
 * while the consent flag defaults to `false`, silently stopping background transcription for the two
 * providers most like the new one. A second field is added instead, and these six must not notice
 * either change.
 */
describe("the LLM providers' background-consent flags", () => {
	const CLOUD = ["anthropic", "openai", "gemini", "openrouter"] as const;
	const LOCAL = ["ollama", "lmstudio"] as const;

	it("leaves the local providers unmetered and unconsented, exactly as before", () => {
		for (const id of LOCAL) {
			expect(ocrBackendEntry(id)?.metered).toBe(false);
			expect(ocrBackendEntry(id)?.needsBackgroundConsent).toBe(false);
		}
	});

	it("keeps the cloud providers metered and gated", () => {
		for (const id of CLOUD) {
			expect(ocrBackendEntry(id)?.metered).toBe(true);
			expect(ocrBackendEntry(id)?.needsBackgroundConsent).toBe(true);
		}
	});

	it("says the same thing with both fields for every provider, so nothing about these six changes", () => {
		for (const entry of ocrBackendEntries()) {
			expect(entry.needsBackgroundConsent).toBe(entry.metered);
		}
	});

	it("gives none of them a setup card, so none of them can be hidden from the dropdown", () => {
		for (const entry of ocrBackendEntries()) expect(entry.renderSetup).toBeUndefined();
	});
});
