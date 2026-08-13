import { describe, expect, it } from "vitest";
import {
	bodyLineSpacing,
	cleanHeadingTitle,
	dehyphenate,
	groupTextLines,
	loadPdfText,
	quoteForRects,
	type PdfPageText,
	type PdfTextLine,
	type RawTextItem,
	sentenceAround,
} from "./pdf-text";

function item(text: string, x: number, y: number, size: number, width = text.length * size * 0.5): RawTextItem {
	return { text, x, y, width, height: size };
}

describe("groupTextLines", () => {
	it("groups items by baseline and orders lines top-down, items left-to-right", () => {
		const items = [item("world", 90, 700, 10), item("second", 50, 686, 10), item("Hello", 50, 700, 10)];

		const lines = groupTextLines(items);

		expect(lines.map((line) => line.text)).toEqual(["Hello world", "second"]);
		expect(lines[0].x).toBe(50);
		expect(lines[0].width).toBe(90 + 25 - 50);
	});

	it("tolerates a baseline that wobbles by less than half a line", () => {
		const lines = groupTextLines([item("same", 50, 700, 10), item("line", 90, 703, 10)]);

		expect(lines.map((line) => line.text)).toEqual(["same line"]);
	});

	it("adds a space only where the gap between items warrants one", () => {
		const glued = groupTextLines([item("co", 50, 700, 10), item("de", 60, 700, 10)]);
		const spaced = groupTextLines([item("two", 50, 700, 10), item("words", 80, 700, 10)]);

		expect(glued[0].text).toBe("code");
		expect(spaced[0].text).toBe("two words");
	});

	it("takes a whitespace-only item as the word boundary it stands for", () => {
		const lines = groupTextLines([item("a", 50, 700, 10), item("   ", 56, 700, 10), item("b", 60, 700, 10)]);

		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("a b");
	});

	/**
	 * The regression the acceptance document turned on: at 13.5pt its headings' word gaps are 2.61pt
	 * where the gap heuristic asks for 0.2 * 13.5 = 2.70, so every one of them came out as
	 * `Seiklarunddirekt`. pdf.js draws the space as an item of its own, which settles it exactly.
	 */
	it("spaces words whose gap is too small for the heuristic when the PDF draws the space", () => {
		const lines = groupTextLines([
			item("Sei", 51.75, 653, 13.5),
			item(" ", 71.7, 653, 13.5),
			item("klar", 74.31, 653, 13.5),
		]);

		expect(lines[0].text).toBe("Sei klar");
	});

	it("measures the line box over its glyphs, so a trailing space does not stretch it", () => {
		const [line] = groupTextLines([item("ab", 50, 700, 10), item(" ", 62, 700, 10)]);

		expect(line.text).toBe("ab");
		// The glyphs end at 50 + 10; the space item reaches to 67 and must not count.
		expect(line.x + line.width).toBe(60);
	});

	it("drops a line that holds nothing but whitespace", () => {
		const lines = groupTextLines([item("a", 50, 700, 10), item("   ", 50, 680, 10)]);

		expect(lines.map((line) => line.text)).toEqual(["a"]);
	});
});

/**
 * A two-column page baselines its columns against each other, so grouping by baseline alone reads
 * straight across the gutter. On the acceptance paper that turned the heading `1 Introduction` into
 * `1 Introduction generalization capabilities of LLMs can lead to highly variable` and alternated
 * every quote between the columns line by line.
 */
