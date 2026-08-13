import {
	BlendMode,
	type Color,
	concatTransformationMatrix,
	LineCapStyle,
	PDFDocument,
	type PDFFont,
	PDFNumber,
	PDFOperator,
	PDFOperatorNames,
	type PDFPage,
	popGraphicsState,
	pushGraphicsState,
	rgb,
	StandardFonts,
} from "pdf-lib";
import { HEADING_TEXT_SIZE_PX, PLAIN_TEXT_SIZE_PX, TEXT_LEFT_PADDING_PX } from "./device-font";
import type { RmHighlight, RmPage, RmRect, RmStroke } from "./rm-parser";
import { faceOf, layoutText, LIST_MARKER_OFFSET_PX } from "./text-layout";

/** `LineJoinStyle.Round` in PDF's numbering; pdf-lib exports the cap styles but not the join ones. */
const ROUND_LINE_JOIN = 1;

/**
 * The frame a scene's strokes are measured in: x centered on the midline (x=0 maps to
 * `widthPx/2`), y top-origin, pixels converting to PDF points at the device's own DPI.
 *
 * For a handwritten notebook that frame is the device's screen (`RM_1_2` / `PAPER_PRO`).
 * For a PDF-backed document it is the *source page* rendered at that same DPI -- see
 * `pageFrame` -- which is why placing a book's annotations needs the device only for its
 * DPI, and needs it exactly: the wrong DPI mis-scales every stroke about the page's top
 * centre, worsening down and away from the midline.
 */
export interface DeviceCanvas {
	widthPx: number;
	heightPx: number;
	pxToPt: number;
	widthPt: number;
	heightPt: number;
}

function deviceCanvas(widthPx: number, heightPx: number, dpi: number): DeviceCanvas {
	const pxToPt = 72 / dpi;
	return { widthPx, heightPx, pxToPt, widthPt: widthPx * pxToPt, heightPt: heightPx * pxToPt };
}

// Both public device specs, identical 0.75 aspect. reMarkable 1/2/Paper Pure: 1404x1872 @ 226 DPI.
// reMarkable Paper Pro: the larger 1620x2160 @ 229 DPI canvas (which `detectCanvas` picks out).
const RM_1_2 = deviceCanvas(1404, 1872, 226);
const PAPER_PRO = deviceCanvas(1620, 2160, 229);

/**
 * The device a scene names in its own `scene_info` block (`RmPage.paperSize`) -- authoritative
 * when present, and the only way to know the DPI of a PDF-backed document's annotations, whose
 * coordinates say nothing about the screen they were drawn on. Null for pre-`scene_info`
 * firmware, and for a screen size no released device has.
 */
function declaredCanvas(pages: RmPage[]): DeviceCanvas | null {
	for (const { paperSize } of pages) {
		if (!paperSize) continue;
		for (const canvas of [RM_1_2, PAPER_PRO]) {
			if (paperSize.width === canvas.widthPx && paperSize.height === canvas.heightPx) return canvas;
		}
	}
	return null;
}

/**
 * Which device a PDF-backed document's annotations were drawn on. A book's strokes are page-framed,
 * so `detectCanvas`'s screen-extent test can't read the device off them; without a declared screen,
 * assume the commoner 226-DPI family (every model but the Pro).
 */
export function resolveDeviceCanvas(scenes: RmPage[]): DeviceCanvas {
	return declaredCanvas(scenes) ?? RM_1_2;
}

/**
 * Which device drew these scenes, for handwritten notebooks whose scenes don't say
 * (`declaredCanvas` is preferred wherever it answers). Only sound for a notebook, whose
 * strokes are measured against the screen: a PDF-backed document's are measured against
 * the source page, which is wider than either screen, so every such document would read
 * as a Paper Pro here.
 *
 * x can't be panned in the reader's bestFit view, so any
 * stroke x beyond the reMarkable 1/2 frame can only have come from the wider Paper Pro
 * canvas; y is no signal (a scrolled PDF exceeds the screen height on either device). We
 * ignore non-physical outliers -- some files decode a few garbage points far past any real
 * device edge -- by bounding the check at the Paper Pro width. A Paper Pro note whose ink
 * all stays within the narrower frame reads as a 1/2 and renders very slightly off-center;
 * the misplacement is smallest exactly there, so the fallback degrades gracefully.
 */
function detectCanvas(pages: RmPage[]): DeviceCanvas {
	for (const page of pages)
		for (const layer of page.layers)
			for (const stroke of layer.strokes)
				for (const { x } of stroke.points)
					if (Number.isFinite(x) && Math.abs(x) > RM_1_2.widthPx / 2 && Math.abs(x) < PAPER_PRO.widthPx) return PAPER_PRO;
	return RM_1_2;
}

