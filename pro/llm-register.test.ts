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

type Caps = { vision: string; thinking: string };

const probe = vi.hoisted(() => ({
	calls: [] as { model: string; provider: string }[],
	answer: null as ((caps: { vision: string; thinking: string }) => void) | null,
	verdict: { vision: "supported", thinking: "unknown" } as { vision: string; thinking: string },
	hold: false,
}));

vi.mock("./ocr-vision-detect", () => ({
	detectVisionCapability: (args: { model: string; provider: string }) => {
		probe.calls.push({ model: args.model, provider: args.provider });
		if (!probe.hold) return Promise.resolve(probe.verdict);
		return new Promise<Caps>((resolve) => {
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

	/**
	 * What the callout says. Since #116 a verdict is painted as one child div per fact -- two facts,
	 * two colours, and `setText` on the element itself can only carry one -- while the transient
	 * states ("Checking…", empty) still sit on the element's own text.
	 */
	const said = (callout: FakeEl): string => [callout.text, ...callout.children.map((line) => line.text)].filter(Boolean).join(" | ");

	/** Lets the field's own `await save()` finish, so the check it schedules afterwards exists. */
	const flush = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};

	beforeEach(() => {
		probe.calls.length = 0;
		probe.answer = null;
		probe.verdict = { vision: "supported", thinking: "unknown" };
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

		expect(said(callout)).toBe("");
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
		expect(said(callout)).toContain("Checking whether");

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
		probe.answer?.({ vision: "unsupported", thinking: "unknown" });
		await flush();

		expect(said(first.callout)).toContain("Checking whether");
		expect(said(first.callout)).not.toContain("no image input");
		expect(said(second.callout)).not.toContain("no image input");
	});
});

/**
 * The second line (#116). The callout said one thing -- whether the model can see -- and a model that
 * reasons before answering is `supported`, correctly and uselessly: the reporter's syncs were ~50x
 * slower and dropped pages while settings showed a green tick.
 */
describe("the thinking line in the callout", () => {
	function show(provider: string, settings: Record<string, unknown>): FakeEl {
		const container = new FakeEl();
		takeSettings();
		ocrBackendEntry(provider)?.renderSettings?.(container as unknown as HTMLElement, {
			settings,
			save: async () => undefined,
			isSelected: true,
			selectDefaultBackend: async () => undefined,
		});
		takeSettings();
		const callout = container.children.find((child) => child.classes.has("tagged-sync-note"));
		if (!callout) throw new Error("no callout");
		return callout;
	}

	const lines = (callout: FakeEl): string[] => callout.children.map((line) => line.text);

	const settle = async (): Promise<void> => {
		vi.advanceTimersByTime(500);
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};

	beforeEach(() => {
		probe.calls.length = 0;
		probe.answer = null;
		probe.verdict = { vision: "supported", thinking: "unknown" };
		probe.hold = false;
		vi.useFakeTimers();
		vi.stubGlobal("window", { setTimeout, clearTimeout });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("says both facts, on their own lines and in their own colours", async () => {
		probe.verdict = { vision: "supported", thinking: "on" };
		const callout = show("openrouter", { model: "qwen/qwen3-vl-4b-thinking" });

		await settle();

		expect(lines(callout)).toEqual([
			'✓ "qwen/qwen3-vl-4b-thinking" supports image input.',
			'⚠ "qwen/qwen3-vl-4b-thinking" reasons before answering — expect much slower syncs, pages left out when an answer runs too long, ' +
				"and the reasoning tokens on your bill. A model that doesn't reason avoids all three.",
		]);
		// A warning, not an error: a reasoning model transcribes, slowly. Red is reserved for
		// "transcription will fail", and one red string in this pane must mean one thing.
		expect(callout.children.map((line) => line.style["color"])).toEqual(["var(--text-success)", "var(--text-warning)"]);
	});

	/** The urgent half keeps the field: a model that cannot see must be replaced either way. */
	it("drops the thinking line when the model cannot see images at all", async () => {
		probe.verdict = { vision: "unsupported", thinking: "on" };
		const callout = show("openrouter", { model: "some/text-only" });

		await settle();

		expect(lines(callout)).toHaveLength(1);
		expect(lines(callout)[0]).toContain("no image input");
	});

	it("says nothing when the answer is unknown, and never that a model does not reason", async () => {
		probe.verdict = { vision: "supported", thinking: "off" };
		const callout = show("openrouter", { model: "openai/gpt-4o" });

		await settle();

		expect(lines(callout)).toEqual(['✓ "openai/gpt-4o" supports image input.']);
	});

	/**
	 * `visionReach: "none"` used to blank the callout and return, so Anthropic -- the one provider that
	 * ships a reasoning model by default -- was the one provider guaranteed to stay silent. It now
	 * means "no vision probe", not "no callout", and there is nothing pending to announce either.
	 */
	it("warns for Anthropic, which has no vision line and no request to wait for", async () => {
		probe.verdict = { vision: "none", thinking: "on" };
		const callout = show("anthropic", { model: "claude-opus-5" });

		expect(callout.text).toBe("");

		await settle();

		expect(lines(callout)).toEqual([
			'⚠ "claude-opus-5" reasons before answering — expect much slower syncs, pages left out when an answer runs too long, ' +
				"and the reasoning tokens on your bill. A model that doesn't reason avoids all three.",
		]);
	});
});
