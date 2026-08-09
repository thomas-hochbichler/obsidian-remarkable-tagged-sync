import type { OcrBackend, OcrResult } from "./ocr-backend";
import type { RmPage } from "./rm-parser";

// `pages: null`, not one `skipped` entry per page: this backend never looked at a page, so per-page
// entries would be fiction. No per-page information means the note renders exactly as it did before
// transcripts were page-anchored.
const SKIPPED: OcrResult = { status: "skipped", pages: null, text: "", confidence: null };

/**
 * The explicit "don't transcribe" choice. Returns `skipped`, never `unavailable`: the user asked for
 * no text, so nothing failed and the platform notice must stay quiet.
 *
 * It also keeps the backend dropdown from being a single disabled entry on Windows and Linux, where
 * Apple Vision cannot run — a list with nothing selectable in it reads as a broken plugin.
 */
export class OffOcrBackend implements OcrBackend {
	readonly id = "off" as const;
	readonly metered = false;

	async recognize(_pages: RmPage[]): Promise<OcrResult> {
		return SKIPPED;
	}
}