const DEFAULT_STROKE_WIDTH_PX = 2;

/** reMarkable's two highlighter tool ids (rmscene's `Pen.is_highlighter` checks both) plus 23 (`SHADER`), the newer Paper Pro tool -- all three render as a translucent overlay instead of a solid line. */
const HIGHLIGHTER_PEN_TYPES = new Set([5, 18]);
const SHADER_PEN_TYPE = 23;

export function isHighlighterOrShader(penType: number): boolean {
	return HIGHLIGHTER_PEN_TYPES.has(penType) || penType === SHADER_PEN_TYPE;
}

/**
 * Highlighter/shader strokes ignore `thickness_scale` -- it stays at ~1 even for a full-width
 * marker band, so treating it as a pixel width draws a hairline instead of a highlight. The
 * device records the tool's real width per point instead, in quarter-pixels (rmscene's point
 * `width` convention): a device highlighter stroke carries a constant 120, i.e. 30 px.
 */
const POINT_WIDTH_PER_PX = 4;
const FALLBACK_HIGHLIGHTER_WIDTH_PX = 30;

/** A 0-255 RGB triple (as used by rmscene/rmc's `RM_PALETTE`) to a pdf-lib Color. */
function paletteColor(r: number, g: number, b: number): Color {
	return rgb(r / 255, g / 255, b / 255);
}

/**
 * Every colorId `rmscene` defines except `HIGHLIGHT` (9), a shared placeholder for
 * highlighter/shader strokes whose real color instead lives in the per-stroke `color_rgba`
 * field (see `drawStroke`). Values sourced from `rmc`'s `RM_PALETTE`
 * (src/rmc/exporters/writing_tools.py, MIT, Rick Lupton) -- same author/lineage as `rmscene`.
 * Anything still unmapped falls back to black, per the pdf-color-rendering map's fallback policy.
 */
const STROKE_COLORS: Record<number, Color> = {
	0: paletteColor(0, 0, 0), // BLACK
	1: paletteColor(144, 144, 144), // GRAY
	2: paletteColor(255, 255, 255), // WHITE
	3: paletteColor(251, 247, 25), // YELLOW
	4: paletteColor(0, 255, 0), // GREEN
	5: paletteColor(255, 192, 203), // PINK
	6: paletteColor(78, 105, 201), // BLUE
	7: paletteColor(179, 62, 57), // RED
	8: paletteColor(125, 125, 125), // GRAY_OVERLAP
	10: paletteColor(161, 216, 125), // GREEN_2
	11: paletteColor(139, 208, 229), // CYAN
	12: paletteColor(183, 130, 205), // MAGENTA
	13: paletteColor(247, 232, 81), // YELLOW_2
};

/**
 * A known palette id is authoritative; `colorRgba` only resolves ids the palette doesn't name
 * (the `HIGHLIGHT` placeholder, 9). Paper Pro firmware pairs a real palette id (3 = YELLOW)
 * with an opaque-black `color_rgba` placeholder -- the reverse of the HIGHLIGHT-9 convention --
 * so preferring `colorRgba` unconditionally rendered those highlights black (issue 04).
 */
function strokeColor(stroke: RmStroke): Color {
	const palette = STROKE_COLORS[stroke.color];
	if (palette) return palette;
	if (stroke.colorRgba) return paletteColor(stroke.colorRgba.r, stroke.colorRgba.g, stroke.colorRgba.b);
	return STROKE_COLORS[0];
}

function strokeWidthPt(stroke: RmStroke, canvas: DeviceCanvas): number {
	return strokeWidthPx(stroke) * canvas.pxToPt;
}

/**
 * `thickness_scale` is the tool's size *setting*, not a width: measured across 23,323 strokes of
 * the 80-page corpus, drawing a pen at it makes 99.7% of strokes too thin, none too thick, by a
 * median of exactly 2.00x and up to 5.6x. The device records what it actually drew per point, so
 * that is what we draw -- the same source the highlighter branch below has always used.
 *
 * The mean rather than the widest, because there is almost nothing to taper: pen 17 (10,657 strokes
 * in the corpus) never varies within a stroke at all, and pen 15 (11,165) varies by at most 1.5px.
 * The calligraphy pen does vary, and keeps its per-segment path in `drawTaperedStroke`.
 *
 * `thickness_scale` remains the fallback for a file whose points record no width.
 */
