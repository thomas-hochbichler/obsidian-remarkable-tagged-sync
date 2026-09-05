import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildDigest, type DigestPageInput, type DigestPipelineDeps } from "./digest-pipeline";
import type { EpubBook } from "./epub-text";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { notebookPageFrame, resolveDeviceCanvas } from "./pdf-renderer";
import { parseRmV6, type RmHighlight, type RmPage, type RmStroke, type RmText } from "./rm-parser";
import { PLAIN_TEXT_SIZE_PX } from "./device-font";
import { layoutText } from "./text-layout";
import type { PdfHeading, PdfPageText, PdfTextDocument, PdfTextLine } from "./pdf-text";

const PDF_PAGE_FIXTURE_PATH = "./test-fixtures/rmv6/weather-station-page1.rm";
const SOURCE_BYTES = new Uint8Array([1, 2, 3]);
/** The fixture page's size in PDF points, and the scene-to-PDF scale the reMarkable 1/2 frame gives it. */
const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;
const PX_TO_PT = 72 / 226;

function fixtureScene(): RmPage {
	return parseRmV6(new Uint8Array(readFileSync(PDF_PAGE_FIXTURE_PATH)));
}

/** Answers the clusters in call order, which the pipeline guarantees by transcribing them sequentially. */
// The digest transcribes one cluster at a time, so a per-page breakdown says nothing here: `pages`
// is null throughout, which is what a single-unit `recognize` legitimately reports.
function fakeOcr(...results: (string | Omit<OcrResult, "pages">)[]): OcrBackend {
	let call = 0;
	return {
		id: "vision",
		metered: false,
		fingerprint: "test-backend",
		recognize: async () => {
			const result = results[call++] ?? "";
			return typeof result === "string" ? { status: "ok", pages: null, text: result, confidence: null } : { pages: null, ...result };
		},
	};
}

function throwingOcr(): OcrBackend {
	return { id: "vision", metered: false, fingerprint: "test-backend", recognize: () => Promise.reject(new Error("vision is not installed")) };
}

function fakeTextDocument(pages: Record<number, PdfPageText>, headings: PdfHeading[] = []): PdfTextDocument {
	return {
		pageCount: Object.keys(pages).length,
		page: async (index) => pages[index] ?? null,
		headings: async () => headings,
	};
}

function deps(overrides: Partial<DigestPipelineDeps> = {}): DigestPipelineDeps {
	return {
		ocrBackend: fakeOcr(),
		// On, because these tests are about what the digest does with margin notes. The shipped
		// default is off (F20); the tests that care about that say so.
		marginNotes: true,
		loadText: async () => null,
		...overrides,
	};
}

function build(pages: DigestPageInput[], overrides: Partial<DigestPipelineDeps> = {}, book?: () => Promise<EpubBook | null>) {
	return buildDigest(deps(overrides), {
		source: { kind: "pdf", bytes: SOURCE_BYTES, book },
		embedPath: "attachments/doc.pdf",
		pages,
	});
}

/** The fixture page as the sync engine hands it over: source page index 1, embedded as page 2. */
function fixturePage(scene: RmPage = fixtureScene()): DigestPageInput {
	return { pageId: "page-a", sourceIndex: 1, embedPage: 2, scene };
}

// --- the fixture page's text layer, rebuilt from the measured geometry -------------------------
// The source PDF (test-fixtures/rmv6/weather-station.pdf) is public and committed beside the
// fixture, but pdf.js is not loadable under vitest, so the fake reproduces what the pipeline reads
// off it: the two headings and the four highlighted sentences, each line at the y its highlight's
// rectangles actually occupy in the fixture scene (bottom edge, scene px * 72/226, y up from the
// page bottom). Three of the four highlights wrap the printed line, so their sentences really are
// two lines -- at the page's own 22.6 pt spacing, which is what the line-height quartile sees.

const FIXTURE_HEADINGS: { y: number; title: string }[] = [
	{ y: 720, title: "The Weather Station at Cape Marrow" },
	{ y: 660, title: "One — The station" },
];

/** Each line sits at the measured bottom edge of the highlight rect it carries. */
const FIXTURE_QUOTES: { sentence: string; lines: { text: string; y: number }[] }[] = [
	{
		sentence:
			"The weather station at Cape Marrow was built in the spring of nineteen sixty-two, on a shelf of rock that the sea had spent a long time deciding not to take.",
		lines: [
			{ text: "The weather station at Cape Marrow was built in the spring of nineteen sixty-two, on a shelf of rock that the sea had spent a long time deciding not", y: 551.9 },
			{ text: "to take.", y: 529.3 },
		],
	},
	{
		sentence:
			"He had asked for the posting in a letter of eleven lines, and the whole of his argument was in the last of them: I would like to be somewhere where the readings matter more than the reader.",
		lines: [
			{ text: "He had asked for the posting in a letter of eleven lines, and the whole of his argument was in the last of them: I would like to be somewhere where the readings matter more", y: 382.4 },
			{ text: "than the reader.", y: 359.8 },
		],
	},
	{
		sentence: "He missed eleven readings in nineteen years.",
		lines: [{ text: "He missed eleven readings in nineteen years.", y: 235.5 }],
	},
	{
		sentence: "Nine of those were in one week in February of nineteen seventy-four, when the roof came off.",
		lines: [
			{ text: "Nine of those were in one week in February of nineteen seventy-four, when the roof came", y: 212.9 },
			{ text: "off.", y: 190.3 },
		],
	},
];

function textLine(text: string, y: number, height: number): PdfTextLine {
	return { text, x: 80, y, width: 450, height };
}

function fixturePageText(): PdfPageText {
	const lines: PdfTextLine[] = FIXTURE_HEADINGS.map((heading) => textLine(heading.title, heading.y, 12));
	for (const quote of FIXTURE_QUOTES) {
		for (const line of quote.lines) lines.push(textLine(line.text, line.y, 10));
	}
	return { label: "2", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines: lines.sort((a, b) => b.y - a.y) };
}

function fixtureTextDocument(): PdfTextDocument {
	return fakeTextDocument(
		{ 1: fixturePageText() },
		FIXTURE_HEADINGS.map((heading) => ({ pageIndex: 1, x: null, y: heading.y, title: heading.title })),
	);
}

/** A plausible Vision reading of the four margin-note clusters, top-down. */
/**
 * A plausible Vision reading per unmatched cluster, in cluster-enumeration order. With the text
 * layer the page yields six of them -- four margin notes, the body underline (which sits too far
 * from any line to resolve as a mark and comes back empty) and one of the two circles; the other
 * circle lands on the fully highlighted "He missed" line and folds into its quote as a mark.
 */
const VISION_OUTPUT = ["margin note one", "", "margin note two", "margin note three", "stray mark one", "stray mark two"];

// --- synthetic scenes -------------------------------------------------------------------------

function boxStroke(id: string, x: number, y: number, width: number, height: number): RmStroke {
	const point = (px: number, py: number) => ({ x: px, y: py, speed: 0, width: 2, direction: 0, pressure: 1 });
	return { layerId: "0001", id, timestamp: "0001", penType: 2, color: 0, brushSize: 2, points: [point(x, y), point(x + width, y + height)] };
}

