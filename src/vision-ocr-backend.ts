import { mapWithConcurrency } from "./concurrency";
import { clusterStrokes } from "./margin-notes";
import type { OcrBackend as OcrBackendId } from "./note-builder";
import { type OcrBackend, type OcrPageResult, type OcrResult, unitStatus } from "./ocr-backend";
import { inkBounds, type InkBounds, rasterizePage } from "./page-rasterizer";
import { isHighlighterOrShader } from "./pdf-renderer";
import { encodeGrayscalePng } from "./png-encoder";
import type { RmPage, RmStroke } from "./rm-parser";
import { layoutText } from "./text-layout";

/** One recognized line's box, normalized against the image it was read from, with a bottom-left origin. */
export interface VisionBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * One image's outcome from a single Vision process: its recognized lines with the box of each, or an
 * image-level error (missing/unreadable). `lines` and `boxes` are index-aligned.
 */
export type VisionBatchResult = { lines: string[]; boxes: VisionBox[]; revision?: number } | { error: string };

/**
 * Runs one `osascript`/Vision process over a batch of page PNGs and returns a per-image result in
 * input order. Injected so the pure backend below stays testable off macOS (the real implementation,
 * which writes temp files and spawns a subprocess, lives in `vision-ocr-runtime.ts`). It **throws**
 * only when Vision cannot run at all (spawn failure, timeout); an image that simply had no text
 * comes back with no lines, and a bad image as `{ error }`.
 */
export type VisionBatchRunner = (images: Uint8Array[]) => Promise<VisionBatchResult[]>;

export interface VisionOcrOptions {
	runBatch: VisionBatchRunner;
	/**
	 * Resolves whether Vision can run in this session: the cheap platform gate plus one real
	 * tiny-image invocation (spec §4.1). Awaited and cached on first `recognize`; `false` yields
	 * `unavailable` without ever spawning again.
	 */
	probe: () => Promise<boolean>;
	/** Pages per Vision process; batching amortises the ~200 ms per-process warm-up (spec §3.4). */
	batchSize?: number;
	/** Max concurrent Vision processes; capped near the perf-core count (spec §3.4). */
	maxParallelism?: number;
}

const DEFAULT_BATCH_SIZE = 5;
/** Default cap on concurrent Vision processes -- near the perf-core count of a typical Mac (spec §3.4). */
export const DEFAULT_MAX_PARALLELISM = 8;

/**
 * The line height the page's ink is clustered at for the rescue pass, in device px. 60 px trades 0.8
 * CER points for 1.3 points of line recall -- defensible, since a missing line is worse than a wrong
 * word, but not the default.
 */
const RESCUE_LINE_HEIGHT_PX = 40;
/** Quiet space around a rescued cluster's own bitmap: a few words read better away from an edge. */
const RESCUE_PADDING_PX = 40;
/** How much of a cluster's height an observation has to cover before the cluster counts as read. */
const COVERAGE_FRACTION = 0.3;
/** How similar a rescued line may be to one already present before it counts as the same line. */
const DUPLICATE_SIMILARITY = 0.6;

// `pages` is empty rather than null on these: they are returned for an empty page set, where one
// entry per input page *is* zero entries, which is arity-correct. `UNAVAILABLE` is the exception --
// it describes the backend, which never looked at a page, so it has nothing per-page to say.
const SKIPPED: OcrResult = { status: "skipped", pages: [], text: "", confidence: null };
const UNAVAILABLE: OcrResult = { status: "unavailable", pages: null, text: "", confidence: null };
const FAILED: OcrResult = { status: "failed", pages: null, text: "", confidence: null };

/** Splits `items` into contiguous chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/**
 * What the current run of Vision left worth reporting, for "Copy diagnostics" (spec §5.2). Reset by
 * each new backend instance, which the plugin builds once per sync -- so these describe one sync.
 *
 * Module state rather than a field, because the adapter is built per run and thrown away, while the
 * diagnostics block is assembled much later and from somewhere else entirely. Nothing is sent
 * anywhere: the user presses a button and pastes the text.
 */