describe("groupTextLines on a multi-column page", () => {
	/** Two columns, 50..180 and 200..350, with a 20pt gutter between them. */
	function twoColumns(y: number, left: string, right: string): RawTextItem[] {
		return [item(left, 50, y, 10, 130), item(right, 200, y, 10, 150)];
	}

	it("reads each column top to bottom instead of across the gutter", () => {
		const lines = groupTextLines([
			...twoColumns(700, "left one", "right one"),
			...twoColumns(686, "left two", "right two"),
			...twoColumns(672, "left three", "right three"),
		]);

		expect(lines.map((line) => line.text)).toEqual(["left one", "left two", "left three", "right one", "right two", "right three"]);
	});

	it("keeps a full-width line whole and in its place between the blocks it separates", () => {
		const lines = groupTextLines([
			[item("a heading over both columns", 50, 720, 10, 300)],
			twoColumns(700, "left one", "right one"),
			twoColumns(686, "left two", "right two"),
			twoColumns(672, "left three", "right three"),
			[item("a footer under both columns", 50, 640, 10, 300)],
		].flat());

		expect(lines.map((line) => line.text)).toEqual([
			"a heading over both columns",
			"left one",
			"left two",
			"left three",
			"right one",
			"right two",
			"right three",
			"a footer under both columns",
		]);
	});

	it("splits three columns as readily as two", () => {
		const row = (y: number, a: string, b: string, c: string) => [item(a, 50, y, 10, 80), item(b, 150, y, 10, 80), item(c, 250, y, 10, 80)];
		const lines = groupTextLines([...row(700, "a1", "b1", "c1"), ...row(686, "a2", "b2", "c2"), ...row(672, "a3", "b3", "c3")]);

		expect(lines.map((line) => line.text)).toEqual(["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3"]);
	});

	it("leaves a single-column page exactly as it was", () => {
		const lines = groupTextLines([
			item("the first line of a paragraph", 50, 700, 10, 300),
			item("the second line of it", 50, 686, 10, 220),
			item("and the third", 50, 672, 10, 140),
		]);

		expect(lines.map((line) => line.text)).toEqual(["the first line of a paragraph", "the second line of it", "and the third"]);
	});

	/** A bullet breaks at the same x on every line of a list, which is the whole shape of a gutter -- except that it leaves no column beside it. */
	it("does not take a bullet's indent for a gutter", () => {
		const bullet = (y: number, text: string) => [item("•", 50, y, 10, 5), item(text, 80, y, 10, 270)];
		const lines = groupTextLines([...bullet(700, "first point"), ...bullet(686, "second point"), ...bullet(672, "third point")]);

		expect(lines.map((line) => line.text)).toEqual(["• first point", "• second point", "• third point"]);
	});

	/** Same shape again from the other side: a page number is a column of its own only in the arithmetic. */
	it("does not take a table of contents' page numbers for a gutter", () => {
		const entry = (y: number, title: string, page: string) => [item(title, 50, y, 10, 175), item(page, 340, y, 10, 10)];
		const lines = groupTextLines([...entry(700, "Introduction", "12"), ...entry(686, "Method", "34"), ...entry(672, "Results", "56")]);

		expect(lines.map((line) => line.text)).toEqual(["Introduction 12", "Method 34", "Results 56"]);
	});
});

describe("bodyLineSpacing", () => {
	/** A run of body lines at `y`, `y - gap`, ... in the given type size. */
	function body(count: number, gap: number, size = 10, from = 700): RawTextItem[] {
		return Array.from({ length: count }, (_, index) => item(`body line ${index}`, 50, from - index * gap, size));
	}

	it("takes the lower quartile of the gaps between body lines", () => {
		const items = [...body(5, 12), item("a paragraph away", 50, 620, 10)];

		expect(bodyLineSpacing(groupTextLines(items))).toBe(12);
	});

	/** A figure's tick labels sit a point or two apart and can outnumber the body on a figure page. */
	it("ignores the gaps a figure's smaller labels leave between them", () => {
		const ticks = [0, 2, 4, 6, 8, 10, 12, 14].map((offset) => item(String(offset), 300, 500 - offset, 4));
		const lines = groupTextLines([...body(3, 12), ...ticks]);

		expect(bodyLineSpacing(lines)).toBe(12);
	});

	it("is null for a page whose lines never share a type size in sequence", () => {
		expect(bodyLineSpacing(groupTextLines([item("heading", 50, 700, 20), item("body", 50, 680, 10)]))).toBeNull();
	});
});

describe("dehyphenate", () => {
	it("joins lines with a space", () => {
		expect(dehyphenate(["one two", "three"])).toBe("one two three");
	});

	it("drops the hyphen at a hyphenated line break", () => {
		expect(dehyphenate(["The second sen-", "tence continues."])).toBe("The second sentence continues.");
	});

	it("keeps a trailing hyphen that is not a broken word", () => {
		expect(dehyphenate(["a range of 5-", "10 items"])).toBe("a range of 5- 10 items");
	});

	it("skips empty lines", () => {
		expect(dehyphenate(["one", "  ", "two"])).toBe("one two");
	});
});

