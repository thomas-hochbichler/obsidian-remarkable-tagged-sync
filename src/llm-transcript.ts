import type { RmPage } from "./rm-parser";
import { layoutText } from "./text-layout";

/** The transcription prompt shared verbatim by every LLM-vision backend (multi-provider spec §3). */
export const TRANSCRIPTION_PROMPT =
	"Transcribe the handwritten text in each of the following page images into clean Markdown, " +
	"preserving reading order and visible structure: headings, lists, GFM task lists (- [ ] / - [x]), " +
	"and tables. Do not invent structure that is not visually present; when unsure, use plain " +
	"paragraphs. Output only the transcript text, with each page's transcript separated by a blank " +
	"line -- no commentary, preamble, code fences, or page labels. If a page has no legible text, " +
	"output nothing for that page.";

/**
 * The text the user typed on these pages, which no page image carries: the rasterizer draws ink, and
 * the raster is all a vision model is handed. Without this it is missing from the note entirely, and
 * it must not go through transcription either -- it is already exact.
 *
 * Appended per page rather than placed within one. A single response covers every page at once and
 * says nothing about where its lines sat, so there is no position to splice against. The local Vision
 * backend reads one page at a time and gets each line's box, and does place it.
 */
export function typedText(pages: RmPage[]): string {
	return pages
		.map((page) =>
			page.text
				? layoutText(page.text)
						.lines.map((line) => line.text)
						.filter((line) => line.trim() !== "")
						.join("\n")
				: "",
		)
		.filter((page) => page !== "")
		.join("\n\n");
}

/**
 * Strip LLM envelope leakage from a transcript: a single leading preamble line and an outer code
 * fence wrapping the whole response (structure-preserving-ocr spec §2). Anchored to the response
 * edges only — never touches inner content, so a code block the user wrote on the page survives.
 * Biased to under-strip: a stray line is a cheap failure, corrupting a note is not.
 */
export function sanitizeTranscript(text: string): string {
	let lines = text.trim().split("\n");

	// 1. Leading preamble line: only a tight "Here is/are (the) transcript/transcription" match.
	if (/^here (is|are)( the)? (transcript|transcription)[:.]?$/i.test(lines[0].trim())) {
		lines = lines.slice(1);
		if (lines[0]?.trim() === "") lines = lines.slice(1);
	}

	// 2. Outer wrapping fence: only when an md/empty-info opening fence and a closing ``` span the
	//    whole (post-preamble) response. Any other info string (```python) is a real code block.
	const firstIdx = lines.findIndex((line) => line.trim() !== "");
	const lastIdx = lines.length - 1 - [...lines].reverse().findIndex((line) => line.trim() !== "");
	if (firstIdx !== -1 && lastIdx > firstIdx) {
		const opener = lines[firstIdx].trim();
		const closer = lines[lastIdx].trim();
		if (/^```(markdown|md)?$/i.test(opener) && closer === "```") {
			lines = lines.slice(firstIdx + 1, lastIdx);
		}
	}

	return lines.join("\n").trim();
}
