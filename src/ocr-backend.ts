import type { OcrBackend as OcrBackendId, OcrStatus } from "./note-builder";
import type { RmPage } from "./rm-parser";

export interface OcrResult {
	status: OcrStatus;
	text: string;
	/** 0-100 if the backend reports one, otherwise null. */
	confidence: number | null;
	/**
	 * Things that went wrong inside a unit the backend still considers a success — a page that failed
	 * while the others read fine. They land in `SyncResult.skipErrors`, so "Copy diagnostics" and the
	 * end-of-sync report can name them.
	 *
	 * Without this channel a partial transcript is silent, and silence is permanent: the sync skips a
	 * document whose device-side hash is unchanged, so the missing page is never revisited.
	 */
	warnings?: string[];
}

/**
 * Pluggable transcription abstraction (spec §6 / ticket 09-10): a backend
 * consumes the parsed ink strokes for a synced unit and returns transcribed
 * text. Whether it needs the strokes directly (e.g. a future stroke-based
 * backend) or a rasterized page image (e.g. the Vision and LLM-vision backends)
 * is an implementation detail of the backend, not the call site.
 */
export interface OcrBackend {
	readonly id: OcrBackendId;
	/**
	 * Whether recognizing with this adapter spends the user's money per page — the auto-sync
	 * money-safety gate. Declared per adapter rather than derived from `id`, so a keyless cloud
	 * provider that fell back to a free backend, or one that can't run here at all, reports honestly.
	 */
	readonly metered: boolean;
	recognize(pages: RmPage[]): Promise<OcrResult>;
}