describe("sentenceAround", () => {
	const text = "First one. Second one is here! Third one?";

	it("expands a range to the sentence containing it", () => {
		const bounds = sentenceAround(text, 18, 20);

		expect(text.slice(bounds.start, bounds.end)).toBe("Second one is here!");
	});

	it("stops at the text bounds when there is no boundary", () => {
		const bounds = sentenceAround("no terminator at all", 3, 6);

		expect(bounds).toEqual({ start: 0, end: 20 });
	});

	it("takes the last sentence up to the end of the text", () => {
		const bounds = sentenceAround(text, 31, 36);

		expect(text.slice(bounds.start, bounds.end)).toBe("Third one?");
	});

	it("does not split at an abbreviating period followed by a digit", () => {
		const numbered = "See Fig. 2 for the setup. Nothing else.";
		const bounds = sentenceAround(numbered, 15, 20);

		expect(numbered.slice(bounds.start, bounds.end)).toBe("See Fig. 2 for the setup.");
	});
});

/** A page whose characters are 5pt wide throughout, so a rectangle's x range maps to a known slice of the line. */
function page(lines: { text: string; y: number }[]): PdfPageText {
	return {
		label: "1",
		width: 612,
		height: 792,
		lines: lines.map(({ text, y }): PdfTextLine => ({ text, x: 50, y, width: text.length * 5, height: 10 })),
	};
}

/** The rectangle covering characters `[from, to)` of a line laid out by `page`. */
function rectOver(from: number, to: number, y: number) {
	return { x: 50 + from * 5, y, width: (to - from) * 5, height: 10 };
}

/**
 * A page with the acceptance fixture's vertical geometry (.scratch/pdf-annotation/acceptance-page2.md):
 * 9pt body lines 13pt apart, 16.9pt section headings, and the ~25pt gap that separates a block from
 * the next. Characters stay 5pt wide, so `rectOver` addresses these lines too.
 */
function spacedPage(lines: { text: string; y: number; height?: number }[]): PdfPageText {
	return {
		label: "1",
		width: 612,
		height: 792,
		lines: lines.map(({ text, y, height = 9 }): PdfTextLine => ({ text, x: 50, y, width: text.length * 5, height })),
	};
}

/** The rectangle covering `part` of the line `text`, which sits at `y`. */
function rectOverText(text: string, part: string, y: number) {
	const at = text.indexOf(part);
	return rectOver(at, at + part.length, y);
}

