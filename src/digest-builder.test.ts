import { describe, expect, it } from "vitest";
import { digestId, renderDigest, slugify } from "./digest-builder";
import type { DigestHighlight, DigestNote, DigestPage } from "./digest-builder";

const EMBED = "Best Practices für Prompting.pdf";
const CROPS = "tagged-sync/attachments/best-practices-fuer-prompting";

/** Page height of the fixture PDF; turns a measured PDF y (bottom-left origin) into a top-down `top`. */
const PAGE_HEIGHT = 792;

function top(pdfY: number): number {
	return PAGE_HEIGHT - pdfY;
}

function highlight(overrides: Partial<DigestHighlight> = {}): DigestHighlight {
	return { id: "hl-000000", sentence: "", marked: [], color: null, notes: [], section: null, top: 0, ...overrides };
}

function note(overrides: Partial<DigestNote> = {}): DigestNote {
	return { id: "nt-000000", anchor: { kind: "page" }, text: "", cropEmbed: null, top: 0, ...overrides };
}

function page(overrides: Partial<DigestPage> = {}): DigestPage {
	return { pageLabel: "1", embedPage: 1, topSection: null, highlights: [], notes: [], ...overrides };
}

// --- The fixture page ---------------------------------------------------------------------------
// Page 2 of the private source PDF, exactly as the pipeline measures it (acceptance-page2.md):
// 9 highlights, 5 margin notes, real Apple Vision text -- including its misreads, which is the point.
// The tops are the measured PDF y values, the ids are the sample's. This one string is the format
// regression net for the whole digest: headings, bold section lines, callouts, nesting, block ids.

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
	topSection: SECTION_A,
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
		// Strokes 0-9: Vision read the circled digit as an "O", and the ink-per-character ratio trips
		// the drawing guard -- so this one carries text *and* a crop.
		{
			...note({
				id: "nt-4c8a17",
				anchor: { kind: "heading", heading: SECTION_B },
				text: "Basic Rule O",
				cropEmbed: { path: `${CROPS}-nt-4c8a17.png`, width: 600, height: 200 },
				top: top(654.2),
			}),
			section: SECTION_B,
		},
		// Strokes 10-11 and 12-13: bare circled digits, Vision returns "" -- crop only.
		{
			...note({
				id: "nt-e5f203",
				anchor: { kind: "heading", heading: SECTION_C },
				cropEmbed: { path: `${CROPS}-nt-e5f203.png`, width: 600, height: 200 },
				top: top(448),
			}),
			section: SECTION_C,
		},
		{
			...note({
				id: "nt-90cc41",
				anchor: { kind: "heading", heading: SECTION_D },
				cropEmbed: { path: `${CROPS}-nt-90cc41.png`, width: 600, height: 200 },
				top: top(350.1),
			}),
			section: SECTION_D,
		},
		{
			...note({
				id: "nt-2b7c95",
				anchor: { kind: "heading", heading: SECTION_E },
				text: "- Widu spruch zum Artikel ally. Pe",
				top: top(148.5),
			}),
			section: SECTION_E,
		},
	],
};

