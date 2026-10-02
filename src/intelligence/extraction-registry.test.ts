import { describe, expect, it, vi } from "vitest";
import { compatExtractionEntry, extractionBackendEntries, extractionBackendEntry, registerExtractionBackend } from "./extraction-registry";
import { openAiCompatComplete } from "./extraction-backend";
import { defaultSlots, genericProfile } from "./settings";

const complete = vi.hoisted(() => vi.fn());
vi.mock("./extraction-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./extraction-backend")>();
	return { ...actual, openAiCompatComplete: vi.fn((options: unknown) => (complete(options), async () => ({ kind: "failed", reason: "x" }))) };
});

const provider = (kind: "cloud" | "local" | "user", id = "openrouter") => ({ id, label: id, kind, resolve: (s: Record<string, unknown>) => ({ baseURL: (s.baseURL as string) ?? "https://x/v1", model: "default-model", apiKey: (s.apiKey as string) ?? null }) });

describe("compatExtractionEntry", () => {
	it("makes a cloud provider a metered, Pro, one-call backend that needs a key", () => {
		const entry = compatExtractionEntry(provider("cloud"));
		expect(entry).toMatchObject({ metered: true, requiresLicence: true, measured: true });
		expect(entry.create({}, null)).toBeNull();
		expect(entry.create({ apiKey: "k" }, " my-model ")).toMatchObject({ id: "openrouter", metered: true });
		expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ model: "my-model", apiKey: "k", requireParameters: true }));
	});

	it("makes the user's own server a free, unmeasured, local one-call backend with the schema as a tool call, no classifier, and needs a URL", () => {
		const entry = compatExtractionEntry(provider("user", "custom"));
		expect(entry).toMatchObject({ metered: false, requiresLicence: false, measured: false });
		expect(entry.create({ baseURL: "" }, null)).toBeNull();
		const backend = entry.create({}, null)!;
		expect(backend).toMatchObject({ id: "custom", metered: false, local: true });
		expect(backend.classify).toBeUndefined();
		expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ model: "default-model", requireParameters: false, schemaAsTool: true }));
		compatExtractionEntry(provider("cloud")).create({ apiKey: "k" }, null);
		expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ schemaAsTool: false }));
	});
});

describe("compatExtractionEntry > which answer an own server is asked for", () => {
	it("takes a model as reasoning from the server's flag or from a model it learned, and keeps a learned one in the provider's settings", async () => {
		const settings: Record<string, unknown> = { reasoningModels: ["seen-before"] };
		const flagged = vi.fn(async (endpoint: { model: string }) => ({ reasons: endpoint.model === "flagged", missing: null }));
		const entry = compatExtractionEntry({ ...provider("local", "lmstudio"), probe: flagged });
		expect(await entry.modelNote!(settings, "seen-before")).toEqual({ kind: "reasons", model: "seen-before" });
		expect(await entry.modelNote!(settings, "flagged")).toEqual({ kind: "reasons", model: "flagged" });
		expect(await entry.modelNote!(settings, "plain")).toBeNull();
		expect(await compatExtractionEntry(provider("user", "custom")).modelNote!(settings, "plain")).toBeNull();

		// An answer that reasoned teaches the provider's settings; the next sync asks for the plain schema.
		const answer = JSON.stringify({ page_date_text: null, tasks: [], summary: "" });
		vi.mocked(openAiCompatComplete).mockReturnValueOnce(async () => ({ kind: "ok", text: answer, reasoned: true }));
		const slots = defaultSlots().filter((slot) => slot.id === "tasks" || slot.id === "summary");
		const input = { profile: genericProfile(false), slots, transcript: "x", referenceDate: new Date(0), known: {} };
		expect(await entry.create(settings, "plain")!.extract(input)).toMatchObject({ kind: "ok" });
		expect(settings.reasoningModels).toEqual(["seen-before", "plain"]);
		expect(await entry.modelNote!(settings, "plain")).toEqual({ kind: "reasons", model: "plain" });
		vi.mocked(openAiCompatComplete).mockReturnValueOnce(async () => ({ kind: "ok", text: answer, reasoned: true }));
		const fresh: Record<string, unknown> = { reasoningModels: "garbled" };
		await entry.create(fresh, "plain")!.extract(input);
		expect(fresh.reasoningModels).toEqual(["plain"]);
		// A provider that cannot be asked takes a model it never saw reason as one that does not.
		let asked: { schema: { properties: Record<string, unknown> } } | null = null;
		vi.mocked(openAiCompatComplete).mockReturnValueOnce(async (request) => ((asked = request as never), { kind: "ok", text: answer }));
		await compatExtractionEntry(provider("user", "custom")).create({}, "plain")!.extract(input);
		expect(Object.keys(asked!.schema.properties)[0]).toBe("lines");
	});
});

describe("compatExtractionEntry > the model probe", () => {
	it("asks the provider about the model that will extract, and names it only when the server says it reasons", async () => {
		const asked: unknown[] = [];
		const entry = compatExtractionEntry({ ...provider("local", "lmstudio"), probe: async (endpoint) => (asked.push(endpoint), { reasons: endpoint.model === "thinker", missing: null }) });
		expect(await entry.modelNote!({ baseURL: "http://h/v1" }, " thinker ")).toEqual({ kind: "reasons", model: "thinker" });
		expect(await entry.modelNote!({}, null)).toBeNull();
		expect(asked).toEqual([
			{ baseURL: "http://h/v1", model: "thinker", apiKey: null },
			{ baseURL: "https://x/v1", model: "default-model", apiKey: null },
		]);
		// A provider that cannot be asked has no probe at all: the settings say nothing.
		expect(compatExtractionEntry(provider("cloud")).modelNote).toBeUndefined();
	});

	it("says first that the server has no model of that name, with the one it has that fits, even for a model learned to reason", async () => {
		const entry = compatExtractionEntry({ ...provider("local", "lmstudio"), probe: async () => ({ reasons: false, missing: { suggestion: "qwen/qwen3-vl-8b" } }) });
		expect(await entry.modelNote!({ reasoningModels: ["qwen3-vl-8b"] }, "qwen3-vl-8b")).toEqual({ kind: "missing", model: "qwen3-vl-8b", suggestion: "qwen/qwen3-vl-8b" });
	});
});

describe("the registry", () => {
	it("keeps entries by id, in registration order", () => {
		registerExtractionBackend(compatExtractionEntry(provider("local", "ollama")));
		expect(extractionBackendEntry("ollama")?.label).toBe("ollama");
		expect(extractionBackendEntry("nope")).toBeNull();
		expect(extractionBackendEntries().map((entry) => entry.id)).toContain("ollama");
	});
});