describe("quoteForRects", () => {
	const article = page([
		{ text: "The first sentence ends here. The second", y: 700 },
		{ text: "sentence continues on the next line and stops.", y: 686 },
		{ text: "A third sentence follows.", y: 672 },
	]);

	it("returns the full sentence around the marked run", () => {
		const quote = quoteForRects(article, [rectOver(9, 18, 686)]);

		expect(quote).toEqual({
			sentence: "The second sentence continues on the next line and stops.",
			marked: ["continues"],
		});
	});

	it("widens a partial hit to whole words", () => {
		const quote = quoteForRects(article, [rectOver(11, 15, 686)]);

		expect(quote?.marked).toEqual(["continues"]);
	});

	it("does not take the next word when the mark stops in the space before it", () => {
		// A marker swipe overshoots the last letter by a little; the space it runs into is not the
		// word behind it. Measured on the real one: 100% of `context` and `engineering.`, 0% of
		// `Building` -- and `Building` came out marked all the same until the range was trimmed.
		const quote = quoteForRects(article, [rectOver(0, 19, 686)]); // "sentence continues" plus the space

		expect(quote?.marked).toEqual(["sentence continues"]);
	});

	it("marks nothing for a rectangle that covers only the space between two words", () => {
		const quote = quoteForRects(article, [rectOver(8, 9, 686)]);

		expect(quote?.marked).toEqual([]);
	});

	it("marks a run spanning several lines and rectangles", () => {
		const quote = quoteForRects(article, [rectOver(30, 40, 700), rectOver(0, 8, 686)]);

		expect(quote?.marked).toEqual(["The second sentence"]);
		expect(quote?.sentence).toBe("The second sentence continues on the next line and stops.");
	});

	it("de-hyphenates a run broken across a line break", () => {
		const broken = page([
			{ text: "The second sen-", y: 700 },
			{ text: "tence continues.", y: 686 },
		]);

		const quote = quoteForRects(broken, [rectOver(11, 15, 700), rectOver(0, 5, 686)]);

		expect(quote).toEqual({ sentence: "The second sentence continues.", marked: ["sentence"] });
	});

	/**
	 * A pen underline under the *second* half of a hyphenated word. Widening to whole words runs per
	 * line, where "lates" starts at offset 0 and has nothing to its left -- but de-hyphenation has
	 * already joined it to "accumu" by the time the run is addressed, so the mark began mid-word and
	 * printed `accumu==lates ...==`. Every two-column paper hyphenates, so this is not a corner.
	 */
	it("widens a run to the whole word when the line break split that word", () => {
		const broken = page([
			{ text: "The interaction history accumu-", y: 700 },
			{ text: "lates both environment observations.", y: 686 },
		]);

		const quote = quoteForRects(broken, [rectOver(0, 36, 686)]);

		expect(quote?.marked).toEqual(["accumulates both environment observations."]);
	});

	/**
	 * The regression page 7 of the acceptance document exposed: one `glyph_def` run carried 20
	 * rectangles over lines 2-8, 13-16 and 36-42, and quoting first-to-last reprinted the whole page --
	 * its headings and its unmarked paragraphs included -- as a single 3000-character highlight.
	 */
	it("quotes each contiguous run of a highlight that skips over text, not the span between them", () => {
		const skipping = page([
			{ text: "First marked line here.", y: 700 },
			{ text: "Unmarked line in between.", y: 686 },
			{ text: "Second marked line here.", y: 672 },
		]);

		const quote = quoteForRects(skipping, [rectOver(0, 5, 700), rectOver(0, 6, 672)]);

		expect(quote?.marked).toEqual(["First", "Second"]);
		expect(quote?.sentence).not.toContain("Unmarked line in between.");
		expect(quote?.sentence).toContain(" … ");
	});

	it("keeps a run that spans consecutive lines in one passage", () => {
		const quote = quoteForRects(article, [rectOver(30, 40, 700), rectOver(0, 8, 686)]);

		expect(quote?.marked).toHaveLength(1);
		expect(quote?.sentence).not.toContain(" … ");
	});

	/**
	 * The reader concatenates two runs without the space between them, so the recorded text reads
	 * `budget_tokenseinen` where the text layer reads `budget_tokens einen`. Collapsing whitespace
	 * could not reconcile that, and the highlight fell back to the estimate, which opens `==` mid-word.
	 */
	it("finds a highlight text that lost the space between two runs", () => {
		const joined = page([{ text: "Setting budget_tokens einen 400 error.", y: 700 }]);

		const quote = quoteForRects(joined, [rectOver(8, 27, 700)], "budget_tokenseinen");

		expect(quote?.marked).toEqual(["budget_tokens einen"]);
	});

	it("returns null when no line is hit", () => {
		expect(quoteForRects(article, [rectOver(0, 5, 400)])).toBeNull();
		expect(quoteForRects(article, [{ x: 500, y: 686, width: 50, height: 10 }])).toBeNull();
	});

	it("ignores a rectangle that only grazes the line below", () => {
		// Sits over line 2 by 4pt and reaches 2pt into line 3, which must stay out of the marked run.
		const quote = quoteForRects(article, [{ x: 50, y: 680, width: 40, height: 10 }]);

		expect(quote?.marked).toEqual(["sentence"]);
		expect(quote?.sentence).toBe("The second sentence continues on the next line and stops.");
	});

	it("keeps the marked run a verbatim substring of the sentence", () => {
		const quote = quoteForRects(article, [rectOver(4, 20, 700)]);

		expect(quote?.sentence).toContain(quote?.marked[0]);
	});

	// A heading carries no sentence terminator, so without the spacing rule the backward scan runs
	// straight through it -- four of the acceptance page's nine quotes opened with their heading.
	const HEADING = "Allgemeine Prinzipien";
	const OPENING = "Die Techniken in diesem Abschnitt gelten für alle aktuellen Modelle,";
	const CONTINUATION = "einschließlich der neuesten.";
	const section = spacedPage([
		{ text: HEADING, y: 723, height: 16.9 },
		{ text: OPENING, y: 698 },
		{ text: CONTINUATION, y: 685 },
	]);

	it("does not reach across the gap that separates a heading from its text", () => {
		const quote = quoteForRects(section, [rectOverText(OPENING, "für alle aktuellen Modelle,", 698)]);

		expect(quote?.sentence).toBe(`${OPENING} ${CONTINUATION}`);
		expect(quote?.sentence).not.toContain(HEADING);
		expect(quote?.sentence).toContain(quote?.marked[0]);
	});

	it("still takes in the next line of the same paragraph", () => {
		const quote = quoteForRects(section, [rectOverText(CONTINUATION, "einschließlich", 685)]);

		expect(quote?.sentence).toBe(`${OPENING} ${CONTINUATION}`);
		expect(quote?.sentence).toContain(quote?.marked[0]);
	});

	/**
	 * The acceptance paper sets its headings tighter than that: `1 Introduction` is 12.7pt type
	 * sitting 13.9pt above 9pt body text whose own lines are 12.8pt apart, so the gap alone reads as
	 * an ordinary line break and the quote opened with the heading. The change of type size is what
	 * gives it away.
	 */
	it("does not reach across a heading set too tight for the gap to show", () => {
		const title = "1 Introduction";
		const opening = "Large Language Models (LLMs), such as GPT-4, have attracted";
		const continuation = "considerable attention due to their advanced capabilities.";
		const tight = spacedPage([
			{ text: title, y: 211.8, height: 12.7 },
			{ text: opening, y: 197.9 },
			{ text: continuation, y: 185.1 },
		]);

		const quote = quoteForRects(tight, [rectOverText(opening, "such as GPT-4, have attracted", 197.9)]);

		expect(quote?.sentence).toBe(`${opening} ${continuation}`);
		expect(quote?.sentence).not.toContain(title);
	});

	it("does not reach across a paragraph break either", () => {
		const lead = "Best Practices:";
		const first = "Verwende konsistente, beschreibende";
		const second = "Tag-Namen in deinen Prompts.";
		const paragraphs = spacedPage([
			{ text: lead, y: 700 },
			{ text: first, y: 675 },
			{ text: second, y: 662 },
		]);

		// Two lines are hit, so without the rule the line above the first of them comes along too.
		const quote = quoteForRects(paragraphs, [rectOverText(first, "beschreibende", 675), rectOverText(second, "Tag-Namen", 662)]);

		expect(quote?.sentence).toBe(`${first} ${second}`);
		expect(quote?.sentence).not.toContain(lead);
		expect(quote?.sentence).toContain(quote?.marked[0]);
	});

	it("takes the marked run from the highlight's own text rather than from the x estimate", () => {
		const rects = [rectOverText(OPENING, "gelten für alle aktuellen Modelle,", 698)];

		const estimated = quoteForRects(section, rects);
		const exact = quoteForRects(section, rects, "für alle aktuellen Modelle,");

		expect(estimated?.marked).toEqual(["gelten für alle aktuellen Modelle,"]);
		expect(exact?.marked).toEqual(["für alle aktuellen Modelle,"]);
		expect(exact?.sentence).toContain(exact?.marked[0]);
	});

	it("finds a highlight text that carries the document's line wrap", () => {
		const quote = quoteForRects(section, [rectOverText(OPENING, "Modelle,", 698)], "aktuellen Modelle,\neinschließlich");

		expect(quote?.marked).toEqual(["aktuellen Modelle, einschließlich"]);
		expect(quote?.sentence).toContain(quote?.marked[0]);
	});

	it("picks the occurrence nearest the rectangles when the text repeats", () => {
		const first = "Use the tag name in the first line.";
		const second = "Then use the tag name again later on.";
		const repeated = spacedPage([
			{ text: first, y: 700 },
			{ text: second, y: 687 },
		]);

		const above = quoteForRects(repeated, [rectOverText(first, "tag name", 700)], "the tag name");
		const below = quoteForRects(repeated, [rectOverText(second, "tag name", 687)], "the tag name");

		expect(above?.sentence).toBe(first);
		expect(below?.sentence).toBe(second);
		expect(above?.marked).toEqual(["the tag name"]);
		expect(below?.marked).toEqual(["the tag name"]);
	});

	it("falls back to the x estimate when the highlight text is not in the context", () => {
		const rects = [rectOverText(OPENING, "gelten für alle", 698)];

		const quote = quoteForRects(section, rects, "a run from some other page");

		expect(quote).toEqual(quoteForRects(section, rects));
		expect(quote?.sentence).toContain(quote?.marked[0]);
	});
});

