import type { TextFace } from "./text-layout";

/**
 * The device's own text metrics, measured off its PDF exports (ticket 19).
 *
 * The typed text on a page is laid out by the device in `reMarkableSans-Regular` at 10.15pt, and a
 * heading paragraph in `reMarkableSerifSmall-Regular` at 14.59pt -- named outright by the fonts
 * embedded in the reMarkable app's own exports, and identical across two unrelated notebooks. At the
 * device's 1404px / 445pt those are 32.0px and 46.0px.
 *
 * **Only the advances are here, never the typeface.** The exports embed the real fonts as subsets;
 * they are the dev's own documents and carry no licence to redistribute outlines, so what ships is
 * the measurement -- the widths -- and the drawing is done with a base-14 face.
 *
 * Why not simply measure with that base-14 face: Helvetica reproduces the corpus's line breaks only
 * inside a fitted 1.5%-wide size window, and gets 3 of 6 paragraphs wrong at the device's own size.
 * Per character it is on average right (mean ratio 1.005) and scatters +-11% around it. Six
 * paragraphs cannot tell a metric from a coincidence at that scatter, so the device's own numbers are
 * used where they exist -- and they break all six correctly on the first attempt, unfitted.
 */

/** Font size in device pixels: 10.15pt and 14.59pt at 1404px / 445pt. */
export const PLAIN_TEXT_SIZE_PX = 32.02;
export const HEADING_TEXT_SIZE_PX = 46.03;

/**
 * How far right of the text box's own x the first glyph is drawn. Measured at 1.30pt on both pages
 * that carry text, and it is padding rather than a margin: the wrap width is still counted from the
 * box's x, which is what makes the stored `width` the exact limit the device breaks at.
 */
export const TEXT_LEFT_PADDING_PX = 4.1;

/**
 * Advance widths per 1000 em.
 *
 * `_MEASURED` is what the device's exports actually supplied; `_ESTIMATED` is Helvetica's own advance
 * scaled by the mean measured ratio between the two faces, for everything a Latin vault might type
 * that the corpus never did -- German umlauts and the comma among them. Replacing an estimate with a
 * measurement needs nothing but a device export that uses the character.
 */
// SANS: 64 measured, 137 estimated at ratio 1.0052
const SANS_MEASURED: Record<string, number> = { " ": 236, "+": 537, "-": 342, ".": 211, "/": 398, "0": 608, "1": 420, "2": 574, "4": 575, "5": 573, "7": 503, "8": 594, ":": 251, "?": 493, "A": 649, "B": 654, "C": 688, "D": 692, "E": 593, "F": 573, "G": 723, "I": 271, "K": 637, "L": 530, "M": 871, "N": 738, "O": 740, "P": 619, "R": 660, "S": 640, "T": 578, "V": 654, "W": 985, "X": 625, "Z": 581, "_": 483, "a": 546, "b": 592, "c": 536, "d": 592, "e": 547, "f": 343, "g": 545, "h": 581, "i": 249, "j": 249, "k": 525, "l": 269, "m": 862, "n": 583, "o": 568, "p": 592, "r": 360, "s": 499, "t": 361, "u": 580, "v": 512, "w": 765, "x": 502, "y": 512, "z": 453, "•": 364, "ﬁ": 592, "ﬂ": 612 };
const SANS_ESTIMATED: Record<string, number> = { "!": 279, "\"": 357, "#": 559, "$": 559, "%": 894, "&": 671, "'": 192, "(": 335, ")": 335, "*": 391, ",": 279, "3": 559, "6": 559, "9": 559, ";": 279, "<": 587, "=": 587, ">": 587, "@": 1020, "H": 726, "J": 503, "Q": 782, "U": 726, "Y": 671, "[": 279, "\\": 279, "]": 279, "^": 471, "`": 335, "q": 559, "{": 336, "|": 261, "}": 336, "~": 587, "¡": 335, "¢": 559, "£": 559, "¤": 559, "¥": 559, "¦": 261, "§": 559, "¨": 335, "©": 741, "ª": 372, "«": 559, "¬": 587, "­": 335, "®": 741, "¯": 335, "°": 402, "±": 587, "²": 335, "³": 335, "´": 335, "µ": 559, "¶": 540, "·": 279, "¸": 335, "¹": 335, "º": 367, "»": 559, "¼": 838, "½": 838, "¾": 838, "¿": 614, "À": 671, "Á": 671, "Â": 671, "Ã": 671, "Ä": 671, "Å": 671, "Æ": 1005, "Ç": 726, "È": 671, "É": 671, "Ê": 671, "Ë": 671, "Ì": 279, "Í": 279, "Î": 279, "Ï": 279, "Ð": 726, "Ñ": 726, "Ò": 782, "Ó": 782, "Ô": 782, "Õ": 782, "Ö": 782, "×": 587, "Ø": 782, "Ù": 726, "Ú": 726, "Û": 726, "Ü": 726, "Ý": 671, "Þ": 671, "ß": 614, "à": 559, "á": 559, "â": 559, "ã": 559, "ä": 559, "å": 559, "æ": 894, "ç": 503, "è": 559, "é": 559, "ê": 559, "ë": 559, "ì": 279, "í": 279, "î": 279, "ï": 279, "ð": 559, "ñ": 559, "ò": 559, "ó": 559, "ô": 559, "õ": 559, "ö": 559, "÷": 587, "ø": 614, "ù": 559, "ú": 559, "û": 559, "ü": 559, "ý": 503, "þ": 559, "ÿ": 503, "–": 559, "—": 1005, "‘": 223, "’": 223, "“": 335, "”": 335, "…": 1005, "€": 559 };

