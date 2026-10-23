import { type LayerLine, wordBoxes } from "./text-layer";
import { levenshtein, type VisionBox } from "./vision-ocr-backend";

/**
 * Word-sequence alignment: a transcript's words placed on the boxes of the words Vision read on the
 * same page, so a layer carries the backend's words where Vision saw them (searchable-pdf spec §2.1).
 */

/** How alike two words must be, above which one may take the other's box. 0.4 to 0.7 changed almost nothing (ticket 05). */
const PLACE_SIMILARITY = 0.5;
/** The most words one read may stand for, when Vision ran them together. */
const MAX_RUN = 6;

/** A word as alignment compares it: case and accents do not tell two words apart. */
function shape(word: string): string {
	return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** 1 for the same word, 0 for nothing in common. */
function similarity(a: string, b: string): number {
	const [left, right] = [shape(a), shape(b)];
	return 1 - levenshtein(left, right) / Math.max(left.length, right.length, 1);
}

/**
 * The words of a transcript as written on the page: comments (`<!-- margin -->`) and inline marks
 * (`**`, `*`, `__`, `` ` ``, `~~`, `==`) go, and so does every token that is only Markdown -- a
 * heading's `#`, a list's `-`, a table's `|` and its `|---|` rule.
 */
function transcriptWords(transcript: string): string[] {
	return transcript
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/__|~~|==|[*`]/g, "")
		.replace(/\|/g, " ")
		.split(/\s+/)
		.filter((word) => !/^[-*#>:]*$/.test(word));
}

/** The smallest box around `boxes`. */
function spanning(boxes: VisionBox[]): VisionBox {
	const left = Math.min(...boxes.map((box) => box.x));
	const bottom = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.w));
	const top = Math.max(...boxes.map((box) => box.y + box.h));
	return { x: left, y: bottom, w: right - left, h: top - bottom };
}

/** One word Vision read, with the box it takes and the line it is on. */
interface Read {
	text: string;
	box: VisionBox;
	line: number;
}

/**
 * The transcript's words on Vision's boxes, line by line in Vision's reading order. A transcript word
 * that finds no place is left out: a hit in the PDF always sits on the word (spec §2.1). Lines no
 * word was placed on are not returned.
 */
export function placeWords(transcript: string, lines: LayerLine[]): LayerLine[] {
	const words = transcriptWords(transcript);
	const reads: Read[] = lines.flatMap((visionLine, line) => {
		const boxes = wordBoxes(visionLine);
		return visionLine.words.map((word, i) => ({ text: word.text, box: boxes[i], line }));
	});

	// Weighted LCS: `best[i][j]` is the most similarity the first `i` words and the first `j` reads can
	// share. `taken[i][j]` is how many words read `j` took on the way there, 0 for none. A run of words
	// is compared as one string, because Vision runs words together ("100547108.") and a model does not.
	const best = Array.from({ length: words.length + 1 }, () => new Float64Array(reads.length + 1));
	const taken = Array.from({ length: words.length + 1 }, () => new Uint8Array(reads.length + 1));
	for (let i = 1; i <= words.length; i++) {
		for (let j = 1; j <= reads.length; j++) {
			best[i][j] = Math.max(best[i - 1][j], best[i][j - 1]);
			for (let run = 1; run <= Math.min(MAX_RUN, i); run++) {
				const alike = similarity(words.slice(i - run, i).join(""), reads[j - 1].text);
				if (alike > PLACE_SIMILARITY && best[i - run][j - 1] + alike > best[i][j]) {
					best[i][j] = best[i - run][j - 1] + alike;
					taken[i][j] = run;
				}
			}
		}
	}

	// Words `from` to `to` (exclusive) on read `read`, in transcript order.
	const matches: { from: number; to: number; read: number }[] = [];
	for (let i = words.length, j = reads.length; i > 0 && j > 0; ) {
		const run = taken[i][j];
		if (run > 0) {
			matches.unshift({ from: i - run, to: i, read: j - 1 });
			i -= run;
			j--;
		} else if (best[i][j] === best[i - 1][j]) i--;
		else j--;
	}

	const placed = new Map<number, { text: string; box: VisionBox }[]>();
	// One word keeps its box; several share it out by characters, as a line's words do.
	const place = (texts: string[], box: VisionBox, line: number) => {
		const boxes = wordBoxes({ box, words: texts.map((text) => ({ text, box: null })) });
		placed.set(line, [...(placed.get(line) ?? []), ...texts.map((text, k) => ({ text, box: boxes[k] }))]);
	};
	matches.forEach((match, k) => {
		const previous = matches[k - 1];
		const line = reads[match.read].line;
		// A gap between two placed neighbours is what a misread looks like. As many words as reads in it:
		// each word takes the read in its place, across a line break too. Otherwise, on one line, the
		// words share the reads in it. With no read in it, or a line break, they have no place.
		const gapWords = previous === undefined ? [] : words.slice(previous.to, match.from);
		const gapReads = previous === undefined ? [] : reads.slice(previous.read + 1, match.read);
		if (gapWords.length > 0 && gapWords.length === gapReads.length) {
			gapWords.forEach((word, i) => place([word], gapReads[i].box, gapReads[i].line));
		} else if (gapWords.length > 0 && gapReads.length > 0 && reads[previous.read].line === line) {
			place(gapWords, spanning(gapReads.map((read) => read.box)), line);
		}
		place(words.slice(match.from, match.to), reads[match.read].box, line);
	});

	return lines.flatMap((visionLine, line) => {
		const lineWords = placed.get(line);
		return lineWords ? [{ box: visionLine.box, words: lineWords }] : [];
	});
}
