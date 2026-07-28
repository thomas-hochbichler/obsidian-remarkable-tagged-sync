import { describe, expect, it } from "vitest";
import { isRegisteredOcrBackend, ocrBackendEntries, ocrBackendEntry } from "./ocr-registry";
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