export const visionRunStats: {
	/** The revision Vision actually ran, which is deliberately the OS's choice and not ours to pin. */
	revision: number | null;
	/** Ink no framing got a word out of -- writing Vision refuses, and so the honest count of what is missing from the notes. */
	unreadableInkRegions: number;
} = { revision: null, unreadableInkRegions: 0 };

/** What one image came back as, once its error case is out of the way. Kept mutable: the rescue pass splices into it. */
interface ReadLines {
	lines: string[];
	boxes: VisionBox[];
}

/** A page's writing. Translucent tools are marker bands rather than words, which is `clusterStrokes`' contract. */
function inkStrokes(page: RmPage): RmStroke[] {
	return page.layers.flatMap((layer) => layer.strokes).filter((stroke) => !isHighlighterOrShader(stroke.penType));
}

/** A scene box projected into Vision's frame: normalized against the page's bitmap, y counted from the bottom. */
function normalize(bounds: { minX: number; minY: number; maxX: number; maxY: number }, frame: InkBounds): VisionBox {
	const x = (bounds.minX - frame.minX) / frame.width;
	const top = 1 - (bounds.minY - frame.minY) / frame.height;
	const bottom = 1 - (bounds.maxY - frame.minY) / frame.height;
	return { x, y: bottom, w: (bounds.maxX - bounds.minX) / frame.width, h: top - bottom };
}

/**
 * Ink the page pass returned no text over, as one crop-ready scene per cluster plus where it sits.
 *
 * This is the whole trigger for the second pass, and it is structural because there is nothing else:
 * Vision reports a confidence of 1.000 over plain misreads, so "no observation covers this writing"
 * is the only signal that a line went missing. A cluster counts as read when some observation
 * overlaps it horizontally *and* covers more than `COVERAGE_FRACTION` of its height.
 *
 * The frame is `inkBounds` itself rather than a copy of its arithmetic: the page's bitmap is what the
 * boxes are normalized against, and a frame that is off by the padding makes every cluster read as
 * uncovered -- which silently re-OCRs the whole page, cluster by cluster.
 */
function uncoveredClusters(page: RmPage, boxes: VisionBox[]): { scene: RmPage; centerY: number }[] {
	const frame = inkBounds(page);
	const ink = inkStrokes(page);
	if (frame === null || ink.length === 0) return [];

	return clusterStrokes(ink, RESCUE_LINE_HEIGHT_PX)
		.map((cluster) => ({ cluster, band: normalize(cluster.bounds, frame) }))
		.filter(
			({ band }) =>
				!boxes.some((box) => {
					const across = Math.min(band.x + band.w, box.x + box.w) - Math.max(band.x, box.x);
					const down = Math.min(band.y + band.h, box.y + box.h) - Math.max(band.y, box.y);
					return across > 0 && down > band.h * COVERAGE_FRACTION;
				}),
		)
		.map(({ cluster, band }) => ({
			scene: { ...page, layers: [{ id: "rescue", name: null, strokes: cluster.strokes }] },
			centerY: band.y + band.h / 2,
		}));
}

/** Levenshtein distance, two-row DP. */
function levenshtein(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = new Uint32Array(b.length + 1);
	let curr = new Uint32Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length];
}

/** Compares two lines as text rather than as bytes: spacing and the typographic variants of a quote or dash never distinguish them. */
function sameLine(a: string, b: string): boolean {
	const shape = (line: string) =>
		line
			.normalize("NFC")
			.replace(/[‘’ʼ]/g, "'")
			.replace(/[“”]/g, '"')
			.replace(/[‐-―]/g, "-")
			.replace(/\s+/g, " ")
			.trim();
	const [left, right] = [shape(a), shape(b)];
	const longest = Math.max(left.length, right.length);
	return longest === 0 || 1 - levenshtein(left, right) / longest >= DUPLICATE_SIMILARITY;
}

