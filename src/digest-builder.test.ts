import { describe, expect, it } from "vitest";
import { digestId, renderDigest } from "./digest-builder";
import type { DigestHighlight, DigestNote, DigestPage, NoteRegion } from "./digest-builder";

const EMBED = "Best Practices für Prompting.pdf";

/** Page height of the fixture PDF; turns a measured PDF y (bottom-left origin) into a top-down `top`. */
const PAGE_HEIGHT = 792;

function top(pdfY: number): number {
	return PAGE_HEIGHT - pdfY;
}

function highlight(overrides: Partial<DigestHighlight> = {}): DigestHighlight {
	return { id: "hl-000000", sentence: "", marked: [], color: null, notes: [], section: null, top: 0, ...overrides };
}

function note(overrides: Partial<DigestNote> = {}): DigestNote {
	return { id: "nt-000000", anchor: { kind: "page" }, text: "", region: null, top: 0, ...overrides };
}

function page(overrides: Partial<DigestPage> = {}): DigestPage {
	return { pageLabel: "1", embedPage: 1, highlights: [], notes: [], ...overrides };
}

/** The fixture page's right margin, where every one of its notes was written. */
function margin(y: number, height: number): NoteRegion {
	return { page: 2, x: 384, y, width: 140, height };
}

// --- The fixture page ---------------------------------------------------------------------------
// Page 2 of the private source PDF, exactly as the pipeline measures it (acceptance-page2.md):
// 9 highlights, 5 margin notes, real Apple Vision text -- including its misreads, which is the point.
// The tops are the measured PDF y values, the ids are the sample's. This one string is the format
// regression net for the whole digest: section headings, body-text quotes, note callouts, the
// per-entry page links and the block ids.

const SECTION_A = "Allgemeine Prinzipien";
const SECTION_B = "Sei klar und direkt";
const SECTION_C = "Füge Kontext hinzu, um die Leistung zu verbessern";
const SECTION_D = "Verwende Beispiele effektiv";
const SECTION_E = "Strukturiere Prompts mit XML-Tags";

/** The note that sits next to the highlight `generieren.` -- nested inside that quote callout. */
const NOTE_NEXT_TO_HIGHLIGHT = note({
	id: "nt-f13a88",
	anchor: { kind: "highlight", highlightId: "hl-8d5b26" },
	text: "→ Claude valisate Examphs",
	top: top(168.6),
});