function scene(strokes: RmStroke[]): RmPage {
	return { formatVersion: 2, layers: [{ id: "0001", name: null, strokes }] };
}

/** A single long diagonal: one cluster's worth of ink. */
function inkyScene(): RmPage {
	return scene([boxStroke("0a", 0, 0, 200, 200)]);
}

describe("buildDigest without a text layer", () => {
	it("quotes every highlight from the .rm text and renders every note as an entry of its own", async () => {
		const result = await build([fixturePage()], { ocrBackend: fakeOcr() });

		// Seven highlight blocks -- the wrapped runs stay separate without a text layer to merge on --
		// and seven note clusters: the four margin notes plus the underline and the two circles,
		// which nothing can resolve into marks without text.
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(7);
		expect(result.markdown.match(/\^nt-/g)).toHaveLength(7);
		// Nothing anchors without a text layer, and nothing needs to: each note is printed under the
		// page's own heading, which is what an unanchored note has to say -- so each title is empty.
		expect(result.markdown.match(/^> \[!handwritten\]$/gm)).toHaveLength(7);
		expect(result.markdown).toContain("a shelf of rock that the sea had spent a long time deciding not");
		// No text layer means no known run inside a sentence, so nothing is marked (F4's soft fail).
		expect(result.markdown).not.toContain("==");
	});

	// The progress bar counts pages; this pipeline transcribes clusters, which are finer. The fixture
	// page holds seven of them and must still tick once.
	it("reports one page at a time, however many clusters it transcribed", async () => {
		const backend = fakeOcr();
		const recognize = vi.spyOn(backend, "recognize");
		const onPage = vi.fn();

		await build([fixturePage(), fixturePage(inkyScene())], { ocrBackend: backend, onPage });

		expect(recognize).toHaveBeenCalledTimes(8);
		expect(onPage).toHaveBeenCalledTimes(2);
	});

	/**
	 * F18's one gap, closed. With margin notes off a stroke that is not recognised as a mark reaches
	 * the vault nowhere at all, and the reasons it missed -- drawn too low, struck through, over a
	 * patch the text layer does not cover -- cannot be seen from the note.
	 */
	it("names a pen mark it could not match to any text, instead of dropping it in silence", async () => {
		// Wide and flat, so it has the shape of an underline, but drawn across the bottom margin where
		// the text layer has no line for it to point at (the page's lowest line sits at 190 pt; this
		// ink lands at 107).
		const stray = boxStroke("0a", 100, 2150, 600, 1);

		const result = await build([fixturePage(scene([stray]))], { loadText: async () => fixtureTextDocument(), marginNotes: false });

		expect(result.warnings).toEqual([
			"Page 2: a pen mark could not be matched to any text there, so it is not in the digest. The embedded render still shows it.",
		]);
	});

	it("says nothing about ordinary handwriting, which is the setting working as asked", async () => {
		// Too short to be a mark: this is a word, and margin notes being off is not news.
		const word = boxStroke("0a", 100, 2150, 8, 1);

		const result = await build([fixturePage(scene([word]))], { loadText: async () => fixtureTextDocument(), marginNotes: false });

		expect(result.warnings).toEqual([]);
	});

	it("labels the page from its source index and says once that the text could not be read", async () => {
		const result = await build([fixturePage()]);

		expect(result.markdown).toContain("### [[attachments/doc.pdf#page=2|Page 2]]");
		expect(result.warnings).toEqual([
			"The PDF's text could not be read; highlights quote the text recorded on the device and margin notes are not anchored.",
		]);
	});
});