// --- pdf.js glue, driven through the injected loader ------------------------------------------

interface FakePage {
	view: unknown;
	getTextContent: (options?: { includeChars?: boolean }) => Promise<{ items: unknown[] }>;
}

interface FakeDocument {
	numPages: number;
	getPage: (pageNumber: number) => Promise<FakePage>;
	getPageLabels?: () => Promise<unknown>;
	getOutline?: () => Promise<unknown>;
	getDestination?: (name: string) => Promise<unknown>;
	getPageIndex?: (ref: unknown) => Promise<unknown>;
}

/** A pdf.js text item as `getTextContent` reports it: the origin lives in the transform, not in an x/y pair. */
function textItem(text: string, x: number, y: number, size: number) {
	return { str: text, width: text.length * size * 0.5, height: size, transform: [size, 0, 0, size, x, y] };
}

function fakePage(items: unknown[], view: unknown = [0, 0, 612, 792]): FakePage {
	return { view, getTextContent: () => Promise.resolve({ items }) };
}

function fakeLoader(doc: FakeDocument, handed: Uint8Array[] = []) {
	return () =>
		Promise.resolve({
			getDocument: (params: { data: Uint8Array }) => {
				handed.push(params.data);
				return { promise: Promise.resolve(doc) };
			},
		});
}

