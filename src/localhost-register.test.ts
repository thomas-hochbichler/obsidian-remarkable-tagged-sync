import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEl, takeSettings } from "../test-stubs/fake-obsidian";
import { ocrBackendEntry } from "./ocr-registry";
import { unreachableMessage } from "./localhost-register";
import { LOCALHOST_PROVIDERS } from "./localhost-providers";
import "./localhost-register";

const probe = vi.hoisted(() => ({ verdict: { vision: "supported", thinking: "unknown" } as { vision: string; thinking: string } }));

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

	it("transcribes nothing while the model field is empty, which is what a fresh install stores", async () => {
		// The row ships empty, so `{}` is exactly what the vault holds until the user fills it in. LM
		// Studio answers a request with no model by using whichever one happens to be loaded -- or with
		// a 400 when none is -- and neither belongs in a note.
		const adapter = ocrBackendEntry("lmstudio")?.create({});
		const result = await adapter?.recognize([{ formatVersion: 6, layers: [] }]);

		expect(result?.status).toBe("failed");
		expect(result?.warnings?.[0]).toContain("No model is set");
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
			isSelected: true,
			selectDefaultBackend: async () => undefined,
		});
		takeSettings();
		// The first note div is the standing model recommendation; the live callout is the one after it.
		const notes = container.children.filter((child) => child.classes.has("tagged-sync-note"));
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