function strokeWidthPx(stroke: RmStroke): number {
	if (!isHighlighterOrShader(stroke.penType)) {
		let total = 0;
		let counted = 0;
		for (const point of stroke.points)
			if (point.width > 0) {
				total += point.width;
				counted++;
			}
		if (counted > 0) return total / counted / POINT_WIDTH_PER_PX;
		return stroke.brushSize > 0 ? stroke.brushSize : DEFAULT_STROKE_WIDTH_PX;
	}
	// The band is as wide as the widest point the tool laid down; we draw one constant width per
	// stroke, so a shader's pressure-tapered ends round up to its full width rather than down.
	let widest = 0;
	for (const point of stroke.points) widest = Math.max(widest, point.width);
	return widest > 0 ? widest / POINT_WIDTH_PER_PX : FALLBACK_HIGHLIGHTER_WIDTH_PX;
}

/**
 * reMarkable stroke coordinates are horizontally centered (x=0 is the page's
 * midline, confirmed against real device data -- observed x values range
 * roughly -700 to +720 for a 1404px-wide page) but vertically top-origin (y=0
 * is the page top). Only x needs the half-page-width shift.
 */
export function toPdfPoint(point: { x: number; y: number }, canvas: DeviceCanvas = RM_1_2): { x: number; y: number } {
	const { x, y } = toPagePoint(point, canvas);
	return { x, y: canvas.heightPt - y };
}