const FIXTURE_MARKDOWN = `
### [[Best Practices für Prompting.pdf#page=2|Page 2]] · Allgemeine Prinzipien

> [!quote]
> Die Techniken in diesem Abschnitt und den folgenden Abschnitten gelten ==für alle aktuellen Claude-Modelle,== einschließlich Claude Fable 5 und Claude Mythos 5. ^hl-9f21c4

#### Sei klar und direkt

> [!note] at the heading »Sei klar und direkt«
> Basic Rule O
> ![[tagged-sync/attachments/best-practices-fuer-prompting-nt-4c8a17.png|600]] ^nt-4c8a17

> [!quote]
> Claude reagiert gut auf ==klare, explizite Anweisungen.== ^hl-b03e52

> [!quote]
> Gib ==Anweisungen als aufeinanderfolgende Schritte mit nummerierten Listen oder Aufzählungspunkten an,== wenn die Reihenfolge oder Vollständigkeit der Schritte wichtig ist. ^hl-77d1a9

#### Füge Kontext hinzu, um die Leistung zu verbessern

> [!note] at the heading »Füge Kontext hinzu, um die Leistung zu verbessern« — not transcribable, crop:
> ![[tagged-sync/attachments/best-practices-fuer-prompting-nt-e5f203.png|600]] ^nt-e5f203

> [!quote]
> Das Bereitstellen von Kontext oder ==Motivation hinter deinen Anweisungen,== etwa indem du Claude erklärst, warum ein solches Verhalten wichtig ist, kann Claude helfen, deine Ziele besser zu verstehen und gezieltere Antworten zu liefern. ^hl-1a6b3d

#### Verwende Beispiele effektiv

> [!note] at the heading »Verwende Beispiele effektiv« — not transcribable, crop:
> ![[tagged-sync/attachments/best-practices-fuer-prompting-nt-90cc41.png|600]] ^nt-90cc41

> [!quote]
> Beispiele sind eine der zuverlässigsten Methoden, ==um Claudes Ausgabeformat, Ton und Struktur zu steuern.== ^hl-c2447e

> [!quote]
> Vielfältig sind: Sie ==decken Randfälle ab== und variieren genug, damit Claude keine unbeabsichtigten Muster aufgreift. ^hl-6e19f0

> [!quote]
> Du kannst Claude auch bitten, deine Beispiele auf Relevanz und Vielfalt zu bewerten oder zusätzliche auf Basis deines ursprünglichen Satzes zu ==generieren.== ^hl-8d5b26
>
> > [!note] next to the highlight
> > → Claude valisate Examphs ^nt-f13a88

#### Strukturiere Prompts mit XML-Tags

> [!note] at the heading »Strukturiere Prompts mit XML-Tags«
> - Widu spruch zum Artikel ally. Pe ^nt-2b7c95

> [!quote]
> XML-Tags helfen Claude, ==komplexe Prompts== eindeutig zu parsen, insbesondere wenn dein Prompt Anweisungen, Kontext, Beispiele und variable Eingaben mischt. ^hl-d94012

> [!quote]
> Verwende konsistente, ==beschreibende Tag-Namen== in deinen Prompts. ^hl-35ae67`;

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

	it("omits the ` · section` part of the page heading when the page has no top section", () => {
		const rendered = renderDigest(EMBED, [
			page({ highlights: [highlight({ id: "hl-1", sentence: "A sentence.", marked: ["A"] })] }),
		]);
		expect(rendered).toBe(`
### [[${EMBED}#page=1|Page 1]]

> [!quote]
> ==A== sentence. ^hl-1`);
	});

	it("emits no section heading for an entry without a section", () => {
		const rendered = renderDigest(EMBED, [
			page({ notes: [{ ...note({ id: "nt-1", text: "A margin note." }), section: null }] }),
		]);
		expect(rendered).toBe(`
### [[${EMBED}#page=1|Page 1]]

> [!note] on this page
> A margin note. ^nt-1`);
	});

	it("repeats no section heading for the top section, and emits one only where the section changes", () => {
		const rendered = renderDigest(EMBED, [
			page({
				topSection: "First",
				highlights: [
					highlight({ id: "hl-1", sentence: "One.", section: "First", top: 10 }),
					highlight({ id: "hl-2", sentence: "Two.", section: "First", top: 20 }),
					highlight({ id: "hl-3", sentence: "Three.", section: "Second", top: 30 }),
				],
			}),
		]);
		expect(rendered.match(/^#### .*$/gm)).toEqual(["#### Second"]);
	});

	it("groups entries by section rather than by position, so a heading-anchored note lands under its section heading", () => {
		// The note sits *above* the heading it belongs to, i.e. above the second section's highlight
		// but below the first section's. Sorting by `top` alone would print it before its section heading.
		const rendered = renderDigest(EMBED, [
			page({
				topSection: "First",
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
### [[${EMBED}#page=1|Page 1]] · First

> [!quote]
> One. ^hl-1

#### Second

> [!note] at the heading »Second«
> Note. ^nt-1

> [!quote]
> Two. ^hl-2`);
	});

	it("renders one `###` heading per page", () => {
		const rendered = renderDigest(EMBED, [
			page({ pageLabel: "iv", embedPage: 4, highlights: [highlight({ id: "hl-1", sentence: "One." })] }),
			page({ pageLabel: "7", embedPage: 7, highlights: [highlight({ id: "hl-2", sentence: "Two." })] }),
		]);
		expect(rendered).toContain(`### [[${EMBED}#page=4|Page iv]]\n`);
		expect(rendered).toContain(`### [[${EMBED}#page=7|Page 7]]\n`);
	});
});

describe("renderDigest — highlight quotes", () => {
	function quoteBody(overrides: Partial<DigestHighlight>): string {
		const rendered = renderDigest(EMBED, [page({ highlights: [highlight({ id: "hl-1", ...overrides })] })]);
		return rendered.split("\n").at(-1) ?? "";
	}

	it("marks the first occurrence of the highlighted run", () => {
		expect(quoteBody({ sentence: "Ein Wort und noch ein Wort.", marked: ["Wort"] })).toBe(
			"> Ein ==Wort== und noch ein Wort. ^hl-1",
		);
	});

	/**
	 * A highlight can legitimately run to thousands of characters -- the reader records a selection
	 * over several paragraphs as one run. Printed open it buries every ordinary quote around it, so it
	 * is folded shut instead of truncated: nothing is dropped, and one click opens it.
	 */
	it("folds a quote longer than a screenful shut, keeping its text", () => {
		const long = `${"Ein sehr langer Satz. ".repeat(30)}Ende.`;
		const rendered = renderDigest(EMBED, [page({ highlights: [highlight({ id: "hl-1", sentence: long, marked: [] })] })]);

		expect(rendered).toContain("> [!quote]- Long highlight\n");
		expect(rendered).toContain(long);
	});

	it("leaves a sentence-scale quote open", () => {
		const rendered = renderDigest(EMBED, [page({ highlights: [highlight({ id: "hl-1", sentence: "Kurz.", marked: [] })] })]);

		expect(rendered).toContain("> [!quote]\n");
		expect(rendered).not.toContain("[!quote]-");
	});

	/**
	 * Markdown passes raw HTML through, so a quoted `<document index="n">` reaches Obsidian as an
	 * unclosed tag and everything after it renders as HTML. One quote on page 3 of the acceptance
	 * document stopped the rest of the digest from rendering at all.
	 */
	it("escapes the angle brackets a quoted passage carries, so an XML tag cannot open raw HTML", () => {
		expect(quoteBody({ sentence: 'Dokumente innerhalb von <document index="n"> hier.', marked: [] })).toBe(
			'> Dokumente innerhalb von \\<document index="n"> hier. ^hl-1',
		);
	});

	it("escapes an ampersand, which would otherwise reach the reader as a decoded entity", () => {
		expect(quoteBody({ sentence: "A &amp; B.", marked: [] })).toBe("> A \\&amp; B. ^hl-1");
	});

	it("escapes a leading `>`, which would open a nested blockquote inside the callout", () => {
		expect(quoteBody({ sentence: "> zitiert.", marked: [] })).toBe("> \\> zitiert. ^hl-1");
	});

	it("leaves the digest's own `==` markers alone while escaping the text around them", () => {
		expect(quoteBody({ sentence: "Nutze <tag> im Prompt.", marked: ["<tag>"] })).toBe(
			"> Nutze ==\\<tag>== im Prompt. ^hl-1",
		);
	});

	it("quotes the sentence plain when no highlighted run is known", () => {
		expect(quoteBody({ sentence: "Nur der Satz.", marked: [] })).toBe("> Nur der Satz. ^hl-1");
	});

	it("falls back to the plain sentence when the run is not in the sentence at all", () => {
		expect(quoteBody({ sentence: "Nur der Satz.", marked: ["etwas anderes"] })).toBe("> Nur der Satz. ^hl-1");
	});

	it("marks each of several disjoint runs", () => {
		expect(quoteBody({ sentence: "Ein Wort und noch ein Wort.", marked: ["Ein", "noch"] })).toBe(
			"> ==Ein== Wort und ==noch== ein Wort. ^hl-1",
		);
	});

	it("marks the union of two overlapping runs once rather than twice", () => {
		// What the device produces for one adjusted selection: the same passage, twice, differently cut.
		expect(quoteBody({ sentence: "Ein Wort und noch mehr.", marked: ["Wort und", "und noch"] })).toBe(
			"> Ein ==Wort und noch== mehr. ^hl-1",
		);
	});

	it("marks a repeated run once", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Wort", "Wort"] })).toBe(
			"> Ein ==Wort== und mehr. ^hl-1",
		);
	});

	it("joins two runs that merely touch, so no empty `==...==` pair is emitted", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Ein ", "Wort"] })).toBe(
			"> ==Ein Wort== und mehr. ^hl-1",
		);
	});

	it("bridges two runs parted by nothing but whitespace", () => {
		// One continuous sweep of the marker that the device recorded as two runs; `==A== ==B==` would
		// render a seam the reader never drew.
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Ein", "Wort"] })).toBe(
			"> ==Ein Wort== und mehr. ^hl-1",
		);
	});

	it("keeps real unmarked words outside the marks", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["Ein", "und"] })).toBe(
			"> ==Ein== Wort ==und== mehr. ^hl-1",
		);
	});

	it("skips a run the sentence does not contain without losing the others", () => {
		expect(quoteBody({ sentence: "Ein Wort und mehr.", marked: ["fehlt", "Wort"] })).toBe(
			"> Ein ==Wort== und mehr. ^hl-1",
		);
	});

	it("does not render the marker color (F9)", () => {
		expect(quoteBody({ sentence: "Gelb.", marked: ["Gelb"], color: { r: 255, g: 207, b: 0 } })).toBe(
			"> ==Gelb==. ^hl-1",
		);
	});
});

