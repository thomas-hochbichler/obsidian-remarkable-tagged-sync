import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEl, takeSettings, type TextComponent } from "../test-stubs/fake-obsidian";
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

// Gap G28's other half -- E8, the live vision-capability callout under the Model field.
//
// It is the one row in the settings surface that talks to a provider while the user types, and all
// three of the things that make it safe to do that were untested: the empty-model early return, the
// debounce, and the el-identity guard. Each is invisible when it works and each fails in a way that
// looks like the plugin being broken: a red "has no image input" about a field nobody has filled in,
// one HTTP request per keystroke, or a verdict about an old model written into the current pane.

const probe = vi.hoisted(() => ({
	calls: [] as { model: string; provider: string }[],
	answer: null as ((verdict: string) => void) | null,
	verdict: "supported" as string,
	hold: false,
}));

vi.mock("./ocr-vision-detect", () => ({
	detectVisionCapability: (args: { model: string; provider: string }) => {
		probe.calls.push({ model: args.model, provider: args.provider });
		if (!probe.hold) return Promise.resolve(probe.verdict);
		return new Promise<string>((resolve) => {
			probe.answer = resolve;
		});
	},
}));

describe("the live vision-capability callout", () => {
	/** The provider is one whose reach is `reported`, so the callout is live rather than switched off. */
	const PROVIDER = "openrouter";

	function show(settings: Record<string, unknown> = {}): { container: FakeEl; callout: FakeEl; model: TextComponent } {
		const container = new FakeEl();
		takeSettings();
		ocrBackendEntry(PROVIDER)?.renderSettings?.(container as unknown as HTMLElement, {
			settings,
			save: async () => undefined,
			isSelected: true,
			selectDefaultBackend: async () => undefined,
		});
		const rows = takeSettings();
		const model = rows.find((row) => row.name === "Model")?.texts[0];
		if (!model) throw new Error("no Model field");
		const callout = container.children.find((child) => child.classes.has("tagged-sync-note"));
		if (!callout) throw new Error("no callout");
		return { container, callout, model };
	}

	/** Lets the field's own `await save()` finish, so the check it schedules afterwards exists. */
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};

	beforeEach(() => {
		probe.calls.length = 0;
		probe.answer = null;
		probe.verdict = "supported";
		probe.hold = false;
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout, clearTimeout });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("stays empty on the empty model field every fresh install starts with", () => {
		// No provider seeds a model id, so an empty field is the normal state of a new vault rather
		// than a mistake. Probing it would render the verdict about `""` -- a red "has no image input"
		// about a field the user has not filled in yet.
		const { callout } = show();

		expect(callout.text).toBe("");
		vi.advanceTimersByTime(5_000);
		expect(probe.calls).toEqual([]);
	});

	it("asks once, 500 ms after the typing stops, not once per keystroke", async () => {
		const { callout, model } = show();

		for (const value of ["g", "gp", "gpt", "gpt-4o"]) {
			model.type(value);
			// The field persists before it schedules the check, so the scheduling is a microtask behind
			// the keystroke -- a synchronous assertion here would be asserting about the moment before.
			await flush();
			vi.advanceTimersByTime(300);
		}
		expect(probe.calls).toEqual([]);
		expect(callout.text).toContain("Checking whether");

		vi.advanceTimersByTime(500);
		expect(probe.calls).toEqual([{ model: "gpt-4o", provider: PROVIDER }]);
	});

	it("drops a verdict that comes back after the pane was drawn again", async () => {
		// The settings pane re-renders on every backend change and on every save that re-draws. Without
		// the el-identity guard, a probe about the model the user has moved away from lands in the
		// callout of the one they are looking at now.
		probe.hold = true;
		const first = show({ model: "old-model" });
		vi.advanceTimersByTime(500);
		expect(probe.calls).toHaveLength(1);

		const second = show({ model: "new-model" });
		probe.answer?.("unsupported");
		await flush();

		expect(first.callout.text).toContain("Checking whether");
		expect(first.callout.text).not.toContain("no image input");
		expect(second.callout.text).not.toContain("no image input");
	});
});
