import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEl, takeSettings } from "../test-stubs/fake-obsidian";
import { extractionBackendEntry } from "./intelligence/extraction-registry";
import { ocrBackendEntry } from "./ocr-registry";
import { unreachableMessage } from "./localhost-register";
import { LOCALHOST_PROVIDERS } from "./localhost-providers";
import { OWN_SERVER_MAX_TOKENS } from "./openai-compat-ocr-backend";
import "./localhost-register";
import { DIAGRAM_PROMPT, pagePrompt } from "./llm-transcript";

const probe = vi.hoisted(() => ({ verdict: { vision: "supported", thinking: "unknown" } as { vision: string; thinking: string; missing?: { suggestion: string | null } } }));

vi.mock("./localhost-vision-detect", async (importOriginal) => ({
	...(await importOriginal<typeof import("./localhost-vision-detect")>()),
	detectLocalhostVisionCapability: () => Promise.resolve(probe.verdict),
}));

const IDS = ["ollama", "lmstudio", "custom"] as const;

/**
 * The three properties that make this backend different from every other one in the free build
 * (free-localhost-ocr spec §3), and the one that makes the whole effort worth doing.
 */
describe("the localhost backends' registration", () => {
	it("registers all three, on every platform", () => {
		// The point of the effort: no `unavailableLabel`, so the dropdown lists them enabled everywhere --
		// including Windows x64 and Linux, where the dropdown had nothing selectable in it.
		for (const id of IDS) {
			const entry = ocrBackendEntry(id);
			expect(entry, id).not.toBeNull();
			expect(entry?.unavailableLabel).toBeUndefined();
		}
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

	it("says what a background run costs, rather than leaving the toggle bare", () => {
		// The registry renders whatever this returns under the switch. An entry that answers nothing
		// leaves the reader consenting to a sentence that is not there.
		for (const id of IDS) {
			const desc = ocrBackendEntry(id)?.backgroundConsent?.description({});
			expect(desc, id).toContain("while you are not there");
		}
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

	it("transcribes nothing while the model field is empty, which is what a fresh install stores", async () => {
		// The row ships empty, so `{}` is exactly what the vault holds until the user fills it in. LM
		// Studio answers a request with no model by using whichever one happens to be loaded -- or with
		// a 400 when none is -- and neither belongs in a note.
		const adapter = ocrBackendEntry("lmstudio")?.create({});
		const result = await adapter?.recognize([{ formatVersion: 6, layers: [] }]);

		expect(result?.status).toBe("failed");
		expect(result?.warnings?.[0]).toContain("No model is set");
	});

	// Ticket 38: a local model asked for text and diagram at once dropped the text; the diagram goes alone.
	it("reads a page's diagram in a request of its own, with the user's signs in the text prompt", () => {
		for (const id of IDS) {
			const adapter = ocrBackendEntry(id)?.create({ baseURL: "http://h/v1" }, { silent: false, signs: [{ glyph: "★", meaning: "note" }] }) as unknown as { prompt: string; diagramPrompt: string };
			expect(adapter.prompt, id).toBe(pagePrompt([{ glyph: "★", meaning: "note" }], false));
			expect(adapter.diagramPrompt, id).toBe(DIAGRAM_PROMPT);
		}
	});

	it("caps every page's answer on these servers, so a model that reasons without end stops in minutes, not at the ten-minute limit", () => {
		for (const id of IDS) expect((ocrBackendEntry(id)?.create({ baseURL: "http://h/v1" }) as unknown as { maxTokens: number }).maxTokens, id).toBe(OWN_SERVER_MAX_TOKENS);
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


/**
 * The free build's half of #116's first thread. Same two lines as Pro's callout, one string apart:
 * nothing here is metered, so no clause about a bill -- and the lever is the `-instruct` build, which
 * is the one naming convention that held on every model measured (0 of 31 `instruct` ids reasoned
 * unasked, while only 4 % of the models that do reason say so in their name).
 */
describe("the thinking line in the localhost callout", () => {
	function show(id: string, settings: Record<string, unknown>): FakeEl {
		const container = new FakeEl();
		takeSettings();
		ocrBackendEntry(id)?.renderSettings?.(container as unknown as HTMLElement, {
			settings,
			save: async () => undefined,
			selectDefaultBackend: async () => undefined,
		});
		// Both sit in the Model row's own description -- one says what to type, the other judges what
		// was typed. The first is the standing recommendation; the live callout is the one after it.
		const notes =
			takeSettings()
				.find((row) => row.name === "Model")
				?.descEl.children.filter((child) => child.classes.has("tagged-sync-verdict")) ?? [];
		return notes[1];
	}

	const lines = (callout: FakeEl): string[] => callout.children.map((line) => line.text);

	const settle = async (): Promise<void> => {
		vi.advanceTimersByTime(500);
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};

	beforeEach(() => {
		probe.verdict = { vision: "supported", thinking: "unknown" };
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout, clearTimeout });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("says both facts, and points at the build that does not reason", async () => {
		probe.verdict = { vision: "supported", thinking: "on" };
		const callout = show("ollama", { model: "qwen3-vl:4b" });

		await settle();

		expect(lines(callout)).toEqual([
			'✓ "qwen3-vl:4b" supports image input.',
			'⚠ "qwen3-vl:4b" reasons before answering — expect much slower syncs, and pages left out when an answer runs too long. ' +
				'A model that doesn\'t reason (often the "-instruct" build) avoids both.',
		]);
		expect(callout.children.map((line) => line.style["color"])).toEqual(["var(--text-success)", "var(--text-warning)"]);
	});

	it("says only that the server has no such model, with the name that fits, in the error colour", async () => {
		probe.verdict = { vision: "supported", thinking: "on", missing: { suggestion: "qwen/qwen3-vl-8b" } };
		const callout = show("lmstudio", { model: "qwen3-vl-8b" });

		await settle();

		expect(lines(callout)).toEqual(['⚠ The server has no model "qwen3-vl-8b". Did you mean "qwen/qwen3-vl-8b"?']);
		expect(callout.children[0].style["color"]).toBe("var(--text-error)");
	});

	it("keeps the field for the urgent half when the model cannot see images", async () => {
		probe.verdict = { vision: "unsupported", thinking: "on" };
		const callout = show("ollama", { model: "llama3.2" });

		await settle();

		expect(lines(callout)).toHaveLength(1);
		expect(lines(callout)[0]).toContain("no image input");
	});

	it("stays quiet about a model that does not reason", async () => {
		probe.verdict = { vision: "supported", thinking: "off" };
		const callout = show("ollama", { model: "qwen2.5vl:7b" });

		await settle();

		expect(lines(callout)).toEqual(['✓ "qwen2.5vl:7b" supports image input.']);
	});
});

describe("the same servers as extraction backends", () => {
	it("name the extraction model when the server says it reasons or does not have it, and nothing when it does not or cannot say", async () => {
		const before = probe.verdict;
		try {
			probe.verdict = { vision: "supported", thinking: "on" };
			expect(await extractionBackendEntry("lmstudio")!.modelNote!({ model: "set-there" }, null)).toEqual({ kind: "reasons", model: "set-there" });
			expect(await extractionBackendEntry("ollama")!.modelNote!({ model: "set-there" }, "typed")).toEqual({ kind: "reasons", model: "typed" });
			for (const thinking of ["off", "unknown"]) {
				probe.verdict = { vision: "supported", thinking };
				expect(await extractionBackendEntry("lmstudio")!.modelNote!({ model: "m" }, null)).toBeNull();
			}
			probe.verdict = { vision: "supported", thinking: "unknown", missing: { suggestion: "qwen/qwen3-vl-8b" } };
			expect(await extractionBackendEntry("lmstudio")!.modelNote!({ model: "m" }, "qwen3-vl-8b")).toEqual({ kind: "missing", model: "qwen3-vl-8b", suggestion: "qwen/qwen3-vl-8b" });
		} finally {
			probe.verdict = before;
		}
	});
});
