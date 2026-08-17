import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildDigest, type DigestPageInput, type DigestPipelineDeps } from "./digest-pipeline";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { notebookPageFrame, resolveDeviceCanvas } from "./pdf-renderer";
import { parseRmV6, type RmHighlight, type RmPage, type RmStroke, type RmText } from "./rm-parser";
import { PLAIN_TEXT_SIZE_PX } from "./device-font";
import { layoutText } from "./text-layout";
import type { PdfHeading, PdfPageText, PdfTextDocument, PdfTextLine } from "./pdf-text";

const PDF_PAGE_FIXTURE_PATH = "./test-fixtures/rmv6/pdf-page-highlights-and-margin-notes.rm";
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
		recognize: async () => {
			const result = results[call++] ?? "";
			return typeof result === "string" ? { status: "ok", pages: null, text: result, confidence: null } : { pages: null, ...result };
		},
	};
}

function throwingOcr(): OcrBackend {
	return { id: "vision", metered: false, recognize: () => Promise.reject(new Error("vision is not installed")) };
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

function build(pages: DigestPageInput[], overrides: Partial<DigestPipelineDeps> = {}) {
	return buildDigest(deps(overrides), {
		source: { kind: "pdf", bytes: SOURCE_BYTES },
		embedPath: "attachments/doc.pdf",
		pages,
	});
}

/** The fixture page as the sync engine hands it over: source page index 1, embedded as page 2. */
function fixturePage(scene: RmPage = fixtureScene()): DigestPageInput {
	return { pageId: "page-a", sourceIndex: 1, embedPage: 2, scene };
}

// --- the fixture page's text layer, rebuilt from the measured geometry -------------------------
// The real source PDF is private, so the fake reproduces what the pipeline reads off it: the five
// headings and the nine highlighted sentences, each at the y its highlight's rectangles actually
// occupy in the fixture scene. Each sentence is split over two lines 13 pt apart, as it is in the
// source, which is what gives the page its 13 pt body spacing.

const FIXTURE_HEADINGS: { y: number; title: string }[] = [
	{ y: 723, title: "Allgemeine Prinzipien" },
	{ y: 653, title: "Sei klar und direkt" },
	{ y: 442, title: "Füge Kontext hinzu, um die Leistung zu verbessern" },
	{ y: 350, title: "Verwende Beispiele effektiv" },
	{ y: 151, title: "Strukturiere Prompts mit XML-Tags" },
];

/** `y` is the bottom of the highlight's rectangle, measured from the fixture scene. */
const FIXTURE_QUOTES: { y: number; sentence: string }[] = [
	{
		y: 693.1,
		sentence:
			"Die Techniken in diesem Abschnitt und den folgenden Abschnitten gelten für alle aktuellen Claude-Modelle, einschließlich Claude Fable 5 und Claude Mythos 5.",
	},
	{ y: 626.1, sentence: "Claude reagiert gut auf klare, explizite Anweisungen." },
	{
		y: 481.5,
		sentence:
			"Gib Anweisungen als aufeinanderfolgende Schritte mit nummerierten Listen oder Aufzählungspunkten an, wenn die Reihenfolge oder Vollständigkeit der Schritte wichtig ist.",
	},
	{
		y: 413.7,
		sentence:
			"Das Bereitstellen von Kontext oder Motivation hinter deinen Anweisungen, etwa indem du Claude erklärst, warum ein solches Verhalten wichtig ist, kann Claude helfen, deine Ziele besser zu verstehen und gezieltere Antworten zu liefern.",
	},
	{ y: 321.0, sentence: "Beispiele sind eine der zuverlässigsten Methoden, um Claudes Ausgabeformat, Ton und Struktur zu steuern." },
	{
		y: 242.6,
		sentence: "Vielfältig sind: Sie decken Randfälle ab und variieren genug, damit Claude keine unbeabsichtigten Muster aufgreift.",
	},
	{
		y: 174.9,
		sentence:
			"Du kannst Claude auch bitten, deine Beispiele auf Relevanz und Vielfalt zu bewerten oder zusätzliche auf Basis deines ursprünglichen Satzes zu generieren.",
	},
	{
		y: 121.4,
		sentence:
			"XML-Tags helfen Claude, komplexe Prompts eindeutig zu parsen, insbesondere wenn dein Prompt Anweisungen, Kontext, Beispiele und variable Eingaben mischt.",
	},
	{ y: 43.8, sentence: "Verwende konsistente, beschreibende Tag-Namen in deinen Prompts." },
];

/** Splits a sentence at the word boundary nearest its middle, the way the source PDF wraps it. */
function wrap(sentence: string): [string, string] {
	const middle = Math.floor(sentence.length / 2);
	const at = sentence.indexOf(" ", middle);
	return at < 0 ? [sentence, ""] : [sentence.slice(0, at), sentence.slice(at + 1)];
}

function textLine(text: string, y: number, height: number): PdfTextLine {
	return { text, x: 80, y, width: 450, height };
}

function fixturePageText(): PdfPageText {
	const lines: PdfTextLine[] = FIXTURE_HEADINGS.map((heading) => textLine(heading.title, heading.y, 12));
	for (const quote of FIXTURE_QUOTES) {
		const [first, second] = wrap(quote.sentence);
		lines.push(textLine(first, quote.y, 10));
		if (second !== "") lines.push(textLine(second, quote.y - 13, 10));
	}
	return { label: "2", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines: lines.sort((a, b) => b.y - a.y) };
}

function fixtureTextDocument(): PdfTextDocument {
	return fakeTextDocument(
		{ 1: fixturePageText() },
		FIXTURE_HEADINGS.map((heading) => ({ pageIndex: 1, x: null, y: heading.y, title: heading.title })),
	);
}

/** The real Apple Vision output for the five clusters, top-down (acceptance-page2.md). */
const VISION_OUTPUT = ["Basic Rule O", "", "", "→ Claude valisate Examphs", "- Widu spruch zum Artikel ally. Pe"];

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

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(9);
		expect(result.markdown.match(/\^nt-/g)).toHaveLength(5);
		// Nothing anchors without a text layer, and nothing needs to: each note is printed under the
		// page's own heading, which is what an unanchored note has to say -- so each title is empty.
		expect(result.markdown.match(/^> \[!handwritten\]$/gm)).toHaveLength(5);
		expect(result.markdown).toContain("für alle aktuellen Claude-Modelle,");
		// No text layer means no known run inside a sentence, so nothing is marked (F4's soft fail).
		expect(result.markdown).not.toContain("==");
	});

	// The progress bar counts pages; this pipeline transcribes clusters, which are finer. The fixture
	// page holds five of them and must still tick once.
	it("reports one page at a time, however many clusters it transcribed", async () => {
		const backend = fakeOcr();
		const recognize = vi.spyOn(backend, "recognize");
		const onPage = vi.fn();

		await build([fixturePage(), fixturePage(inkyScene())], { ocrBackend: backend, onPage });

		expect(recognize).toHaveBeenCalledTimes(6);
		expect(onPage).toHaveBeenCalledTimes(2);
	});

	/**
	 * F18's one gap, closed. With margin notes off a stroke that is not recognised as a mark reaches
	 * the vault nowhere at all, and the reasons it missed -- drawn too low, struck through, over a
	 * patch the text layer does not cover -- cannot be seen from the note.
	 */
	it("names a pen mark it could not match to any text, instead of dropping it in silence", async () => {
		// Wide and flat, so it has the shape of an underline, but drawn across the bottom margin where
		// the text layer has no line for it to point at.
		const stray = boxStroke("0a", 100, 1850, 600, 1);

		const result = await build([fixturePage(scene([stray]))], { loadText: async () => fixtureTextDocument(), marginNotes: false });

		expect(result.warnings).toEqual([
			"Page 2: a pen mark could not be matched to any text there, so it is not in the digest. The embedded render still shows it.",
		]);
	});

	it("says nothing about ordinary handwriting, which is the setting working as asked", async () => {
		// Too short to be a mark: this is a word, and margin notes being off is not news.
		const word = boxStroke("0a", 100, 1850, 8, 1);

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

		expect(result.markdown).toContain(
			"Die Techniken in diesem Abschnitt und den folgenden Abschnitten gelten ==für alle aktuellen Claude-Modelle,== einschließlich Claude Fable 5 und Claude Mythos 5.",
		);
		expect(result.markdown).toContain("Claude reagiert gut auf ==klare, explizite Anweisungen.==");
		expect(result.markdown).toContain("Verwende konsistente, ==beschreibende Tag-Namen== in deinen Prompts.");
		expect(result.warnings).toEqual([]);
	});

	it("resolves the five margin notes to the anchors measured on the real page", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// Four notes sit level with a heading and are printed under it; the fifth belongs to the
		// highlight `generieren.` and is printed right below it. Either way the position says where the
		// note sat, so every title carries nothing but the page link -- and none of the five falls
		// through the cascade to a line or the bare page.
		expect(result.markdown.match(/^> \[!handwritten\] \[\[/gm)).toHaveLength(5);
		expect(result.markdown).not.toContain("[!handwritten] at »");
	});

	it("orders the page's entries by section and then top-down", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });
		const sections = result.markdown.match(/^### .+$/gm);

		expect(sections).toEqual([
			"### Allgemeine Prinzipien",
			"### Sei klar und direkt",
			"### Füge Kontext hinzu, um die Leistung zu verbessern",
			"### Verwende Beispiele effektiv",
			"### Strukturiere Prompts mit XML-Tags",
		]);
		// Reading order runs down the page: `top` is a scene coordinate, which grows downwards.
		const first = result.markdown.indexOf("für alle aktuellen Claude-Modelle,");
		const last = result.markdown.indexOf("beschreibende Tag-Namen");
		expect(first).toBeGreaterThan(0);
		expect(last).toBeGreaterThan(first);
		expect(result.markdown.slice(last).match(/\^(hl|nt)-/g)).toHaveLength(1);
	});

	it("gives every note the place its handwriting sits, whatever the real Vision output was", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// All five notes, including the two whose flawed-but-non-empty text stands alone in the entry:
		// `→ Claude valisate Examphs` is unreadable, and only the handwriting says what was written.
		expect(result.markdown.match(/^> ```remarkable-note$/gm)).toHaveLength(5);
		// Only the two bare circled digits, which come back empty, announce themselves as untranscribed.
		expect(result.markdown.match(/Handwriting that could not be transcribed\./g)).toHaveLength(2);
		// No image file is named anywhere in the digest -- that is the whole point of the format.
		expect(result.markdown).not.toContain("![[");
		// The id terminates the last *text* line, above the block -- on the closing fence it would take
		// the block apart instead of naming the entry.
		expect(result.markdown).toMatch(/^> Basic Rule O \^nt-[0-9a-f]{6}$/m);
	});

	it("renders no note at all when margin notes are off", async () => {
		const result = await build([fixturePage()], {
			loadText: async () => fixtureTextDocument(),
			ocrBackend: fakeOcr(...VISION_OUTPUT),
			marginNotes: false,
		});

		expect(result.markdown).not.toContain("[!handwritten]");
		expect(result.markdown).not.toContain("Basic Rule O");
		// The highlights are untouched -- the setting is about handwriting, not about the digest.
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(9);
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
		expect(ys).toHaveLength(5);
		// Reading order runs down the page, and so does this axis: the five notes' y values only grow.
		expect([...ys].sort((a, b) => a - b)).toEqual(ys);
		// The topmost note sits beside the second heading, at 653 pt from the bottom of a 792 pt page.
		expect(ys[0]).toBeGreaterThan(792 - 653 - 20);
		expect(ys[0]).toBeLessThan(792 - 653 + 20);
	});

	/**
	 * A note written off the paper is drawn shrunk onto its page (`annotatedPageFit`), and a pdf.js
	 * viewport measures what was drawn. Read off the source page's own coordinates instead, this
	 * rectangle would come out at x -44 -- a place no page has, and every band on the page would open
	 * 44 pt to the left of the handwriting it was asked for.
	 */
	it("measures the rectangle where the renderer drew the ink, not where the source page had it", async () => {
		// 1100 px left of the midline, on a 612 pt page whose own half-width is 960 px.
		const marginNote = scene([boxStroke("0a", -1100, 800, 100, 20)]);

		const result = await build([fixturePage(marginNote)], { ...withText, ocrBackend: fakeOcr("Am Rand.") });

		expect(result.markdown).toContain("Am Rand.");
		// Hard against the page's left edge, and 32 pt of ink drawn at the 93 % the page had room for.
		expect(result.markdown).toMatch(/^> rect: 0 \d+ 30 \d+$/m);
	});

	it("names the page of the embed, which is the page its link points at", async () => {
		const result = await build([fixturePage()], { ...withText, ocrBackend: fakeOcr(...VISION_OUTPUT) });

		expect(result.markdown.match(/^> page: 2$/gm)).toHaveLength(5);
	});

	/**
	 * Without a text layer the frame is the device screen rather than the page (see `buildDigest`), so
	 * the rectangle would not name a place in the PDF at all. Better no button than one that opens the
	 * wrong strip of paper -- and such a document already says its text could not be read.
	 */
	it("leaves the block off a page whose text could not be read", async () => {
		const result = await build([fixturePage()], { ocrBackend: fakeOcr(...VISION_OUTPUT) });

		expect(result.markdown.match(/\^nt-/g)).toHaveLength(5);
		expect(result.markdown).not.toContain("remarkable-note");
	});

	it("says in words that nothing was transcribed, instead of leaving the entry empty", async () => {
		const result = await build([{ pageId: "p", sourceIndex: 0, embedPage: 1, scene: inkyScene() }], { ocrBackend: fakeOcr("") });

		expect(result.markdown).toContain("Handwriting that could not be transcribed.");
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
		const off: OcrBackend = { id: "off", metered: false, recognize: async () => ({ status: "unavailable", pages: null, text: "", confidence: null }) };

		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: off });

		expect(result.markdown.match(/Handwriting that could not be transcribed\./g)).toHaveLength(5);
		expect(result.markdown.match(/^> ```remarkable-note$/gm)).toHaveLength(5);
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(9);
		expect(result.markdown).toContain("Claude reagiert gut auf ==klare, explizite Anweisungen.==");
	});

	it("turns a throwing OCR backend into warnings and entries rather than an exception", async () => {
		const result = await build([fixturePage()], { ocrBackend: throwingOcr() });

		expect(result.warnings.filter((warning) => warning.includes("could not be transcribed"))).toHaveLength(5);
		expect(result.warnings[1]).toContain("vision is not installed");
		expect(result.markdown.match(/Handwriting that could not be transcribed\./g)).toHaveLength(5);
	});

	it("warns when a page carries no text layer of its own", async () => {
		const result = await build([fixturePage()], { loadText: async () => fakeTextDocument({}) });

		expect(result.warnings).toEqual([
			"Page 2: the PDF has no readable text there, so highlights quote the text recorded on the device.",
		]);
	});

	it("reports a text layer that could not be opened at all", async () => {
		const result = await build([fixturePage()], {
			loadText: () => Promise.reject(new Error("pdf.js is missing")),
		});

		expect(result.warnings[0]).toContain("pdf.js is missing");
		// The device's own recorded highlight text still carries every entry (F4's soft fail).
		expect(result.markdown).toContain("für alle aktuellen Claude-Modelle,\n^hl-");
	});
});

