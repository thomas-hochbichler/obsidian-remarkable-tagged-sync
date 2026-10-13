import type { CutOff, OcrBackend, OcrFraming, OcrResult } from "./ocr-backend";
import { pushUnique } from "./push-unique";

/** What became of the images one run sent, by outcome. */
export interface OcrCounts {
	/** Came back with text. */
	read: number;
	/** Came back empty: the backend answered and found no words. */
	empty: number;
	/** The backend answered with an error, or not at all. */
	failed: number;
	/** The backend could not run here and never looked. */
	unavailable: number;
}

/**
 * What one run's transcription did, for "Copy diagnostics".
 *
 * Built because the report that needed it had none of it: a user's margin notes all read "could not
 * be transcribed", and the diagnostics said `Last error: none` -- true, since an empty answer is not an
 * error -- while naming neither the model nor how many notes came back empty. Each of those would have
 * pointed at the cause on the first message.
 */
export interface OcrTally {
	/** The backend that actually ran, which a fallback can make different from the one selected. */
	backend: string;
	model: string | null;
	pages: OcrCounts;
	notes: OcrCounts;
	/** What the backend said went wrong, each distinct sentence once and the first few only. */
	warnings: string[];
	/** What cut answers off, the first few only -- see `CutOff`. */
	cutOffs: CutOff[];
}

/** The most warnings a tally keeps: past this they are the same failure again, and the block is pasted into an issue. */
const MAX_WARNINGS = 5;

const zero = (): OcrCounts => ({ read: 0, empty: 0, failed: 0, unavailable: 0 });

function count(tally: OcrTally, framing: OcrFraming, images: number, result: OcrResult): void {
	const counts = framing === "note" ? tally.notes : tally.pages;
	if (result.pages !== null && result.pages.length === images) {
		for (const page of result.pages) {
			if (page.status === "ok") counts.read++;
			else if (page.status === "failed") counts.failed++;
			else counts.empty++;
		}
	} else if (result.status === "unavailable") counts.unavailable += images;
	else if (result.status === "failed") counts.failed += images;
	else if (result.status === "ok") counts.read += images;
	else counts.empty += images;
	pushUnique(tally.warnings, result.warnings ?? [], MAX_WARNINGS);
	tally.cutOffs.push(...(result.cutOffs ?? []).slice(0, MAX_WARNINGS - tally.cutOffs.length));
}

/**
 * A per-run stand-in for `backend` that counts what it transcribes into a fresh tally.
 *
 * `onFirstSend` hands the tally over the first time the run sends an image, before the backend sees
 * it. A run that sends nothing -- a cancelled dialog, a refusal before any money is spent, a sync
 * with nothing changed -- leaves the last run's figures standing; one that fails halfway reports what
 * it had sent by then.
 *
 * Built with `Object.create(backend)` rather than as a wrapper object: the unavailable notice and the
 * re-transcribe gate both ask `instanceof UnavailableOcrBackend`, and with the adapter on its
 * prototype chain the stand-in answers that, and every field, as the adapter does. The adapter
 * itself is left untouched. It used to have its `recognize` replaced in place, and Apple Vision's is
 * one object for the whole session, so every sync wrapped it once more and kept counting into every
 * older tally. The stand-in covers every caller -- the notebook pass, the digest's margin notes,
 * re-transcribe -- and every backend, without any of them knowing it is there.
 *
 * Except "Off", which is handed back as it is: it sends nothing anywhere, so it is no run to report.
 * Counted, its skipped answers read as "40 empty" -- forty blank pages -- and replaced the figures of
 * the last run that did transcribe.
 */
export function tallyOcr<T extends OcrBackend>(backend: T, onFirstSend: (tally: OcrTally) => void): T {
	if (backend.id === "off") return backend;
	const tally: OcrTally = { backend: backend.id, model: backend.model ?? null, pages: zero(), notes: zero(), warnings: [], cutOffs: [] };
	let sent = false;
	const counted = Object.create(backend) as T;
	counted.recognize = async (pages, onPage, framing) => {
		if (!sent && pages.length > 0) {
			sent = true;
			onFirstSend(tally);
		}
		try {
			const result = await backend.recognize(pages, onPage, framing);
			count(tally, framing ?? "page", pages.length, result);
			return result;
		} catch (error) {
			count(tally, framing ?? "page", pages.length, { status: "failed", pages: null, text: "", confidence: null });
			throw error;
		}
	};
	return counted;
}

function countsLine(label: string, counts: OcrCounts): string {
	const parts = [`${counts.read} read`, `${counts.empty} empty`, `${counts.failed} failed`];
	if (counts.unavailable > 0) parts.push(`${counts.unavailable} not run`);
	return `${label}: ${parts.join(", ")}`;
}

function cutOffLine(cut: CutOff): string {
	const tokens = cut.promptTokens === null || cut.answerTokens === null ? "tokens unknown" : `prompt ${cut.promptTokens} + answer ${cut.answerTokens} = ${cut.promptTokens + cut.answerTokens} tokens`;
	return `- ${tokens}, context ${cut.context ?? "unknown"}, reasoning: ${cut.reasoning ? "yes" : "no"}, repeated lines: ${cut.repeatedLines} of ${cut.lines}`;
}

/** The tally as the lines of the diagnostics block. */
export function describeOcrTally(tally: OcrTally | null): string[] {
	if (tally === null) return ["Last transcription: none since Obsidian started"];
	return [
		`Last transcription: ${tally.backend}${tally.model === null ? "" : `, model ${tally.model.trim() === "" ? "(none set)" : tally.model}`}`,
		countsLine("Pages", tally.pages),
		countsLine("Margin notes", tally.notes),
		...(tally.warnings.length === 0 ? ["Transcription warnings: none"] : ["Transcription warnings:", ...tally.warnings.map((warning) => `- ${warning}`)]),
		...(tally.cutOffs.length === 0 ? ["Cut-off answers: none"] : ["Cut-off answers:", ...tally.cutOffs.map(cutOffLine)]),
	];
}
