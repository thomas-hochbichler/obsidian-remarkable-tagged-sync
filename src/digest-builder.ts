// The digest's data model and its markdown (spec F1-F9). Pure: everything this module needs is
// handed to it, so the format is decided in one place and testable as a single string. The pipeline
// (T9) does the measuring, the OCR and the file writing; nothing of that leaks in here.
//
// The signed-off sample (prototype/05-sample-digest.md) is the contract, with one deviation: section
// changes render as `####` headings rather than the sample's bold lines, so the digest's sections show
// up in Obsidian's outline pane next to the `###` page headings.

import type { DigestAnchor } from "./digest-anchoring";
import { hashString } from "./note-builder";

export interface DigestNote {
	/** Block id without the caret, e.g. `nt-4c8a17`. */
	id: string;
	anchor: DigestAnchor;
	/** "" when nothing was transcribed -- then the crop carries the entry (F6). */
	text: string;
	/** The crop, at the size it was rasterized, or null. The embed's display width is derived from it -- see `cropDisplayWidth`. */
	cropEmbed: { path: string; width: number; height: number } | null;
	/** Scene y, for reading order. */
	top: number;
}

export interface DigestHighlight {
	/** Block id without the caret, e.g. `hl-9f21c4`. */
	id: string;
	/** The full surrounding sentence, or the `.rm` highlight text alone (F4 soft fail). */
	sentence: string;
	/**
	 * The highlighted runs inside `sentence`; empty when none is known (F4 soft fail).
	 *
	 * A list, not a single run: the device keeps every version of a selection the user adjusted, so
	 * one sentence commonly arrives as several overlapping `glyph_def` runs. The pipeline merges them
	 * into this one entry instead of printing the same sentence once per run.
	 */
	marked: string[];
	/**
	 * The marker's color. Carried through the model but deliberately never rendered: F9 keeps every
	 * highlight a uniform `==...==`, because color semantics ("yellow = important") is the user's
	 * private convention and guessing at it would put meaning in the note that nobody stated. Do not
	 * "fix" this by rendering it -- changing it needs a spec decision, not a patch.
	 */
	color: { r: number; g: number; b: number } | null;
	/** Notes anchored to this highlight, nested inside its callout (F5). */
	notes: DigestNote[];
	/** Nearest section heading. */
	section: string | null;
	top: number;
}

export interface DigestPage {
	pageLabel: string;
	embedPage: number;
	topSection: string | null;
	highlights: DigestHighlight[];
	/** Notes not nested under a highlight, each with its own `section`. */
	notes: (DigestNote & { section: string | null })[];
}

/**
 * Crop width cap in px, about a note pane's readable column. Only the wide crops meet it -- a note
 * written across the page arrives ~1600 px wide -- and holding those to a narrow aside shrank the
 * handwriting to a couple of dozen pixels tall, legible only when clicked. Nothing is upscaled to
 * reach this, so a small mark is unaffected by the number.
 */
const CROP_MAX_WIDTH = 600;

/**
 * Crop height cap in px, so a tall narrow mark stays an aside too. A bracket down a margin is a few
 * millimetres wide and several centimetres long; held to the width cap alone it renders as a
 * thousand-pixel column that dwarfs the note it annotates.
 */
const CROP_MAX_HEIGHT = 200;

/**
 * The width to embed a crop at: never wider than it was rasterized, and never so wide that it grows
 * past the height cap.
 *
 * The no-upscaling half is the one that matters. `rasterizePage` draws a crop 1:1 in device pixels,
 * so its size *is* how much was written -- a 116x417 bracket, a 32x54 tick. Pinning every embed to a
 * fixed width magnified those to 280x1007 and 280x472: a blurry upscale of a small mark, printed
 * larger than the paragraphs around it. Scaling down stays allowed, because a note written right
 * across the page arrives 1600 px wide and has to fit the pane.
 */
function cropDisplayWidth(crop: { width: number; height: number }): number {
	if (crop.width <= 0 || crop.height <= 0) return CROP_MAX_WIDTH;
	// Floored, not rounded: rounding a cap up puts the result back over it.
	return Math.max(1, Math.floor(Math.min(crop.width, CROP_MAX_WIDTH, (CROP_MAX_HEIGHT * crop.width) / crop.height)));
}

/** How many words of the nearest line the `line` anchor quotes before trailing off. */
const ANCHOR_LINE_WORDS = 4;

/** All fixed labels are English, matching the plugin's other note surfaces (F8). */
const CROP_TITLE_SUFFIX = " — not transcribable, crop:";