describe("buildDigest on pen marks", () => {
	/** The scene y whose ink top lands at `pdfTop` on the fixture page -- `sceneRectToPdf` inverted. */
	const sceneYForPdfTop = (pdfTop: number) => (PAGE_HEIGHT_PT - pdfTop) / PX_TO_PT;
	/** The scene x that lands at `pdfX`, with the page's midline at scene x 0. */
	const sceneXForPdfX = (pdfX: number) => pdfX / PX_TO_PT - PAGE_WIDTH_PT / PX_TO_PT / 2;

	/**
	 * An underline under the left half of `Claude reagiert gut auf klare,`, the second quote's first
	 * line. 4 pt of clearance under it, and 225 pt long -- well past the 2.5 line heights a mark needs.
	 */
	function underlinedScene(): RmPage {
		const y = sceneYForPdfTop(626.1 - 4);
		const x = sceneXForPdfX(80);
		return scene([boxStroke("0a", x, y, 225 / PX_TO_PT, 1)]);
	}

	it("quotes the text an underline sits under instead of transcribing the line itself", async () => {
		const result = await build([fixturePage(underlinedScene())], { loadText: async () => fixtureTextDocument() });

		expect(result.markdown).toContain("==Claude reagiert==");
		expect(result.markdown).toContain("^hl-");
		// The failure this replaces: a callout holding a picture of a line, with whatever OCR made of it.
		expect(result.markdown).not.toContain("[!handwritten]");
	});

	it("makes no OCR call for it -- a line has no transcription to get wrong", async () => {
		const recognize = vi.fn().mockResolvedValue({ status: "ok", pages: null, text: "176", confidence: null });

		await build([fixturePage(underlinedScene())], {
			loadText: async () => fixtureTextDocument(),
			ocrBackend: { id: "vision", metered: false, recognize },
		});

		expect(recognize).not.toHaveBeenCalled();
	});

	it("keeps the mark with handwritten notes off: its text comes from the PDF, not from the reader's hand", async () => {
		const result = await build([fixturePage(underlinedScene())], {
			loadText: async () => fixtureTextDocument(),
			marginNotes: false,
		});

		expect(result.markdown).toContain("==Claude reagiert==");
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

		const idOf = (markdown: string) => /Claude reagiert gut auf[^\n]*\n\^(hl-[0-9a-f]{6})/.exec(markdown)?.[1];
		expect(idOf(plain.markdown)).toBeDefined();
		expect(idOf(marked.markdown)).toBe(idOf(plain.markdown));
	});

	it("does not take the fixture page's own handwriting for marks", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// The five notes and nine highlights the page has always produced, and not one more of either.
		expect(result.markdown.match(/\^nt-/g)).toHaveLength(5);
		expect(result.markdown.match(/\^hl-/g)).toHaveLength(9);
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

		const result = await build([appendedPage()], { ocrBackend: { id: "vision", metered: false, recognize: ocr } });

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

	it("gives it its own page heading rather than the last section of a document it is not part of", async () => {
		const headings: PdfHeading[] = [{ pageIndex: 0, x: null, y: 700, title: "A chapter of the PDF" }];
		const text = fakeTextDocument({ 0: { label: "1", width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT, lines: [] } }, headings);

		const result = await build([appendedPage()], { loadText: async () => text, ocrBackend: fakeOcr("text") });

		expect(result.markdown).toContain("### [[attachments/doc.pdf#page=16|Page 16]]");
		expect(result.markdown).not.toContain("A chapter of the PDF");
	});

	it("drops it entirely with handwritten notes off, like every other handwriting on the page", async () => {
		const ocr = vi.fn();

		const result = await build([appendedPage()], { marginNotes: false, ocrBackend: { id: "vision", metered: false, recognize: ocr } });

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
