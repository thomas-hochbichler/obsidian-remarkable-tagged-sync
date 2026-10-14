import { describe, expect, it } from "vitest";
import { BULLET_JOURNAL, readSigns, signRules, transcriptSigns } from "./signs";

describe("readSigns", () => {
	it("carries every row with a sign as stored, and nothing else", () => {
		// A meaning a newer build added survives this one's next save of the shared `data.json`.
		const stored = [{ glyph: "•", meaning: "task-open" }, { glyph: "!", meaning: "urgent-later" }, { meaning: "note" }, "•", null];
		expect(readSigns(stored)).toEqual([{ glyph: "•", meaning: "task-open" }, { glyph: "!", meaning: "urgent-later" }]);
		expect(readSigns(undefined)).toEqual([]);
		expect(readSigns({ glyph: "•" })).toEqual([]);
	});
});

describe("transcriptSigns", () => {
	it("names a sign by its character, and by its look where the user gave one", () => {
		expect(transcriptSigns([{ glyph: "", meaning: "event" }, { glyph: " • ", meaning: "task-open" }, { glyph: "△", drawn: " a small triangle ", meaning: "note" }])).toEqual({ list: "•, △ for a small triangle", first: "•" });
		expect(transcriptSigns([{ glyph: " ", meaning: "note" }])).toBeNull();
	});
});

describe("signRules", () => {
	it("says what each Bullet Journal sign means, and that a leading - is only the list format", () => {
		expect(signRules(BULLET_JOURNAL)).toEqual([
			"The sign • (a dot) before a line marks an open task.",
			"The sign X (a cross over the dot) before a line marks a task that is done: set done to true.",
			"The sign > (an arrow to the right) before a line marks a task that is not open here: leave it out.",
			"The sign < (an arrow to the left) before a line marks a task that is not open here: leave it out.",
			"The sign ○ (a small circle) before a line marks an event: not a task.",
			"The sign — (a dash) before a line marks a note: not a task.",
			"A - at the start of a line is the list format, not a sign.",
		]);
	});

	it("gives a sign of the user's own in their words, and says nothing it cannot", () => {
		expect(
			signRules([
				{ glyph: "△", drawn: "a small triangle", meaning: "custom", text: " an idea " },
				// No words yet, no sign yet, a meaning from a newer build: nothing to tell the model.
				{ glyph: "★", meaning: "custom" },
				{ glyph: "", meaning: "task-open" },
				{ glyph: "!", meaning: "urgent-later" as never },
			]),
		).toEqual(["The sign △ (a small triangle) before a line means: an idea", "A - at the start of a line is the list format, not a sign."]);
	});

	it("does not call a dash the list format where the dash is a sign", () => {
		expect(signRules([{ glyph: "-", meaning: "note" }])).toEqual(["The sign - before a line marks a note: not a task."]);
	});

	it("says nothing without signs", () => {
		expect(signRules([])).toEqual([]);
	});
});
