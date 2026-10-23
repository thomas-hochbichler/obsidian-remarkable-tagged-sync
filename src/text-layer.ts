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
	// WinAnsi throws on what it cannot encode; `drawPageText`'s substitute keeps the rest of the word findable.
	const encodable = new Set(font.getCharacterSet());
	const drawable = (text: string) => [...text].map((character) => (encodable.has(character.codePointAt(0) ?? 0) ? character : "·")).join("");

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
				const text = drawable(word.text);
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
