import { BlendMode, type Color, LineCapStyle, PDFDocument, PDFNumber, PDFOperator, PDFOperatorNames, type PDFPage, rgb } from "pdf-lib";
import type { RmHighlight, RmPage, RmRect, RmStroke } from "./rm-parser";

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

function strokeWidthPx(stroke: RmStroke): number {
	if (!isHighlighterOrShader(stroke.penType)) return stroke.brushSize > 0 ? stroke.brushSize : DEFAULT_STROKE_WIDTH_PX;
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
 * flattens it into a plain line. Every other ink tool records a constant per-point width, so they
 * stay on the cheaper single-path route -- pencil grain and brush texture remain unmodeled (ticket 05).
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
 * How far down the page a scene's ink reaches, in device px, ignoring anything past `limitPx`
 * (see `MAX_SCROLLED_SCREENS`). Null for a page with no ink. Half a stroke's width is included so
 * a thick mark at the very bottom isn't shaved in half.
 */
function inkBottomPx(rmPage: RmPage, limitPx: number): number | null {
	let bottom = Number.NEGATIVE_INFINITY;
	for (const layer of rmPage.layers) {
		for (const stroke of layer.strokes) {
			const pad = strokeWidthPx(stroke) / 2;
			for (const { y } of stroke.points) if (y <= limitPx) bottom = Math.max(bottom, y + pad);
		}
	}
	for (const highlight of rmPage.highlights ?? [])
		for (const rect of highlight.rects) if (rect.y + rect.height <= limitPx) bottom = Math.max(bottom, rect.y + rect.height);
	return bottom > Number.NEGATIVE_INFINITY ? bottom : null;
}

/**
 * The frame one notebook page is drawn in: the device screen, grown downwards when the page's ink
 * runs past it. A notebook page is a *scrolling* canvas -- the writer keeps scrolling down and the
 * page keeps growing -- so its ink routinely reaches y well beyond the screen height, while a
 * screen-height PDF page maps all of it to negative y and clips it away silently.
 *
 * Only the bottom moves: y=0 stays the page top (the direction the device's canvas actually grows),
 * so growth costs no coordinate offset and a page whose ink fits one screen is sized exactly as before.
 */
function scrolledCanvas(rmPage: RmPage, canvas: DeviceCanvas): DeviceCanvas {
	const bottom = inkBottomPx(rmPage, canvas.heightPx * MAX_SCROLLED_SCREENS);
	if (bottom === null || bottom <= canvas.heightPx) return canvas;
	return { ...canvas, heightPx: bottom, heightPt: bottom * canvas.pxToPt };
}

export async function renderPagesToPdf(pages: RmPage[]): Promise<Uint8Array> {
	// A zero-page render is never a legitimate result -- it silently produced the empty PDFs that
	// masked notebooks syncing nothing. Callers that can legitimately have no `.rm` pages (an
	// uploaded PDF) go through `renderAnnotatedPdf` instead and never reach here.
	if (pages.length === 0) throw new Error("renderPagesToPdf: no pages to render");

	const canvas = declaredCanvas(pages) ?? detectCanvas(pages);
	const doc = await PDFDocument.create();
	for (const rmPage of pages) {
		// Per page, not per document: each page scrolls on its own, so they legitimately differ in height.
		const pageCanvas = scrolledCanvas(rmPage, canvas);
		const page = doc.addPage([pageCanvas.widthPt, pageCanvas.heightPt]);
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

/**
 * Composites a PDF-backed document (spec §5's PDF path): each output page is the source PDF page at
 * its own size with the handwritten annotation scene drawn on top, placed in the page's own frame
 * (see `pageFrame`) so every stroke lands on the words it marks. A `sourceIndex` with no matching
 * source page (shouldn't happen) degrades to an annotations-only page, drawn against the device
 * screen for want of a page to measure against, rather than failing the whole document.
 */
export async function renderAnnotatedPdf(sourcePdfBytes: Uint8Array, pages: AnnotatedPdfPage[]): Promise<Uint8Array> {
	if (pages.length === 0) throw new Error("renderAnnotatedPdf: no pages to render");

	const device = resolveDeviceCanvas(pages.map((page) => page.annotations).filter((scene): scene is RmPage => scene !== null));
	const src = await PDFDocument.load(sourcePdfBytes);
	const out = await PDFDocument.create();

	for (const { sourceIndex, annotations } of pages) {
		const srcPage = sourceIndex >= 0 && sourceIndex < src.getPageCount() ? src.getPage(sourceIndex) : null;
		const { width, height } = srcPage?.getSize() ?? { width: device.widthPt, height: device.heightPt };
		const outPage = out.addPage([width, height]);
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
		if (annotations) drawPageStrokes(outPage, annotations, srcPage ? pageFrame(width, height, device) : device);
	}

	return out.save();
}
