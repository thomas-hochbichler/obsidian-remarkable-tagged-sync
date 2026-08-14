import { describe, expect, it } from "vitest";
import { isListedBackend, isRegisteredOcrBackend, ocrBackendEntries, ocrBackendEntry, type OcrBackendEntry } from "./ocr-registry";
import "./vision-register";

describe("the free registry", () => {
	it("offers Apple Vision and Off, and nothing metered", () => {
		expect(ocrBackendEntries().map((entry) => entry.id)).toEqual(["vision", "off"]);
		expect(ocrBackendEntries().every((entry) => !entry.metered)).toBe(true);
	});

	it("reports Vision as unavailable off macOS, rather than offering a backend that cannot run", () => {
		expect(ocrBackendEntry("vision")?.unavailableLabel?.()).toBe("Apple Vision — macOS only");
	});

	// Where Vision cannot run, Vision is the only other entry and it is disabled. Without Off the
	// dropdown would have nothing selectable in it, which reads as a broken plugin.
	it("always leaves at least one selectable backend, even where Vision cannot run", () => {
		const selectable = ocrBackendEntries().filter((entry) => !entry.unavailableLabel?.());
		expect(selectable.map((entry) => entry.id)).toEqual(["off"]);
	});

	// Adding "Off" made the registry two entries long, so any "is there more than one backend?" test
	// silently became true. The strings that offer a network backend must key off what a backend IS,
	// not off how many are registered.
	it("has no backend that sends anything over a network", () => {
		const builtIn = new Set(["vision", "off"]);
		expect(ocrBackendEntries().filter((entry) => !builtIn.has(entry.id))).toEqual([]);
	});

	it("Off transcribes nothing without claiming to be unavailable", async () => {
		const result = await ocrBackendEntry("off")!.create({})!.recognize([{ formatVersion: 6, layers: [] }]);
		expect(result.status).toBe("skipped");
		expect(result.text).toBe("");
	});

	it("has no settings rows of its own", () => {
		expect(ocrBackendEntry("vision")?.renderSettings).toBeUndefined();
	});

	// The field a local model needs and the six LLM providers must not notice. Both free backends are
	// free in every sense: no money, and nothing worth interrupting a background sync over.
	it("asks for no background consent, on either backend", () => {
		expect(ocrBackendEntries().every((entry) => !entry.needsBackgroundConsent)).toBe(true);
	});
});

/**
 * Show-but-disable is for a gap the user cannot fix; hide is for a gap the entry's own setup card is
 * already explaining. The distinction matters because Obsidian persists a dropdown change
 * immediately: listing a backend that cannot run yet saves a setting that transcribes nothing.
 */
describe("isListedBackend", () => {
	function entry(overrides: Partial<OcrBackendEntry> = {}): OcrBackendEntry {
		return {
			id: "candidate",
			label: "Candidate",
			metered: false,
			requiresLicence: false,
			needsBackgroundConsent: false,
			create: () => null,
			...overrides,
		};
	}

	it("lists a backend that can run here", () => {
		expect(isListedBackend(entry(), "vision")).toBe(true);
	});

	it("lists an unavailable backend that has no card, so a permanent gap explains itself in place", () => {
		expect(isListedBackend(entry({ unavailableLabel: () => "Apple Vision — macOS only" }), "vision")).toBe(true);
	});

	it("hides an unavailable backend whose card is already explaining the gap", () => {
		const candidate = entry({ unavailableLabel: () => "not ready", renderSetup: () => {} });
		expect(isListedBackend(candidate, "vision")).toBe(false);
	});

	it("keeps a card-carrying backend listed while it is the selected one, so the dropdown is never empty", () => {
		const candidate = entry({ unavailableLabel: () => "not ready", renderSetup: () => {} });
		expect(isListedBackend(candidate, "candidate")).toBe(true);
	});

	it("lists a card-carrying backend that can run, since the card is not what hides it", () => {
		expect(isListedBackend(entry({ renderSetup: () => {} }), "vision")).toBe(true);
	});
});

// Load-time migration (multi-provider spec §7): anything that isn't a backend *this build has* is
// coerced to the platform default, so a retired literal and an absent backend behave the same way.
describe("isRegisteredOcrBackend", () => {
	it("accepts a registered backend", () => {
		expect(isRegisteredOcrBackend("vision")).toBe(true);
	});

	it("rejects retired literals", () => {
		expect(isRegisteredOcrBackend("llm-vision")).toBe(false);
		expect(isRegisteredOcrBackend("tesseract")).toBe(false);
	});

	it("rejects a backend this build does not include", () => {
		expect(isRegisteredOcrBackend("anthropic")).toBe(false);
	});

	it("rejects non-strings", () => {
		expect(isRegisteredOcrBackend(undefined)).toBe(false);
		expect(isRegisteredOcrBackend(42)).toBe(false);
	});
});
