import { describe, expect, it } from "vitest";
import { FakeEl, takeSettings, type Setting as FakeSetting } from "../test-stubs/fake-obsidian";
import { BULLET_JOURNAL, type SignDef } from "./signs";
import { renderSignsSettings, type SignsHost } from "./signs-section";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function host(signs: SignDef[], options: { dropsSigns?: string; changed?: boolean } = {}) {
	const log: string[] = [];
	const h: SignsHost & { log: string[] } = {
		log,
		signs,
		save: async (redraw) => void log.push(redraw ? "redraw" : "save"),
		changed: options.changed ?? false,
		dropsSigns: options.dropsSigns ?? null,
		reTranscribeAll: () => void log.push("re-transcribe"),
	};
	return h;
}

function draw(h: SignsHost): FakeSetting[] {
	takeSettings();
	renderSignsSettings(new FakeEl() as unknown as HTMLElement, h);
	return takeSettings();
}

const head = (rows: FakeSetting[]) => rows.find((row) => row.name === "Signs")!;
/** The rows between the head and the "from now on" line: one a sign. */
const signRows = (rows: FakeSetting[]) => rows.slice(1, -1);
const after = (rows: FakeSetting[]) => rows[rows.length - 1];

describe("renderSignsSettings", () => {
	it("fills in the Bullet Journal, and only the look a sign already there lacks", async () => {
		const h = host([
			{ glyph: "•", meaning: "note" },
			{ glyph: "X", drawn: "a big cross", meaning: "task-done" },
		]);
		head(draw(h)).buttons[0].click();
		await flush();

		expect(h.signs).toEqual([{ glyph: "•", drawn: "a dot", meaning: "note" }, { glyph: "X", drawn: "a big cross", meaning: "task-done" }, ...BULLET_JOURNAL.slice(2)]);
		expect(h.log).toEqual(["redraw"]);
	});

	it("adds a sign from the palette, or an empty one to type", async () => {
		const h = host([]);
		head(draw(h)).dropdowns[0].pick("★");
		await flush();
		head(draw(h)).dropdowns[0].pick("other");
		await flush();
		// The prompt option itself adds nothing.
		head(draw(h)).dropdowns[0].pick("");
		await flush();

		expect(h.signs).toEqual([
			{ glyph: "★", meaning: "note" },
			{ glyph: "", meaning: "note" },
		]);
	});

	it("edits a sign in its row, and asks for words only for a meaning of the user's own", async () => {
		const h = host([{ glyph: "•", meaning: "note" }]);
		let row = signRows(draw(h))[0];
		expect(row.texts).toHaveLength(2);
		row.texts[0].type(" ★ ");
		row.texts[1].type("a star");
		row.dropdowns[0].pick("custom");
		await flush();

		row = signRows(draw(h))[0];
		expect(row.texts).toHaveLength(3);
		row.texts[2].type("important");
		await flush();
		expect(h.signs).toEqual([{ glyph: "★", drawn: "a star", meaning: "custom", text: "important" }]);
		// A typed character keeps the field's focus; a new meaning redraws the row.
		expect(h.log).toEqual(["save", "save", "redraw", "save"]);
		// An emptied field is no look and no words, not an empty string the prompts would quote.
		row = signRows(draw(h))[0];
		row.texts[1].type(" ");
		row.texts[2].type("");
		await flush();
		expect(h.signs).toEqual([{ glyph: "★", meaning: "custom" }]);

		signRows(draw(h))[0].buttons[0].click();
		await flush();
		expect(h.signs).toEqual([]);
	});

	// Ticket 43: Vision is the macOS default, so a table it cannot carry is the common case.
	it("says when the transcription backend keeps no signs, once there are signs to lose", () => {
		const warning = (h: SignsHost) => head(draw(h)).descEl.allText().join(" ");
		expect(warning(host(BULLET_JOURNAL.slice(), { dropsSigns: "Apple Vision" }))).toBe("Apple Vision keeps no signs. Your signs reach insight notes only with a language model that does.");
		expect(warning(host([], { dropsSigns: "Apple Vision" }))).toBe("");
		expect(warning(host(BULLET_JOURNAL.slice()))).toBe("");
	});

	it("offers to re-transcribe after a change, since only pages read from now on get the new signs", async () => {
		const h = host([{ glyph: "•", meaning: "note" }]);
		const rows = draw(h);
		expect(after(rows).settingEl.visible).toBe(false);
		signRows(rows)[0].texts[0].type("★");
		await flush();
		expect(after(rows).settingEl.visible).toBe(true);
		expect(after(draw(host([], { changed: true }))).settingEl.visible).toBe(true);

		after(rows).buttons[0].click();
		expect(h.log).toContain("re-transcribe");
	});
});