function singlePageDoc(page: FakePage, extras: Partial<FakeDocument> = {}): FakeDocument {
	return { numPages: 1, getPage: () => Promise.resolve(page), ...extras };
}

const BYTES = new Uint8Array([1, 2, 3]);

describe("loadPdfText", () => {
	it("returns null when Obsidian does not expose pdf.js", async () => {
		expect(await loadPdfText(BYTES)).toBeNull();
	});

	it("returns null when the document cannot be opened", async () => {
		const loader = () => Promise.resolve({ getDocument: () => ({ promise: Promise.reject(new Error("broken PDF")) }) });

		expect(await loadPdfText(BYTES, loader)).toBeNull();
	});

	it("hands pdf.js a copy of the bytes, which it may transfer away", async () => {
		const handed: Uint8Array[] = [];

		await loadPdfText(BYTES, fakeLoader(singlePageDoc(fakePage([])), handed));

		expect(handed[0]).not.toBe(BYTES);
		expect([...handed[0]]).toEqual([...BYTES]);
	});

	it("reads a page's lines, size and label", async () => {
		const doc = singlePageDoc(fakePage([textItem("Hello", 50, 700, 10), textItem("world", 90, 700, 10)]), {
			getPageLabels: () => Promise.resolve(["iv"]),
		});

		const text = await loadPdfText(BYTES, fakeLoader(doc));
		const page = await text?.page(0);

		expect(text?.pageCount).toBe(1);
		expect(page).toEqual({
			label: "iv",
			width: 612,
			height: 792,
			lines: [{ text: "Hello world", x: 50, y: 700, width: 65, height: 10 }],
		});
	});

	it("labels a page by its 1-based index when the PDF names none", async () => {
		const doc = singlePageDoc(fakePage([textItem("Body", 50, 700, 10)]));

		const page = await (await loadPdfText(BYTES, fakeLoader(doc)))?.page(0);

		expect(page?.label).toBe("1");
	});

	it("returns null for a page with no text layer and for a page that does not exist", async () => {
		const text = await loadPdfText(BYTES, fakeLoader(singlePageDoc(fakePage([]))));

		expect(await text?.page(0)).toBeNull();
		expect(await text?.page(1)).toBeNull();
		expect(await text?.page(-1)).toBeNull();
	});

	it("offers includeChars and falls back to plain getTextContent when it is rejected", async () => {
		const offered: (boolean | undefined)[] = [];
		const page: FakePage = {
			view: [0, 0, 612, 792],
			getTextContent: (options) => {
				offered.push(options?.includeChars);
				if (options?.includeChars) return Promise.reject(new Error("unsupported option"));
				return Promise.resolve({ items: [textItem("Body", 50, 700, 10)] });
			},
		};

		const text = await loadPdfText(BYTES, fakeLoader(singlePageDoc(page)));

		expect((await text?.page(0))?.lines[0].text).toBe("Body");
		expect(offered).toEqual([true, undefined]);
	});

	it("reads a page only once, however often it is asked for", async () => {
		let reads = 0;
		const doc = singlePageDoc({
			view: [0, 0, 612, 792],
			getTextContent: () => {
				reads++;
				return Promise.resolve({ items: [textItem("Body", 50, 700, 10)] });
			},
		});

		const text = await loadPdfText(BYTES, fakeLoader(doc));
		await text?.page(0);
		await text?.page(0);

		expect(reads).toBe(1);
	});

	it("takes headings from the outline, resolving named destinations", async () => {
		const doc = singlePageDoc(fakePage([textItem("Body", 50, 700, 10)]), {
			getOutline: () =>
				Promise.resolve([
					{ title: "Chapter 1", dest: "chapter-1", items: [{ title: "Section 1.1", dest: [{ num: 4 }, { name: "FitH" }, 620] }] },
					{ title: "Untitled destination", dest: null },
				]),
			getDestination: () => Promise.resolve([{ num: 3 }, { name: "XYZ" }, 72, 740, null]),
			getPageIndex: (ref) => Promise.resolve((ref as { num: number }).num === 3 ? 0 : 1),
		});

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings).toEqual([
			{ pageIndex: 0, x: 72, y: 740, title: "Chapter 1" },
			// FitH names a top edge but no left one, so the column it sits in stays unknown.
			{ pageIndex: 1, x: null, y: 620, title: "Section 1.1" },
		]);
	});

	it("leaves y null for a destination that carries no coordinate", async () => {
		const doc = singlePageDoc(fakePage([textItem("Body", 50, 700, 10)]), {
			getOutline: () => Promise.resolve([{ title: "Cover", dest: [{ num: 1 }, { name: "Fit" }] }]),
			getPageIndex: () => Promise.resolve(0),
		});

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings).toEqual([{ pageIndex: 0, x: null, y: null, title: "Cover" }]);
	});

	/**
	 * The acceptance fixture has no outline at all, so this is the only heading path that runs for it:
	 * 9pt body text, 13.5pt section headings, a 16.9pt page-top section, on a 612x792 page.
	 */
	it("falls back to the font-size heuristic when the PDF has no outline", async () => {
		const lines: unknown[] = [
			textItem("Chapter 3 - Attention", 72, 740, 16.9),
			textItem("Introduction", 72, 700, 13.5),
			textItem("Body text runs at nine points here.", 72, 680, 9),
			textItem("It keeps running for several lines.", 72, 666, 9),
			textItem("And a third one, to be the mode.", 72, 652, 9),
			textItem("Method", 72, 600, 13.5),
			textItem("More body text at nine points.", 72, 586, 9),
			textItem("Still more body text here.", 72, 572, 9),
		];
		const doc = singlePageDoc(fakePage(lines), { getOutline: () => Promise.resolve(null) });

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings).toEqual([
			{ pageIndex: 0, x: 72, y: 740, title: "Chapter 3 - Attention" },
			{ pageIndex: 0, x: 72, y: 700, title: "Introduction" },
			{ pageIndex: 0, x: 72, y: 600, title: "Method" },
		]);
	});

	it("keeps only the first line of a multi-line heading", async () => {
		const doc = singlePageDoc(
			fakePage([
				textItem("A heading that wraps", 72, 740, 13.5),
				textItem("onto a second line", 72, 720, 13.5),
				textItem("Body text at nine points.", 72, 700, 9),
				textItem("More body text at nine points.", 72, 686, 9),
			]),
			{ getOutline: () => Promise.resolve([]) },
		);

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings).toEqual([{ pageIndex: 0, x: 72, y: 740, title: "A heading that wraps" }]);
	});

	it("returns no headings when there is neither an outline nor a larger line", async () => {
		const doc = singlePageDoc(fakePage([textItem("All the same size.", 72, 700, 9), textItem("Nothing stands out.", 72, 686, 9)]));

		expect(await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings()).toEqual([]);
	});

	it("cleans an outline title, and drops a heading whose title is nothing but an ornament", async () => {
		const doc = singlePageDoc(fakePage([textItem("Body", 50, 700, 10)]), {
			getOutline: () => Promise.resolve([{ title: "■ 1 Introduction", dest: "a" }, { title: "■", dest: "a" }]),
			getDestination: () => Promise.resolve([{ num: 1 }, { name: "XYZ" }, 72, 740, null]),
			getPageIndex: () => Promise.resolve(0),
		});

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings).toEqual([{ pageIndex: 0, x: 72, y: 740, title: "1 Introduction" }]);
	});

	/** hyperref writes bookmarks unnumbered by default, and the number is then only on the page. */
	it("takes the section number an unnumbered outline title has on its page", async () => {
		const doc = singlePageDoc(
			fakePage([
				textItem("1", 72, 740, 12),
				textItem("Introduction", 96, 740, 12),
				textItem("2.1", 72, 700, 10),
				textItem("Harness Engineering", 96, 700, 10),
				textItem("A", 72, 660, 12),
				textItem("Experimental Setup", 96, 660, 12),
			]),
			{
				getOutline: () => Promise.resolve([{ title: "Introduction", dest: "a" }, { title: "Harness Engineering", dest: "a" }, { title: "Experimental Setup", dest: "a" }]),
				getDestination: () => Promise.resolve([{ num: 1 }, { name: "XYZ" }, 72, 740, null]),
				getPageIndex: () => Promise.resolve(0),
			},
		);

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings?.map((heading) => heading.title)).toEqual(["1 Introduction", "2.1 Harness Engineering", "A Experimental Setup"]);
	});

	it("keeps the outline's own title where the page does not say exactly that, numbered", async () => {
		const doc = singlePageDoc(
			fakePage([
				// The heading wraps, so its first line is not the whole title.
				textItem("3", 72, 740, 12),
				textItem("A heading that wraps", 96, 740, 12),
				textItem("onto a second line", 72, 720, 12),
				// Already numbered in the outline: the page must not number it twice.
				textItem("4 Method", 72, 680, 12),
			]),
			{
				getOutline: () => Promise.resolve([{ title: "A heading that wraps onto a second line", dest: "a" }, { title: "4 Method", dest: "a" }]),
				getDestination: () => Promise.resolve([{ num: 1 }, { name: "XYZ" }, 72, 740, null]),
				getPageIndex: () => Promise.resolve(0),
			},
		);

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings?.map((heading) => heading.title)).toEqual(["A heading that wraps onto a second line", "4 Method"]);
	});

	it("cleans a title the font-size heuristic reads off the page too", async () => {
		const doc = singlePageDoc(
			fakePage([
				textItem("• Bullet heading", 72, 740, 13.5),
				textItem("Body text at nine points.", 72, 700, 9),
				textItem("More body text at nine points.", 72, 686, 9),
			]),
			{ getOutline: () => Promise.resolve([]) },
		);

		const headings = await (await loadPdfText(BYTES, fakeLoader(doc)))?.headings();

		expect(headings?.map((heading) => heading.title)).toEqual(["Bullet heading"]);
	});
});