const FIXTURE_PAGE: DigestPage = {
	pageLabel: "2",
	embedPage: 2,
	highlights: [
		highlight({
			id: "hl-9f21c4",
			sentence:
				"Die Techniken in diesem Abschnitt und den folgenden Abschnitten gelten für alle aktuellen Claude-Modelle, einschließlich Claude Fable 5 und Claude Mythos 5.",
			marked: ["für alle aktuellen Claude-Modelle,"],
			color: { r: 255, g: 207, b: 0 },
			section: SECTION_A,
			top: top(693.1),
		}),
		highlight({
			id: "hl-b03e52",
			sentence: "Claude reagiert gut auf klare, explizite Anweisungen.",
			marked: ["klare, explizite Anweisungen."],
			section: SECTION_B,
			top: top(626.1),
		}),
		highlight({
			id: "hl-77d1a9",
			sentence:
				"Gib Anweisungen als aufeinanderfolgende Schritte mit nummerierten Listen oder Aufzählungspunkten an, wenn die Reihenfolge oder Vollständigkeit der Schritte wichtig ist.",
			marked: ["Anweisungen als aufeinanderfolgende Schritte mit nummerierten Listen oder Aufzählungspunkten an,"],
			section: SECTION_B,
			top: top(481.5),
		}),
		highlight({
			id: "hl-1a6b3d",
			sentence:
				"Das Bereitstellen von Kontext oder Motivation hinter deinen Anweisungen, etwa indem du Claude erklärst, warum ein solches Verhalten wichtig ist, kann Claude helfen, deine Ziele besser zu verstehen und gezieltere Antworten zu liefern.",
			marked: ["Motivation hinter deinen Anweisungen,"],
			section: SECTION_C,
			top: top(413.7),
		}),
		highlight({
			id: "hl-c2447e",
			sentence:
				"Beispiele sind eine der zuverlässigsten Methoden, um Claudes Ausgabeformat, Ton und Struktur zu steuern.",
			marked: ["um Claudes Ausgabeformat, Ton und Struktur zu steuern."],
			section: SECTION_D,
			top: top(321),
		}),
		highlight({
			id: "hl-6e19f0",
			sentence:
				"Vielfältig sind: Sie decken Randfälle ab und variieren genug, damit Claude keine unbeabsichtigten Muster aufgreift.",
			marked: ["decken Randfälle ab"],
			section: SECTION_D,
			top: top(242.6),
		}),
		highlight({
			id: "hl-8d5b26",
			sentence:
				"Du kannst Claude auch bitten, deine Beispiele auf Relevanz und Vielfalt zu bewerten oder zusätzliche auf Basis deines ursprünglichen Satzes zu generieren.",
			marked: ["generieren."],
			notes: [NOTE_NEXT_TO_HIGHLIGHT],
			section: SECTION_D,
			top: top(174.9),
		}),
		highlight({
			id: "hl-d94012",
			sentence:
				"XML-Tags helfen Claude, komplexe Prompts eindeutig zu parsen, insbesondere wenn dein Prompt Anweisungen, Kontext, Beispiele und variable Eingaben mischt.",
			marked: ["komplexe Prompts"],
			section: SECTION_E,
			top: top(121.4),
		}),
		highlight({
			id: "hl-35ae67",
			sentence: "Verwende konsistente, beschreibende Tag-Namen in deinen Prompts.",
			marked: ["beschreibende Tag-Namen"],
			section: SECTION_E,
			top: top(43.8),
		}),
	],
	notes: [
		// Strokes 0-9: Vision read the circled digit as an "O" -- the entry carries that text, and the
		// block under it says where the ink it came from sits.
		{
			...note({
				id: "nt-4c8a17",
				anchor: { kind: "heading", heading: SECTION_B },
				text: "Basic Rule O",
				region: margin(top(654.2), 26),
				top: top(654.2),
			}),
			section: SECTION_B,
		},
		// Strokes 10-11 and 12-13: bare circled digits, Vision returns "" -- the entry says so in words.
		{
			...note({
				id: "nt-e5f203",
				anchor: { kind: "heading", heading: SECTION_C },
				region: margin(top(448), 24),
				top: top(448),
			}),
			section: SECTION_C,
		},
		{
			...note({
				id: "nt-90cc41",
				anchor: { kind: "heading", heading: SECTION_D },
				region: margin(top(350.1), 24),
				top: top(350.1),
			}),
			section: SECTION_D,
		},
		{
			...note({
				id: "nt-2b7c95",
				anchor: { kind: "heading", heading: SECTION_E },
				text: "- Widu spruch zum Artikel ally. Pe",
				region: margin(top(148.5), 52),
				top: top(148.5),
			}),
			section: SECTION_E,
		},
	],
};

/** The locator every entry of this page ends with, since a section is what heads it. */
const P2 = " · [[Best Practices für Prompting.pdf#page=2|p. 2]]";

const FIXTURE_MARKDOWN = `
### Allgemeine Prinzipien

Die Techniken in diesem Abschnitt und den folgenden Abschnitten gelten ==für alle aktuellen Claude-Modelle,== einschließlich Claude Fable 5 und Claude Mythos 5.${P2}
^hl-9f21c4

### Sei klar und direkt

> [!note] Handwritten${P2}
> Basic Rule O ^nt-4c8a17
> \`\`\`remarkable-note
> page: 2
> rect: 384 138 140 26
> \`\`\`

Claude reagiert gut auf ==klare, explizite Anweisungen.==${P2}
^hl-b03e52

Gib ==Anweisungen als aufeinanderfolgende Schritte mit nummerierten Listen oder Aufzählungspunkten an,== wenn die Reihenfolge oder Vollständigkeit der Schritte wichtig ist.${P2}
^hl-77d1a9

### Füge Kontext hinzu, um die Leistung zu verbessern

> [!note] Handwritten${P2}
> Handwriting that could not be transcribed. ^nt-e5f203
> \`\`\`remarkable-note
> page: 2
> rect: 384 344 140 24
> \`\`\`

Das Bereitstellen von Kontext oder ==Motivation hinter deinen Anweisungen,== etwa indem du Claude erklärst, warum ein solches Verhalten wichtig ist, kann Claude helfen, deine Ziele besser zu verstehen und gezieltere Antworten zu liefern.${P2}
^hl-1a6b3d

### Verwende Beispiele effektiv

> [!note] Handwritten${P2}
> Handwriting that could not be transcribed. ^nt-90cc41
> \`\`\`remarkable-note
> page: 2
> rect: 384 442 140 24
> \`\`\`

Beispiele sind eine der zuverlässigsten Methoden, ==um Claudes Ausgabeformat, Ton und Struktur zu steuern.==${P2}
^hl-c2447e

Vielfältig sind: Sie ==decken Randfälle ab== und variieren genug, damit Claude keine unbeabsichtigten Muster aufgreift.${P2}
^hl-6e19f0

Du kannst Claude auch bitten, deine Beispiele auf Relevanz und Vielfalt zu bewerten oder zusätzliche auf Basis deines ursprünglichen Satzes zu ==generieren.==${P2}
^hl-8d5b26

> [!note] Handwritten${P2}
> → Claude valisate Examphs ^nt-f13a88

### Strukturiere Prompts mit XML-Tags

> [!note] Handwritten${P2}
> - Widu spruch zum Artikel ally. Pe ^nt-2b7c95
> \`\`\`remarkable-note
> page: 2
> rect: 384 644 140 52
> \`\`\`

XML-Tags helfen Claude, ==komplexe Prompts== eindeutig zu parsen, insbesondere wenn dein Prompt Anweisungen, Kontext, Beispiele und variable Eingaben mischt.${P2}
^hl-d94012

Verwende konsistente, ==beschreibende Tag-Namen== in deinen Prompts.${P2}
^hl-35ae67`;

