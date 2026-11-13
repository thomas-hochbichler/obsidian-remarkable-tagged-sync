/**
 * The page a sent note is printed on: send-from-the-vault spec §4.1, §4.4 and §4.5.
 *
 * Arithmetic and text only -- no Obsidian, no Electron -- so every number chosen on the tablet itself
 * (prototype, nine rounds) is pinned by a test rather than by a look at a PDF.
 * What reads layout (the diagram, task-list and keep-whole passes) and the print itself live
 * elsewhere; they take their numbers from here.
 *
 * **The page is the tablet's physical screen**, not A5 and not one format for all: a reMarkable 2
 * page shown on a Paper Pro is scaled up 14 %, and 10 pt becomes the 11.4 pt the user rejected.
 * So the type has the same physical size on either device, and a Paper Pro simply holds more of it.
 */

import { PAPER_PRO, RM_1_2, type DeviceCanvas } from "./pdf-renderer";

/** The two pages a note can be printed on. A Paper Pro Move has none of its own in v1 (spec §4.1). */
export type SendTablet = "rm12" | "paperPro";
export type SendTextSize = "normal" | "large";

/** What the three settings of the *Send from the vault* group decide about a printed note. */
export interface PrintChoice {
	readonly tablet: SendTablet;
	readonly textSize: SendTextSize;
	/** The tablet is in left-handed mode, so its toolbar -- and the wide margin -- is on the right. */
	readonly toolbarRight: boolean;
}

