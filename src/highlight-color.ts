/**
 * Which of Zotero's eight colours a highlighter colour *is*.
 *
 * Shared by the two places a highlight's colour is shown -- the annotation written into Zotero
 * (`zotero-annotations.ts`) and the mark in the note's digest (`digest-builder.ts`) -- so that the
 * green a reader sees in Zotero is the green they see in Obsidian. One table, one hue rule; a
 * device colour that lands in one place cannot land differently in the other.
 */

import { DEFAULT_ANNOTATION_COLOR } from "./zotero-client";

/** Zotero's colour names, as its reader shows them in the colour filter. */
export type HighlightColorName = "yellow" | "red" | "green" | "blue" | "purple" | "magenta" | "orange" | "gray";

/**
 * The hue each of Zotero's chromatic colours owns, as the upper edge of its band in degrees, in the
 * order the bands run round the circle. Grey is not a band: it is what a colour with no hue gets.
 *
 * The edges are where the measured device colours (`zotero-annotations.test.ts`, *the colour*) say
 * the eye puts them. Three are not midpoints on purpose: blue runs to 245° because every blue a
 * reMarkable records is a royal blue (227-231°) while Zotero's is an azure (200°); yellow starts at
 * 40° so that the Paper Pro's amber shader stays with the yellows it sits next to on the device; and
 * magenta runs to 355° so that the palette's pink (255/192/203, hue 350°) -- what a reMarkable 2 and,
 * on current firmware, the Paper Pro's highlighter record for "pink" -- is Zotero's magenta like the
 * lilac pink (242/158/255) older Paper Pro firmware writes, not its red. Reds proper sit at 0-2°.
 */
const HUE_BANDS: readonly { upTo: number; name: HighlightColorName }[] = [
	{ upTo: 15, name: "red" },
	{ upTo: 40, name: "orange" },
	{ upTo: 75, name: "yellow" },
	{ upTo: 165, name: "green" },
	{ upTo: 245, name: "blue" },
	{ upTo: 275, name: "purple" },
	{ upTo: 355, name: "magenta" }, // and past it the circle closes on red again
];

/** Zotero's own eight, by name -- the hex its reader offers for each. */
const HEX_BY_NAME: Record<HighlightColorName, string> = {
	yellow: "#ffd400",
	red: "#ff6666",
	green: "#5fb236",
	blue: "#2ea8e5",
	purple: "#a28ae5",
	magenta: "#e56eee",
	orange: "#f19837",
	gray: "#aaaaaa",
};

/**
 * Below this spread between the strongest and weakest channel a colour has no hue worth the name:
 * the Paper Pro's grey highlighter is 1, its black shader 5, and the palest colour any device records
 * (the palette's pink, 255/192/203) is 63.
 */
const GREY_CHROMA = 32;

/**
 * The name of the Zotero colour whose hue band the device colour falls in, or grey for a colour
 * with no hue.
 *
 * Not the nearest in RGB. Every highlighter colour a device records is pastel -- the Paper Pro's
 * yellow is 255/237/117, its green 172/255/133 -- and by squared distance a pastel is nearer to
 * Zotero's grey than to its own saturated namesake, which turned green and orange highlights grey
 * and the yellow one orange. A colour's name is its hue; lightness is what the highlighter's
 * translucency adds, and both readers add their own.
 */
export function highlightColorName(color: { r: number; g: number; b: number }): HighlightColorName {
	const { r, g, b } = color;
	const max = Math.max(r, g, b);
	const chroma = max - Math.min(r, g, b);
	if (chroma < GREY_CHROMA) return "gray";
	const sector = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
	const hue = (sector * 60 + 360) % 360;
	return HUE_BANDS.find((band) => hue < band.upTo)?.name ?? "red";
}

/**
 * The one of Zotero's eight the reader drew with, as lowercase hex.
 *
 * A highlight the device recorded without a colour, and every pen mark, is Zotero's default yellow:
 * the colour is not known to be anything else, and `#ffd400` is what Zotero itself fills in.
 */
export function zoteroColor(color: { r: number; g: number; b: number } | null): string {
	return color === null ? DEFAULT_ANNOTATION_COLOR : HEX_BY_NAME[highlightColorName(color)];
}