describe("renderDigest", () => {
	it("renders the fixture page exactly as the signed-off format prescribes", () => {
		expect(renderDigest(EMBED, [FIXTURE_PAGE])).toBe(FIXTURE_MARKDOWN);
	});

	it("is a pure function of its input — two runs are byte-identical (F16)", () => {
		expect(renderDigest(EMBED, [FIXTURE_PAGE])).toBe(renderDigest(EMBED, [FIXTURE_PAGE]));
	});

	it("returns nothing when there is nothing to show", () => {
		expect(renderDigest(EMBED, [])).toBe("");
		expect(renderDigest(EMBED, [page()])).toBe("");
	});

	/**
	 * Plenty of PDFs have neither an outline nor recognizably larger headings. The page then steps in
	 * as the heading -- and carries the link, so its entries do not repeat it (ticket 04).
	 */
	it("heads an entry without a section with its page, and leaves that entry without a locator", () => {
		const rendered = renderDigest(EMBED, [
			page({ highlights: [highlight({ id: "hl-1", sentence: "A sentence.", marked: ["A"] })] }),
		]);
		expect(rendered).toBe(`
### [[${EMBED}#page=1|Page 1]]

==A== sentence.
^hl-1`);
	});

	it("heads an entry with a section with that section, and ends the entry with its page link", () => {
		const rendered = renderDigest(EMBED, [
			page({
				pageLabel: "iv",
				embedPage: 4,
				notes: [{ ...note({ id: "nt-1", text: "A margin note." }), section: "First" }],
			}),
		]);
		expect(rendered).toBe(`
### First

> [!note] Handwritten · [[${EMBED}#page=4|p. iv]]
> A margin note. ^nt-1`);
	});

	it("emits a section heading once, where the section changes", () => {
		const rendered = renderDigest(EMBED, [
			page({
				highlights: [
					highlight({ id: "hl-1", sentence: "One.", section: "First", top: 10 }),
					highlight({ id: "hl-2", sentence: "Two.", section: "First", top: 20 }),
					highlight({ id: "hl-3", sentence: "Three.", section: "Second", top: 30 }),
				],
			}),
		]);
		expect(rendered.match(/^### .*$/gm)).toEqual(["### First", "### Second"]);
	});

	/**
	 * A section runs on across a page break -- repeating its heading there would say nothing the
	 * entries' own page links do not.
	 */
	it("carries a section across pages rather than heading it again", () => {
		const rendered = renderDigest(EMBED, [
			page({ embedPage: 1, highlights: [highlight({ id: "hl-1", sentence: "One.", section: "First" })] }),
			page({ pageLabel: "2", embedPage: 2, highlights: [highlight({ id: "hl-2", sentence: "Two.", section: "First" })] }),
			page({ pageLabel: "3", embedPage: 3, highlights: [highlight({ id: "hl-3", sentence: "Three.", section: "Second" })] }),
		]);
		expect(rendered).toBe(`
### First

One. · [[${EMBED}#page=1|p. 1]]
^hl-1

Two. · [[${EMBED}#page=2|p. 2]]
^hl-2

### Second

Three. · [[${EMBED}#page=3|p. 3]]
^hl-3`);
	});

	it("heads every page of a document without sections, since each heading names its own page", () => {
		const rendered = renderDigest(EMBED, [
			page({ pageLabel: "iv", embedPage: 4, highlights: [highlight({ id: "hl-1", sentence: "One." })] }),
			page({ pageLabel: "7", embedPage: 7, highlights: [highlight({ id: "hl-2", sentence: "Two." })] }),
		]);
		expect(rendered.match(/^### .*$/gm)).toEqual([`### [[${EMBED}#page=4|Page iv]]`, `### [[${EMBED}#page=7|Page 7]]`]);
	});

	it("groups entries by section rather than by position, so a heading-anchored note lands under its section heading", () => {
		// The note sits *above* the heading it belongs to, i.e. above the second section's highlight
		// but below the first section's. Sorting by `top` alone would print it before its section heading.
		const rendered = renderDigest(EMBED, [
			page({
				highlights: [
					highlight({ id: "hl-1", sentence: "One.", section: "First", top: 10 }),
					highlight({ id: "hl-2", sentence: "Two.", section: "Second", top: 30 }),
				],
				notes: [
					{
						...note({ id: "nt-1", anchor: { kind: "heading", heading: "Second" }, text: "Note.", top: 20 }),
						section: "Second",
					},
				],
			}),
		]);
		expect(rendered).toBe(`
### First

One. · [[${EMBED}#page=1|p. 1]]
^hl-1

### Second

> [!note] Handwritten · [[${EMBED}#page=1|p. 1]]
> Note. ^nt-1

Two. · [[${EMBED}#page=1|p. 1]]
^hl-2`);
	});
});

describe("renderDigest — highlight quotes", () => {
	function quoteBody(overrides: Partial<DigestHighlight>): string {
		const rendered = renderDigest(EMBED, [page({ highlights: [highlight({ id: "hl-1", ...overrides })] })]);
		return rendered.split("\n").at(-2) ?? "";
	}

	/**
	 * Measured in a real Reading View: Obsidian hides a trailing `^id` inside a callout but prints it
	 * as grey text at the end of a paragraph — so the move out of the callout made every id visible,
	 * against F7. On a line of its own it is hidden again and still resolves as a link target. No
	 * blank line in between, so the id stays part of the entry.
	 */
	it("puts a highlight's block id on a line of its own, directly under the quote", () => {
		const rendered = renderDigest(EMBED, [
			page({ highlights: [highlight({ id: "hl-1", sentence: "Ein Satz.", section: "First" })] }),
		]);

		expect(rendered.split("\n").slice(-2)).toEqual([`Ein Satz. · [[${EMBED}#page=1|p. 1]]`, "^hl-1"]);
	});

	it("marks the first occurrence of the highlighted run", () => {
		expect(quoteBody({ sentence: "Ein Wort und noch ein Wort.", marked: ["Wort"] })).toBe(
			"Ein ==Wort== und noch ein Wort.",
		);
	});

	/**
	 * A mark only says something by contrast. Where it covers the whole entry there is nothing left
	 * for it to single out, and Obsidian paints one mark per wrapped line, so a long one reads as a
	 * striped slab -- which is what opened this map. The threshold also removes every fragmented mark
	 * the fixture has, since each of those sits at 98 % or above.
	 */
	it("drops the marks from a quote that is almost entirely marked", () => {
		// 21 of 26 characters, i.e. 81 %: what is left unmarked is a lead-in, not a distinction.
		expect(quoteBody({ sentence: "Also ist das hier wichtig.", marked: ["ist das hier wichtig."] })).toBe(
			"Also ist das hier wichtig.",
		);
	});

	it("keeps the marks where a quarter of the quote stays unmarked", () => {
		expect(quoteBody({ sentence: "Also ist das hier wichtig.", marked: ["das hier wichtig."] })).toBe(
			"Also ist ==das hier wichtig.==",
		);
	});

	it("counts the coverage over the resolved ranges, so an adjusted selection cannot over-count", () => {
		// The device records every version of a selection, so the same run arrives repeatedly. Summed
		// raw these three cover the sentence more than once and the mark would be dropped; resolved
		// they cover 13 of 23 characters.
		expect(quoteBody({ sentence: "Ein Wort und noch mehr.", marked: ["Wort und", "Wort und", "und noch"] })).toBe(
			"Ein ==Wort und noch== mehr.",
		);
	});

	/**
	 * A highlight can legitimately run to thousands of characters -- the reader records a selection
	 * over several paragraphs as one run. It used to be folded shut to keep the callout short; without
	 * the callout there is nothing to fold, and the quote is simply a long paragraph.
	 */
	it("prints a quote of any length whole", () => {
		const long = `${"Ein sehr langer Satz. ".repeat(30)}Ende.`;
		expect(quoteBody({ sentence: long, marked: [] })).toBe(long);
	});

	/**
	 * Markdown passes raw HTML through, so a quoted `<document index="n">` reaches Obsidian as an
	 * unclosed tag and everything after it renders as HTML. One quote on page 3 of the acceptance
	 * document stopped the rest of the digest from rendering at all.
	 */
	it("escapes the angle brackets a quoted passage carries, so an XML tag cannot open raw HTML", () => {
		expect(quoteBody({ sentence: 'Dokumente innerhalb von <document index="n"> hier.', marked: [] })).toBe(
			'Dokumente innerhalb von \\<document index="n"> hier.',
		);
	});

	it("escapes an ampersand, which would otherwise reach the reader as a decoded entity", () => {
		expect(quoteBody({ sentence: "A &amp; B.", marked: [] })).toBe("A \\&amp; B.");
	});

	it("escapes a leading `>`, which would open a blockquote instead of printing the character", () => {
		expect(quoteBody({ sentence: "> zitiert.", marked: [] })).toBe("\\> zitiert.");
	});

	it("leaves the digest's own `==` markers alone while escaping the text around them", () => {
		expect(quoteBody({ sentence: "Nutze <tag> im Prompt.", marked: ["<tag>"] })).toBe(
			"Nutze ==\\<tag>== im Prompt.",
		);
	});

	it("quotes the sentence plain when no highlighted run is known", () => {
		expect(quoteBody({ sentence: "Nur der Satz.", marked: [] })).toBe("Nur der Satz.");
	});

	it("falls back to the plain sentence when the run is not in the sentence at all", () => {
		expect(quoteBody({ sentence: "Nur der Satz.", marked: ["etwas anderes"] })).toBe("Nur der Satz.");
	});

	it("marks each of several disjoint runs", () => {
		expect(quoteBody({ sentence: "Ein Wort und noch ein Wort.", marked: ["Ein", "noch"] })).toBe(
			"==Ein== Wort und ==noch== ein Wort.",
		);
	});

	it("marks the union of two overlapping runs once rather than twice", () => {
		// What the device produces for one adjusted selection: the same passage, twice, differently cut.
		expect(quoteBody({ sentence: "Ein Wort und noch mehr.", marked: ["Wort und", "und noch"] })).toBe(
			"Ein ==Wort und noch== mehr.",
		);
	});

	it("marks a repeated run once", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Wort", "Wort"] })).toBe(
			"Ein ==Wort== und mehr.",
		);
	});

	it("joins two runs that merely touch, so no empty `==...==` pair is emitted", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Ein ", "Wort"] })).toBe(
			"==Ein Wort== und mehr.",
		);
	});

	it("bridges two runs parted by nothing but whitespace", () => {
		// One continuous sweep of the marker that the device recorded as two runs; `==A== ==B==` would
		// render a seam the reader never drew.
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Ein", "Wort"] })).toBe(
			"==Ein Wort== und mehr.",
		);
	});

	it("keeps real unmarked words outside the marks", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Ein", "und"] })).toBe(
			"==Ein== Wort ==und== mehr.",
		);
	});

	it("skips a run the sentence does not contain without losing the others", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["fehlt", "Wort"] })).toBe(
			"Ein ==Wort== und mehr.",
		);
	});

	it("does not render the marker color (F9)", () => {
		expect(quoteBody({ sentence: "Gelb ist die Farbe hier.", marked: ["Gelb"], color: { r: 255, g: 207, b: 0 } })).toBe(
			"==Gelb== ist die Farbe hier.",
		);
	});
});

