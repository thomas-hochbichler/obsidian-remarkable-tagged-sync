// Correcting a quote the device spelled wrong, against the book it came from.
//
// The device's EPUB-to-PDF conversion loses letters: `off` arrives as `oP`, a plain U+0050 (spec
// §2). So the quote cannot simply be looked up -- it has to be found *despite* being damaged, which
// is an approximate match, not a search. The original `.epub` (see `epub-text.ts`) then supplies the
// wording.
//
// A failure to find it is a `null` and never an exception: the caller keeps the device's text, which
// is a blemish, rather than losing the annotation, which is not allowed (spec §3).

/** How much of the quote may be wrong before a match is not believable: 15%, and at least 2 characters for a short one. */
const MAX_ERROR_RATIO = 0.15;
const MIN_ERROR_BUDGET = 2;
/** Anchors tried, and windows examined per anchor. Both bound the work on a book-length source. */
const ANCHOR_WORDS = 3;
const MAX_WINDOWS = 24;
/** Room around a window for the text to be longer than the damaged quote (dropped glyphs, dehyphenation). */
const WINDOW_SLACK = 24;

/**
 * Comparison form, or null when this text cannot be folded one character to one character -- which
 * `toLowerCase` does not guarantee (`İ` lowercases to two code points). Every index in the folded
 * string has to address the same character in the original, because that is what maps a match back.
 */
function fold(text: string): string | null {
	const folded = foldChars(text);
	return folded.length === text.length ? folded : null;
}

function foldChars(text: string): string {
	return text
		.toLowerCase()
		// A PDF text layer and an `.epub` disagree about punctuation for reasons that are not the
		// reader's: curly quotes, dashes and the spaces a layout engine sets are all flattened here.
		.replace(/[‘’‛′]/g, "'")
		.replace(/[“”‟″]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.replace(/[\u00a0\u2007\u202f]/g, " ");
}

/** The longest words of the quote, which are its rarest and so its cheapest way into a book-length text. */
function anchors(quote: string): string[] {
	const words = [...new Set(quote.match(/\p{L}{4,}/gu) ?? [])];
	return words.sort((a, b) => b.length - a.length).slice(0, ANCHOR_WORDS);
}

interface Alignment {
	/** Edit distance between the quote and the stretch of source it was matched to. */
	distance: number;
	start: number;
	end: number;
	/** For each character of the quote, where it begins in the source. Length is the quote's length + 1; the last entry is `end`. */
	map: number[];
}

/**
 * The stretch of `source` inside `[from, to)` that the quote matches most closely, aligned character
 * by character.
 *
 * A fitting alignment: the quote is matched whole, the source freely -- the match may begin and end
 * anywhere in the window, because the window is a guess and the quote is the thing being located.
 */
function alignInWindow(quote: string, source: string, from: number, to: number): Alignment {
	const window = source.slice(from, to);
	const m = quote.length;
	const n = window.length;
	// One row per quote character; every source position is a free start, hence a zero first row.
	const distance = new Int32Array((m + 1) * (n + 1));
	for (let i = 1; i <= m; i++) distance[i * (n + 1)] = i;

	for (let i = 1; i <= m; i++) {
		const row = i * (n + 1);
		const previous = row - (n + 1);
		for (let j = 1; j <= n; j++) {
			const substitute = distance[previous + j - 1] + (quote[i - 1] === window[j - 1] ? 0 : 1);
			const drop = distance[previous + j] + 1;
			const skip = distance[row + j - 1] + 1;
			distance[row + j] = Math.min(substitute, drop, skip);
		}
	}

	let best = 0;
	for (let j = 1; j <= n; j++) if (distance[m * (n + 1) + j] < distance[m * (n + 1) + best]) best = j;

	// Walk the same choices back to learn where the match started and which source character each
	// quote character landed on.
	const map = new Array<number>(m + 1);
	map[m] = from + best;
	let i = m;
	let j = best;
	while (i > 0) {
		const row = i * (n + 1);
		const previous = row - (n + 1);
		if (j > 0 && distance[row + j] === distance[previous + j - 1] + (quote[i - 1] === window[j - 1] ? 0 : 1)) {
			map[i - 1] = from + j - 1;
			i--;
			j--;
		} else if (distance[row + j] === distance[previous + j] + 1) {
			// A quote character with no source character of its own: it belongs at the current position.
			map[i - 1] = from + j;
			i--;
		} else {
			j--;
		}
	}

	return { distance: distance[m * (n + 1) + best], start: from + j, end: from + best, map };
}

/** Where the quote sits in the source, or null when no stretch of it matches closely enough. */
function locate(quote: string, source: string): Alignment | null {
	const foldedQuote = fold(quote);
	const foldedSource = fold(source);
	if (foldedQuote === null || foldedSource === null) return null;
	const budget = Math.max(MIN_ERROR_BUDGET, Math.floor(foldedQuote.length * MAX_ERROR_RATIO));

	// Windows are collected from every anchor before any is aligned, so a common anchor cannot spend
	// the whole budget on its own occurrences while a rarer one goes untried.
	const windows: number[] = [];
	for (const word of anchors(foldedQuote)) {
		const offsetInQuote = foldedQuote.indexOf(word);
		let at = foldedSource.indexOf(word);
		while (at >= 0 && windows.length < MAX_WINDOWS) {
			const from = Math.max(0, at - offsetInQuote - WINDOW_SLACK);
			// Two anchors in one sentence describe the same window; aligning it twice buys nothing.
			if (!windows.some((existing) => Math.abs(existing - from) < WINDOW_SLACK)) windows.push(from);
			at = foldedSource.indexOf(word, at + 1);
		}
		if (windows.length >= MAX_WINDOWS) break;
	}

	let best: Alignment | null = null;
	for (const from of windows) {
		const alignment = alignInWindow(foldedQuote, foldedSource, from, Math.min(foldedSource.length, from + foldedQuote.length + 2 * WINDOW_SLACK));
		if (!best || alignment.distance < best.distance) best = alignment;
		if (best.distance === 0) break;
	}

	return best && best.distance <= budget ? best : null;
}

/**
 * The book's own wording for a quote the device recorded, with the highlighted runs carried over to
 * the corrected text -- or null when the quote cannot be located, when the caller keeps what it has.
 *
 * `marked` moves with the sentence deliberately: a corrected sentence whose `==...==` still addressed
 * the old spelling would mark the wrong words, which is worse than the wrong letter it set out to fix.
 */
export function correctQuote(sentence: string, marked: string[], source: string): { sentence: string; marked: string[] } | null {
	if (sentence.trim().length === 0) return null;
	const alignment = locate(sentence, source);
	if (!alignment) return null;

	const corrected = source.slice(alignment.start, alignment.end);
	if (corrected.length === 0) return null;

	const runs: string[] = [];
	for (const run of marked) {
		const at = sentence.indexOf(run);
		// A run that is not in the sentence cannot be placed in the corrected one either. Correcting
		// the sentence but not the run would drop a highlight's markers, so nothing is corrected.
		if (at < 0 || run.length === 0) return null;
		const from = alignment.map[at] - alignment.start;
		const to = alignment.map[at + run.length] - alignment.start;
		if (!(from >= 0 && to > from && to <= corrected.length)) return null;
		runs.push(corrected.slice(from, to));
	}

	return { sentence: corrected, marked: runs };
}