describe("renderDigest — note anchors and crops", () => {
	function noteBlock(overrides: Partial<DigestNote>): string {
		const rendered = renderDigest(EMBED, [
			page({ notes: [{ ...note({ id: "nt-1", ...overrides }), section: null }] }),
		]);
		return rendered.split("\n\n").slice(1).join("\n\n");
	}

	it("titles the callout with the anchor", () => {
		expect(noteBlock({ anchor: { kind: "heading", heading: "Any" }, text: "x" })).toContain(
			"> [!note] at the heading »Any«",
		);
		expect(noteBlock({ anchor: { kind: "highlight", highlightId: "hl-9" }, text: "x" })).toContain(
			"> [!note] next to the highlight",
		);
		expect(noteBlock({ anchor: { kind: "page" }, text: "x" })).toContain("> [!note] on this page");
	});

	it("quotes the first words of the nearest line for a line anchor", () => {
		expect(noteBlock({ anchor: { kind: "line", line: "Die Techniken in diesem Abschnitt gelten" }, text: "x" })).toContain(
			"> [!note] at »Die Techniken in diesem…«",
		);
		expect(noteBlock({ anchor: { kind: "line", line: "Kurze Zeile" }, text: "x" })).toContain(
			"> [!note] at »Kurze Zeile«",
		);
	});

	it("embeds the crop and says so when nothing was transcribed", () => {
		expect(noteBlock({ cropEmbed: { path: "crops/nt-1.png", width: 600, height: 200 } })).toBe(
			"> [!note] on this page — not transcribable, crop:\n> ![[crops/nt-1.png|600]] ^nt-1",
		);
	});

	/**
	 * `rasterizePage` draws a crop 1:1 in device pixels, so its size is how much was written. A fixed
	 * embed width magnified the acceptance document's 116x417 margin bracket to 280x1007 and its 32x54
	 * tick to 280x472 -- blurry upscales printed larger than the paragraphs they annotate.
	 */
	it("never embeds a crop wider than it was rasterized", () => {
		expect(noteBlock({ cropEmbed: { path: "crops/nt-1.png", width: 32, height: 54 } })).toContain(
			"![[crops/nt-1.png|32]]",
		);
	});

	it("narrows a tall crop further, so it cannot grow past the height cap", () => {
		// 116x417 held to its own width would render 417 px tall; 55 px wide keeps it under 200.
		expect(noteBlock({ cropEmbed: { path: "crops/nt-1.png", width: 116, height: 417 } })).toContain(
			"![[crops/nt-1.png|55]]",
		);
	});

	it("still scales a crop wider than the cap down to it", () => {
		expect(noteBlock({ cropEmbed: { path: "crops/nt-1.png", width: 1616, height: 133 } })).toContain(
			"![[crops/nt-1.png|600]]",
		);
	});

	it("shows the crop below the text without the suffix when the drawing guard fired", () => {
		expect(noteBlock({ text: "Basic Rule O", cropEmbed: { path: "crops/nt-1.png", width: 600, height: 200 } })).toBe(
			"> [!note] on this page\n> Basic Rule O\n> ![[crops/nt-1.png|600]] ^nt-1",
		);
	});

	it("nests a highlight-anchored note inside that quote callout", () => {
		const rendered = renderDigest(EMBED, [
			page({
				highlights: [
					highlight({
						id: "hl-1",
						sentence: "Ein Satz.",
						marked: ["Satz"],
						notes: [note({ id: "nt-1", anchor: { kind: "highlight", highlightId: "hl-1" }, text: "Dazu." })],
					}),
				],
			}),
		]);
		expect(rendered).toContain(
			"> [!quote]\n> Ein ==Satz==. ^hl-1\n>\n> > [!note] next to the highlight\n> > Dazu. ^nt-1",
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

describe("slugify", () => {
	it("transliterates German umlauts instead of dropping them", () => {
		expect(slugify("Best Practices für Prompting")).toBe("best-practices-fuer-prompting");
		expect(slugify("Größe, Öl und Ähren")).toBe("groesse-oel-und-aehren");
	});

	it("transliterates a decomposed umlaut too — macOS hands names over in NFD", () => {
		expect(slugify("f\u0075\u0308r")).toBe("fuer");
	});

	it("strips remaining diacritics rather than replacing them", () => {
		expect(slugify("Café Crème")).toBe("cafe-creme");
	});

	it("collapses punctuation and whitespace into single dashes and trims them", () => {
		expect(slugify("  Notes: Part 1 — (draft!)  ")).toBe("notes-part-1-draft");
	});
});
