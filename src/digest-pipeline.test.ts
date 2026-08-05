import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentStore } from "./attachment-writer";
import { buildDigest, type DigestPageInput, type DigestPipelineDeps } from "./digest-pipeline";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { parseRmV6, type RmPage, type RmStroke } from "./rm-parser";
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

function fakeStore(): AttachmentStore & { writeBinary: ReturnType<typeof vi.fn> } {
	return {
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		remove: vi.fn().mockResolvedValue(undefined),
	};
}

/** Answers the clusters in call order, which the pipeline guarantees by transcribing them sequentially. */
function fakeOcr(...results: (string | OcrResult)[]): OcrBackend {
	let call = 0;
	return {
		id: "vision",
		metered: false,
		recognize: async () => {
			const result = results[call++] ?? "";
			return typeof result === "string" ? { status: "ok", text: result, confidence: null } : result;
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
		attachmentStore: fakeStore(),
		attachmentsFolder: "attachments",
		// On, because these tests are about what the digest does with margin notes. The shipped
		// default is off (F20); the tests that care about that say so.
		marginNotes: true,
		loadText: async () => null,
		...overrides,
	};
}

function build(pages: DigestPageInput[], overrides: Partial<DigestPipelineDeps> = {}) {
	return buildDigest(deps(overrides), {
		sourcePdfBytes: SOURCE_BYTES,
		docSlug: "the-doc",
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

// --- synthetic scenes for the crop decision ----------------------------------------------------

function boxStroke(id: string, x: number, y: number, width: number, height: number): RmStroke {
	const point = (px: number, py: number) => ({ x: px, y: py, speed: 0, width: 2, direction: 0, pressure: 1 });
	return { layerId: "0001", id, timestamp: "0001", penType: 2, color: 0, brushSize: 2, points: [point(x, y), point(x + width, y + height)] };
}

function scene(strokes: RmStroke[]): RmPage {
	return { formatVersion: 2, layers: [{ id: "0001", name: null, strokes }] };
}

/** A single long diagonal: one cluster's worth of ink, enough to rasterize into a crop. */
function inkyScene(): RmPage {
	return scene([boxStroke("0a", 0, 0, 200, 200)]);
}

describe("buildDigest without a text layer", () => {
	it("quotes every highlight from the .rm text and anchors every note on the page", async () => {
		const result = await build([fixturePage()], { ocrBackend: fakeOcr() });

		expect(result.markdown.match(/\^hl-/g)).toHaveLength(9);
		expect(result.markdown.match(/\^nt-/g)).toHaveLength(5);
		expect(result.markdown.match(/\[!note\] on this page/g)).toHaveLength(5);
		expect(result.markdown).toContain("für alle aktuellen Claude-Modelle,");
		// No text layer means no known run inside a sentence, so nothing is marked (F4's soft fail).
		expect(result.markdown).not.toContain("==");
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

		// Four notes sit level with a heading; the fourth belongs to the highlight `generieren.` and
		// nests inside its quote, which is what the `> > ` prefix says.
		expect(result.markdown.match(/\[!note\] at the heading »/g)).toHaveLength(4);
		expect(result.markdown).toContain("> > [!note] next to the highlight");
		expect(result.markdown).not.toContain("[!note] on this page");
	});

	it("orders the page's entries by section and then top-down", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });
		const sections = result.markdown.match(/^#### .+$/gm);

		expect(result.markdown).toContain("### [[attachments/doc.pdf#page=2|Page 2]] · Allgemeine Prinzipien");
		expect(sections).toEqual([
			"#### Sei klar und direkt",
			"#### Füge Kontext hinzu, um die Leistung zu verbessern",
			"#### Verwende Beispiele effektiv",
			"#### Strukturiere Prompts mit XML-Tags",
		]);
		// Reading order runs down the page: `top` is a scene coordinate, which grows downwards.
		const first = result.markdown.indexOf("für alle aktuellen Claude-Modelle,");
		const last = result.markdown.indexOf("beschreibende Tag-Namen");
		expect(first).toBeGreaterThan(0);
		expect(last).toBeGreaterThan(first);
		expect(result.markdown.slice(last).match(/\^(hl|nt)-/g)).toHaveLength(1);
	});

	it("gives every note its crop, whatever the real Vision output was", async () => {
		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		// All five notes, including the two whose flawed-but-non-empty text used to render alone:
		// `→ Claude valisate Examphs` is unreadable, and only the image says what was really written.
		expect(result.cropIds.size).toBe(5);
		// Only the two bare circled digits, which come back empty, announce themselves as untranscribed.
		expect(result.markdown.match(/not transcribable, crop:/g)).toHaveLength(2);
		expect(result.markdown).toMatch(/\[!note\] at the heading »Sei klar und direkt«\n> Basic Rule O\n> !\[\[attachments\/the-doc-nt-[0-9a-f]{6}\.png\|\d+\]\]/);
		// Nested inside its quote callout, hence the doubled prefix.
		expect(result.markdown).toMatch(/> > → Claude valisate Examphs\n> > !\[\[attachments\/the-doc-nt-[0-9a-f]{6}\.png\|\d+\]\]/);
	});

	it("renders no note at all, and writes no crop, when margin notes are off", async () => {
		const result = await build([fixturePage()], {
			loadText: async () => fixtureTextDocument(),
			ocrBackend: fakeOcr(...VISION_OUTPUT),
			marginNotes: false,
		});

		expect(result.cropIds.size).toBe(0);
		expect(result.markdown).not.toContain("[!note]");
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

		expect(result.markdown).not.toContain("[!note] at the heading");
		expect(result.markdown).toContain("[!note] at »");
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

		expect(result.markdown).toContain("#page=1|Page 1]] · Erster Abschnitt");
		expect(result.markdown).toContain("#page=2|Page 2]] · Erster Abschnitt");
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

		expect(result.markdown).toContain("#page=2|Page 2]] · Zweiter Abschnitt");
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

		expect(result.markdown).toContain("#page=2|Page 2]] · Ganze Seite");
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

		expect(result.markdown).toContain("#page=1|Page 1]] · 1 Einleitung");
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

		expect(result.markdown.match(/\[!quote\]/g)).toHaveLength(1);
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

		expect(result.markdown.match(/\[!quote\]/g)).toHaveLength(2);
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

		expect(result.markdown.match(/\[!quote\]/g)).toHaveLength(1);
		expect(result.markdown).toContain("> > [!note] next to the highlight\n> > Dazu.");
	});
});

describe("buildDigest crop decision", () => {
	const page = (): DigestPageInput => ({ pageId: "p", sourceIndex: 0, embedPage: 1, scene: inkyScene() });

	it("shows the crop instead of the text when nothing was transcribed", async () => {
		const result = await build([page()], { ocrBackend: fakeOcr("") });

		expect(result.markdown).toContain("not transcribable, crop:");
		expect(result.markdown).toMatch(/!\[\[attachments\/the-doc-nt-[0-9a-f]{6}\.png\|\d+\]\]/);
		expect(result.cropIds.size).toBe(1);
	});

	// A low confidence used to replace the text with the crop. That rule is gone: no shipped backend
	// reports a score, and the text now stands with its crop under it either way.
	it("keeps the text, and its crop, when a backend reports a low confidence", async () => {
		const result = await build([page()], { ocrBackend: fakeOcr({ status: "ok", text: "eine ganze Zeile Handschrift", confidence: 20 }) });

		expect(result.markdown).toContain("eine ganze Zeile Handschrift");
		expect(result.markdown).not.toContain("not transcribable, crop:");
		expect(result.cropIds.size).toBe(1);
	});

	// The one that matters: a transcription no heuristic can fault -- long, plausible, confident --
	// still gets its image, because "plausible" is exactly what a misread looks like from here.
	it("shows the crop under a healthy transcription too", async () => {
		const result = await build([page()], { ocrBackend: fakeOcr("eine ganze Zeile Handschrift dazu") });

		expect(result.markdown).toContain("eine ganze Zeile Handschrift dazu");
		expect(result.markdown).toMatch(/!\[\[attachments\/the-doc-nt-[0-9a-f]{6}\.png\|\d+\]\]/);
		expect(result.cropIds.size).toBe(1);
	});
});

describe("buildDigest resilience", () => {
	it("renders every margin note as a crop when OCR is off or unavailable, leaving the highlights alone", async () => {
		const off: OcrBackend = { id: "off", metered: false, recognize: async () => ({ status: "unavailable", text: "", confidence: null }) };

		const result = await build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: off });

		expect(result.markdown.match(/not transcribable, crop:/g)).toHaveLength(5);
		expect(result.cropIds.size).toBe(5);
		expect(result.markdown.match(/\[!quote\]/g)).toHaveLength(9);
		expect(result.markdown).toContain("Claude reagiert gut auf ==klare, explizite Anweisungen.==");
	});

	it("turns a throwing OCR backend into warnings and crops rather than an exception", async () => {
		const result = await build([fixturePage()], { ocrBackend: throwingOcr() });

		expect(result.warnings.filter((warning) => warning.includes("could not be transcribed"))).toHaveLength(5);
		expect(result.warnings[1]).toContain("vision is not installed");
		expect(result.markdown.match(/not transcribable, crop:/g)).toHaveLength(5);
	});

	it("warns when a page carries no text layer of its own", async () => {
		const result = await build([fixturePage()], { loadText: async () => fakeTextDocument({}) });

		expect(result.warnings).toEqual([
			"Page 2: the PDF has no readable text there, so highlights quote the text recorded on the device.",
		]);
	});

	it("keeps the note when its crop cannot be written, and says so", async () => {
		const store = fakeStore();
		store.writeBinary.mockRejectedValue(new Error("read-only vault"));

		const result = await build([{ pageId: "p", sourceIndex: 0, embedPage: 1, scene: inkyScene() }], {
			attachmentStore: store,
			ocrBackend: fakeOcr(""),
		});

		expect(result.warnings[1]).toContain("read-only vault");
		expect(result.markdown).toContain("[!note]");
		expect(result.cropIds.size).toBe(0);
	});

	it("reports a text layer that could not be opened at all", async () => {
		const result = await build([fixturePage()], {
			loadText: () => Promise.reject(new Error("pdf.js is missing")),
		});

		expect(result.warnings[0]).toContain("pdf.js is missing");
		expect(result.markdown).toContain("[!quote]");
	});
});

describe("buildDigest determinism", () => {
	it("renders byte-identical markdown and the same crop ids twice", async () => {
		const run = () => build([fixturePage()], { loadText: async () => fixtureTextDocument(), ocrBackend: fakeOcr(...VISION_OUTPUT) });

		const first = await run();
		const second = await run();

		expect(second.markdown).toBe(first.markdown);
		expect([...second.cropIds]).toEqual([...first.cropIds]);
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
		expect(result.cropIds.size).toBe(0);
	});
});