// SERIF: 33 measured, 167 estimated at ratio 1.0184
const SERIF_MEASURED: Record<string, number> = { " ": 235, "-": 338, ".": 218, "2": 512, "K": 675, "M": 901, "N": 725, "P": 585, "S": 583, "a": 521, "b": 606, "c": 485, "d": 605, "e": 507, "f": 337, "g": 528, "h": 584, "i": 247, "j": 247, "k": 538, "l": 247, "m": 876, "n": 584, "o": 581, "p": 606, "r": 371, "s": 456, "t": 341, "u": 567, "v": 503, "w": 748, "y": 500, "Δ": 647 };
const SERIF_ESTIMATED: Record<string, number> = { "!": 283, "\"": 362, "#": 566, "$": 566, "%": 905, "&": 679, "'": 195, "(": 339, ")": 339, "*": 396, "+": 595, ",": 283, "/": 283, "0": 566, "1": 566, "3": 566, "4": 566, "5": 566, "6": 566, "7": 566, "8": 566, "9": 566, ":": 283, ";": 283, "<": 595, "=": 595, ">": 595, "?": 566, "@": 1034, "A": 679, "B": 679, "C": 735, "D": 735, "E": 679, "F": 622, "G": 792, "H": 735, "I": 283, "J": 509, "L": 566, "O": 792, "Q": 792, "R": 735, "T": 622, "U": 735, "V": 679, "W": 961, "X": 679, "Y": 679, "Z": 622, "[": 283, "\\": 283, "]": 283, "^": 478, "_": 566, "`": 339, "q": 566, "x": 509, "z": 509, "{": 340, "|": 265, "}": 340, "~": 595, "¡": 339, "¢": 566, "£": 566, "¤": 566, "¥": 566, "¦": 265, "§": 566, "¨": 339, "©": 751, "ª": 377, "«": 566, "¬": 595, "­": 339, "®": 751, "¯": 339, "°": 407, "±": 595, "²": 339, "³": 339, "´": 339, "µ": 566, "¶": 547, "·": 283, "¸": 339, "¹": 339, "º": 372, "»": 566, "¼": 849, "½": 849, "¾": 849, "¿": 622, "À": 679, "Á": 679, "Â": 679, "Ã": 679, "Ä": 679, "Å": 679, "Æ": 1018, "Ç": 735, "È": 679, "É": 679, "Ê": 679, "Ë": 679, "Ì": 283, "Í": 283, "Î": 283, "Ï": 283, "Ð": 735, "Ñ": 735, "Ò": 792, "Ó": 792, "Ô": 792, "Õ": 792, "Ö": 792, "×": 595, "Ø": 792, "Ù": 735, "Ú": 735, "Û": 735, "Ü": 735, "Ý": 679, "Þ": 679, "ß": 622, "à": 566, "á": 566, "â": 566, "ã": 566, "ä": 566, "å": 566, "æ": 905, "ç": 509, "è": 566, "é": 566, "ê": 566, "ë": 566, "ì": 283, "í": 283, "î": 283, "ï": 283, "ð": 566, "ñ": 566, "ò": 566, "ó": 566, "ô": 566, "õ": 566, "ö": 566, "÷": 595, "ø": 622, "ù": 566, "ú": 566, "û": 566, "ü": 566, "ý": 509, "þ": 566, "ÿ": 509, "–": 566, "—": 1018, "‘": 226, "’": 226, "“": 339, "”": 339, "•": 356, "…": 1018, "€": 566 };


const SANS: Record<string, number> = { ...SANS_ESTIMATED, ...SANS_MEASURED };
const SERIF: Record<string, number> = { ...SERIF_ESTIMATED, ...SERIF_MEASURED };

/** Widths for the fallback faces the device reaches for; the same exports supplied these three. */
const SYMBOLS: Record<string, number> = { "\u2192": 918, "\u21d2": 859, "\u2610": 865 };

/**
 * How wide `text` is, in device pixels, in the face and size the device uses for `face`.
 *
 * A character in neither table falls back to the face's own `n`, which is a stand-in and not a
 * measurement -- it is reached only by scripts this table does not cover at all.
 */
export function measureDeviceText(text: string, face: TextFace): number {
	const table = face === "heading" ? SERIF : SANS;
	const sizePx = face === "heading" ? HEADING_TEXT_SIZE_PX : PLAIN_TEXT_SIZE_PX;
	let total = 0;
	for (const character of text) total += table[character] ?? SYMBOLS[character] ?? table.n;
	return (total * sizePx) / 1000;
}
