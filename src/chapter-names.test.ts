import { describe, expect, it } from "vitest";
import { chapterName } from "./chapter-names";

/** *Alice*, as the device's own navigation carries it. */
const ALICE = [
	"Alice’s Adventures in Wonderland",
	"Contents",
	"CHAPTER I. Down the Rabbit-Hole",
	"CHAPTER II. The Pool of Tears",
	"CHAPTER III. A Caucus-Race and a Long Tale",
	"CHAPTER VI. Pig and Pepper",
	"CHAPTER VII. A Mad Tea-Party",
];

describe("chapterName", () => {
	it("completes the heading the render cut short", () => {
		// What the note actually said before this: "### CHAPTER I."
		expect(chapterName("CHAPTER I.", ALICE)).toBe("CHAPTER I. Down the Rabbit-Hole");
	});

	it("tells the chapter apart from the one whose number merely starts the same", () => {
		expect(chapterName("CHAPTER II.", ALICE)).toBe("CHAPTER II. The Pool of Tears");
	});

	it("recognises a heading the conversion to a PDF damaged", () => {
		// The damage this whole path exists for: a letter the render dropped or replaced.
		expect(chapterName("CHAPTER III. A Caucus-Race and a Long TaP", ALICE)).toBe("CHAPTER III. A Caucus-Race and a Long Tale");
	});

	it("keeps a heading that names no chapter in particular", () => {
		// It fits the opening of every chapter equally well, and naming it after the wrong one would be
		// worse than leaving it as the render found it.
		expect(chapterName("CHAPTER", ALICE)).toBeNull();
	});

	it("still reads a damaged numeral as the chapter it fits best", () => {
		// "Vl." is one edit from chapter VI and two from chapter VII, because the second "l" the number
		// would need is not there.
		expect(chapterName("CHAPTER Vl.", ALICE)).toBe("CHAPTER VI. Pig and Pepper");
	});

	it("keeps a heading the navigation does not name at all", () => {
		// An article's own subheadings are finer than its navigation, which names the piece as a whole.
		expect(chapterName("Model details", ["Introducing Claude Sonnet 5"])).toBeNull();
	});

	it("keeps every heading when the book has no navigation", () => {
		expect(chapterName("CHAPTER I.", [])).toBeNull();
	});

	it("has nothing to say about a heading that is empty", () => {
		expect(chapterName("   ", ALICE)).toBeNull();
		// And in a book with a single chapter, where no tie refuses it first: a blank is two edits from
		// any name at all, which is exactly the budget a two-character heading gets.
		expect(chapterName(" ", ["Introduction"])).toBeNull();
	});

	it("measures the damage against the heading, not against the name it would be given", () => {
		// Three of ten characters wrong is not a heading anyone can recognise, however long the chapter
		// name is. Taking the budget from the name -- 31 characters, so four edits -- accepts it.
		expect(chapterName("CHAPTXR l,", ["CHAPTER I. Down the Rabbit-Hole"])).toBeNull();
		expect(chapterName("CHAPTXR I.", ["CHAPTER I. Down the Rabbit-Hole"])).toBe("CHAPTER I. Down the Rabbit-Hole");
	});

	it("reads the same heading through the punctuation a layout engine changed", () => {
		expect(chapterName("Alice's Adventures in Wonderland", ALICE)).toBe("Alice’s Adventures in Wonderland");
	});
});
