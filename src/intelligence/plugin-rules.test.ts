import { describe, expect, it } from "vitest";
import type { ExtractionBackendEntry } from "./extraction-registry";
import { backgroundExtractionAllowed, chooseExtractionBackend, effectiveModes, effectiveSlotsFor, freeSlots, freeTag, isEngineDevice, scansDue } from "./plugin-rules";
import { defaultSlots, emptyIntelligence, genericProfile, setIntelligenceMode, TASKS_FORMAT, type IntelligenceSettings } from "./settings";

const MAP = { work: "Work", home: "Home", misc: "Misc" };
const T1 = new Date("2026-09-01T00:00:00.000Z");
const T2 = new Date("2026-09-02T00:00:00.000Z");

function onFor(...pairs: [string, Date][]): IntelligenceSettings {
	return pairs.reduce((settings, [tag, at]) => setIntelligenceMode(settings, tag, true, at), emptyIntelligence());
}

describe("freeTag", () => {
	it("is the mapping switched on first, ties broken by name, and none when nothing is on", () => {
		expect(freeTag(onFor(["home", T2], ["work", T1]), MAP)).toBe("work");
		expect(freeTag(onFor(["work", T1], ["home", T1]), MAP)).toBe("home");
		expect(freeTag(emptyIntelligence(), MAP)).toBeNull();
	});

	it("keeps the first tag even after it was switched off and on again", () => {
		const settings = setIntelligenceMode(setIntelligenceMode(onFor(["work", T1], ["home", T2]), "work", false, T2), "work", true, new Date("2026-09-09T00:00:00.000Z"));
		expect(freeTag(settings, MAP)).toBe("work");
	});

	it("skips a tag whose Intelligence Mode is off now", () => {
		expect(freeTag(setIntelligenceMode(onFor(["work", T1], ["home", T2]), "work", false, T2), MAP)).toBe("home");
	});
});

describe("effectiveModes", () => {
	const settings = onFor(["work", T1], ["home", T2]);

	it("keeps Intelligence Mode on every tag with Pro", () => {
		const modes = effectiveModes(settings, MAP, true);
		expect([modes("work"), modes("home"), modes("misc")]).toEqual([
			{ transcript: true, intelligence: true },
			{ transcript: true, intelligence: true },
			{ transcript: true, intelligence: false },
		]);
	});

	it("keeps it only on the free tag without Pro, transcript modes untouched", () => {
		const modes = effectiveModes({ ...settings, mappings: { ...settings.mappings, home: { ...settings.mappings.home, transcript: false } } }, MAP, false);
		expect([modes("work"), modes("home")]).toEqual([
			{ transcript: true, intelligence: true },
			{ transcript: false, intelligence: false },
		]);
	});
});

describe("freeSlots", () => {
	it("runs Tasks and Summary only, Tasks in the Tasks format with review locked on", () => {
		const custom = defaultSlots().map((slot) => (slot.id === "tasks" ? { ...slot, itemFormat: "- {{text}}", review: false, instruction: "mine" } : slot));
		const free = freeSlots(custom);
		expect(free.map((slot) => slot.id)).toEqual(["tasks", "summary"]);
		expect(free[0]).toMatchObject({ itemFormat: TASKS_FORMAT, review: true, instruction: "mine" });
		expect(effectiveSlotsFor(false)(genericProfile(false), custom)).toEqual(free);
		expect(effectiveSlotsFor(true)(genericProfile(true), custom)).toEqual(custom);
	});
});

describe("isEngineDevice", () => {
	it("is true only on the device the synced setting names", () => {
		const settings = { ...emptyIntelligence(), engineDeviceId: "mac" };
		expect([isEngineDevice(settings, "mac"), isEngineDevice(settings, "ipad"), isEngineDevice(settings, null), isEngineDevice(emptyIntelligence(), null)]).toEqual([true, false, false, false]);
	});
});

describe("scansDue", () => {
	it("names the effective Intelligence tags whose current enabledAt has not been scanned", () => {
		const settings = onFor(["work", T1], ["home", T2]);
		expect(scansDue(settings, MAP, true, {})).toEqual(["work", "home"]);
		expect(scansDue(settings, MAP, true, { work: T1.toISOString(), home: "old" })).toEqual(["home"]);
		expect(scansDue(settings, MAP, false, {})).toEqual(["work"]);
	});
});

describe("chooseExtractionBackend", () => {
	const entry = (id: string, requiresLicence: boolean): ExtractionBackendEntry => ({ id, label: id, metered: requiresLicence, requiresLicence, measured: false, create: () => null });
	const registry = (...entries: ExtractionBackendEntry[]) => (id: string) => entries.find((e) => e.id === id) ?? null;

	it("takes the configured backend, else the transcription backend when it can extract", () => {
		const lookup = registry(entry("openrouter", true), entry("ollama", false));
		expect(chooseExtractionBackend({ settings: { ...emptyIntelligence(), backend: "ollama" }, transcriptionBackend: "openrouter", pro: true, lookup })).toMatchObject({ kind: "ready", entry: { id: "ollama" } });
		expect(chooseExtractionBackend({ settings: emptyIntelligence(), transcriptionBackend: "openrouter", pro: true, lookup })).toMatchObject({ kind: "ready", entry: { id: "openrouter" } });
	});

	it("falls back from a Pro backend to the local model without Pro, and pauses when there is none", () => {
		const settings = { ...emptyIntelligence(), backend: "openrouter" };
		expect(chooseExtractionBackend({ settings, transcriptionBackend: "vision", pro: false, lookup: registry(entry("openrouter", true), entry("local", false)) })).toMatchObject({ kind: "ready", entry: { id: "local" } });
		expect(chooseExtractionBackend({ settings, transcriptionBackend: "vision", pro: false, lookup: registry(entry("openrouter", true)) })).toEqual({ kind: "paused", reason: expect.stringContaining("part of Tagged Sync Pro") });
	});

	it("pauses when nothing is set and the transcription backend cannot extract", () => {
		expect(chooseExtractionBackend({ settings: emptyIntelligence(), transcriptionBackend: "vision", pro: true, lookup: registry() })).toEqual({ kind: "paused", reason: expect.stringContaining("No extraction backend is set") });
	});
});

describe("backgroundExtractionAllowed", () => {
	it("asks a paid backend for consent to spend and the local model for consent to run, and lets the user's own server run", () => {
		const none = emptyIntelligence();
		const both = { ...none, autoExtractMetered: true, autoExtractLocal: true };
		expect([backgroundExtractionAllowed({ id: "openrouter", metered: true }, none), backgroundExtractionAllowed({ id: "openrouter", metered: true }, both)]).toEqual([false, true]);
		expect([backgroundExtractionAllowed({ id: "local", metered: false }, none), backgroundExtractionAllowed({ id: "local", metered: false }, both)]).toEqual([false, true]);
		expect(backgroundExtractionAllowed({ id: "ollama", metered: false }, none)).toBe(true);
	});
});