describe("buildDigest with the fixture page's text layer", () => {

	it("quotes the surrounding sentence and marks the highlighted run", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// The wrapped runs merge into one marked range spanning the printed line break.
		expect(result.markdown).toContain(
			"on ==a shelf of rock that the sea had spent a long time deciding not to take.==",
		);
		expect(result.markdown).toContain("somewhere where the ==readings matter more than the reader.==");
		// A run that covers its whole sentence marks nothing: the quote IS the run.
		expect(result.markdown).toContain("He missed eleven readings in nineteen years.");
		expect(result.markdown).not.toContain("==He missed");
		expect(result.warnings).toEqual([]);
	});

	// A book the device rendered from an `.epub`: the conversion loses letters, so the page's text
	// layer is not the author's wording and the original book has to supply it (spec §7 step 2).
	describe("against the original book", () => {
		/**
		 * The fixture's text layer with one word damaged the way the device damages one.
		 *
		 * The damage sits outside the highlighted run on purpose. Only the text layer is damaged here,
		 * while the scene's own highlight text stays clean -- on a real book both come from the same
		 * conversion and carry the same error, and a run that no longer matches the page moves the
		 * markers for a reason that has nothing to do with this correction.
		 */
		function damagedTextDocument(): PdfTextDocument {
			const page = fixturePageText();
			return fakeTextDocument(
				{ 1: { ...page, lines: page.lines.map((line) => ({ ...line, text: line.text.replace("February", "Febrnary") })) } },
				FIXTURE_HEADINGS.map((heading) => ({ pageIndex: 1, x: null, y: heading.y, title: heading.title })),
			);
		}

		const BOOK: EpubBook = { text: "Chapter One. Nine of those were in one week in February of nineteen seventy-four, when the roof came off. The keeper rebuilt it that spring.", chapters: [] };

		it("re-spells a damaged quote in the book's own words, and keeps the run marked", async () => {
			const result = await build([fixturePage()], { loadText: async () => damagedTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) }, async () => BOOK);

			expect(result.markdown).toContain("in February of nineteen seventy-four, when ==the roof came== off.");
			expect(result.markdown).not.toContain("Febrnary");
		});

		it("keeps the device's text, and says so once, when the book cannot be read", async () => {
			const result = await build([fixturePage()], { loadText: async () => damagedTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) }, async () => null);

			expect(result.markdown).toContain("Febrnary");
			expect(result.warnings).toEqual(["The book's own text could not be read; quotes and chapter names keep what the device recorded."]);
		});

		it("keeps a quote it cannot find in the book, and stays quiet about it", async () => {
			// Not a failure worth a line: the device's text is not known to be wrong, and a book has
			// pages this quote could legitimately not be on.
			const result = await build([fixturePage()], { loadText: async () => damagedTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) }, async () => ({ text: "A different book about sailing ships.", chapters: [] }));

			expect(result.markdown).toContain("Febrnary");
			expect(result.warnings).toEqual([]);
		});

		it("names a section the way the book's navigation names it", async () => {
			// What the render found was "One — The station"; the book calls that chapter by its full
			// name, and the digest should say so.
			const chapters = ["Chapter One — The station, 1962 to 1981"];
			const result = await build([fixturePage()], { loadText: async () => damagedTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) }, async () => ({ ...BOOK, chapters }));

			expect(result.markdown).toContain("### Chapter One — The station, 1962 to 1981");
			expect(result.markdown).not.toContain("### One — The station\n");
		});

		it("reads the book once, for the headings and the quotes together", async () => {
			const book = vi.fn(async () => BOOK);

			await build([fixturePage()], { loadText: async () => damagedTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) }, book);

			expect(book).toHaveBeenCalledTimes(1);
		});

		it("does not fetch the book for a page with no heading and no quote on it", async () => {
			// A megabyte nobody should download for a page of ink the book has nothing to say about.
			const book = vi.fn(async () => BOOK);

			await build([fixturePage(inkyScene())], { loadText: async () => fakeTextDocument({ 1: fixturePageText() }) }, book);

			expect(book).not.toHaveBeenCalled();
		});
	});

	it("resolves the page's six clusters to the anchors measured on the real page", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// Three clusters resolve to a quote and say so ("at »..."); the other three sit level with
		// nothing closer than the page itself, so their title carries only the page link. Nothing
		// falls out of the digest, and the seventh cluster is the mark the pen-marks suite covers.
		expect(result.markdown.match(/^> \[!handwritten\] \[\[/gm)).toHaveLength(3);
		expect(result.markdown.match(/\[!handwritten\] at »/g)).toHaveLength(3);
	});

	it("orders the page's entries by section and then top-down", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });
		const sections = result.markdown.match(/^### .+$/gm);

		// Every entry on this page sits below the page's second heading, so one section carries all
		// of it; the multi-section ordering is pinned by the synthetic suites below.
		expect(sections).toEqual(["### One — The station"]);
		// Reading order runs down the page: `top` is a scene coordinate, which grows downwards.
		const first = result.markdown.indexOf("a shelf of rock");
		const last = result.markdown.indexOf("the roof came");
		expect(first).toBeGreaterThan(0);
		expect(last).toBeGreaterThan(first);
	});

	it("gives every note the place its handwriting sits, whatever the real Vision output was", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// All six clusters, including the flawed-but-non-empty readings, whose text stands alone in
		// the entry: only the handwriting says what was really written.
		expect(result.markdown.match(/^> ```remarkable-note$/gm)).toHaveLength(6);
		// Only the underline, which comes back empty, announces itself as untranscribed.
		expect(result.markdown.match(/Handwriting that could not be transcribed\./g)).toHaveLength(1);
		// No image file is named anywhere in the digest -- that is the whole point of the format.
		expect(result.markdown).not.toContain("![[");
		// The id terminates the last *text* line, above the block -- on the closing fence it would take
		// the block apart instead of naming the entry.
		expect(result.markdown).toMatch(/^> margin note one \^nt-[0-9a-f]{6}$/m);
	});

	it("renders no note at all when margin notes are off", async () => {
		const result = await build([fixturePage()], {
			loadText: async () => fixtureTextDocument(),
			ocrBackend: fakeOcr(...VISION_OUTPUT),
			marginNotes: false,
		});

		expect(result.markdown).not.toContain("[!handwritten]");
		expect(result.markdown).not.toContain("margin note one");
		// The highlights are untouched -- the setting is about handwriting, not about the digest.
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(4);
	});

	it("makes no OCR call at all when margin notes are off", async () => {
		const backend = fakeOcr(...VISION_OUTPUT);
		const recognize = vi.spyOn(backend, "recognize");

		await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: backend, marginNotes: false });

		expect(recognize).not.toHaveBeenCalled();
	});

	it("derives the line height from the lower quartile of the baseline gaps, not from their mode", async () => {
		// A page of one-line paragraphs: 14 gaps of 25 pt against 6 of 13 pt, so mode and median both
		// say 25. The note sits 20 pt below the heading -- inside a 25 pt tolerance, outside a 13 pt
		// one -- so it must not come out as "at the heading".
		const gaps = [13, 25, 13, 25, 25, 13, 25, 25, 13, 25, 25, 13, 25, 25, 13, 25, 25, 25, 25, 25];
		const lines: PdfTextLine[] = [];
		let y = PAGE_HEIGHT_PT - 100;
		for (const gap of gaps) {
			lines.push(textLine(`Zeile bei ${y}.`, y, 10));
			y -= gap;
		}
		const document = fakeTextDocument(
			{ 0: { label: "1", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines } },
			[{ pageIndex: 0, x: null, y: 720, title: "Ein Abschnitt" }],
		);
		// Scene y for a cluster centred 20 pt below the heading, i.e. at PDF y 700.
		const top = (PAGE_HEIGHT_PT - 700) / PX_TO_PT - 15;
		const page: DigestPageInput = { pageId: "p", sourceIndex: 0, embedPage: 1, scene: scene([boxStroke("0a", 0, top, 100, 30)]) };

		const result = await build([page], { loadText: async () => document, ocrBackend: fakeOcr("Notiz") });

		expect(result.markdown).not.toContain("[!handwritten] at the heading");
		expect(result.markdown).toContain("[!handwritten] at »");
	});
});

describe("buildDigest sections across pages", () => {
	/** A page carrying one highlight at `highlightY` and, optionally, one heading line at `headingY`. */
	function sectionPage(sourceIndex: number, highlightY: number, heading?: { y: number; title: string }) {
		const lines: PdfTextLine[] = [textLine("Ein Satz auf dieser Seite.", highlightY, 10)];
		if (heading) lines.push(textLine(heading.title, heading.y, 12));
		const text: PdfPageText = {
			label: String(sourceIndex + 1),
			width: PAGE_WIDTH_PT,
			height: PAGE_HEIGHT_PT,
			lines: lines.sort((a, b) => b.y - a.y),
		};
		// The highlight's scene rect, converted back from the PDF box the text line occupies (x runs
		// from the page midline in scene coordinates, y from the page top).
		const rect = {
			x: (80 - PAGE_WIDTH_PT / 2) / PX_TO_PT,
			y: (PAGE_HEIGHT_PT - highlightY - 10) / PX_TO_PT,
			width: 450 / PX_TO_PT,
			height: 10 / PX_TO_PT,
		};
		const scene: RmPage = {
			formatVersion: 2,
			layers: [],
			highlights: [{ id: `h${sourceIndex}`, color: 0, text: "Ein Satz auf dieser Seite.", rects: [rect] }],
		};
		const page: DigestPageInput = { pageId: `p${sourceIndex}`, sourceIndex, embedPage: sourceIndex + 1, scene };
		return { page, text };
	}

	it("carries the section still open from the page before to a page whose annotation sits above its own first heading", async () => {
		const first = sectionPage(0, 600, { y: 700, title: "Erster Abschnitt" });
		const second = sectionPage(1, 600, { y: 400, title: "Zweiter Abschnitt" });
		const document = fakeTextDocument({ 0: first.text, 1: second.text }, [
			{ pageIndex: 0, x: null, y: 700, title: "Erster Abschnitt" },
			{ pageIndex: 1, x: null, y: 400, title: "Zweiter Abschnitt" },
		]);

		const result = await build([first.page, second.page], { loadText: async () => document });

		// One heading for the section, and the page each entry sits on in the entry's own link.
		expect(result.markdown.match(/^### .+$/gm)).toEqual(["### Erster Abschnitt"]);
		expect(result.markdown).toContain("#page=1|p. 1]]");
		expect(result.markdown).toContain("#page=2|p. 2]]");
		expect(result.markdown).not.toContain("Zweiter Abschnitt");
	});

	it("takes a heading on the entry's own page when the entry sits below it", async () => {
		const first = sectionPage(0, 600, { y: 700, title: "Erster Abschnitt" });
		const second = sectionPage(1, 300, { y: 400, title: "Zweiter Abschnitt" });
		const document = fakeTextDocument({ 0: first.text, 1: second.text }, [
			{ pageIndex: 0, x: null, y: 700, title: "Erster Abschnitt" },
			{ pageIndex: 1, x: null, y: 400, title: "Zweiter Abschnitt" },
		]);

		const result = await build([first.page, second.page], { loadText: async () => document });

		expect(result.markdown).toContain("### Zweiter Abschnitt\n\nEin Satz auf dieser Seite. · [[attachments/doc.pdf#page=2|p. 2]]");
	});

	it("orders a heading without a y at the top of its page", async () => {
		const first = sectionPage(0, 600, { y: 700, title: "Erster Abschnitt" });
		const second = sectionPage(1, 600);
		const document = fakeTextDocument({ 0: first.text, 1: second.text }, [
			{ pageIndex: 0, x: null, y: 700, title: "Erster Abschnitt" },
			// A Fit destination: no coordinate, so it opens its page and every entry on it belongs to it.
			{ pageIndex: 1, x: null, y: null, title: "Ganze Seite" },
		]);

		const result = await build([first.page, second.page], { loadText: async () => document });

		expect(result.markdown).toContain("### Ganze Seite\n\nEin Satz auf dieser Seite. · [[attachments/doc.pdf#page=2|p. 2]]");
	});

	/**
	 * On a two-column page y is not reading order: the right column's headings all sit higher than the
	 * left column's text while coming after it. Taking y for the answer put every left-column
	 * annotation of the acceptance paper -- a third of its lines -- under a heading from the column
	 * beside it.
	 */
	it("takes the section from reading order, not from what sits higher on a two-column page", async () => {
		const column = (text: string, x: number, y: number, height: number): PdfTextLine => ({ text, x, y, width: 200, height });
		const marked = "Ein Satz in der linken Spalte.";
		const text: PdfPageText = {
			label: "1",
			width: PAGE_WIDTH_PT,
			height: PAGE_HEIGHT_PT,
			// Reading order: the whole left column, then the whole right one.
			lines: [
				column("1 Einleitung", 80, 700, 12),
				column(marked, 80, 600, 10),
				// Lower on the page than the heading above, but later in the text.
				column("2 Methode", 330, 650, 12),
				column("Ein Satz in der rechten Spalte.", 330, 560, 10),
			],
		};
		const rect = {
			x: (80 - PAGE_WIDTH_PT / 2) / PX_TO_PT,
			y: (PAGE_HEIGHT_PT - 600 - 10) / PX_TO_PT,
			width: 200 / PX_TO_PT,
			height: 10 / PX_TO_PT,
		};
		const page: DigestPageInput = {
			pageId: "p0",
			sourceIndex: 0,
			embedPage: 1,
			scene: { formatVersion: 2, layers: [], highlights: [{ id: "h0", color: 0, text: marked, rects: [rect] }] },
		};
		const document = fakeTextDocument({ 0: text }, [
			{ pageIndex: 0, x: 80, y: 700, title: "1 Einleitung" },
			{ pageIndex: 0, x: 330, y: 650, title: "2 Methode" },
		]);

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown).toContain("### 1 Einleitung");
		expect(result.markdown).not.toContain("2 Methode");
	});

	it("renders no section at all for a document without headings", async () => {
		const first = sectionPage(0, 600);
		const second = sectionPage(1, 600);
		const document = fakeTextDocument({ 0: first.text, 1: second.text });

		const result = await build([first.page, second.page], { loadText: async () => document });

		expect(result.markdown.match(/^### /gm)).toHaveLength(2);
		expect(result.markdown).not.toContain("]] · ");
		expect(result.markdown.match(/^\*\*(.+)\*\*$/gm)).toBeNull();
	});
});

describe("buildDigest merges highlights that share a sentence", () => {
	const SENTENCE = "Wenn du eine harte Obergrenze benötigst, ist erweitertes Denken weiterhin funktionsfähig.";

	/** A page whose text is one line per sentence, with a highlight rectangle over each given run. */
	function sharedSentencePage(sentences: string[], runs: { sentence: number; from: number; to: number }[]) {
		const lines = sentences.map((sentence, index) => textLine(sentence, 700 - index * 13, 10));
		const text: PdfPageText = { label: "1", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines };
		const scene: RmPage = {
			formatVersion: 2,
			layers: [],
			highlights: runs.map((run, index) => {
				const line = lines[run.sentence];
				const share = (at: number) => (line.width * at) / line.text.length;
				return {
					id: `h${index}`,
					color: 0,
					text: line.text.slice(run.from, run.to),
					rects: [
						{
							x: (line.x + share(run.from) - PAGE_WIDTH_PT / 2) / PX_TO_PT,
							y: (PAGE_HEIGHT_PT - line.y - line.height) / PX_TO_PT,
							width: (share(run.to) - share(run.from)) / PX_TO_PT,
							height: line.height / PX_TO_PT,
						},
					],
				};
			}),
		};
		const page: DigestPageInput = { pageId: "p", sourceIndex: 0, embedPage: 1, scene };
		return { page, document: fakeTextDocument({ 0: text }) };
	}

	it("prints one quote carrying every run when two highlights cover the same sentence", async () => {
		const { page, document } = sharedSentencePage([SENTENCE], [
			{ sentence: 0, from: 0, to: 20 },
			{ sentence: 0, from: 40, to: 62 },
		]);

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(1);
		expect(result.markdown.match(/==/g)).toHaveLength(4);
	});

	it("keeps the id of the topmost contributing highlight and its position", async () => {
		const { page, document } = sharedSentencePage(["Ein erster Satz auf dieser Seite steht hier.", SENTENCE], [
			// The lower highlight comes first in the scene, so the surviving id cannot be "the first one".
			{ sentence: 1, from: 0, to: 20 },
			{ sentence: 1, from: 40, to: 62 },
			{ sentence: 0, from: 0, to: 10 },
		]);
		const single = await build([{ ...page, scene: { ...page.scene!, highlights: [page.scene!.highlights![0]] } }], {
			loadText: async () => document,
		});

		const result = await build([page], { loadText: async () => document });

		// Two entries left, the merged one keeps `h0`'s id, and it still sorts below the other sentence.
		const ids = result.markdown.match(/\^hl-[0-9a-f]{6}/g) ?? [];
		expect(ids).toHaveLength(2);
		expect(ids[1]).toBe(single.markdown.match(/\^hl-[0-9a-f]{6}/)?.[0]);
	});

	// The Alice bug: one marker stroke across a line break arrives as one run per line. The closing
	// quote before the parenthetical made the two runs' sentences overlap without containment, so
	// they never merged -- the digest printed `(Which was very likely true.)` twice, once behind a
	// stranded `”`.
	it("does not print the parenthetical of one marker stroke twice when it crosses the line break", async () => {
		const line0 = "Why, I wouldn’t say anything about it, even if I fell off the top of the house!”";
		const line1 = "(Which was very likely true.) Down, down, down.";
		const { page, document } = sharedSentencePage([line0, line1], [
			{ sentence: 0, from: 0, to: line0.length },
			{ sentence: 1, from: 0, to: "(Which was very likely true.)".length },
		]);

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown.match(/\(Which was very likely true\.\)/g)).toHaveLength(1);
		expect(result.markdown).not.toMatch(/^”/m);
	});

	// One drawn marker gesture across wrapped lines arrives as one run per line, in the wrap shape:
	// every junction has the upper run reaching the right margin and the lower one starting at the
	// left. The reader drew one highlight, so the digest owes them one entry -- not one per sentence
	// the gesture happened to cross.
	it("prints one marker stroke across several wrapped lines as one entry", async () => {
		const lines = [
			"“Well!” thought Alice, “after such a fall I shall think nothing of stairs!",
			"How brave they’ll all think me at home! Why, I wouldn’t say anything now!”",
			"(Which was very likely true.)",
		];
		const { page, document } = sharedSentencePage(lines, [
			{ sentence: 0, from: 5, to: lines[0].length },
			{ sentence: 1, from: 0, to: lines[1].length },
			{ sentence: 2, from: 0, to: lines[2].length },
		]);

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(1);
		expect(result.markdown).toContain("How brave they’ll all think me at home!");
		expect(result.markdown).toContain("(Which was very likely true.)");
	});

	it("does not merge wrapped lines drawn in different colors", async () => {
		const lines = ["“Well!” thought Alice, “after such a fall I shall think nothing of stairs!", "How brave they’ll all think me at home!"];
		const { page, document } = sharedSentencePage(lines, [
			{ sentence: 0, from: 5, to: lines[0].length },
			{ sentence: 1, from: 0, to: lines[1].length },
		]);
		page.scene!.highlights![1] = { ...page.scene!.highlights![1], color: 5 };

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(2);
	});

	// A run whose rectangles hang in the margin sits on no text line; the wrap test must fail it
	// rather than glue it to whatever run happens to be stacked above.
	it("does not merge a run whose rectangles sit on no text line", async () => {
		const lines = ["“Well!” thought Alice, “after such a fall I shall think nothing of stairs!", "How brave they’ll all think me at home!"];
		const { page, document } = sharedSentencePage(lines, [
			{ sentence: 0, from: 5, to: lines[0].length },
			{ sentence: 1, from: 0, to: lines[1].length },
		]);
		// Push the second run's rectangle right of the text column: same drop, but on no line.
		const second = page.scene!.highlights![1];
		page.scene!.highlights![1] = { ...second, rects: second.rects.map((rect) => ({ ...rect, x: rect.x + 2000 })) };

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(2);
	});

	// The device may store a run with text but no rectangles at all; it must neither crash the sort
	// nor be glued onto a gesture it cannot be located against.
	it("leaves a highlight with no rectangles out of the gesture merge", async () => {
		const lines = ["“Well!” thought Alice, “after such a fall I shall think nothing of stairs!", "How brave they’ll all think me at home!"];
		const { page, document } = sharedSentencePage(lines, [
			{ sentence: 0, from: 5, to: lines[0].length },
			{ sentence: 1, from: 0, to: lines[1].length },
		]);
		page.scene!.highlights!.push({ id: "hx", color: 0, text: "a rectless run", rects: [] });

		const result = await build([page], { loadText: async () => document });

		// The wrapped pair still merges; the rectless run stands alone on the device's own text.
		expect(result.markdown).toContain("a rectless run");
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(2);
	});

	// The device can hand one run several rectangles of its own; the junction test then reads the
	// lowest of the upper run against the highest of the lower one.
	it("merges runs that already carry several rectangles by their outermost lines", async () => {
		const lines = [
			"“Well!” thought Alice, “after such a fall I shall think nothing of stairs!",
			"How brave they’ll all think me at home! Why, I wouldn’t say anything now!”",
			"(Which was very likely true.) Down, down, down. Would the fall never end?",
		];
		const { page, document } = sharedSentencePage(lines, [
			{ sentence: 0, from: 5, to: lines[0].length },
			{ sentence: 1, from: 0, to: lines[1].length },
			{ sentence: 2, from: 0, to: lines[2].length },
		]);
		const [first, second, third] = page.scene!.highlights!;
		// The first two lines arrive as ONE run with several rectangles, deliberately out of order --
		// the outermost-line lookup must not depend on the order the device stored them in.
		const jitter = { ...first.rects[0], y: first.rects[0].y + 1 };
		page.scene!.highlights = [{ ...first, text: `${first.text} ${second.text}`, rects: [...second.rects, ...first.rects, jitter] }, third];

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(1);
	});

	it("leaves highlights on different sentences alone", async () => {
		const { page, document } = sharedSentencePage(["Ein erster Satz auf dieser Seite steht hier.", SENTENCE], [
			{ sentence: 0, from: 0, to: 10 },
			{ sentence: 1, from: 0, to: 20 },
		]);

		const result = await build([page], { loadText: async () => document });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(2);
	});

	it("re-points a note anchored to a merged-away highlight at the surviving quote", async () => {
		const { page, document } = sharedSentencePage([SENTENCE], [
			{ sentence: 0, from: 0, to: 20 },
			{ sentence: 0, from: 40, to: 62 },
		]);
		// A cluster level with the sentence and just right of it: far from the first highlight's
		// rectangle, close to the *second* one -- which is the one the merge drops.
		const scenePt = (pt: number) => pt / PX_TO_PT;
		const strokes = [
			boxStroke("0a", scenePt(410 - PAGE_WIDTH_PT / 2), scenePt(PAGE_HEIGHT_PT - 710), scenePt(40), scenePt(10)),
		];
		const scene: RmPage = { ...page.scene!, layers: [{ id: "0001", name: null, strokes }] };

		const result = await build([{ ...page, scene }], { loadText: async () => document, ocrBackend: fakeOcr("Dazu.") });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(1);
		// No heading on this page, so the page is the heading and carries the link -- the entries, this
		// note included, carry none.
		expect(result.markdown).toContain("> [!handwritten]\n> Dazu.");
	});
});

describe("buildDigest note regions", () => {
	const withText = { loadText: async () => fixtureTextDocument() };

	/**
	 * The rectangle is the ink's own box, with y measured from the page top -- the axis a pdf.js
	 * viewport uses. `clusterRect` works in the PDF's bottom-left frame, which the anchor cascade needs
	 * and a viewport does not, so a note printed near the top of the page must come out with a *small*
	 * y. Getting this backwards would draw every note from the mirror-image strip of paper.
	 */
	it("measures the rectangle from the page top", async () => {
		const result = await build([fixturePage()], { ...withText, ocrBackend: fakeOcr(...VISION_OUTPUT) });

		const ys = [...result.markdown.matchAll(/^> rect: \d+ (\d+) \d+ \d+$/gm)].map((match) => Number(match[1]));
		expect(ys).toHaveLength(6);
		// Reading order runs down the page, and so does this axis: the clusters' y values only grow.
		expect([...ys].sort((a, b) => a - b)).toEqual(ys);
		// The topmost cluster is the "built on rock" note beside the first paragraph, measured at
		// 174 pt from the page top.
		expect(ys[0]).toBeGreaterThan(160);
		expect(ys[0]).toBeLessThan(190);
	});

	/**
	 * A note written off the paper is drawn shrunk onto its page (`annotatedPageFit`), and a pdf.js
	 * viewport measures what was drawn. Read off the source page's own coordinates instead, this
	 * rectangle would come out at x -44 -- a place no page has, and every band on the page would open
	 * 44 pt to the left of the handwriting it was asked for.
	 */
	it("measures the rectangle where the renderer drew the ink, not where the source page had it", async () => {
		// 1100 px left of the midline, on a 612 pt page whose own half-width is 960 px. Level with no
		// text line (2300 px is below the fixture's prose), so the paragraph expansion stays out of it
		// and the rectangle is the ink's own box -- what this test is about is the fit transform.
		const marginNote = scene([boxStroke("0a", -1100, 2300, 100, 20)]);

		const result = await build([fixturePage(marginNote)], { ...withText, ocrBackend: fakeOcr("Am Rand.") });

		expect(result.markdown).toContain("Am Rand.");
		// Hard against the page's left edge, and 32 pt of ink drawn at the 93 % the page had room for.
		expect(result.markdown).toMatch(/^> rect: 0 \d+ 30 \d+$/m);
	});

	it("names the page of the embed, which is the page its link points at", async () => {
		const result = await build([fixturePage()], { ...withText, ocrBackend: fakeOcr(...VISION_OUTPUT) });

		expect(result.markdown.match(/^> page: 2$/gm)).toHaveLength(6);
	});

	/**
	 * Without a text layer the frame is the device screen rather than the page (see `buildDigest`), so
	 * the rectangle would not name a place in the PDF at all. Better no button than one that opens the
	 * wrong strip of paper -- and such a document already says its text could not be read.
	 */
	it("leaves the block off a page whose text could not be read", async () => {
		const result = await build([fixturePage()], { ocrBackend: fakeOcr(...VISION_OUTPUT) });

		expect(result.markdown.match(/\^nt-/g)).toHaveLength(7);
		expect(result.markdown).not.toContain("remarkable-note");
	});

	it("says in words that nothing was transcribed, instead of leaving the entry empty", async () => {
		const result = await build([{ pageId: "p", sourceIndex: 0, embedPage: 1, scene: inkyScene() }], { ocrBackend: fakeOcr("") });

		expect(result.markdown).toContain("Handwriting that could not be transcribed.");
	});

	// The clip exists so the reader sees what the note is *about*: handwriting beside the last line
	// of a paragraph, clipped to its own box, shows one line of prose and no context at all.
	it("spans the whole paragraph the handwriting sits beside, so the clip carries its context", async () => {
		const lines = [
			textLine("Poor Alice! It was as much as she could do, lying down on one side, to look", 700, 10),
			textLine("through into the garden with one eye; but to get through was more hopeless", 687, 10),
			textLine("than ever: she sat down and began to cry again.", 674, 10),
		];
		const text: PdfPageText = { label: "1", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines };
		// Ink in the right margin, level with the paragraph's LAST line (pdf top edge 684).
		const toSceneX = (pt: number) => (pt - PAGE_WIDTH_PT / 2) / PX_TO_PT;
		const toSceneY = (ptTop: number) => (PAGE_HEIGHT_PT - ptTop) / PX_TO_PT;
		const ink = scene([boxStroke("0a", toSceneX(540), toSceneY(684), 40 / PX_TO_PT, 10 / PX_TO_PT)]);

		const result = await build([{ pageId: "p", sourceIndex: 0, embedPage: 1, scene: ink }], {
			loadText: async () => fakeTextDocument({ 0: text }),
			ocrBackend: fakeOcr("Why is Alice poor?"),
		});

		expect(result.markdown).toContain("Why is Alice poor?");
		const rect = result.markdown.match(/^> rect: (\d+) (\d+) (\d+) (\d+)$/m);
		expect(rect).not.toBeNull();
		const [, , top, , height] = rect!.map(Number);
		// The region reaches up to the paragraph's first line (top edge 710 pt -> 82 pt from the page
		// top) and down over the ink -- not just the ink's own 10 pt strip beside the last line.
		expect(top).toBeLessThan(90);
		expect(top + height).toBeGreaterThan(115);
	});

	// The one that matters: a transcription no heuristic can fault -- long, plausible, confident --
	// still carries its region, because "plausible" is exactly what a misread looks like from here.
	it("carries the region under a healthy transcription too", async () => {
		const result = await build([fixturePage()], { ...withText, ocrBackend: fakeOcr("eine ganze Zeile Handschrift dazu") });

		expect(result.markdown).toContain("eine ganze Zeile Handschrift dazu");
		expect(result.markdown).toMatch(/^> ```remarkable-note$/m);
	});
});

