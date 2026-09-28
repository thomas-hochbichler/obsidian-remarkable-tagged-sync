import { describe, expect, it } from "vitest";
import {
	defaultSlots,
	markSaid,
	markSlotsUsed,
	slotIdFor,
	EMPTY_INTELLIGENCE_FINGERPRINT,
	emptyIntelligence,
	genericProfile,
	intelligenceFingerprint,
	modesFor,
	readIntelligence,
	setIntelligenceMode,
} from "./settings";

const NOW = new Date("2026-09-28T10:00:00.000Z");
const LATER = new Date("2026-10-01T08:00:00.000Z");

describe("readIntelligence", () => {
	it("gives a complete block with the default Slots for anything that is not a stored block", () => {
		for (const junk of [undefined, null, "x", 3, []]) expect(readIntelligence(junk, NOW)).toEqual(emptyIntelligence());
		expect(emptyIntelligence().slots.map((s) => s.id)).toEqual(["tasks", "decisions", "summary", "tags"]);
	});

	it("is idempotent", () => {
		const once = readIntelligence({ mappings: { work: { intelligence: true } }, slots: defaultSlots().slice(0, 1) }, NOW);
		expect(readIntelligence(JSON.parse(JSON.stringify(once)), LATER)).toEqual(once);
	});

	it("does not bring back a default Slot the user deleted", () => {
		expect(readIntelligence({ slots: [] }, NOW).slots).toEqual([]);
	});

	it("fills each mapping field on its own and drops junk inside it", () => {
		expect(readIntelligence({ mappings: { work: { transcript: false, profiles: ["p1", 3] }, home: "junk" } }, NOW).mappings).toEqual({
			work: { transcript: false, intelligence: false, profiles: ["p1"] },
			home: { transcript: true, intelligence: false, profiles: [] },
		});
	});

	it("stamps a mapping that is on but was never stamped with the load time, in memory", () => {
		expect(readIntelligence({ mappings: { work: { intelligence: true } } }, NOW).mappings.work).toMatchObject({ enabledAt: NOW.toISOString(), firstEnabledAt: NOW.toISOString() });
		expect(readIntelligence({ mappings: { work: { intelligence: true, enabledAt: "2026-09-01T00:00:00.000Z" } } }, NOW).mappings.work).toMatchObject({
			enabledAt: "2026-09-01T00:00:00.000Z",
			firstEnabledAt: "2026-09-01T00:00:00.000Z",
		});
	});

	it("carries Profiles and Slots whole, unknown fields included, and reads the backend", () => {
		const block = readIntelligence({ profiles: [{ id: "p", future: 1 }, "junk"], slots: [{ id: "s", future: 2 }], backend: "openrouter", model: "m", engineDeviceId: "d" }, NOW);
		expect(block.profiles).toEqual([{ id: "p", future: 1 }]);
		expect(block.slots).toEqual([{ id: "s", future: 2 }]);
		expect([block.backend, block.model, block.engineDeviceId]).toEqual(["openrouter", "m", "d"]);
	});
});

describe("modesFor", () => {
	const settings = setIntelligenceMode(emptyIntelligence(), "work", true, NOW);

	it("gives a mapped tag its modes and an unmentioned one the defaults", () => {
		expect(modesFor(settings, { work: "Work", home: "Home" }, "work").intelligence).toBe(true);
		expect(modesFor(settings, { work: "Work", home: "Home" }, "home")).toEqual({ transcript: true, intelligence: false, profiles: [] });
	});

	it("ignores the modes of a tag whose mapping was removed", () => {
		expect(modesFor(settings, {}, "work").intelligence).toBe(false);
	});
});

describe("setIntelligenceMode", () => {
	it("stamps enabledAt on every switch-on and firstEnabledAt only once", () => {
		const on = setIntelligenceMode(emptyIntelligence(), "work", true, NOW);
		const off = setIntelligenceMode(on, "work", false, LATER);
		expect(off.mappings.work).toEqual({ transcript: true, intelligence: false, profiles: [], enabledAt: NOW.toISOString(), firstEnabledAt: NOW.toISOString() });
		const again = setIntelligenceMode(off, "work", true, LATER);
		expect(again.mappings.work).toMatchObject({ intelligence: true, enabledAt: LATER.toISOString(), firstEnabledAt: NOW.toISOString() });
	});
});

describe("intelligenceFingerprint", () => {
	it("ignores key order and entries equal to the defaults, so an upgrade and a no-op write cost no scan", () => {
		expect(intelligenceFingerprint({ a: { transcript: true, intelligence: false, profiles: [] } })).toBe(EMPTY_INTELLIGENCE_FINGERPRINT);
		const x = { transcript: false, intelligence: false, profiles: [] };
		const y = { transcript: true, intelligence: true, profiles: [], enabledAt: "t" };
		expect(intelligenceFingerprint({ a: x, b: y })).toBe(intelligenceFingerprint({ b: y, a: x }));
	});

	it("changes on a toggle, a re-stamp or a Profile list change", () => {
		const on = setIntelligenceMode(emptyIntelligence(), "work", true, NOW).mappings;
		const restamped = setIntelligenceMode({ ...emptyIntelligence(), mappings: on }, "work", true, LATER).mappings;
		expect(intelligenceFingerprint(on)).not.toBe(EMPTY_INTELLIGENCE_FINGERPRINT);
		expect(intelligenceFingerprint(restamped)).not.toBe(intelligenceFingerprint(on));
		expect(intelligenceFingerprint({ work: { ...on.work, profiles: ["p"] } })).not.toBe(intelligenceFingerprint(on));
	});
});

describe("genericProfile", () => {
	it("runs Tasks and Summary, plus Tags with Pro", () => {
		expect(genericProfile(false).slots).toEqual(["tasks", "summary"]);
		expect(genericProfile(true).slots).toEqual(["tasks", "summary", "tags"]);
	});
});

describe("markSlotsUsed", () => {
	it("marks the Slots a sync wrote, and hands back the same settings when nothing changes", () => {
		const settings = emptyIntelligence();
		const marked = markSlotsUsed(settings, ["tasks"]);
		expect(marked.slots.find((slot) => slot.id === "tasks")!.used).toBe(true);
		expect(marked.slots.find((slot) => slot.id === "summary")!.used).toBeUndefined();
		expect(markSlotsUsed(marked, ["tasks"])).toBe(marked);
		expect(markSlotsUsed(settings, [])).toBe(settings);
	});
});

describe("slotIdFor", () => {
	it("makes a readable id from the name, unique among the Slots", () => {
		expect(slotIdFor("Ausgaben & Kosten", [])).toBe("ausgaben-kosten");
		expect(slotIdFor("Tasks", ["tasks", "tasks-2"])).toBe("tasks-3");
		expect(slotIdFor("!!!", [])).toBe("slot");
	});
});

describe("markSaid", () => {
	it("records a notice as said once, and hands back the same settings when it already was", () => {
		const said = markSaid(emptyIntelligence(), ["local-classifier", "local-classifier"]);
		expect(said.saidOnce).toEqual(["local-classifier"]);
		expect(markSaid(said, ["local-classifier"])).toBe(said);
	});
});