describe("renderDigest — note anchors and regions", () => {
	function noteBlock(overrides: Partial<DigestNote>): string {
		const rendered = renderDigest(EMBED, [
			page({ notes: [{ ...note({ id: "nt-1", ...overrides }), section: null }] }),
		]);
		return rendered.split("\n\n").slice(1).join("\n\n");
	}

	/**
	 * The layout shows what these anchors say: a note under a section heading sat at that heading,
	 * one under a quote sat next to it, and a page-anchored note sits under its page's own heading.
	 * Naming them there only repeats the position, so the title says what the entry is.
	 */
	it("titles a note »Handwritten« wherever the layout already shows its anchor", () => {
		expect(noteBlock({ anchor: { kind: "heading", heading: "Any" }, text: "x" })).toContain("> [!note] Handwritten");
		expect(noteBlock({ anchor: { kind: "highlight", highlightId: "hl-9" }, text: "x" })).toContain("> [!note] Handwritten");
		expect(noteBlock({ anchor: { kind: "page" }, text: "x" })).toContain("> [!note] Handwritten");
	});

	/** The one anchor the layout cannot show: which sentence the note stood beside. */
	it("quotes the first words of the nearest line for a line anchor", () => {
		expect(noteBlock({ anchor: { kind: "line", line: "Die Techniken in diesem Abschnitt gelten" }, text: "x" })).toContain(
			"> [!note] at »Die Techniken in diesem…«",
		);
		expect(noteBlock({ anchor: { kind: "line", line: "Kurze Zeile" }, text: "x" })).toContain(
			"> [!note] at »Kurze Zeile«",
		);
	});

	it("says so in words when nothing was transcribed, rather than standing empty", () => {
		expect(noteBlock({})).toBe("> [!note] Handwritten\n> Handwriting that could not be transcribed. ^nt-1");
	});

	/**
	 * The block is what the reader's click reads back, and it is the reason the id moved: appended to
	 * the entry as a whole, `^nt-1` would land on the closing fence and take the block apart.
	 */
	it("puts the region block under the text, with the block id still on the last text line", () => {
		expect(noteBlock({ text: "check table 2", region: { page: 3, x: 384, y: 246, width: 140, height: 24 } })).toBe(
			["> [!note] Handwritten", "> check table 2 ^nt-1", "> ```remarkable-note", "> page: 3", "> rect: 384 246 140 24", "> ```"].join("\n"),
		);
	});

	/** The rectangle only has to find the ink again, and what is drawn from it is padded by whole points. */
	it("rounds the rectangle to whole points", () => {
		expect(noteBlock({ text: "x", region: { page: 3, x: 383.62, y: 245.5, width: 139.94, height: 24.4 } })).toContain(
			"> rect: 384 246 140 24",
		);
	});

	/** A page added on the device has no source page under its ink, so there is nothing to draw out of. */
	it("leaves the block off entirely when there is no region", () => {
		expect(noteBlock({ text: "A margin note." })).toBe("> [!note] Handwritten\n> A margin note. ^nt-1");
	});

	/** There is no quote callout left to nest inside, and the note carries no locator: the highlight it belongs to already gave one. */
	it("prints a highlight-anchored note right below that highlight", () => {
		const rendered = renderDigest(EMBED, [
			page({
				highlights: [
					highlight({
						id: "hl-1",
						sentence: "Ein Satz mit Inhalt.",
						marked: ["Satz"],
						section: "First",
						notes: [note({ id: "nt-1", anchor: { kind: "highlight", highlightId: "hl-1" }, text: "Dazu." })],
					}),
				],
			}),
		]);
		expect(rendered).toContain(
			`Ein ==Satz== mit Inhalt. · [[${EMBED}#page=1|p. 1]]
^hl-1\n\n> [!note] Handwritten · [[${EMBED}#page=1|p. 1]]\n> Dazu. ^nt-1`,
		);
	});
});

describe("digestId", () => {
	it("is `<prefix>-` plus six hex chars", () => {
		expect(digestId("hl", "page-1", "0110")).toMatch(/^hl-[0-9a-f]{6}$/);
		expect(digestId("nt", "page-1", "0007")).toMatch(/^nt-[0-9a-f]{6}$/);
	});

	it("is stable for the same page and CRDT id — the whole point of F15", () => {
		expect(digestId("hl", "page-1", "0110")).toBe(digestId("hl", "page-1", "0110"));
	});

	it("separates page and CRDT id, so two pages' annotations cannot collide by concatenation", () => {
		expect(digestId("hl", "ab", "c")).not.toBe(digestId("hl", "a", "bc"));
	});

	it("differs per prefix and per annotation", () => {
		expect(digestId("nt", "page-1", "0110")).not.toBe(digestId("hl", "page-1", "0110"));
		expect(digestId("hl", "page-1", "0110")).not.toBe(digestId("hl", "page-1", "0111"));
	});
});