/**
 * The heading is the digest's only heading now, so a `■` the outline carries for decoration lands as
 * the loudest text on the page. Measured over the fixture: 0 of its 43 outline titles change, i.e.
 * this is a repair for broken input, not a rewrite of good input.
 */
describe("cleanHeadingTitle", () => {
	it("strips leading ornaments, however many", () => {
		expect(cleanHeadingTitle("■ 1 Introduction")).toBe("1 Introduction");
		expect(cleanHeadingTitle("• Bullet heading")).toBe("Bullet heading");
		expect(cleanHeadingTitle("✦✦ Fancy")).toBe("Fancy");
		expect(cleanHeadingTitle("→ Weiterführendes")).toBe("Weiterführendes");
	});

	it("removes invisibles wherever they sit", () => {
		expect(cleanHeadingTitle("Soft­hyphen")).toBe("Softhyphen");
		expect(cleanHeadingTitle("Zero​width")).toBe("Zerowidth");
		expect(cleanHeadingTitle("﻿BOM")).toBe("BOM");
	});

	it("keeps ZWJ, which carries meaning rather than decorating", () => {
		expect(cleanHeadingTitle("क‍ष")).toBe("क‍ष");
	});

	it("keeps numbering and punctuation, which locate the section", () => {
		expect(cleanHeadingTitle("1.1 Related surveys")).toBe("1.1 Related surveys");
		expect(cleanHeadingTitle("»Zitat« als Titel")).toBe("»Zitat« als Titel");
		expect(cleanHeadingTitle("§ 5 Verfahren")).toBe("§ 5 Verfahren");
		expect(cleanHeadingTitle("(Anhang) Tabellen")).toBe("(Anhang) Tabellen");
	});

	it("collapses whitespace and trims", () => {
		expect(cleanHeadingTitle("  Zwei   Wörter  ")).toBe("Zwei Wörter");
	});

	it("returns nothing for a title that holds nothing but junk", () => {
		expect(cleanHeadingTitle("■")).toBe("");
		expect(cleanHeadingTitle("   ")).toBe("");
	});
});
