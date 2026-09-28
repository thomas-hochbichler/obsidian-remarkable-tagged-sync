import { describe, expect, it } from "vitest";
import { classifyUnit, pageModified, switchOnStamp, type SeenEntry } from "./seen-set";

const ENABLED_AT = 1_759_000_000_000;
const seen = (pageHash: string | null): SeenEntry => ({ scope: "notebook", pageHash, firstSeen: null });

describe("pageModified", () => {
	it("reads the epoch-ms string the device stamps on an edited page", () => {
		expect(pageModified({ id: "p1", modifed: "1759000000123" })).toBe(1_759_000_000_123);
	});

	it("is null for a page never edited since the device started stamping it", () => {
		// 1 of 15 pages in both real fixtures carries no `modifed` at all.
		expect(pageModified({ id: "p1" })).toBeNull();
	});

	it("is null for a value that is not a number, rather than NaN", () => {
		// NaN compares false against everything, so a garbled stamp would read as "old" by accident
		// in one comparison and "new" in its negation. Null makes the absent case explicit.
		expect(pageModified({ id: "p1", modifed: "yesterday" })).toBeNull();
		expect(pageModified({ id: "p1", modifed: "" })).toBeNull();
		expect(pageModified(null)).toBeNull();
	});
});

describe("classifyUnit", () => {
	it("calls a seen page changed only when its hash differs", () => {
		expect(classifyUnit({ seen: seen("a"), pageHash: "b", modified: null, enabledAt: ENABLED_AT, legacy: false })).toBe("changed");
		expect(classifyUnit({ seen: seen("a"), pageHash: "a", modified: ENABLED_AT + 1, enabledAt: ENABLED_AT, legacy: false })).toBe("unchanged");
	});

	it("counts the first ink on a page that had no .rm when seen as a change", () => {
		expect(classifyUnit({ seen: seen(null), pageHash: "a", modified: null, enabledAt: ENABLED_AT, legacy: false })).toBe("changed");
	});

	it("calls an unseen page new only when it was edited after Intelligence Mode was switched on", () => {
		expect(classifyUnit({ seen: undefined, pageHash: "a", modified: ENABLED_AT + 1, enabledAt: ENABLED_AT, legacy: false })).toBe("new");
		expect(classifyUnit({ seen: undefined, pageHash: "a", modified: ENABLED_AT, enabledAt: ENABLED_AT, legacy: false })).toBe("old");
	});

	it("calls an unseen page without a modified stamp old, so a notebook from 2025 tagged today costs nothing", () => {
		expect(classifyUnit({ seen: undefined, pageHash: "a", modified: null, enabledAt: ENABLED_AT, legacy: false })).toBe("old");
	});

	it("calls every page of a legacy pages[] document old, whatever the clock says", () => {
		expect(classifyUnit({ seen: undefined, pageHash: "a", modified: ENABLED_AT + 1, enabledAt: ENABLED_AT, legacy: true })).toBe("old");
	});
});

describe("switchOnStamp", () => {
	it("stamps pages written before the toggle or never stamped, and leaves a page written after it to the two questions", () => {
		// The scan runs at the next sync, not at the click: a page written in between is the user's
		// first page under the new mode and must not be swallowed as "seen".
		expect(switchOnStamp(ENABLED_AT - 1, ENABLED_AT)).toBe(true);
		expect(switchOnStamp(ENABLED_AT, ENABLED_AT)).toBe(true);
		expect(switchOnStamp(null, ENABLED_AT)).toBe(true);
		expect(switchOnStamp(ENABLED_AT + 1, ENABLED_AT)).toBe(false);
	});
});