/**
 * The reported case: one sentence written down the right margin of a paper arrived as four callouts,
 * each transcribed on its own and one of them anchored somewhere else entirely. The fake page's text
 * ends at 530 pt, so ink out at scene x 750 stands past it -- in the margin, where merging is safe.
 */
describe("buildDigest margin blocks", () => {
	const marginBlock = scene([
		boxStroke("0a", 750, 700, 250, 30),
		boxStroke("0b", 750, 745, 230, 30),
		boxStroke("0c", 750, 790, 240, 30),
	]);

	it("prints three lines written down the margin as one entry, transcribed once", async () => {
		const ocr = fakeOcr("Das gehört zusammen.", "zweiter Aufruf", "dritter Aufruf");

		const result = await build([fixturePage(marginBlock)], { loadText: async () => fixtureTextDocument(), ocrBackend: ocr });

		expect(result.markdown.match(/\^nt-/g)).toHaveLength(1);
		expect(result.markdown).toContain("Das gehört zusammen.");
		// One cluster, so the backend was asked once: the second answer is never used.
		expect(result.markdown).not.toContain("zweiter Aufruf");
	});

	/** The block is one rectangle, so its band shows all three lines at once rather than a third of the note. */
	it("carries one region that covers the whole block", async () => {
		const result = await build([fixturePage(marginBlock)], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr("Das gehört zusammen.") });

		const rects = [...result.markdown.matchAll(/^> rect: \d+ \d+ \d+ (\d+)$/gm)].map((match) => Number(match[1]));
		expect(rects).toHaveLength(1);
		// 120 px of scene from the first line's top to the last line's bottom, at 72/226 pt per px.
		expect(rects[0]).toBeGreaterThan(35);
	});

	/** Without a text layer there is no column, so there is no way to tell a margin from the text -- and nothing merges. */
	it("leaves the lines apart on a page whose text could not be read", async () => {
		const result = await build([fixturePage(marginBlock)], { ocrBackend: fakeOcr("eins", "zwei", "drei") });

		expect(result.markdown.match(/\^nt-/g)).toHaveLength(3);
	});
});

