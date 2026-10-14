/**
 * Which line in the note is which item in the base. The note carries no ids (they would confuse
 * users), so identity is recovered from text: exact match on normalised text first, then token-set
 * similarity >= 0.6, one to one, best score first, position breaking ties.
 *
 * The failure mode is benign on purpose: a heavy rewrite reads as "user deleted the item and added
 * a line". The deleted item becomes a tombstone, so the model cannot bring it back, and the user's
 * line is kept -- nothing is lost or duplicated.
 */

export const SIMILARITY_THRESHOLD = 0.6;

export function normaliseText(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Sørensen–Dice over the two texts' word sets. */
export function similarity(a: string, b: string): number {
	const setA = new Set(normaliseText(a).split(" ").filter(Boolean));
	const setB = new Set(normaliseText(b).split(" ").filter(Boolean));
	if (setA.size + setB.size === 0) return 0;
	let shared = 0;
	for (const token of setA) if (setB.has(token)) shared++;
	return (2 * shared) / (setA.size + setB.size);
}

export interface MatchResult {
	/** Per note line, the base id it is, or null for a line the user added. */
	lineToBase: (string | null)[];
	/** Base ids no line claimed: items the user deleted. */
	deleted: string[];
}

export function matchItems(lines: readonly { text: string }[], base: readonly { id: string; text: string }[]): MatchResult {
	const lineToBase: (string | null)[] = lines.map(() => null);
	const taken = new Set<number>();

	const normLines = lines.map((line) => normaliseText(line.text));
	const normBase = base.map((item) => normaliseText(item.text));
	normLines.forEach((norm, li) => {
		const bi = normBase.findIndex((candidate, index) => !taken.has(index) && candidate === norm);
		if (bi === -1) return;
		taken.add(bi);
		lineToBase[li] = base[bi].id;
	});

	const pairs: { li: number; bi: number; score: number; distance: number }[] = [];
	lines.forEach((line, li) => {
		if (lineToBase[li] !== null) return;
		base.forEach((item, bi) => {
			if (taken.has(bi)) return;
			const score = similarity(line.text, item.text);
			if (score >= SIMILARITY_THRESHOLD) pairs.push({ li, bi, score, distance: Math.abs(li - bi) });
		});
	});
	pairs.sort((x, y) => y.score - x.score || x.distance - y.distance);
	for (const { li, bi } of pairs) {
		if (lineToBase[li] !== null || taken.has(bi)) continue;
		taken.add(bi);
		lineToBase[li] = base[bi].id;
	}

	return { lineToBase, deleted: base.filter((_, bi) => !taken.has(bi)).map((item) => item.id) };
}
