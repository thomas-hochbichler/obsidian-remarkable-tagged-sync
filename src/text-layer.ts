import {
	beginText,
	endText,
	PDFDocument,
	popGraphicsState,
	pushGraphicsState,
	setCharacterSqueeze,
	setFontAndSize,
	setTextMatrix,
	setTextRenderingMode,
	showText,
	StandardFonts,
	TextRenderingMode,
} from "pdf-lib";
import { inkBounds, type InkBounds } from "./page-rasterizer";
import { type DeviceCanvas, notebookCanvas, notebookPageFrame, type PdfRect, sceneRectToPdf } from "./pdf-renderer";
import { LOAD_WITHOUT_PAUSES, SAVE_WITHOUT_PAUSES } from "./pdf-source";
import type { RmPage } from "./rm-parser";
import type { VisionBox, VisionWord } from "./vision-ocr-backend";

/**
 * The text layer: the transcript, as invisible text, laid over the handwriting in the render, each
 * word on the word it transcribes (searchable-pdf spec §2.1).
 */

/** One line Vision read on a page: its own box, and its words in the order they were read. Boxes are normalised on the page's ink bitmap. */
export interface LayerLine {
	box: VisionBox;
	words: VisionWord[];
}

/** Reads where the words sit on each page, for a layer whose words come from elsewhere: `VisionOcrBackend.readLayer`. */
export interface LayerReader {
	/** One entry per page, `null` for a page it has no boxes for. */
	readLayer(pages: RmPage[]): Promise<(LayerLine[] | null)[]>;
}

/**
 * How a sync's text layer went, for "Copy diagnostics" (spec §2.7): of the pages it rendered, how many
 * carry a layer, and of the words their transcripts hold, how many were placed and how many left out.
 * Left out includes text typed on a page: it is in the transcript, and the render carries it as real
 * text already, so the layer never places it.
 */
export interface TextLayerTally {
	pages: number;
	layered: number;
	placed: number;
	leftOut: number;
}

/** The boxes of a line's words, if Vision gave each word one of its own: none missing, no two the same. */
function ownWordBoxes(line: LayerLine): VisionBox[] | null {
	const boxes = line.words.map((word) => word.box);
	if (!boxes.every((box): box is VisionBox => box !== null)) return null;
	const distinct = new Set(boxes.map((box) => [box.x, box.y, box.w, box.h].map((value) => value.toFixed(4)).join()));
	return distinct.size === boxes.length ? boxes : null;
}

/**
 * Each word's box: its own where Vision gave one, else the line shared out by characters, spaces
 * included. Vision gives words it ran together one box between them, and a word with no box of its
 * own goes the same way.
 */
export function wordBoxes(line: LayerLine): VisionBox[] {
	const own = ownWordBoxes(line);
	if (own) return own;
	const total = line.words.reduce((sum, word) => sum + word.text.length, line.words.length - 1);
	let offset = 0;
	return line.words.map(({ text }) => {
		const box = { ...line.box, x: line.box.x + (line.box.w * offset) / total, w: (line.box.w * text.length) / total };
		offset += text.length + 1;
		return box;
	});
}

/** Letters NFD does not split into a base letter and a mark, and the minus sign. */
const BASE_LETTERS: Record<string, string> = { ł: "l", Ł: "L", đ: "d", Đ: "D", ı: "i", "−": "-", "‐": "-", "‑": "-" };

/**
 * A word as Helvetica can write it (searchable-pdf spec §2.2). One that WinAnsi holds stays as it is; one
 * that it does not is folded to its base letters as a whole, so `Łódź` becomes `Lodz` and the plain
 * spelling finds it. A character with no base letter (`√`) becomes one `·`, as `drawPageText` writes it.
 */
export function foldWord(text: string, encodable: ReadonlySet<number>): string {
	const writable = (characters: string) => [...characters].every((character) => encodable.has(character.codePointAt(0) ?? 0));
	// Composed first: a `ü` sent as `u` and a mark is still a WinAnsi word.
	const composed = text.normalize("NFC");
	if (writable(composed)) return composed;
	return [...composed]
		.map((character) => {
			const base = BASE_LETTERS[character] ?? character.normalize("NFD").replace(/\p{M}/gu, "");
			return writable(base) ? base : "·";
		})
		.join("");
}

/**
 * A Vision box in the PDF page it was read from.
 *
 * Vision normalises against the page's *ink* bitmap (`inkBounds`), bottom-left origin; the render
 * draws in `notebookPageFrame`. Both come from the same scene, so the box goes back into scene px
 * first and from there through the renderer's own mapping.
 */
export function visionBoxToPdf(box: VisionBox, ink: InkBounds, frame: DeviceCanvas): PdfRect {
	return sceneRectToPdf(
		{
			x: ink.minX + box.x * ink.width,
			y: ink.minY + (1 - box.y - box.h) * ink.height,
			width: box.w * ink.width,
			height: box.h * ink.height,
		},
		frame,
	);
}

/**
 * Lays Vision's words over a `renderPagesToPdf` render of the same scenes, as invisible text (`3 Tr`):
 * the drawing is left as it is, and a viewer's search finds each word where it was written. `reads[i]`
 * is page `i`'s lines; a page with none gets no layer, and a render with no lines at all comes back as
 * the very bytes it went in as.
 *
 * Words go in reading order, each followed by a space so a viewer never runs two together, all words
 * of a line at the line's height so a highlight does not jump, and each word squeezed (`Tz`) to its
 * own box's width.
 */
export async function addTextLayer(pdf: Uint8Array, scenes: RmPage[], reads: LayerLine[][]): Promise<Uint8Array> {
	if (reads.every((lines) => lines.length === 0)) return pdf;
	const doc = await PDFDocument.load(pdf, LOAD_WITHOUT_PAUSES);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	// Ascender to descender at size 1: a line box this tall takes the font at size 1.
	const heightAtOne = font.heightAtSize(1);
	const descent = heightAtOne - font.heightAtSize(1, { descender: false });
	const device = notebookCanvas(scenes);
	// WinAnsi throws on what it cannot encode, so every word goes through `foldWord`.
	const encodable = new Set(font.getCharacterSet());

	scenes.forEach((scene, index) => {
		const ink = inkBounds(scene);
		const lines = reads[index] ?? [];
		if (!ink || lines.length === 0) return;
		const frame = notebookPageFrame(scene, device);
		const page = doc.getPage(index);
		const fontKey = page.node.newFontDictionary(font.name, font.ref);
		const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
		for (const line of lines) {
			const lineHeight = visionBoxToPdf(line.box, ink, frame).height;
			const size = lineHeight / heightAtOne;
			const boxes = wordBoxes(line);
			for (const [i, word] of line.words.entries()) {
				const text = foldWord(word.text, encodable);
				const rect = visionBoxToPdf(boxes[i], ink, frame);
				// The line's height, centred on the word: a drifting baseline is followed, the height is not.
				const bottom = rect.y + rect.height / 2 - lineHeight / 2;
				// Per character: `widthOfTextAtSize` kerns pairs, and `Tj` draws without kerning.
				const drawnWidth = [...text].reduce((sum, character) => sum + font.widthOfTextAtSize(character, size), 0);
				ops.push(
					setFontAndSize(fontKey, size),
					setCharacterSqueeze((100 * rect.width) / drawnWidth),
					setTextMatrix(1, 0, 0, 1, rect.x, bottom + descent * size),
					showText(font.encodeText(`${text} `)),
				);
			}
		}
		ops.push(endText(), popGraphicsState());
		page.pushOperators(...ops);
	});

	return doc.save(SAVE_WITHOUT_PAUSES);
}
