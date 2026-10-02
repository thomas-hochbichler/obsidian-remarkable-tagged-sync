import { describe, expect, it, vi } from "vitest";
import { compatExtractionEntry, extractionBackendEntries, extractionBackendEntry, registerExtractionBackend } from "./extraction-registry";

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

	it("makes the user's own server a free, unmeasured two-call backend, and needs a URL", () => {
		const entry = compatExtractionEntry(provider("user", "custom"));
		expect(entry).toMatchObject({ metered: false, requiresLicence: false, measured: false });
		expect(entry.create({ baseURL: "" }, null)).toBeNull();
		expect(entry.create({}, null)).toMatchObject({ id: "custom", metered: false });
		expect(complete).toHaveBeenLastCalledWith(expect.objectContaining({ model: "default-model", requireParameters: false }));
	});
});

describe("compatExtractionEntry > the reasoning probe", () => {
	it("asks the provider about the model that will extract, and names it only when the server says it reasons", async () => {
		const asked: unknown[] = [];
		const entry = compatExtractionEntry({ ...provider("local", "lmstudio"), reasons: async (endpoint) => (asked.push(endpoint), endpoint.model === "thinker") });
		expect(await entry.reasoningModel!({ baseURL: "http://h/v1" }, " thinker ")).toBe("thinker");
		expect(await entry.reasoningModel!({}, null)).toBeNull();
		expect(asked).toEqual([
			{ baseURL: "http://h/v1", model: "thinker", apiKey: null },
			{ baseURL: "https://x/v1", model: "default-model", apiKey: null },
		]);
		// A provider that cannot be asked has no probe at all: the settings say nothing.
		expect(compatExtractionEntry(provider("cloud")).reasoningModel).toBeUndefined();
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