/** In inches, as `printToPDF` takes them. */
export interface PrintMargins {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

export interface PrintPage {
	readonly widthIn: number;
	readonly heightIn: number;
	readonly margins: PrintMargins;
	/** The text column in CSS px (96 to the inch): how wide the note is rendered and laid out. */
	readonly columnPx: number;
	/** A block shorter than this is kept whole; a longer one may split (spec §4.3, pass 7). */
	readonly keepWholePx: number;
	readonly bodyPt: number;
	readonly codePt: number;
	/** The size a diagram's labels are scaled to (spec §4.3, pass 5). */
	readonly diagramPt: number;
}

const CSS_PX_PER_INCH = 96;

/**
 * The margins, fixed and not a setting. The toolbar's side must clear the tablet's toolbar -- that
 * strip of the screen is under it, which is also why nothing may hang left of the column; the other
 * side is as narrow as reads comfortably. No writing margin: the user tried one and chose the
 * wider column.
 */
const TOOLBAR_SIDE_IN = 0.75;
const FAR_SIDE_IN = 0.4;
const TOP_AND_BOTTOM_IN = 0.45;

const BODY_PT: Record<SendTextSize, number> = { normal: 10, large: 12 };

// Everything else in ratio to the body, so `Large` keeps the look the user chose at `Normal`.
const LINE_HEIGHT = 1.45;
const CODE_RATIO = 0.7;
const CODE_LINE_HEIGHT = 1.35;
const TABLE_RATIO = 0.78;
const DIAGRAM_RATIO = 0.85;
const CAPTION_RATIO = 0.85;

/**
 * The share of the printable height below which a block is kept whole. Round 2 kept blocks under
 * 60 % whole and a long code block pushed to the next page left most of a page blank; a third of a
 * page is the most worth leaving empty.
 */
const KEEP_WHOLE_SHARE = 0.35;

/**
 * The list indent a task's checkbox is pulled back by, so the box sits inside the column rather than
 * hanging left of it (round 6: under the toolbar, and half cut off by the print).
 */
const TASK_INDENT_EM = 1.8;

/** The public class on the printed note: users' own print snippets select it, so it never changes. */
export const SEND_CLASS = "tagged-sync-send";
/** The one small line an embed that cannot be printed becomes (spec §4.3, pass 2). */
export const MISSING_EMBED_CLASS = "tagged-sync-send-missing";
/** A paragraph of nothing but emphasis right after an image or a diagram (pass 4). */
export const CAPTION_CLASS = "tagged-sync-send-caption";
/** A block short enough to be kept on one page (pass 7). */
export const KEEP_WHOLE_CLASS = "tagged-sync-send-keep";

const SCREENS: Record<SendTablet, DeviceCanvas> = { rm12: RM_1_2, paperPro: PAPER_PRO };

// Two decimals of a point, so 10 × 0.7 is 7 and not 7.000000000000001 in the stylesheet.
const roundPt = (pt: number): number => Math.round(pt * 100) / 100;

/** The page, its margins and every size that follows from the three settings. */
export function printPage(choice: PrintChoice): PrintPage {
	const screen = SCREENS[choice.tablet];
	// From the device frames the renderer already measures strokes in, never a typed-in literal: the
	// one place that knows what a reMarkable's screen is stays the one place.
	const widthIn = screen.widthPt / 72;
	const heightIn = screen.heightPt / 72;
	const [left, right] = choice.toolbarRight ? [FAR_SIDE_IN, TOOLBAR_SIDE_IN] : [TOOLBAR_SIDE_IN, FAR_SIDE_IN];
	const margins = { top: TOP_AND_BOTTOM_IN, right, bottom: TOP_AND_BOTTOM_IN, left };
	const bodyPt = BODY_PT[choice.textSize];
	return {
		widthIn,
		heightIn,
		margins,
		columnPx: Math.round((widthIn - left - right) * CSS_PX_PER_INCH),
		keepWholePx: Math.round((heightIn - margins.top - margins.bottom) * CSS_PX_PER_INCH * KEEP_WHOLE_SHARE),
		bodyPt,
		codePt: roundPt(bodyPt * CODE_RATIO),
		diagramPt: roundPt(bodyPt * DIAGRAM_RATIO),
	};
}

/** The part of Electron's `printToPDF` options this plugin passes. Inches throughout (Electron 21+). */
export interface PrintToPdfOptions {
	readonly pageSize: { readonly width: number; readonly height: number };
	readonly margins: PrintMargins;
	readonly printBackground: true;
	readonly generateDocumentOutline: true;
	readonly generateTaggedPDF: true;
}

/**
 * The options for `printToPDF`, checked before they are used.
 *
 * Checked here and not left to Electron because of what a rejected print costs: Electron 21 to 39
 * queue every PDF print of the app on one promise, and a rejection leaves it rejected, so one bad
 * number would block all PDF printing until Obsidian restarts (research 02). The numbers come from
 * constants today; the check is for the day they do not.
 *
 * Both outline options, together: `generateDocumentOutline` alone gave no outline (prototype round
 * 4). The outline is what files the returned quotes under the note's own headings. Electron before
 * 29 ignores both, and the note is sent without one.
 */
export function printOptions(page: PrintPage): PrintToPdfOptions {
	const { widthIn, heightIn, margins } = page;
	for (const [name, value] of Object.entries({ widthIn, heightIn, ...margins })) {
		if (!Number.isFinite(value) || value <= 0) throw new Error(`The print page's ${name} is not a positive number: ${value}`);
	}
	if (margins.left + margins.right >= widthIn || margins.top + margins.bottom >= heightIn) {
		throw new Error("The print page's margins leave no room for text");
	}
	return {
		pageSize: { width: widthIn, height: heightIn },
		margins: { ...margins },
		printBackground: true,
		generateDocumentOutline: true,
		generateTaggedPDF: true,
	};
}

/**
 * The stylesheet the print surface adds after every other one, so its rules win over the theme's
 * and the user's snippets (spec §4.4). Every rule is scoped to `.print`, the wrapper Obsidian's own
 * print stylesheet shows and nothing else.
 *
 * `!important` where the theme sets the same property, because a theme's selector may be more
 * specific than ours and a theme that prints badly is what the public class is for, not this.
 *
 * **Nothing may hang left of the text column**: that strip is under the tablet's toolbar. The one
 * negative length is the checkbox pulled back into its list's own indent.
 */
export function printStylesheet(page: PrintPage): string {
	const note = `.print .markdown-preview-view.${SEND_CLASS}`;
	const inNote = (selectors: string): string =>
		selectors
			.split(",")
			.map((selector) => `.print .${SEND_CLASS} ${selector.trim()}`)
			.join(", ");
	return [
		`${note} { font-size: ${page.bodyPt}pt !important; line-height: ${LINE_HEIGHT} !important; padding: 0 !important; max-width: none !important; width: 100% !important; }`,
		// An embedded note is a reading view of its own, with Obsidian's size and file margins: at
		// 16 px in a 10 pt note it printed half again as large and a column narrower (ticket 12).
		`${inNote(".markdown-preview-view")} { font-size: inherit !important; line-height: inherit !important; padding: 0 !important; max-width: none !important; width: 100% !important; }`,
		// A heading at the foot of a page with its text on the next is the break readers notice most.
		`${inNote("h1, h2, h3, h4, h5, h6")} { break-after: avoid; }`,
		`${inNote("p, li")} { orphans: 3; widows: 3; }`,
		// Code wraps rather than running off the page, and is set smaller: at body size it wrapped on
		// nearly every line (round 5).
		`${inNote("pre, pre code")} { white-space: pre-wrap !important; overflow-wrap: anywhere; font-size: ${page.codePt}pt !important; line-height: ${CODE_LINE_HEIGHT} !important; }`,
		`${inNote("pre")} { padding: 6px 8px !important; }`,
		// Columns sized by their content, words broken only where they must: a fixed layout gave six
		// equal columns and broke every second word (round 3). The size has to reach the cells.
		`${inNote("table")} { table-layout: auto; width: 100% !important; max-width: 100% !important; font-size: ${TABLE_RATIO}em !important; }`,
		`${inNote("th, td")} { font-size: inherit !important; padding: 3px 5px !important; overflow-wrap: anywhere; vertical-align: top; }`,
		`${inNote("td code, th code")} { white-space: normal !important; overflow-wrap: anywhere; }`,
		`${inNote("img, svg")} { max-width: 100% !important; height: auto; }`,
		`${inNote("ul.contains-task-list")} { padding-inline-start: ${TASK_INDENT_EM}em !important; margin-inline-start: 0 !important; }`,
		`${inNote("li.task-list-item")} { list-style: none !important; }`,
		`${inNote("li.task-list-item > .task-list-item-checkbox, li.task-list-item > p > .task-list-item-checkbox")} { margin-inline-start: -${TASK_INDENT_EM}em !important; margin-inline-end: 0.55em !important; }`,
		// A paragraph of its own, or the emphasis on the line under an image (pass 4); the margin only
		// moves the paragraph.
		`${inNote(`.${CAPTION_CLASS}`)} { font-size: ${CAPTION_RATIO}em !important; margin-top: 0.2em !important; }`,
		`${inNote(`.${MISSING_EMBED_CLASS}`)} { font-size: ${CAPTION_RATIO}em; color: var(--text-muted); }`,
		`${inNote(`.${KEEP_WHOLE_CLASS}`)} { break-inside: avoid; }`,
	].join("\n");
}
