import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placeWords } from "./layer-alignment";
import type { LayerLine } from "./text-layer";
import type { VisionBox } from "./vision-ocr-backend";

/** A line Vision read at height `y`, each word boxed 0.1 wide with a 0.05 gap, left to right. */
function line(y: number, ...texts: string[]): LayerLine {
	return {
		box: { x: 0, y, w: texts.length * 0.15 - 0.05, h: 0.05 },
		words: texts.map((text, i) => ({ text, box: { x: i * 0.15, y, w: 0.1, h: 0.05 } })),
	};
}

/** Each placed word with its box's left edge and width, rounded so a split reads as plain numbers. */
function placed(lines: LayerLine[]): [string, number, number][][] {
	const round = (value: number) => Math.round(value * 1000) / 1000;
	return lines.map((placedLine) => placedLine.words.map(({ text, box }) => [text, round(box!.x), round(box!.w)]));
}

describe("placeWords", () => {
	it("puts the transcript's words on the boxes of the words Vision read", () => {
		expect(placed(placeWords("Rapoldeck Hütte", [line(0.5, "Rapoldeck", "Hütte")]))).toEqual([
			[
				["Rapoldeck", 0, 0.1],
				["Hütte", 0.15, 0.1],
			],
		]);
	});

	// "abcd" and "abxy" are exactly half alike; "efgh" and "efgx" three quarters.
	it("places a word only on a read more than half like it", () => {
		expect(placed(placeWords("abcd efgh", [line(0.5, "abxy", "efgx")]))).toEqual([[["efgh", 0.15, 0.1]]]);
	});

	it("tells words apart by neither case nor accents, so a misread in the right place still takes its box", () => {
		expect(placed(placeWords("FRÜHJAHR", [line(0.5, "frühjohr")]))).toEqual([[["FRÜHJAHR", 0, 0.1]]]);
	});

	// 11 characters, the space between them included, share the read's 0.1: 5 and 5 of them.
	it("spreads the words between two placed neighbours on one line over the reads between them", () => {
		expect(placed(placeWords("Wir gehen heute morgen", [line(0.5, "Wir", "qqqqq", "morgen")]))).toEqual([
			[
				["Wir", 0, 0.1],
				["gehen", 0.15, 0.045],
				["heute", 0.205, 0.045],
				["morgen", 0.3, 0.1],
			],
		]);
	});

	it.each([
		["Vision read nothing for it", "Rapoldeck Hütte Gipfel", [line(0.5, "Rapoldeck", "Hütte")]],
		["it sits between neighbours with no read between them", "Wir gehen morgen", [line(0.5, "Wir", "morgen")]],
		["its neighbours are on different lines", "Wir gehen morgen", [line(0.9, "Wir", "qqqqq"), line(0.8, "morgen")]],
	])("leaves out a word with no place: %s", (_case, transcript, read) => {
		const words = placeWords(transcript, read).flatMap((placedLine) => placedLine.words.map((word) => word.text));

		expect(words).toEqual(transcript.split(" ").filter((word) => !["Gipfel", "gehen"].includes(word)));
	});

	// 13 characters, spaces between them included, share the read's 0.1: 2, 2, 2 and 4 of them.
	it("splits a read Vision ran several words together in by characters, one stretch for each", () => {
		expect(placed(placeWords("Konto 10 05 47 108.", [line(0.5, "Konto", "100547108.")]))).toEqual([
			[
				["Konto", 0, 0.1],
				["10", 0.15, 0.015],
				["05", 0.173, 0.015],
				["47", 0.196, 0.015],
				["108.", 0.219, 0.031],
			],
		]);
	});

	describe("on the reference pages, the ground truth on Vision's pinned page pass", () => {
		/** A reference page's ground truth as a transcript, and Vision's reading of it as recorded in `vision-layer/`. */
		function referencePage(id: string, name: string): { transcript: string; read: LayerLine[] } {
			const root = join(process.cwd(), "test-fixtures", "ocr-reference");
			return {
				transcript: readFileSync(join(root, "pages", name), "utf8").replace(/^---\n[\s\S]*?\n---\n/, ""),
				read: JSON.parse(readFileSync(join(root, "vision-layer", `${id}.json`), "utf8")) as LayerLine[],
			};
		}

		/** The read whose box holds the middle of a placed word. */
		function readUnder(read: LayerLine[], box: VisionBox): string | undefined {
			const [x, y] = [box.x + box.w / 2, box.y + box.h / 2];
			return read.flatMap((visionLine) => visionLine.words).find(({ box: own }) => own && x >= own.x && x <= own.x + own.w && y >= own.y && y <= own.y + own.h)?.text;
		}

		// Vision reads the table by column, the ground truth by row: the alignment keeps one order and
		// leaves out what crosses it. Today that places 12 words and none on a cell it does not resemble;
		// a change to either number is a change to how tables come out, and wants a look (spec §11 point 4).
		it("page 05, the table: keeps today's count of words placed (12) and of words on a cell they do not resemble (0)", () => {
			const { transcript, read } = referencePage("05", "05-table-de.md");

			const words = placeWords(transcript, read).flatMap((placedLine) => placedLine.words);
			const misplaced = words.filter(({ text, box }) => {
				// A cell's own read holds the word ("620" in "620m") or is held by it ("Or" in "Ort").
				const [word, under] = [text.toLowerCase(), readUnder(read, box!)?.toLowerCase()];
				return under === undefined || !(under.includes(word) || word.includes(under));
			});

			expect(words.map((word) => word.text)).toEqual(["Ort", "Höhe", "620", "m", "890", "m", "1240", "m", "1610", "m", "3:05", "4:20"]);
			expect(misplaced).toEqual([]);
		});

		it("page 10, dense: the words of the lines Vision did not see are not in the layer", () => {
			const { transcript, read } = referencePage("10", "10-dense-de.md");

			const words = placeWords(transcript, read).flatMap((placedLine) => placedLine.words.map((word) => word.text));

			// From "ohne Lippenbewegung las, als merkwürdig. Erst mit dem Buchdruck und den billigen Büchern
			// wurde das" and "Satz keinen Rhythmus hat. Wir merken auch nicht, wenn", which Vision read nothing of.
			for (const missed of ["Lippenbewegung", "merkwürdig.", "Buchdruck", "billigen", "Büchern", "keinen", "Rhythmus"]) expect(words).not.toContain(missed);
			expect(words).toContain("Klöstern");
			expect(words).toContain("Gewohnheit.");
		});
	});

	it("aligns the words, not the Markdown a model wrote around them", () => {
		const transcript = ["# Plan", "", "| Ort | Höhe |", "|-----|------|", "- **Waldrand** 890", "<!-- margin --> Sattel", "*Gipfel* `1875` ~~Hütte~~ ==Rast=="].join("\n");
		const read = [line(0.9, "Plan"), line(0.8, "Ort", "Höhe"), line(0.7, "Waldrand", "890"), line(0.6, "Sattel"), line(0.5, "Gipfel", "1875", "Hütte", "Rast")];

		expect(placeWords(transcript, read).map((placedLine) => placedLine.words.map((word) => word.text))).toEqual([
			["Plan"],
			["Ort", "Höhe"],
			["Waldrand", "890"],
			["Sattel"],
			["Gipfel", "1875", "Hütte", "Rast"],
		]);
	});
});
