// The digest's data model and its markdown (spec F1-F9). Pure: everything this module needs is
// handed to it, so the format is decided in one place and testable as a single string. The pipeline
// (T9) does the measuring, the OCR and the file writing; nothing of that leaks in here.
//
// The layout is the one the digest-presentation map settled: the *section* is the digest's `###`
// heading and runs on across page breaks, a highlight is body text rather than a callout, and every
// entry under a section heading ends with a link to the page it sits on. Only handwriting is still a
// callout. The page steps in as the heading where no section is known, and then it carries the link
// and its entries carry none.

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
	/**
	 * True for the single entry a page added on the device produces: the whole page transcribed at
	 * once, rather than one note per line (F21). It changes only the callout's title -- such a page is
	 * not annotation *of* anything, so "at this heading" would be a claim about a document it is not
	 * part of.
	 */
	wholePage?: boolean;
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
 * The title of a page added on the device (F21). It says what the entry is -- a page of the reader's
 * own notes rather than a mark on someone else's text -- because that is the one thing about it a
 * reader cannot see from where it is printed.
 */
const WHOLE_PAGE_TITLE = "Handwritten page";

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
 * A leading `>` is escaped because a passage that starts with one would open a blockquote instead of
 * printing the character -- as the entry's own paragraph, and as a nested one inside a note callout.
 */
function escapeText(text: string): string {
	return text.replace(/[<&]/g, "\\$&").replace(/^>/, "\\>");
}

/**
 * The note callout's title.
 *
 * The anchor cascade (F5/F14) establishes where the note sat, and the layout now *shows* that: a
 * note printed under a section heading sat at that heading, one printed under a quote sat next to
 * that quote, and a note with no anchor at all sits under its page's own heading. Naming the anchor
 * there only repeats the position -- so the title says what the entry is, and nothing else.
 *
 * The line anchor is the exception, and the only one: nothing in the layout says which sentence the
 * note stood beside. It stays named. The cascade itself is untouched — it still decides where every
 * note is printed, which is the part the reader acts on.
 */
function anchorTitle(anchor: DigestAnchor): string {
	if (anchor.kind !== "line") return "Handwritten";
	const words = anchor.line.split(/\s+/).filter((word) => word !== "");
	const head = words.slice(0, ANCHOR_LINE_WORDS).join(" ");
	return `at »${escapeText(head)}${words.length > ANCHOR_LINE_WORDS ? "…" : ""}«`;
}

/**
 * The share of a quote that may be marked before the marks are dropped altogether.
 *
 * A mark only says something by contrast: where it covers the whole entry there is nothing left for
 * it to single out, and Obsidian paints one mark per wrapped line, so a long one reads as a striped
 * slab rather than a highlight. Measured over the fixture's 77 marked lines, 31 sit at 75 % or above
 * -- and every one of the 3 fragmented lines sits at 98 % or above, so the threshold removes the
 * fragments with them. Below it the mark is the only carrier of which words the reader actually drew
 * over, since the sentence around them is context the digest adds on purpose (F3).
 */
const FULLY_MARKED_COVERAGE = 0.75;

/**
 * Wraps every run in `==...==` at its first occurrence, or leaves the sentence plain when the runs
 * cover {@link FULLY_MARKED_COVERAGE} of it.
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

	// Over the resolved ranges, not over `marked`, whose runs overlap and repeat -- counting those
	// would put the coverage of an adjusted selection over 100 %.
	const covered = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
	if (covered >= FULLY_MARKED_COVERAGE * sentence.length) return sentence;

	let quoted = "";
	let cut = 0;
	for (const { start, end } of ranges) {
		quoted += `${sentence.slice(cut, start)}==${sentence.slice(start, end)}==`;
		cut = end;
	}
	return quoted + sentence.slice(cut);
}

/** The block id (F7) terminates the entry's last body line -- it has to sit on content, not on a callout's title line. */
function withBlockId(lines: string[], id: string): string[] {
	const last = lines.length - 1;
	return lines.map((line, index) => (index === last ? `${line} ^${id}` : line));
}

/**
 * A margin note, the one entry that is still a callout: it is the reader's own hand, and the box is
 * what tells it apart from the document's text around it.
 *
 * `prefix` is `> ` for a note of its own and `> > ` for one printed under a highlight.
 *
 * The locator rides on the **title** line rather than at the end of the entry, which is where a
 * highlight carries it. A note's last line is usually its crop, and a crop is up to 600 px wide: the
 * link then wrapped underneath the image and stood there on its own, and beside a narrow crop it sat
 * flush against it -- the same link in a different place on every note. The title line is one place.
 */
