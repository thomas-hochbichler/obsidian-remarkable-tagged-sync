import { describe, expect, it } from "vitest";
import { correctQuote } from "./quote-correction";

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
		// Half the words replaced: an alignment could still be found, and it would be a guess.
		expect(correctQuote("Whx, I wxuldn’t sax anxthing abxut xt, xven xf I fxll oP thx txp", ["oP"], BOOK)).toBeNull();
	});

	it("leaves everything alone when a marked run is not inside the sentence", () => {
		// Correcting the sentence but not the run would silently drop the highlight's markers.
		expect(correctQuote("Down, down, down.", ["never come to an end"], BOOK)).toBeNull();
	});

	it("returns null for an empty quote rather than matching the start of the book", () => {
		expect(correctQuote("   ", [], BOOK)).toBeNull();
	});

	it("finds a quote that appears late in a long book, and only the right one", () => {
		const long = `${"Down, down, down. ".repeat(400)}${BOOK}`;

		expect(correctQuote("even if I fell oP the top", ["fell oP"], long)?.marked).toEqual(["fell off"]);
	});
});
