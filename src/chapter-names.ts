// Naming a section the way the book itself names it.
//
// A reMarkable renders an EPUB to a PDF, and the digest reads its section headings back out of that
// render -- which is a guess twice over: the heading was recognised by how it is set on the page, and
// its letters went through the same lossy conversion as every quote (`quote-correction.ts`). *Alice*
// is the whole case in one line: the render says "CHAPTER I.", the book's navigation says
// "CHAPTER I. Down the Rabbit-Hole".
//
// A name only ever *renames* a heading the render already found. It never adds one: an article's own
// subheadings are finer than its navigation, which names the piece as a whole, and replacing them
// would cost the reader the very structure they annotated.

import { errorBudget, matchDistance } from "./quote-correction";

/**
 * The book's own name for a heading the device rendered, or null to keep the heading as it stands.
 *
 * Null is the answer whenever the match is not obvious: no chapter close enough, or two chapters
 * equally close under different names. "CHAPTER VI." damaged into "CHAPTER Vl." sits one edit from
 * both chapter VI and chapter VII, and a heading named after the wrong chapter is worse than a
 * heading that is merely short.
 */
export function chapterName(heading: string, chapters: string[]): string | null {
	if (heading.trim().length === 0) return null;

	let best: { name: string; distance: number } | null = null;
	let ambiguous = false;
	for (const chapter of chapters) {
		const distance = matchDistance(heading, chapter);
		if (distance === null) continue;
		if (best === null || distance < best.distance) {
			best = { name: chapter, distance };
			ambiguous = false;
		} else if (distance === best.distance && chapter !== best.name) {
			ambiguous = true;
		}
	}

	if (best === null || ambiguous) return null;
	// The budget is the heading's, not the chapter's: the heading is what has to be recognised, and a
	// chapter name may be much the longer of the two -- that is the point of looking it up.
	return best.distance <= errorBudget(heading.length) ? best.name : null;
}