/**
 * Puts one line into a page's read at the height it belongs to.
 *
 * Reading order is worth more than the rescue pass itself: appending recovered lines to the end of a
 * page costs 2.4 CER points against splicing them in, because a line in the wrong place is charged
 * twice -- missing where it belongs, spurious where it landed. The page pass owns the order and is
 * never re-sorted; an inserted line goes in ahead of the first line whose box sits lower.
 */
function insertLine(read: ReadLines, line: string, centerY: number): void {
	let at = read.lines.length;
	for (let i = 0; i < read.boxes.length; i++) {
		if (read.boxes[i].y + read.boxes[i].h / 2 < centerY) {
			at = i;
			break;
		}
	}
	read.lines.splice(at, 0, line);
	read.boxes.splice(at, 0, { x: 0, y: centerY, w: 1, h: 0 });
}

/**
 * Adds the text the user typed on the page, at the height the device lays each line out at.
 *
 * Typed text is not on the image at all -- the rasterizer draws ink -- so without this it is simply
 * absent from the note, and putting it through OCR would be worse than useless: it is already exact
 * digital text, and Vision would only introduce errors into it.
 *
 * Never deduplicated against what came back from Vision. A typed line cannot be a re-read of the same
 * words, because Vision never saw it, so a resemblance to nearby handwriting is a coincidence -- and
 * dropping the user's own text over a coincidence is not a trade worth making.
 */
function insertTypedText(read: ReadLines, page: RmPage): void {
	if (!page.text) return;
	const frame = inkBounds(page);
	for (const line of layoutText(page.text).lines) {
		if (line.text.trim() === "") continue;
		// Without ink there is no frame and no observation either, so every line simply appends in
		// document order -- which is the order they are laid out in.
		insertLine(read, line.text, frame ? 1 - (line.yPx - frame.minY) / frame.height : 0);
	}
}

/**
 * Native macOS OCR backend (spec §3): rasterizes each page with the shared
 * `rasterizePage` → `encodeGrayscalePng` pipeline, then hands the PNGs to Apple's Vision framework
 * via an injected `osascript` runner. Batches pages per process and caps parallelism to amortise
 * Vision's per-process warm-up. `confidence` is permanently `null` -- Vision reports a constant 1.0
 * even over misread text (spec §3.6), so surfacing it would put a fabricated score in frontmatter.
 */
export class VisionOcrBackend implements OcrBackend {
	readonly id = "vision" as const;
	readonly metered = false;
	/**
	 * A constant, because there is nothing else honest to put here: the model belongs to the OS and is
	 * not addressable from the plugin -- `visionRevision` is chosen per request and deliberately never
	 * pinned (see the class docstring). So a macOS upgrade can change what Vision reads without the
	 * transcript store noticing. Accepted rather than papered over with the OS version, which changes
	 * for a hundred reasons that are not this one; OCR drift is issue #100's question, not the store's.
	 */
	readonly fingerprint = "vision";
	private readonly runBatch: VisionBatchRunner;
	private readonly probe: () => Promise<boolean>;
	private readonly batchSize: number;
	private readonly maxParallelism: number;
	private availability: Promise<boolean> | null = null;

	constructor(options: VisionOcrOptions) {
		this.runBatch = options.runBatch;
		this.probe = options.probe;
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.maxParallelism = options.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
		visionRunStats.revision = null;
		visionRunStats.unreadableInkRegions = 0;
	}

	private available(): Promise<boolean> {
		return (this.availability ??= this.probe());
	}

	/** Reads a list of images, batched per process and with the process count capped. */
	private async read(images: Uint8Array[]): Promise<VisionBatchResult[]> {
		const batches = chunk(images, this.batchSize);
		const results = await mapWithConcurrency(batches, this.maxParallelism, (batch) => this.runBatch(batch));
		return results.flat();
	}

