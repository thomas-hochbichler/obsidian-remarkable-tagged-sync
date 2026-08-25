import { describe, expect, it } from "vitest";
import { correctQuote, matchDistance } from "./quote-correction";

/** The passage the probe actually read off the device, and the book's own wording for it. */
const BOOK =
	"“Well!” thought Alice to herself, “after such a fall as this, I shall think nothing of tumbling down stairs! " +
	"How brave they’ll all think me at home! Why, I wouldn’t say anything about it, even if I fell off the top of the house!” " +
	"(Which was very likely true.) Down, down, down. Would the fall never come to an end?";

describe("correctQuote", () => {
	it("restores the letters the device's conversion lost", () => {
		// `off` reaches us as `oP` -- a plain U+0050, with no ligature codepoint to map back (spec §2).
		const sentence = "Why, I wouldn’t say anything about it, even if I fell oP the top of the house!”";

		const corrected = correctQuote(sentence, [sentence], BOOK);

		expect(corrected?.sentence).toBe("Why, I wouldn’t say anything about it, even if I fell off the top of the house!”");
	});

	it("moves the highlighted run onto the corrected wording", () => {
		const sentence = "even if I fell oP the top of the house";
		const marked = ["I fell oP the top"];

		const corrected = correctQuote(sentence, marked, BOOK);

		expect(corrected?.marked).toEqual(["I fell off the top"]);
		// The run still has to be a run of the sentence, or the renderer cannot put `==` around it.
		expect(corrected?.sentence).toContain(corrected!.marked[0]);
	});

	it("carries several runs of one sentence across", () => {
		const sentence = "How brave they’ll all think me at home! Why, I wouldn’t say anything about it";

		const corrected = correctQuote(sentence, ["How brave", "at home"], BOOK);

		expect(corrected?.marked).toEqual(["How brave", "at home"]);
	});

	it("matches across the typographic punctuation a device and a book disagree on", () => {
		const sentence = '"Well!" thought Alice to herself, "after such a fall as this';

		expect(correctQuote(sentence, [sentence], BOOK)?.sentence).toBe("“Well!” thought Alice to herself, “after such a fall as this");
	});

	it("returns null when the quote is not in this book", () => {
		expect(correctQuote("It was the best of times, it was the worst of times", ["best of times"], BOOK)).toBeNull();
	});

	it("returns null when too much of the quote is damaged to trust a match", () => {
		// One word is left intact on purpose. It is the quote's longest, so the passage *is* found and
		// aligned -- and then refused on the error budget alone, which is what this measures. With every
		// word damaged there is no anchor to find the passage by, and the null says nothing about the
		// budget: raising it from 15% to 50% passed all 1797 tests.
		expect(correctQuote("Whx, I wxuldn’t sax anything abxut xt, xven xf I fxll oP thx txp", ["oP"], BOOK)).toBeNull();
	});

	it("leaves everything alone when a marked run is not inside the sentence", () => {
		// Correcting the sentence but not the run would silently drop the highlight's markers.
		expect(correctQuote("Down, down, down.", ["never come to an end"], BOOK)).toBeNull();
	});

	it("returns null for an empty quote rather than matching the start of the book", () => {
		// It holds because a blank has no word to search the book by, not because anything checks for a
		// blank: the explicit guard that used to sit at the top of `correctQuote` could be deleted with
		// all 1797 tests still passing, because nothing it refused had ever reached it.
		expect(correctQuote("   ", [], BOOK)).toBeNull();
	});

	it("finds a quote that appears late in a long book, and only the right one", () => {
		const long = `${"Down, down, down. ".repeat(400)}${BOOK}`;

		expect(correctQuote("even if I fell oP the top", ["fell oP"], long)?.marked).toEqual(["fell off"]);
	});

	it("keeps looking when the quote's own longest word is all over the book", () => {
		// The word the passage is cheapest to find by is not always a rare one. Here it stands 30 times
		// before the passage itself, so a search that aligns the first place it appears and stops finds
		// nothing -- and neither does one that lets those 30 near-identical windows use up the budget
		// meant for the quote's other words.
		const long = `${"tumbling ".repeat(30)}${BOOK}`;

		expect(correctQuote("I shall think nothing of tumbling down stairs!", ["tumbling down"], long)?.marked).toEqual(["tumbling down"]);
	});

	it("returns null for a book whose letters cannot be folded one for one", () => {
		// `İ` lowercases to two code points, so from there on every index into the folded book addresses
		// a different character than in the book itself -- and a run mapped back through it would mark
		// the wrong words. The device's own spelling is kept instead.
		expect(correctQuote("even if I fell oP the top", ["fell oP"], `${BOOK} İstanbul, later.`)).toBeNull();
	});
});

describe("matchDistance", () => {
	it("reads a device's punctuation and a book's as the same text", () => {
		// A layout engine sets curly quotes, dashes and no-break spaces; the render straightens them all.
		// None of that is the reader's difference, so none of it may cost the match a single edit -- the
		// error budget is there for the letters the conversion lost, and there is not much of it.
		const book = "\u201cWell!\u201d thought Alice \u2014 Alice\u2019s\u00a0sister";

		expect(matchDistance(`"Well!" thought Alice - Alice's sister`, book)).toBe(0);
	});

	it("counts the letters that really differ", () => {
		expect(matchDistance("thought Alice", "thought Alicx")).toBe(1);
	});
});