describe("buildDigest resilience", () => {
	it("keeps every margin note when OCR is off or unavailable, leaving the highlights alone", async () => {
		const off: OcrBackend = { id: "off", metered: false, fingerprint: "test-backend", recognize: async () => ({ status: "unavailable", pages: null, text: "", confidence: null }) };

		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: off });

		expect(result.markdown.match(/Handwriting that could not be transcribed\./g)).toHaveLength(6);
		expect(result.markdown.match(/^> ```remarkable-note$/gm)).toHaveLength(6);
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(4);
		expect(result.markdown).toContain("somewhere where the ==readings matter more than the reader.==");
	});

	it("turns a throwing OCR backend into warnings and entries rather than an exception", async () => {
		const result = await build([fixturePage()], { ocrBackend: throwingOcr() });

		expect(result.warnings.filter((warning) => warning.includes("could not be transcribed"))).toHaveLength(7);
		expect(result.warnings[1]).toContain("vision is not installed");
		expect(result.markdown.match(/Handwriting that could not be transcribed\./g)).toHaveLength(7);
	});

	it("warns when a page carries no text layer of its own", async () => {
		const result = await build([fixturePage()], { loadText: async () => fakeTextDocument({}) });

		expect(result.warnings).toEqual([
			"Page 2: the PDF has no readable text there, so highlights quote the text recorded on the device.",
		]);
	});

	// A whole-document unit walks every page of a book or an article, and those end in pages that are
	// one picture: measured on an extension-captured article, whose last two pages carry no text item
	// at all. Nothing on such a page fell back to anything.
	it("stays quiet about a page with no text layer and nothing marked on it", async () => {
		const result = await build([fixturePage(scene([]))], { loadText: async () => fakeTextDocument({}) });

		expect(result.warnings).toEqual([]);
	});

	it("reports a text layer that could not be opened at all", async () => {
		const result = await build([fixturePage()], {
			loadText: () => Promise.reject(new Error("pdf.js is missing")),
		});

		expect(result.warnings[0]).toContain("pdf.js is missing");
		// The device's own recorded highlight text still carries every entry (F4's soft fail).
		expect(result.markdown).toContain("a shelf of rock that the sea had spent a long time deciding not\n^hl-");
	});
});

describe("buildDigest on pen marks", () => {
	/** The scene y whose ink top lands at `pdfTop` on the fixture page -- `sceneRectToPdf` inverted. */
	const sceneYForPdfTop = (pdfTop: number) => (PAGE_HEIGHT_PT - pdfTop) / PX_TO_PT;
	/** The scene x that lands at `pdfX`, with the page's midline at scene x 0. */
	const sceneXForPdfX = (pdfX: number) => pdfX / PX_TO_PT - PAGE_WIDTH_PT / PX_TO_PT / 2;

	/**
	 * An underline under the opening words of the second quote's first line ("He had asked for the
	 * posting…"). 4 pt of clearance under it, and 110 pt long -- past the 2.5 line heights a mark
	 * needs, and well short of the highlighted run at the line's end.
	 */
	function underlinedScene(): RmPage {
		const y = sceneYForPdfTop(382.4 - 4);
		const x = sceneXForPdfX(80);
		return scene([boxStroke("0a", x, y, 110 / PX_TO_PT, 1)]);
	}

	it("quotes the text an underline sits under instead of transcribing the line itself", async () => {
		const result = await build([fixturePage(underlinedScene())], { loadText: async () => fixtureTextDocument() });

		expect(result.markdown).toContain("==He had asked for the posting in a letter of==");
		expect(result.markdown).toContain("^hl-");
		// The failure this replaces: a callout holding a picture of a line, with whatever OCR made of it.
		expect(result.markdown).not.toContain("[!handwritten]");
	});

	it("makes no OCR call for it -- a line has no transcription to get wrong", async () => {
		const recognize = vi.fn().mockResolvedValue({ status: "ok", pages: null, text: "176", confidence: null });

		await build([fixturePage(underlinedScene())], {
			loadText: async () => fixtureTextDocument(),
			ocrBackend: { id: "vision", metered: false, fingerprint: "test-backend", recognize },
		});

		expect(recognize).not.toHaveBeenCalled();
	});

	it("keeps the mark with handwritten notes off: its text comes from the PDF, not from the reader's hand", async () => {
		const result = await build([fixturePage(underlinedScene())], {
			loadText: async () => fixtureTextDocument(),
			marginNotes: false,
		});

		expect(result.markdown).toContain("==He had asked for the posting in a letter of==");
	});

	it("leaves the mark a note when the page has no text layer, since nothing can be resolved there", async () => {
		const result = await build([fixturePage(underlinedScene())], { ocrBackend: fakeOcr("176") });

		expect(result.markdown).toContain("[!handwritten]\n");
	});

	it("keeps the marker highlight's id when a mark lands on a sentence that already had one", async () => {
		// The fixture page already highlights the sentence the underline sits under, so the two merge.
		const underlined = fixtureScene();
		underlined.layers[0].strokes.push(...(underlinedScene().layers[0].strokes ?? []));
		const run = (page: RmPage) =>
			build([fixturePage(page)], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		const plain = await run(fixtureScene());
		const marked = await run(underlined);

		const idOf = (markdown: string) => /He had asked for the posting[^\n]*\n\^(hl-[0-9a-f]{6})/.exec(markdown)?.[1];
		expect(idOf(plain.markdown)).toBeDefined();
		expect(idOf(marked.markdown)).toBe(idOf(plain.markdown));
	});

	it("does not take the fixture page's own handwriting for marks", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// The six clusters and four quotes the page measurably produces, and not one more of either
		// -- handwriting must not be misread as underlines just because text sits near it.
		expect(result.markdown.match(/\^nt-/g)).toHaveLength(6);
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(4);
	});
});

describe("buildDigest determinism", () => {
	it("renders byte-identical markdown twice", async () => {
		const run = () => build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		const first = await run();
		const second = await run();

		expect(second.markdown).toBe(first.markdown);
		expect(second.warnings).toEqual(first.warnings);
	});
});

describe("buildDigest page selection", () => {
	it("skips a page with neither a highlight nor a margin note", async () => {
		const pages: DigestPageInput[] = [
			{ pageId: "blank", sourceIndex: 0, embedPage: 1, scene: null },
			fixturePage(),
		];

		const result = await build(pages, { ocrBackend: fakeOcr() });

		expect(result.markdown.match(/^### /gm)).toHaveLength(1);
	});

	it("returns an empty digest for a document with no annotations at all", async () => {
		const result = await build([{ pageId: "blank", sourceIndex: 0, embedPage: 1, scene: null }]);

		expect(result.markdown).toBe("");
	});
});

/**
 * A page the user added on the device behind the PDF's own pages (F21): no `cPages.redir`, so it maps
 * to no source page. The fixture scene stands in for its ink -- what is under test is the *shape* of
 * what such a page produces, not which strokes it holds.
 */
describe("buildDigest on a page added on the device", () => {
	function appendedPage(): DigestPageInput {
		return { pageId: "added-page", sourceIndex: 15, embedPage: 16, scene: fixtureScene(), appended: true };
	}

	it("transcribes the whole page as one entry instead of one note per line", async () => {
		const ocr = vi.fn().mockResolvedValue({ status: "ok", text: "first line\nsecond line", confidence: null });

		const result = await build([appendedPage()], { ocrBackend: { id: "vision", metered: false, fingerprint: "test-backend", recognize: ocr } });

		// One OCR call for the page, where the margin-note path makes one per cluster.
		expect(ocr).toHaveBeenCalledTimes(1);
		expect(result.markdown.match(/^> \[!handwritten\]/gm)).toHaveLength(1);
		expect(result.markdown).toContain("[!handwritten] Handwritten page");
		expect(result.markdown).toContain("> first line\n> second line");
	});

	it("carries no region for it: there is no source page to draw its ink out of", async () => {
		const result = await build([appendedPage()], { ocrBackend: fakeOcr("some text") });

		expect(result.markdown).not.toContain("remarkable-note");
		expect(result.markdown).not.toContain("![[");
	});

	it("does not report the PDF's missing text for it, which is neither missing nor a failure", async () => {
		// A document whose pages exist only up to index 0 -- exactly what a 15-page PDF does to page 16.
		const text = fakeTextDocument({ 0: { label: "1", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines: [] } });

		const result = await build([appendedPage()], { loadText: async () => text, ocrBackend: fakeOcr("text") });

		expect(result.warnings).toEqual([]);
	});

	it("gives it its own heading rather than the last section of a document it is not part of", async () => {
		const headings: PdfHeading[] = [{ pageIndex: 0, x: null, y: 700, title: "A chapter of the PDF" }];
		const text = fakeTextDocument({ 0: { label: "1", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines: [] } }, headings);

		const result = await build([appendedPage()], { loadText: async () => text, ocrBackend: fakeOcr("text") });

		expect(result.markdown).toContain("### [[attachments/doc.pdf#page=16|Added page]]");
		expect(result.markdown).not.toContain("A chapter of the PDF");
	});

	// Measured on a real device: a page inserted after page 8 of *Alice* used to be headed "Page 9",
	// which is a page of the book that exists, is elsewhere, and had a synced note of its own.
	it("does not name itself after the source page whose number it happens to sit at", async () => {
		const result = await build([appendedPage()], { ocrBackend: fakeOcr("text") });

		expect(result.markdown).not.toContain("Page 16");
	});

	it("drops it entirely with handwritten notes off, like every other handwriting on the page", async () => {
		const ocr = vi.fn();

		const result = await build([appendedPage()], { marginNotes: false, ocrBackend: { id: "vision", metered: false, fingerprint: "test-backend", recognize: ocr } });

		expect(result.markdown).toBe("");
		expect(ocr).not.toHaveBeenCalled();
	});
});

// A page whose text was typed rather than carried by a source PDF: an article the "Read on
// reMarkable" extension sent to the device as a notebook, a page written with the Type Folio. There
// is no PDF to read the text out of and no source page to place it against -- the text, the
// highlights over it and the ink beside it are one scene in one frame.
describe("typed text as the document", () => {
	const SCREEN = resolveDeviceCanvas([]);
	const SENTENCE = "Context engineering is the art and science of curating what will go into the limited context window. ";

	/** A text box of `SENTENCE` repeated, which wraps into a column of prose the way the device wraps it. */
	function typedScene(overrides: Partial<RmPage> = {}, styles: RmText["styles"] = new Map()): RmPage {
		return {
			formatVersion: 2,
			layers: [],
			text: { posX: -468, posY: 234, width: 936, runs: [{ id: "1:10", text: SENTENCE.repeat(6), deleted: 0 }], styles },
			...overrides,
		};
	}

	/** A highlight covering the whole of one laid-out line, in the scene's own frame. */
	function highlightOfLine(scene: RmPage, index: number): RmHighlight {
		const line = layoutText(scene.text!).lines[index];
		return {
			id: "h0",
			color: 3,
			text: "",
			// Scene y grows down and a line's y is its baseline, so the glyphs stand above it.
			rects: [{ x: line.xPx, y: line.yPx - PLAIN_TEXT_SIZE_PX, width: 800, height: PLAIN_TEXT_SIZE_PX }],
		};
	}

	function typedPage(scene: RmPage): DigestPageInput {
		return { pageId: "page-a", sourceIndex: 0, embedPage: 1, scene };
	}

	function buildTyped(pages: DigestPageInput[], overrides: Partial<DigestPipelineDeps> = {}) {
		return buildDigest(deps(overrides), { source: { kind: "typed-text" }, embedPath: "attachments/doc.pdf", pages });
	}

	it("quotes the typed text a highlight covers, out of the scene and not out of a PDF", async () => {
		const scene = typedScene();
		scene.highlights = [highlightOfLine(scene, 2)];

		const result = await buildTyped([typedPage(scene)]);

		// The whole sentence, with the covered run marked inside it -- and the sentence runs across the
		// line the highlight sits on, so it was read out of the page's own typed text rather than out of
		// anything the device recorded with the highlight (which is nothing: its `text` is empty).
		const marked = /==([^=]+)==/.exec(result.markdown)?.[1] ?? "";
		// What was marked came off the line the rectangle covers, rounded back to whole words...
		expect(marked).not.toBe("");
		expect(layoutText(scene.text!).lines[2].text.startsWith(marked)).toBe(true);
		// ...and the quote around it is the whole sentence, which runs past that line in both
		// directions -- so it was read from the page's typed text, not from the one line.
		expect(result.markdown.replace(/==/g, "")).toContain(SENTENCE.trim());
		expect(result.warnings).toEqual([]);
	});

	it("anchors a margin note under the typed heading it sits level with", async () => {
		// The heading style is the only thing marking a section on such a page: there is no outline.
		const scene = typedScene({}, new Map([["0:0", 3]]));
		const heading = layoutText(scene.text!).lines[0];
		scene.layers = [{ id: "0001", name: null, strokes: [boxStroke("s1", 620, heading.yPx, 40, 60)] }];

		const result = await buildTyped([typedPage(scene)], { ocrBackend: fakeOcr("a note in the margin") });

		expect(result.markdown).toContain(`### ${heading.text}`);
		expect(result.markdown).toContain("a note in the margin");
	});

	it("places a note's region on the page the renderer actually writes, which grows with the text", async () => {
		const scene = typedScene();
		const frame = notebookPageFrame(scene, SCREEN);
		scene.layers = [{ id: "0001", name: null, strokes: [boxStroke("s1", 620, 400, 40, 60)] }];

		const result = await buildTyped([typedPage(scene)], { ocrBackend: fakeOcr("beside the text") });

		const rect = /rect: (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(result.markdown);
		expect(rect).not.toBeNull();
		const [x, y, width, height] = rect!.slice(1).map(Number);
		// Inside the sheet, in the sheet's own points -- a page sized to its content is drawn 1:1, so
		// there is no fit to undo and nothing may land off the paper.
		expect(x).toBeGreaterThanOrEqual(0);
		expect(y).toBeGreaterThanOrEqual(0);
		expect(x + width).toBeLessThanOrEqual(frame.widthPt);
		expect(y + height).toBeLessThanOrEqual(frame.heightPt);
	});

	it("says nothing about a PDF's text layer, because there is no PDF", async () => {
		const result = await buildTyped([typedPage(typedScene())]);

		expect(result.warnings).toEqual([]);
	});
});
