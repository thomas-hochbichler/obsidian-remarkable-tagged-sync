import { describe, expect, it } from "vitest";
import type { RmText } from "./rm-parser";
import { layoutText } from "./text-layout";

/** A text box at the device's usual position, with `runs` spelled out. */
function text(runs: RmText["runs"], overrides: Partial<RmText> = {}): RmText {
	return { posX: -468, posY: 234, width: 936, runs, styles: new Map(), ...overrides };
}

const FIRST_LINE_Y = 234 + 62;
const PARAGRAPH_ADVANCE = 69.5;
const WRAPPED_LINE_ADVANCE = 45.5;

describe("layoutText", () => {
	it("advances a paragraph gap between single-line paragraphs, reproducing the verified model", () => {
		const layout = layoutText(text([{ id: "1:10", text: "one\ntwo\nthree", deleted: 0 }]));

		expect(layout.lines.map((line) => line.yPx)).toEqual([
			FIRST_LINE_Y,
			FIRST_LINE_Y + PARAGRAPH_ADVANCE,
			FIRST_LINE_Y + 2 * PARAGRAPH_ADVANCE,
		]);
	});

	it("puts a paragraph's newline on that paragraph's own line, which is what anchors name", () => {
		// "one\ntwo": the newline is character 3, and it belongs to the line "one" -- not to "two".
		const layout = layoutText(text([{ id: "1:10", text: "one\ntwo", deleted: 0 }]));

		expect(layout.yOfChar.get("1:13")).toBe(FIRST_LINE_Y); // the newline
		expect(layout.yOfChar.get("1:14")).toBe(FIRST_LINE_Y + PARAGRAPH_ADVANCE); // "t" of "two"
	});

	it("advances a wrapped line by the leading, not by the paragraph gap", () => {
		// A measure that fits two words per line, so the paragraph breaks twice.
		const measure = (value: string) => value.split(" ").length * 400;

		const layout = layoutText(text([{ id: "1:10", text: "aa bb cc dd", deleted: 0 }]), measure);

		expect(layout.lines.map((line) => line.text)).toEqual(["aa bb", "cc dd"]);
		expect(layout.lines.map((line) => line.yPx)).toEqual([FIRST_LINE_Y, FIRST_LINE_Y + WRAPPED_LINE_ADVANCE]);
	});

	it("never breaks a line without a measure, because guessing the font moves every line below", () => {
		const layout = layoutText(text([{ id: "1:10", text: "a very long paragraph that would wrap".repeat(10), deleted: 0 }]));

		expect(layout.lines).toHaveLength(1);
	});

	it("gives a tombstoned run no line, so deleted text does not push the rest down", () => {
		const layout = layoutText(
			text([
				{ id: "1:10", text: "", deleted: 40 },
				{ id: "1:50", text: "kept", deleted: 0 },
			]),
		);

		expect(layout.lines).toEqual([{ text: "kept", xPx: -468, yPx: FIRST_LINE_Y, style: 1 }]);
	});

	it("indents a list item, and wraps it against the narrower width that leaves", () => {
		// 65px per character puts the whole paragraph at 910px: under the box's 936, but over the
		// 888 an indented list item has left. So the indent alone decides the break.
		const measure = (value: string) => value.length * 65;
		const runs = [{ id: "1:10", text: "aaaa bbbb cccc", deleted: 0 }];

		const listed = layoutText(text(runs, { styles: new Map([["1:10", 4]]) }), measure);
		const plain = layoutText(text(runs), measure);

		expect(listed.lines[0].xPx).toBe(-468 + 48);
		expect(listed.lines.map((line) => line.text)).toEqual(["aaaa bbbb", "cccc"]);
		expect(plain.lines.map((line) => line.text)).toEqual(["aaaa bbbb cccc"]);
	});

	it("carries a style forward until another entry changes it", () => {
		const styled = text([{ id: "1:10", text: "plain\nheading\nstill heading", deleted: 0 }], {
			styles: new Map([["1:16", 3]]),
		});

		const layout = layoutText(styled);

		expect(layout.lines.map((line) => line.style)).toEqual([1, 3, 3]);
	});
});
