import type { OcrBackend as OcrBackendId } from "./note-builder";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { encodeGrayscalePng } from "./png-encoder";
import { rasterizePage } from "./page-rasterizer";
import type { RmPage } from "./rm-parser";

/** One page's outcome from a single Vision process: recognized text, or an image-level error (missing/unreadable). */
export type VisionBatchResult = { text: string } | { error: string };

/**
 * Runs one `osascript`/Vision process over a batch of page PNGs and returns a per-image result in
 * input order. Injected so the pure backend below stays testable off macOS (the real implementation,
 * which writes temp files and spawns a subprocess, lives in `vision-ocr-runtime.ts`). It **throws**
 * only when Vision cannot run at all (spawn failure, timeout); an image that simply had no text
 * comes back as `{ text: "" }`, and a bad image as `{ error }`.
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

const SKIPPED: OcrResult = { status: "skipped", text: "", confidence: null };
const UNAVAILABLE: OcrResult = { status: "unavailable", text: "", confidence: null };
const FAILED: OcrResult = { status: "failed", text: "", confidence: null };

/** Splits `items` into contiguous chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** Maps `items` through `fn` with at most `limit` in flight at once, preserving input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
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
	}

	private available(): Promise<boolean> {
		return (this.availability ??= this.probe());
	}

	async recognize(pages: RmPage[]): Promise<OcrResult> {
		if (pages.length === 0) return SKIPPED;
		if (!(await this.available())) return UNAVAILABLE;

		try {
			const batches = chunk(pages, this.batchSize);
			const batchResults = await mapWithConcurrency(batches, this.maxParallelism, (batch) =>
				this.runBatch(batch.map((page) => encodeGrayscalePng(rasterizePage(page)))),
			);
			const perPage = batchResults.flat();

			const text = perPage
				.map((result) => ("text" in result ? result.text.trim() : ""))
				.filter((line) => line.length > 0)
				.join("\n\n")
				.trim();
			if (text.length > 0) return { status: "ok", text, confidence: null };

			// No text anywhere: a genuine blank page is `skipped`; a bad image (some page errored) is `failed`.
			return perPage.some((result) => "error" in result) ? FAILED : SKIPPED;
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

	constructor(readonly id: OcrBackendId) {}

	async recognize(pages: RmPage[]): Promise<OcrResult> {
		return pages.length === 0 ? SKIPPED : UNAVAILABLE;
	}
}