	/**
	 * Re-reads the ink the page pass returned nothing over, and splices what it recovers back in.
	 *
	 * Replacing the page with crops outright loses: fewer and larger images score better, monotonically,
	 * and the trend extrapolates back to the whole page -- Vision's page-level layout pass is doing real
	 * work, not only dropping lines. So the page stays the input and this only fills its gaps, for about
	 * 1.4 extra images per page.
	 */
	private async rescue(pages: RmPage[], reads: (ReadLines | null)[]): Promise<void> {
		const missed = pages.flatMap((page, index) => {
			const read = reads[index];
			return read ? uncoveredClusters(page, read.boxes).map((cluster) => ({ ...cluster, index })) : [];
		});
		if (missed.length === 0) return;

		const recovered = await this.read(
			missed.map(({ scene }) => encodeGrayscalePng(rasterizePage(scene, { paddingPx: RESCUE_PADDING_PX }))),
		);
		missed.forEach((cluster, i) => {
			const result = recovered[i];
			const read = reads[cluster.index];
			const lines = result !== undefined && "lines" in result ? result.lines : [];
			// A cluster that stays wordless at its own framing too is writing Vision refuses outright --
			// the honest count of what is missing from the note, and the only in-product signal for it.
			if (lines.length === 0) visionRunStats.unreadableInkRegions++;
			if (!read) return;
			// A rescued crop often re-reads a neighbour the page pass already returned, and an unmerged
			// duplicate costs twice: 14 uncovered clusters on the corpus yielded 6 genuinely new lines.
			for (const line of lines) if (!read.lines.some((existing) => sameLine(existing, line))) insertLine(read, line, cluster.centerY);
		});
	}

	async recognize(pages: RmPage[]): Promise<OcrResult> {
		if (pages.length === 0) return SKIPPED;
		if (!(await this.available())) return UNAVAILABLE;

		try {
			const perPage = await this.read(pages.map((page) => encodeGrayscalePng(rasterizePage(page))));
			const reads = perPage.map((result): ReadLines | null => ("lines" in result ? { lines: [...result.lines], boxes: [...result.boxes] } : null));
			for (const result of perPage) if ("revision" in result && result.revision !== undefined) visionRunStats.revision = result.revision;

			await this.rescue(pages, reads);
			reads.forEach((read, index) => {
				if (read) insertTypedText(read, pages[index]);
			});

			// One entry per input page, in input order. The per-page outcome was always computed here --
			// `VisionBatchResult` is `{ lines } | { error }` -- and used to be thrown away by a `.filter()`
			// that dropped the empty pages, losing the error flag and the index alignment together.
			const pageResults = reads.map((read): OcrPageResult => {
				if (read === null) return { status: "failed", text: "" };
				const text = read.lines.join("\n").trim();
				return text.length > 0 ? { status: "ok", text } : { status: "skipped", text: "" };
			});
			const text = pageResults
				.filter((page) => page.status === "ok")
				.map((page) => page.text)
				.join("\n\n")
				.trim();
			return { status: unitStatus(pageResults), pages: pageResults, text, confidence: null };
		} catch (error) {
			console.warn("Tagged Sync: Vision OCR failed, note will ship with render only", error);
			return FAILED;
		}
	}
}

/**
 * A backend that can never transcribe here (spec §6.1 `unavailable`): non-macOS with no LLM-vision
 * key, or macOS below the version floor. It still returns `skipped` for an empty page set so a
 * blank unit reads the same everywhere. `id` reflects the backend the user *chose* -- the note's
 * frontmatter then honestly records "you picked this, and it isn't available here".
 */
export class UnavailableOcrBackend implements OcrBackend {
	/** Transcribes nothing, so it can never spend — even when `id` names a metered cloud provider. */
	readonly metered = false;
	/** Transcribes nothing, so it stores nothing; the string only has to be stable. */
	readonly fingerprint = "unavailable";

	constructor(readonly id: OcrBackendId) {}

	async recognize(pages: RmPage[]): Promise<OcrResult> {
		return pages.length === 0 ? SKIPPED : UNAVAILABLE;
	}
}