/**
 * Neutralises the markup a quoted passage can carry into the note. Every string that comes from the
 * PDF or from OCR goes through this; nothing the digest generates itself does.
 *
 * `<` is what makes this necessary rather than tidy. Markdown passes raw HTML through, so a document
 * that talks about XML -- and the acceptance document is a prompting guide, so it does it constantly
 * -- emits `<document index="n">` into the note as an *unclosed tag*, and Obsidian renders
 * everything after it as HTML. One quote on page 3 silently stopped the rest of the digest from
 * rendering at all. `&` is the same mechanism one step smaller: `&amp;` in the source would reach
 * the reader as a bare `&`.
 *
 * A leading `>` is escaped because a callout body is written as `> <text>`; a passage that starts
 * with one would open a nested blockquote inside the callout instead of printing the character.
 */
function escapeText(text: string): string {
	return text.replace(/[<&]/g, "\\$&").replace(/^>/, "\\>");
}

/**
 * The note callout's title: what the geometry established about where the note sat (F5). No hedged
 * wording -- the cascade already decided, and "on this page" is the honest floor.
 */
function anchorTitle(anchor: DigestAnchor): string {
	switch (anchor.kind) {
		case "heading":
			// Named, not just "at the heading": the digest prints several notes per page and a bare
			// "at the heading" says nothing the reader can act on. Naming it also keeps this apart from
			// the line anchor below, which quotes a heading's text whenever that heading is the nearest
			// line -- two different findings that read identically while both were unnamed.
			return `at the heading »${escapeText(anchor.heading)}«`;
		case "highlight":
			return "next to the highlight";
		case "line": {
			const words = anchor.line.split(/\s+/).filter((word) => word !== "");
			const head = words.slice(0, ANCHOR_LINE_WORDS).join(" ");
			return `at »${escapeText(head)}${words.length > ANCHOR_LINE_WORDS ? "…" : ""}«`;
		}
		case "page":
			return "on this page";
	}
}

/**
 * Wraps every run in `==...==` at its first occurrence.
 *
 * The runs are separate selections over one passage, so they overlap, repeat and touch each other.
 * They are resolved to non-overlapping character ranges first: nested or crossing `==` markers are
 * not valid Markdown, and a character marked twice would print its own delimiters. Touching counts
 * as overlapping -- `==a====b==` is not a rendering of two adjacent runs.
 *
 * The caller guarantees each run is a substring, but a miss must not cost the reader the quote: the
 * plain sentence still says what the highlight was about, while throwing would drop the annotation
 * entirely.
 */
function markSentence(sentence: string, marked: string[]): string {
	const found = marked
		.map((run) => ({ start: run === "" ? -1 : sentence.indexOf(run), length: run.length }))
		.filter((range) => range.start >= 0)
		.sort((a, b) => a.start - b.start || a.length - b.length);

	const ranges: { start: number; end: number }[] = [];
	for (const { start, length } of found) {
		const last = ranges[ranges.length - 1];
		// Runs parted by nothing but whitespace are bridged: on the device that was one continuous
		// stroke of the marker, and `==A== ==B==` renders the seam the reader never drew. Only
		// whitespace is swallowed -- real unmarked words in between stay outside the marks.
		if (last && sentence.slice(last.end, start).trim() === "") last.end = Math.max(last.end, start + length);
		else ranges.push({ start, end: start + length });
	}

	let quoted = "";
	let cut = 0;
	for (const { start, end } of ranges) {
		quoted += `${sentence.slice(cut, start)}==${sentence.slice(start, end)}==`;
		cut = end;
	}
	return quoted + sentence.slice(cut);
}

/** The block id terminates the entry's last body line (F7) -- it has to sit on content, not on a callout's title line. */
function withBlockId(lines: string[], id: string): string[] {
	const last = lines.length - 1;
	return lines.map((line, index) => (index === last ? `${line} ^${id}` : line));
}

/** `prefix` is `> ` for a page-level note and `> > ` for one nested inside a quote callout. */
function renderNote(note: DigestNote, prefix: string): string {
	const embed = note.cropEmbed === null ? [] : [`![[${note.cropEmbed.path}|${cropDisplayWidth(note.cropEmbed)}]]`];
	const body = note.text === "" ? embed : [escapeText(note.text), ...embed];
	// Only a crop-*only* note announces itself as not transcribable. Every note carries a crop now
	// (F6), so the crop's presence says nothing about the text; its absence in the body does.
	const suffix = note.text === "" && note.cropEmbed !== null ? CROP_TITLE_SUFFIX : "";
	const lines = withBlockId([`[!note] ${anchorTitle(note.anchor)}${suffix}`, ...body], note.id);
	return lines.map((line) => `${prefix}${line}`).join("\n");
}

/**
 * Above this many characters a quote is folded shut. Nothing is dropped -- one click opens it, and
 * the PDF it quotes is embedded at the top of the same note.
 *
 * A highlight can legitimately run this long: the reader records a selection over several paragraphs
 * as one run, and page 7 of the acceptance document has one covering 1350 characters across three
 * passages. Printed open it buries the eight shorter highlights around it, which is the opposite of
 * what a digest is for. 600 is about a screenful in the reading pane and leaves every ordinary
 * sentence-scale quote -- the longest of the other 60 on that document is 320 -- open as before.
 */