function renderNote(note: DigestNote, prefix: string, locator: string): string {
	const embed = note.cropEmbed === null ? [] : [`![[${note.cropEmbed.path}|${cropDisplayWidth(note.cropEmbed)}]]`];
	// Split before escaping, not after: a page transcript is the one body that keeps its newlines, and
	// every line of it needs the callout prefix of its own -- plus `escapeText`'s leading-`>` guard,
	// which only ever looks at the start of the string it is given.
	const textLines = note.text === "" ? [] : note.text.split("\n").map(escapeText);
	const body = [...textLines, ...embed];
	// Only a crop-*only* note announces itself as not transcribable. Every note carries a crop now
	// (F6), so the crop's presence says nothing about the text; its absence in the body does. The
	// suffix stays last: its colon points at the crop below it.
	const suffix = note.text === "" && note.cropEmbed !== null ? CROP_TITLE_SUFFIX : "";
	const title = note.wholePage ? WHOLE_PAGE_TITLE : anchorTitle(note.anchor);
	const lines = withBlockId([`[!note] ${title}${locator}${suffix}`, ...body], note.id);
	return lines.map((line) => `${prefix}${line}`).join("\n");
}

/**
 * A highlight is body text: the sentence with its marked runs, then the locator and the block id.
 *
 * No callout. A quote is prose and reads as prose; the box around it was the digest's loudest
 * element and said nothing a reader could act on, and stacked against the note callouts it made the
 * page alternate grey and blue for its whole length. With the box gone the fold it existed to keep
 * short goes too -- a long quote is now simply a long paragraph.
 */
function renderHighlight(highlight: DigestHighlight, locator: string): string {
	// Escaped after marking, not before: the runs are matched against the raw sentence, and `==` is
	// the digest's own markup rather than the document's, so it must survive untouched.
	//
	// The block id goes on a line of its own, which is what keeps F7's "invisible in reading view"
	// true. Measured in a real Reading View: Obsidian hides a trailing `^id` inside a callout but
	// prints it as grey text at the end of a paragraph -- so moving the quote out of its callout made
	// every id visible. On its own line (no blank line, so it stays part of the entry) it is hidden
	// again and still resolves as a link target. A note keeps its id on the last body line: inside
	// the callout it was never visible.
	const quote = `${escapeText(markSentence(highlight.sentence, highlight.marked))}${locator}\n^${highlight.id}`;
	// A note anchored to this highlight follows it as a block of its own -- there is no callout left
	// to nest inside. It repeats the locator rather than leaning on the quote above it: as a separate
	// box it reads as an entry, and an entry whose title lacks the link every other one has reads as
	// a link that went missing.
	const nested = highlight.notes.map((note) => `\n\n${renderNote(note, "> ", locator)}`);
	return `${quote}${nested.join("")}`;
}

interface DigestEntry {
	section: string | null;
	top: number;
	/** `locator` is the entry's trailing page link, "" where the page is the heading and carries it. */
	render(locator: string): string;
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
			render: (locator: string) => renderHighlight(highlight, locator),
		})),
		...page.notes.map((note) => ({
			section: note.section,
			top: note.top,
			render: (locator: string) => renderNote(note, "> ", locator),
		})),
	];

	const sectionOrder = new Map<string | null, number>();
	for (const entry of [...entries].sort((a, b) => a.top - b.top)) {
		if (!sectionOrder.has(entry.section)) sectionOrder.set(entry.section, sectionOrder.size);
	}
	return entries.sort(
		(a, b) => (sectionOrder.get(a.section) ?? 0) - (sectionOrder.get(b.section) ?? 0) || a.top - b.top,
	);
}

/**
 * The whole `## Digest` section body, or "" when there is nothing to show. Starts with a blank line
 * and carries no trailing newline, the shape `buildManagedBlock` expects of a section body.
 *
 * One `###` heading per section, not per page. A section runs on across a page break, and repeating
 * its heading there would say nothing the entry's own page link does not -- the pages are the
 * locators, the sections are the structure. Where an entry has no section (a PDF with neither an
 * outline nor larger headings) its page is the heading instead, and then the heading carries the
 * link and the entries carry none.
 *
 * A page without a single entry contributes nothing, so it never appears as a bare heading: a page
 * with no annotation is not part of the digest.
 */
export function renderDigest(embedPath: string, pages: DigestPage[]): string {
	const blocks: string[] = [];
	let heading: string | null = null;

	for (const page of pages) {
		const pageLink = (label: string) => `[[${embedPath}#page=${page.embedPage}|${label}]]`;
		for (const entry of pageEntries(page)) {
			// Compared as the rendered line, which is what settles both cases at once: the same section
			// twice running is one heading, while two pages without a section are two -- their headings
			// differ, because each names its own page.
			const line = entry.section === null ? `### ${pageLink(`Page ${page.pageLabel}`)}` : `### ${escapeText(entry.section)}`;
			if (line !== heading) {
				heading = line;
				blocks.push(line);
			}
			blocks.push(entry.render(entry.section === null ? "" : ` · ${pageLink(`p. ${page.pageLabel}`)}`));
		}
	}

	return blocks.length === 0 ? "" : `\n${blocks.join("\n\n")}`;
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
