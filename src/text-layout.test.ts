import { describe, expect, it } from "vitest";
import type { RmText } from "./rm-parser";
import { layoutText } from "./text-layout";

/** A text box at the device's usual position, with `runs` spelled out. */
function text(runs: RmText["runs"], overrides: Partial<RmText> = {}): RmText {
	return { posX: -468, posY: 234, width: 936, runs, styles: new Map(), ...overrides };
}

// A page whose first paragraph is plain starts at 33.8 below the box's top; the 62 every earlier
// measurement found is that plus the 28.2 a code-2 first paragraph opens above itself.
const FIRST_LINE_Y = 234 + 33.8;
const STYLE_2_FIRST_LINE_Y = 234 + 62;
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

	it("opens the space a code-2 first paragraph asks for, which is what 62 always was", () => {
		// Every page the 62 was ever fitted against opens with a code-2 paragraph. Measured against the
		// device's exports, a page that opens plain starts 28.2px higher -- and both ends of a
		// sentinel-anchored page follow, so this is a placement change, not only a drawing one.
		const runs = [{ id: "1:10", text: "opening", deleted: 0 }];

		const plain = layoutText(text(runs));
		const code2 = layoutText(text(runs, { styles: new Map([["0:0", 2]]) }));

		expect(plain.lines[0].yPx).toBeCloseTo(FIRST_LINE_Y, 1);
		expect(code2.lines[0].yPx).toBeCloseTo(STYLE_2_FIRST_LINE_Y, 1);
		expect(plain.topY).toBeCloseTo(FIRST_LINE_Y, 1);
		expect(code2.topY).toBeCloseTo(STYLE_2_FIRST_LINE_Y, 1);
	});

	it("anchors a page whose runs are all tombstoned where its first line would have been", () => {
		// `Daily-41a34af6` and `Schnellnotiz-de294e7a` are this case, and both are sentinel-anchored: with
		// nothing laid out there is no first line to read the top off, and their ink still has to land.
		const empty = layoutText(text([{ id: "1:10", text: "", deleted: 40 }], { styles: new Map([["0:0", 2]]) }));

		expect(empty.topY).toBeCloseTo(STYLE_2_FIRST_LINE_Y, 1);
	});

	it("breaks a long token after a slash, which is the only way the device's URL page can break", () => {
		// The device's own export breaks this 108-character token after `.../1vaoces/` and nowhere else.
		// There is no space in it, so a space-only rule would leave it one unbreakable word.
		const url =
			"https://www.reddit.com/r/RemarkableTablet/comments/1vaoces/free_plugin_remarkable_obsidian_sync_by_tag_with/";

		const layout = layoutText(text([{ id: "1:10", text: url, deleted: 0 }], { posX: -576, width: 1152 }));

		expect(layout.lines.map((line) => line.text)).toEqual([
			"https://www.reddit.com/r/RemarkableTablet/comments/1vaoces/",
			"free_plugin_remarkable_obsidian_sync_by_tag_with/",
		]);
	});

	it("gives a tombstoned run no line, so deleted text does not push the rest down", () => {
		const layout = layoutText(
			text([
				{ id: "1:10", text: "", deleted: 40 },
				{ id: "1:50", text: "kept", deleted: 0 },
			]),
		);

		expect(layout.lines).toEqual([{ text: "kept", xPx: -468, yPx: FIRST_LINE_Y, style: 1, firstLine: true }]);
	});

	it("indents a list item, and wraps it against the narrower width that leaves", () => {
		// 65px per character puts the whole paragraph at 910px: under the box's 936, but over the
		// 888 an indented list item has left. So the indent alone decides the break.
		const measure = (value: string) => value.length * 65;
		const runs = [{ id: "1:10", text: "aaaa bbbb cccc", deleted: 0 }];

		const listed = layoutText(text(runs, { styles: new Map([["0:0", 4]]) }), measure);
		const plain = layoutText(text(runs), measure);

		expect(listed.lines[0].xPx).toBe(-468 + 48);
		expect(listed.lines.map((line) => line.text)).toEqual(["aaaa bbbb", "cccc"]);
		expect(plain.lines.map((line) => line.text)).toEqual(["aaaa bbbb cccc"]);
	});

	it("keys a style by the newline above the paragraph it styles, not by that paragraph's own first character", () => {
		// "plain\nheading\nplain again": the heading starts at 1:16, and the device keys its entry to
		// 1:15 -- the newline that ended the paragraph above. The first paragraph uses the "0:0" sentinel.
		const styled = text([{ id: "1:10", text: "plain\nheading\nplain again", deleted: 0 }], {
			styles: new Map([["1:15", 3]]),
		});

		expect(layoutText(styled).lines.map((line) => line.style)).toEqual([1, 3, 1]);
	});

	it("does not carry a style forward, because the device gives every styled paragraph its own entry", () => {
		// Under a running rule the third paragraph would inherit the heading. The device's export says
		// otherwise twice over: a plain paragraph follows its heading, and no list item after the first
		// goes without an entry of its own.
		const styled = text([{ id: "1:10", text: "a\nb\nc", deleted: 0 }], { styles: new Map([["1:11", 3]]) });

		expect(layoutText(styled).lines.map((line) => line.style)).toEqual([1, 3, 1]);
	});

	it("opens the space a heading needs above it, and puts the paragraph after it back on the plain rhythm", () => {
		const styled = text([{ id: "1:10", text: "plain\nheading\nplain again", deleted: 0 }], {
			styles: new Map([["1:15", 3]]),
		});

		const [first, heading, after] = layoutText(styled).lines;

		// Measured baseline-to-baseline on the device's export: 116.5px into a heading, 66.2px out of it.
		expect(heading.yPx - first.yPx).toBeCloseTo(116.5, 1);
		expect(after.yPx - heading.yPx).toBeCloseTo(69.5, 1);
	});

	describe("a character the device draws nothing for", () => {
		// U+2028 opens the paragraphs the "Read on reMarkable" extension lifts out of a web page. These
		// use the device's real widths rather than an injected measure, because the whole question is
		// what the device charges for that character -- and the answer is nothing.
		const SEPARATOR = "\u2028";
		// 1151.0px against the box's 1152: it fits, and it fits by less than the 18.7px the separator
		// would cost if it were charged the fallback width of a character with no advance of its own.
		const FULL_LINE = "the quick brown fox jumps over the lazy dog and then the same dog runs back a";
		const wide = (runs: RmText["runs"]) => text(runs, { posX: -576, width: 1152 });

		it("costs the line no width, so the line breaks where the device broke it", () => {
			const layout = layoutText(wide([{ id: "1:10", text: `${SEPARATOR}${FULL_LINE} bit`, deleted: 0 }]));

			expect(layout.lines.map((line) => line.text)).toEqual([FULL_LINE, "bit"]);
		});

		it("is not drawn, and still counts as one of the paragraph's characters", () => {
			const layout = layoutText(wide([{ id: "1:10", text: `${SEPARATOR}word`, deleted: 0 }]));

			expect(layout.lines[0].text).toBe("word");
			// The separator is 1:10, so `w` is 1:11 -- the ids are the device's and do not close up.
			expect(layout.yOfChar.get("1:11")).toBe(FIRST_LINE_Y);
		});
	});
});