const FOLD_QUOTE_CHARS = 600;

function renderHighlight(highlight: DigestHighlight): string {
	// `-` is Obsidian's foldable-and-collapsed callout marker.
	const callout = highlight.sentence.length > FOLD_QUOTE_CHARS ? "[!quote]- Long highlight" : "[!quote]";
	// Escaped after marking, not before: the runs are matched against the raw sentence, and `==` is
	// the digest's own markup rather than the document's, so it must survive untouched.
	const lines = withBlockId([callout, escapeText(markSentence(highlight.sentence, highlight.marked))], highlight.id);
	const quote = lines.map((line) => `> ${line}`).join("\n");
	// A `>` line keeps the nested note a separate callout instead of a continuation of the quote.
	const nested = highlight.notes.map((note) => `\n>\n${renderNote(note, "> > ")}`);
	return `${quote}${nested.join("")}`;
}

interface DigestEntry {
	section: string | null;
	top: number;
	markdown: string;
}

/**
 * Reading order: section first, then top-down within the section.
 *
 * Sorting by `top` alone does not reproduce the sample. A note written *at* a heading sits slightly
 * above that heading's baseline, so by position it still belongs to the section above it and would be
 * printed before the section heading it introduces. Grouping by section fixes that, and it also settles the
 * exact `top` tie a heading produces between the last entry of one section and the first of the next.
 *
 * Sections themselves run in the order their first entry appears top-down, which is the order of
 * their headings on the page -- the page carries no heading positions of its own.
 */
function pageEntries(page: DigestPage): DigestEntry[] {
	const entries: DigestEntry[] = [
		...page.highlights.map((highlight) => ({
			section: highlight.section,
			top: highlight.top,
			markdown: renderHighlight(highlight),
		})),
		...page.notes.map((note) => ({ section: note.section, top: note.top, markdown: renderNote(note, "> ") })),
	];

	const sectionOrder = new Map<string | null, number>();
	for (const entry of [...entries].sort((a, b) => a.top - b.top)) {
		if (!sectionOrder.has(entry.section)) sectionOrder.set(entry.section, sectionOrder.size);
	}
	return entries.sort(
		(a, b) => (sectionOrder.get(a.section) ?? 0) - (sectionOrder.get(b.section) ?? 0) || a.top - b.top,
	);
}

function renderPage(embedPath: string, page: DigestPage): string {
	const link = `[[${embedPath}#page=${page.embedPage}|Page ${page.pageLabel}]]`;
	const blocks = [`### ${link}${page.topSection === null ? "" : ` · ${escapeText(page.topSection)}`}`];

	// The page heading already names the top section, so it is the initial value here and never
	// repeats as a `####` heading right below itself (F3).
	let section = page.topSection;
	for (const entry of pageEntries(page)) {
		if (entry.section !== section) {
			section = entry.section;
			if (section !== null) blocks.push(`#### ${escapeText(section)}`);
		}
		blocks.push(entry.markdown);
	}
	return blocks.join("\n\n");
}

/**
 * The whole `## Digest` section body, or "" when there is nothing to show. Starts with a blank line
 * and carries no trailing newline, the shape `buildManagedBlock` expects of a section body.
 *
 * Pages without a single entry are dropped rather than rendered as a bare heading: a page with no
 * annotation is not part of the digest.
 */
export function renderDigest(embedPath: string, pages: DigestPage[]): string {
	const rendered = pages
		.filter((page) => page.highlights.length > 0 || page.notes.length > 0)
		.map((page) => renderPage(embedPath, page));
	return rendered.length === 0 ? "" : `\n${rendered.join("\n\n")}`;
}

/**
 * The stable block id of a digest entry (F15). Derived from the device's own CRDT ids, so it survives
 * a better OCR backend, a recomputed sentence context and a re-sync -- the user's links into the note
 * keep pointing at the same annotation. Six hex chars keep the id readable in the markdown; a
 * collision would merge two entries' links, not lose an entry.
 */
export function digestId(prefix: "hl" | "nt", pageId: string, crdtId: string): string {
	return `${prefix}-${hashString(`${pageId}:${crdtId}`).slice(0, 6)}`;
}

/**
 * A file-name-safe slug for the document, used to name crop attachments (F17).
 *
 * German umlauts are transliterated before the diacritics are stripped, so "für" becomes "fuer" and
 * not "fur". The NFC pass in front of it is what makes that reliable: names read off a macOS volume
 * arrive decomposed, where "ä" is an "a" plus a combining mark and the transliteration would miss it.
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize("NFC")
		.replace(/ä/g, "ae")
		.replace(/ö/g, "oe")
		.replace(/ü/g, "ue")
		.replace(/ß/g, "ss")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
