import type { RmPage, RmPoint, RmStroke } from "./rm-parser";

// The reMarkable 1/2 device canvas, used only to size the bitmap for a page with no ink on it --
// every other page is sized to its own ink (see `inkBounds`). Rasterizing in device px directly,
// no pt conversion needed for OCR input.
const PAGE_WIDTH_PX = 1404;
const PAGE_HEIGHT_PX = 1872;
/** Bounds the bitmap a corrupt coordinate can ask for, well past any real page's ink. */
const MAX_RASTER_PX = 6000;
const DEFAULT_STROKE_WIDTH_PX = 2;
const MAX_STROKE_RADIUS_PX = 50; // caps a corrupt/outlier brushSize value from blowing up fillDisc's cost
// Generous margin beyond the page for a stroke's legitimate off-page tail, while bounding the
// distance/step-count blowup that occurs on corrupt point data (observed: coordinates ~1e38).
const COORDINATE_MARGIN_PX = 4000;

export interface RasterImage {
	width: number;
	height: number;
	/** One byte per pixel, row-major, top-down. 0 = black, 255 = white. */
	pixels: Uint8Array;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Clamps a point's coordinates to a bounded margin around the page, guarding against corrupt/outlier point data. */
function clampPoint(point: RmPoint): { x: number; y: number } {
	return {
		x: clamp(point.x, -COORDINATE_MARGIN_PX, PAGE_WIDTH_PX + COORDINATE_MARGIN_PX),
		y: clamp(point.y, -COORDINATE_MARGIN_PX, PAGE_HEIGHT_PX + COORDINATE_MARGIN_PX),
	};
}

function strokeRadiusPx(stroke: RmStroke): number {
	const width = stroke.brushSize > 0 ? stroke.brushSize : DEFAULT_STROKE_WIDTH_PX;
	return clamp(width / 2, 0.5, MAX_STROKE_RADIUS_PX);
}

/** Fills a filled disc of the given radius, clipped to the image bounds. */
function fillDisc(image: RasterImage, cx: number, cy: number, radius: number): void {
	const minX = Math.max(0, Math.floor(cx - radius));
	const maxX = Math.min(image.width - 1, Math.ceil(cx + radius));
	const minY = Math.max(0, Math.floor(cy - radius));
	const maxY = Math.min(image.height - 1, Math.ceil(cy + radius));
	const radiusSq = radius * radius;

	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const dx = x - cx;
			const dy = y - cy;
			if (dx * dx + dy * dy <= radiusSq) image.pixels[y * image.width + x] = 0;
		}
	}
}

/** Draws a stroke as a sequence of thick line segments, sampled densely enough to leave no gaps. */
/** Draws one stroke, with the scene-to-bitmap offset (the ink box's origin) applied to every point. */
function drawStroke(image: RasterImage, stroke: RmStroke, offsetX: number, offsetY: number): void {
	const radius = strokeRadiusPx(stroke);
	const at = (point: RmPoint) => {
		const { x, y } = clampPoint(point);
		return { x: x - offsetX, y: y - offsetY };
	};

	if (stroke.points.length === 1) {
		const point = at(stroke.points[0]);
		fillDisc(image, point.x, point.y, radius);
		return;
	}

	for (let i = 1; i < stroke.points.length; i++) {
		const from = at(stroke.points[i - 1]);
		const to = at(stroke.points[i]);
		const distance = Math.hypot(to.x - from.x, to.y - from.y);
		const steps = Math.max(1, Math.ceil(distance / (radius > 0.5 ? radius : 0.5)));

		for (let step = 0; step <= steps; step++) {
			const t = step / steps;
			fillDisc(image, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius);
		}
	}
}

/**
 * The box the page's ink actually occupies, padded by the widest stroke's radius so no mark is
 * shaved off at an edge. Sizing the bitmap to this rather than to the device screen is what keeps
 * a scene's coordinate frame out of the rasterizer: scene x is measured from the page midline and
 * so is negative across the whole left half of a page, and a PDF-backed page's ink is measured
 * against the source page, which is larger than any screen -- against a fixed screen-sized bitmap
 * anchored at (0,0), both simply fall outside it and are never transcribed.
 */
function inkBounds(page: RmPage): { minX: number; minY: number; width: number; height: number } | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let pad = 0;

	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			pad = Math.max(pad, strokeRadiusPx(stroke));
			for (const point of stroke.points) {
				const { x, y } = clampPoint(point);
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
	}
	if (minX > maxX) return null;

	return {
		minX: minX - pad,
		minY: minY - pad,
		width: Math.min(Math.ceil(maxX - minX + 2 * pad) || 1, MAX_RASTER_PX),
		height: Math.min(Math.ceil(maxY - minY + 2 * pad) || 1, MAX_RASTER_PX),
	};
}

/** Rasterizes a parsed `.rm` scene into a white-background grayscale bitmap, for OCR backends that need a page image (the Vision and LLM-vision backends). */
export function rasterizePage(page: RmPage): RasterImage {
	const bounds = inkBounds(page);
	const width = bounds?.width ?? PAGE_WIDTH_PX;
	const height = bounds?.height ?? PAGE_HEIGHT_PX;
	const image: RasterImage = { width, height, pixels: new Uint8Array(width * height).fill(255) };

	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			drawStroke(image, stroke, bounds?.minX ?? 0, bounds?.minY ?? 0);
		}
	}

	return image;
}