/** A rectangle in PDF points with the PDF's own bottom-left origin. */
export interface PdfRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A scene rectangle (a text highlight's run) in the PDF's frame. Rectangles are top-origin like
 * every other scene coordinate while the PDF's y grows upwards, so the rect's *bottom* edge
 * (y + height) is what maps to the PDF rect's origin.
 */
export function sceneRectToPdf(rect: RmRect, frame: DeviceCanvas): PdfRect {
	const { x, y } = toPdfPoint({ x: rect.x, y: rect.y + rect.height }, frame);
	return { x, y, width: rect.width * frame.pxToPt, height: rect.height * frame.pxToPt };
}

/** Same mapping as `toPdfPoint` but keeping y measured from the page top, which is the axis `drawSvgPath` expects. */
function toPagePoint(point: { x: number; y: number }, canvas: DeviceCanvas): { x: number; y: number } {
	return { x: (point.x + canvas.widthPx / 2) * canvas.pxToPt, y: point.y * canvas.pxToPt };
}

/**
 * Multiply already keeps whatever is underneath legible (the ink drawn over a highlight stays
 * black), so the highlight itself is laid down at full strength -- exactly how the device
 * composites it: a sampled device highlight matches its stored color to within a few units.
 */
const HIGHLIGHTER_OPACITY = 1;

function strokePath(stroke: RmStroke, canvas: DeviceCanvas): string {
	return stroke.points
		.map((point, i) => {
			const { x, y } = toPagePoint(point, canvas);
			return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
}

/**
 * The calligraphy pen is a chisel tip: its width swells and thins *within* a stroke with tilt and
 * pressure, and the device records the result per point. Drawing it at one constant width is what
 * flattens it into a plain line.
 *
 * Other tools do vary a little -- pen 15 by up to 1.5px within a stroke, pen 17 not at all, measured
 * over the corpus -- but not enough for a reader to see, so they stay on the cheaper single-path
 * route at their mean width (`strokeWidthPx`). Pencil grain and brush texture remain unmodeled.
 */
const CALLIGRAPHY_PEN_TYPE = 21;

function drawTaperedStroke(page: PDFPage, stroke: RmStroke, color: Color, canvas: DeviceCanvas): void {
	for (let i = 1; i < stroke.points.length; i++) {
		const [from, to] = [stroke.points[i - 1], stroke.points[i]];
		const widthPx = (from.width + to.width) / 2 / POINT_WIDTH_PER_PX;
		// Round caps, so consecutive segments of differing width still read as one continuous nib.
		page.drawLine({
			start: toPdfPoint(from, canvas),
			end: toPdfPoint(to, canvas),
			thickness: (widthPx > 0 ? widthPx : DEFAULT_STROKE_WIDTH_PX) * canvas.pxToPt,
			color,
			lineCap: LineCapStyle.Round,
		});
	}
}

/** Pen pressure/texture (pencil grain, marker/highlighter blending) is not modeled -- documented limitation, see ticket 05 comments. */
function drawStroke(page: PDFPage, stroke: RmStroke, canvas: DeviceCanvas): void {
	const color = strokeColor(stroke);
	const thickness = strokeWidthPt(stroke, canvas);
	const translucent = isHighlighterOrShader(stroke.penType);
	const opacity = translucent ? HIGHLIGHTER_OPACITY : undefined;
	const blendMode = translucent ? BlendMode.Multiply : undefined;

	if (stroke.points.length === 1) {
		const center = toPdfPoint(stroke.points[0], canvas);
		page.drawCircle({ ...center, size: thickness / 2, color, opacity, blendMode });
		return;
	}

	if (stroke.penType === CALLIGRAPHY_PEN_TYPE) {
		drawTaperedStroke(page, stroke, color, canvas);
		return;
	}

	// One path for the whole stroke, not one per segment: a translucent segment drawn over its
	// neighbour composites twice, and at 30 px wide every segment overlaps several of its
	// neighbours -- which is what turned marker strokes into dark, blotchy bands.
	page.drawSvgPath(strokePath(stroke, canvas), {
		x: 0,
		y: canvas.heightPt,
		borderColor: color,
		borderWidth: thickness,
		borderLineCap: LineCapStyle.Round,
		borderOpacity: opacity,
		blendMode,
	});
}

/**
 * Renders parsed `.rm` scenes to a single PDF -- one call handles both the
 * per-page path (a single-element array, for page-level tags) and the
 * multi-page assembly path (whole-notebook notes), in document order.
 */
/**
 * The colour a text highlight falls back to when the scene names only the `HIGHLIGHT` placeholder
 * and carries no true colour -- the palette's yellow, since the alternative (`STROKE_COLORS`'
 * black fallback) would lay an opaque black bar over the words it is meant to mark.
 */
const DEFAULT_HIGHLIGHT_COLOR = STROKE_COLORS[3];

/** Draws a text highlight's rectangles, in the same frame and translucent treatment as a marker stroke. */
function drawHighlight(page: PDFPage, highlight: RmHighlight, canvas: DeviceCanvas): void {
	// Same precedence as `strokeColor`: a known palette id wins, `colorRgba` resolves the rest.
	const color =
		STROKE_COLORS[highlight.color] ??
		(highlight.colorRgba
			? paletteColor(highlight.colorRgba.r, highlight.colorRgba.g, highlight.colorRgba.b)
			: DEFAULT_HIGHLIGHT_COLOR);
	for (const rect of highlight.rects) {
		page.drawRectangle({
			...sceneRectToPdf(rect, canvas),
			color,
			opacity: HIGHLIGHTER_OPACITY,
			blendMode: BlendMode.Multiply,
		});
	}
}

/** Draws one parsed scene's highlights and strokes onto an already-sized page, in the given coordinate frame. */
function drawPageStrokes(page: PDFPage, rmPage: RmPage, canvas: DeviceCanvas): void {
	// Round joins for every stroke on the page: the default miter join spikes out to many
	// times the line width where a wide marker stroke doubles back on itself.
	page.pushOperators(PDFOperator.of(PDFOperatorNames.SetLineJoinStyle, [PDFNumber.of(ROUND_LINE_JOIN)]));
	const strokes = rmPage.layers.flatMap((layer) => layer.strokes);
	// Highlights (text and marker alike) must sit under all other ink on the page -- pdf-lib has no
	// z-index, draw order is paint order, so they're drawn first regardless of layer/document order.
	for (const highlight of rmPage.highlights ?? []) {
		drawHighlight(page, highlight, canvas);
	}
	const highlighters = strokes.filter((stroke) => isHighlighterOrShader(stroke.penType));
	const ink = strokes.filter((stroke) => !isHighlighterOrShader(stroke.penType));
	for (const stroke of [...highlighters, ...ink]) {
		drawStroke(page, stroke, canvas);
	}
}

/**
 * The page's typed text, drawn where the device lays it out.
 *
 * Without this a page that carries only typed text renders blank -- `Schnellnotiz-8c6044dc` is 1144
 * characters and no strokes, and our PDF for it was 724 bytes of nothing.
 *
 * **The face is Helvetica; the metrics are the device's.** Where a line breaks is what has to match,
 * because a wrong break moves every line below it and every node anchored to one; which letterforms
 * carry it is not something a reader can act on. So the break is computed in `text-layout.ts` from
 * the device's own advance widths and the drawing simply follows, at the device's own size -- a
 * base-14 face costs no bytes and needs no licence.
 *
 * A line's y is the same slot its anchored handwriting is placed at, so the baseline is drawn on it
 * rather than offset from it: the typed line and the ink that hangs off it must agree.
 */
function drawPageText(page: PDFPage, rmPage: RmPage, canvas: DeviceCanvas, font: PDFFont, encodable: Set<number>): void {
	if (!rmPage.text) return;
	for (const line of layoutText(rmPage.text).lines) {
		const heading = faceOf(line.style) === "heading";
		const sizePt = (heading ? HEADING_TEXT_SIZE_PX : PLAIN_TEXT_SIZE_PX) * canvas.pxToPt;
		if (line.firstLine && line.xPx > rmPage.text.posX) {
			// The bullet is the style's doing, not a character: the stored paragraph starts at its text.
			const marker = toPdfPoint({ x: rmPage.text.posX + LIST_MARKER_OFFSET_PX, y: line.yPx }, canvas);
			page.drawText("•", { x: marker.x, y: marker.y, size: sizePt, font, color: rgb(0, 0, 0) });
		}
		if (line.text === "") continue;
		const at = toPdfPoint({ x: line.xPx + TEXT_LEFT_PADDING_PX, y: line.yPx }, canvas);
		// pdf-lib's WinAnsi encoder throws on anything it cannot encode, which would cost the page its
		// whole text for one stray glyph. Fail soft to the substitute the device's own export uses.
		const drawable = [...line.text].map((character) => (encodable.has(character.codePointAt(0) ?? 0) ? character : "·")).join("");
		page.drawText(drawable, { x: at.x, y: at.y, size: sizePt, font, color: rgb(0, 0, 0) });
	}
}

/**
 * How tall a scrolled page is allowed to get, in screen-heights. Scenes decode a handful of garbage
 * coordinates -- this repo's own `normal-a-stroke-2-layers` fixture carries y values around 1e12,
 * and `page-rasterizer.ts` hit the same thing at ~1e38 -- and one of them would stretch a page to
 * hundreds of inches. Unlike `detectCanvas`, which can appeal to a physical screen width, a
 * scrolling canvas has no true bound; but 20 screens is already several metres of handwriting while
 * the noise sits nine orders of magnitude beyond it, so no real ink comes near the line. It also
 * keeps every page inside the PDF's own 14400pt (200in) maximum page dimension.
 */
const MAX_SCROLLED_SCREENS = 20;

/**
 * How far down the page a scene's content reaches, in device px, ignoring anything past `limitPx`
 * (see `MAX_SCROLLED_SCREENS`). Null for a page with nothing on it. Half a stroke's width is
 * included so a thick mark at the very bottom isn't shaved in half.
 *
 * Typed text counts, not only ink: `Schnellnotiz-8c6044dc` is 1144 characters and no strokes, and
 * its text reaches a third of a screen past the bottom. Sized by ink alone the page stays screen
 * height and the render clips two thirds of the text away -- which looked like the text not being
 * drawn at all.
 */
function contentBottomPx(rmPage: RmPage, limitPx: number): number | null {
	let bottom = Number.NEGATIVE_INFINITY;
	for (const layer of rmPage.layers) {
		for (const stroke of layer.strokes) {
			const pad = strokeWidthPx(stroke) / 2;
			for (const { y } of stroke.points) if (y <= limitPx) bottom = Math.max(bottom, y + pad);
		}
	}
	for (const highlight of rmPage.highlights ?? [])
		for (const rect of highlight.rects) if (rect.y + rect.height <= limitPx) bottom = Math.max(bottom, rect.y + rect.height);
	if (rmPage.text) {
		for (const line of layoutText(rmPage.text).lines) {
			if (line.text === "" || line.yPx > limitPx) continue;
			// A baseline is not the bottom of the line: the descenders below it are part of the text.
			bottom = Math.max(bottom, line.yPx + (faceOf(line.style) === "heading" ? HEADING_TEXT_SIZE_PX : PLAIN_TEXT_SIZE_PX) * TEXT_DESCENT);
		}
	}
	return bottom > Number.NEGATIVE_INFINITY ? bottom : null;
}

/** Helvetica's descender, as a fraction of the em -- how far a `g` reaches below its baseline. */
const TEXT_DESCENT = 0.212;

/**
 * The frame one notebook page is drawn in: the device screen, grown downwards when the page's ink
 * runs past it. A notebook page is a *scrolling* canvas -- the writer keeps scrolling down and the
 * page keeps growing -- so its ink routinely reaches y well beyond the screen height, while a
 * screen-height PDF page maps all of it to negative y and clips it away silently.
 *
 * Only the bottom moves: y=0 stays the page top (the direction the device's canvas actually grows),
 * so growth costs no coordinate offset and a page whose ink fits one screen is sized exactly as before.
 */
/**
 * The frame widens when the writer panned sideways. A notebook canvas expands horizontally in one
 * discrete step -- the device's own PDF exports are 445x594pt for a normal page and 594x594 for an
 * expanded one, i.e. 1404 -> 1872px, which is the screen's own portrait height; a Paper Pro steps
 * 1620 -> 2160 the same way. Unlike the vertical growth, which follows the ink to fitted values
 * (630, 716, 824, 878pt were all observed), the width never lands between the two.
 *
 * So the box is not sized to the ink: it takes the step whenever the ink needs more room than the
 * screen. Measured over the corpus, 13 of 45 notebook pages need it and every one of them fits
 * inside the step, the tightest with 11px to spare.
 *
 * Ink beyond the expanded frame is decode noise rather than a third canvas size, and is ignored --
 * the same guard `detectCanvas` applies for the same reason.
 */
function expandedCanvas(rmPage: RmPage, canvas: DeviceCanvas): DeviceCanvas {
	const half = canvas.widthPx / 2;
	for (const layer of rmPage.layers)
		for (const stroke of layer.strokes)
			for (const { x } of stroke.points)
				if (Number.isFinite(x) && Math.abs(x) > half && Math.abs(x) <= canvas.heightPx) {
					const widthPx = canvas.heightPx;
					return { ...canvas, widthPx, widthPt: widthPx * canvas.pxToPt };
				}
	return canvas;
}

function scrolledCanvas(rmPage: RmPage, canvas: DeviceCanvas): DeviceCanvas {
	const bottom = contentBottomPx(rmPage, canvas.heightPx * MAX_SCROLLED_SCREENS);
	if (bottom === null || bottom <= canvas.heightPx) return canvas;
	return { ...canvas, heightPx: bottom, heightPt: bottom * canvas.pxToPt };
}

/**
 * The frame one notebook page is drawn in: the device screen, widened where the writer panned
 * sideways and grown downwards where the content runs past the bottom.
 *
 * This is `renderPagesToPdf`'s own measurement, named so that anything reading such a page can
 * measure it the same way. The digest does: it places an annotation by the frame the page was drawn
 * in, and a frame of its own that disagreed by a pixel would put every region and every anchor
 * slightly beside the thing it names.
 *
 * There is no fit to go with it, the way `annotatedPageFit` accompanies `pageFrame`: this page is
 * sized to its own content and drawn 1:1, so the fit is the identity.
 */
export function notebookPageFrame(rmPage: RmPage, device: DeviceCanvas): DeviceCanvas {
	return scrolledCanvas(rmPage, expandedCanvas(rmPage, device));
}

export async function renderPagesToPdf(pages: RmPage[]): Promise<Uint8Array> {
	// A zero-page render is never a legitimate result -- it silently produced the empty PDFs that
	// masked notebooks syncing nothing. Callers that can legitimately have no `.rm` pages (an
	// uploaded PDF) go through `renderAnnotatedPdf` instead and never reach here.
	if (pages.length === 0) throw new Error("renderPagesToPdf: no pages to render");

	const canvas = declaredCanvas(pages) ?? detectCanvas(pages);
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const encodable = new Set(font.getCharacterSet());
	for (const rmPage of pages) {
		// Per page, not per document: each page scrolls and expands on its own, so they legitimately
		// differ in both dimensions.
		const pageCanvas = notebookPageFrame(rmPage, canvas);
		const page = doc.addPage([pageCanvas.widthPt, pageCanvas.heightPt]);
		// Typed text under the handwriting, as the device stacks them.
		drawPageText(page, rmPage, pageCanvas, font, encodable);
		drawPageStrokes(page, rmPage, pageCanvas);
	}
	return doc.save();
}

/** One page of a PDF-backed document: which source-PDF page it shows, plus any handwritten annotation scene drawn on it (null if never drawn on). */
export interface AnnotatedPdfPage {
	sourceIndex: number;
	annotations: RmPage | null;
}

/**
 * The frame a PDF-backed document's annotations are measured in: the source page itself, rendered
 * at the device's DPI (`pagePt * dpi / 72`, the unit rmapi-js documents for `customZoomPageWidth`),
 * with x centered on the page's midline and y down from the page top.
 *
 * The device anchors a book's ink to the *page*, not to the screen -- it has to, or scrolling and
 * zooming in the reader would tear ink away from the words it marks. So the reader's view (bestFit,
 * fitToWidth, a custom zoom, wherever the page is scrolled to) doesn't enter into placement at all;
 * only the DPI does.
 */
export function pageFrame(widthPt: number, heightPt: number, device: DeviceCanvas): DeviceCanvas {
	return { widthPx: widthPt / device.pxToPt, heightPx: heightPt / device.pxToPt, pxToPt: device.pxToPt, widthPt, heightPt };
}

/** Quiet space beyond the outermost ink on a page sized to its own strokes, in device px. */
const MAX_INK_MARGIN_PX = 24;

/**
 * Ceiling on a self-sized page, in device px -- about ten screens. Corrupt point data has been seen at
 * ~1e38 (`page-rasterizer.ts`), and a PDF page is capped at 14400 pt whatever we ask for.
 */
const MAX_CANVAS_PX = 20000;

/**
 * The frame for a page the PDF has no source page for: one sized to the ink itself.
 *
 * This is not the "shouldn't happen" case it was written as. A page the user *adds on the device*
 * behind a PDF's last page has no `cPages.redir`, so it lands past the source's last index -- and it
 * is a notebook page, which means it can be scrolled far taller than a screen. The fixture's is
 * 1939x5078 px against a 1620x2160 device canvas, so drawn against the screen it lost 58 % of its
 * height and part of its left column, silently, in every document that has such a page.
 *
 * The mapping fixes what can be moved and what cannot: `toPagePoint` puts scene x=0 on the canvas
 * midline, so a symmetric width centred on the ink fits any x; scene y=0 is the page top with no
 * offset to give, so the height simply has to reach the lowest ink and any blank band above it stays.
 * `pxToPt` is carried over untouched -- the ink keeps the device's own scale and only the sheet grows.
 */
function inkCanvas(scene: RmPage, device: DeviceCanvas): DeviceCanvas {
	// Deliberately not `page-rasterizer`'s `inkBounds`: that module imports this one, and what a sheet
	// needs is only how far the ink reaches, without the per-stroke radius padding a bitmap wants.
	let reachX = 0;
	let reachY = 0;
	for (const layer of scene.layers) {
		for (const stroke of layer.strokes) {
			for (const point of stroke.points) {
				if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
				reachX = Math.max(reachX, Math.abs(point.x));
				reachY = Math.max(reachY, point.y);
			}
		}
	}
	// A stroke is drawn centred on its path, so half a generous nib clears the outermost one.
	const margin = MAX_INK_MARGIN_PX;
	const widthPx = Math.min(Math.max(device.widthPx, 2 * reachX + 2 * margin), MAX_CANVAS_PX);
	const heightPx = Math.min(Math.max(device.heightPx, reachY + margin), MAX_CANVAS_PX);
	return { widthPx, heightPx, pxToPt: device.pxToPt, widthPt: widthPx * device.pxToPt, heightPt: heightPx * device.pxToPt };
}

/**
 * How far past the paper a page may grow on one side, as a multiple of that side's own length.
 *
 * A bound rather than a fit, for the reason every other frame in this file has one: scenes decode a
 * few impossible coordinates, and one of them would otherwise blow the sheet up to a metre of empty
 * paper around the page. Measured over the annotation corpus, the widest real margin note runs 224 pt
 * past a 612 pt page -- comfortably inside one page width, while the noise sits orders of magnitude
 * beyond it, so nothing a hand wrote comes near the line.
 */
const MAX_OVERHANG = 1;

/**
 * The sheet an annotated page needs: the paper, grown on whichever sides its ink runs off.
 *
 * The device does not stop the pen at the paper's edge. A reader who zooms the page out writes in the
 * space beside it, and the scene stores that ink exactly like any other -- so a page sized to its
 * source page maps a margin note to coordinates outside its own box and draws nothing at all. Two
 * readers reported the same thing: handwriting cut off partway through a word, at the edge of the
 * page. In the corpus one page in twelve loses ink this way, one of them a whole sentence 224 pt out.
 *
 * Returned in the *source page's* own coordinates, so a box that reaches past the paper has a
 * negative x or y, or a width past the page's. `annotatedPageFit` is what brings it back onto a sheet.
 *
 * Only strokes are measured, and only where their points are: half a nib past the last point is a
 * third of a point of paper, and chasing it would grow every page whose ink touches an edge. A text
 * highlight is not measured at all -- it marks words that are printed on the page, so it is on the
 * page by construction, and a rectangle that says otherwise is a decode fault rather than ink.
 */
export function annotatedPageBox(scene: RmPage | null, frame: DeviceCanvas): PdfRect {
	const paper = { x: 0, y: 0, width: frame.widthPt, height: frame.heightPt };
	if (!scene) return paper;

	const half = frame.widthPx / 2;
	let left = 0;
	let right = 0;
	let above = 0;
	let below = 0;
	for (const layer of scene.layers) {
		for (const stroke of layer.strokes) {
			for (const { x, y } of stroke.points) {
				if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
				left = Math.max(left, -x - half);
				right = Math.max(right, x - half);
				above = Math.max(above, -y);
				below = Math.max(below, y - frame.heightPx);
			}
		}
	}

	const capX = frame.widthPx * MAX_OVERHANG;
	const capY = frame.heightPx * MAX_OVERHANG;
	const grow = (amount: number, cap: number): number => Math.min(amount, cap) * frame.pxToPt;
	const [leftPt, rightPt, abovePt, belowPt] = [grow(left, capX), grow(right, capX), grow(above, capY), grow(below, capY)];
	return {
		x: -leftPt,
		y: -belowPt,
		width: frame.widthPt + leftPt + rightPt,
		height: frame.heightPt + abovePt + belowPt,
	};
}

/**
 * Where an annotated page's content is placed on the sheet that is actually written out: a point
 * `(x, y)` of the source page lands at `(x * scale + dx, y * scale + dy)`, in PDF points.
 *
 * **The sheet keeps the size of its source page and the content shrinks to fit it**, rather than the
 * page growing to the ink. Growing is what the file wants -- it costs no type size and no page keeps
 * a millimetre of paper it doesn't need -- but it makes a document whose pages are not all the same
 * size, and a reader is free to disagree about that. Obsidian's embedded viewer scales a whole
 * document by one factor taken from the page it opened on, so the one wide page overflows the frame
 * and its margin note is cut off *on screen* at exactly the old page edge: right in the file, missing
 * where it is read. A reader who never sees the note cannot tell that ours is the correct rendering.
 *
 * So the cost lands on the one page that earned it, as type a few percent smaller than its
 * neighbours', and every page whose ink stays on the paper is written out untouched -- `scale` is 1
 * there and the transform is the identity, which is nearly every page of nearly every document.
 *
 * Top-left aligned, because a page is read from its top: the spare paper the shrunk content leaves
 * over collects at the bottom, where a page's own margin already is.
 */
export interface PageFit {
	box: PdfRect;
	scale: number;
	dx: number;
	dy: number;
}

export function annotatedPageFit(scene: RmPage | null, frame: DeviceCanvas): PageFit {
	const box = annotatedPageBox(scene, frame);
	const scale = Math.min(1, frame.widthPt / box.width, frame.heightPt / box.height);
	return { box, scale, dx: -box.x * scale, dy: -box.y * scale + (frame.heightPt - box.height * scale) };
}

/**
 * Composites a PDF-backed document (spec §5's PDF path): each output page is the source PDF page at
 * its own size with the handwritten annotation scene drawn on top, placed in the page's own frame
 * (see `pageFrame`) so every stroke lands on the words it marks -- shrunk to fit the sheet wherever
 * the ink runs off the paper (see `annotatedPageFit`). A page with no matching source page -- one added on
 * the device behind the PDF -- becomes an annotations-only page sized to its own ink (see
 * `inkCanvas`) rather than failing the whole document.
 */
export async function renderAnnotatedPdf(sourcePdfBytes: Uint8Array, pages: AnnotatedPdfPage[]): Promise<Uint8Array> {
	if (pages.length === 0) throw new Error("renderAnnotatedPdf: no pages to render");

	const device = resolveDeviceCanvas(pages.map((page) => page.annotations).filter((scene): scene is RmPage => scene !== null));
	const src = await PDFDocument.load(sourcePdfBytes);
	const out = await PDFDocument.create();

	for (const { sourceIndex, annotations } of pages) {
		const srcPage = sourceIndex >= 0 && sourceIndex < src.getPageCount() ? src.getPage(sourceIndex) : null;
		// Only computed where there is no source page to measure against; `annotations` is what such a
		// page is made of, so a null scene there leaves the device canvas as the last resort.
		const ownCanvas = srcPage || !annotations ? device : inkCanvas(annotations, device);
		const { width, height } = srcPage?.getSize() ?? { width: ownCanvas.widthPt, height: ownCanvas.heightPt };
		const outPage = out.addPage([width, height]);
		const frame = srcPage ? pageFrame(width, height, device) : ownCanvas;
		// Page and ink are placed by one transform on the whole page, so they cannot come apart: the ink
		// marks the words it was drawn on whatever the page had to give up to hold it (see `annotatedPageFit`).
		const { scale, dx, dy } = annotatedPageFit(annotations, frame);
		if (scale !== 1) outPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(scale, 0, 0, scale, dx, dy));
		if (srcPage) {
			try {
				const embedded = await out.embedPage(srcPage);
				outPage.drawPage(embedded, { x: 0, y: 0, width, height });
			} catch (error) {
				// A source page with no drawable content (e.g. a genuinely empty PDF page) can't be
				// embedded; keep the annotations rather than failing the whole document over one page.
				console.warn(`Tagged Sync: couldn't embed source page ${sourceIndex}, keeping its annotations only`, error);
			}
		}
		if (annotations) drawPageStrokes(outPage, annotations, frame);
		if (scale !== 1) outPage.pushOperators(popGraphicsState());
	}

	return out.save();
}
