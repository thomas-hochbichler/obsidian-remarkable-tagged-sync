// The text layer half of the nightly's Apple Vision part (searchable-pdf spec §7.4): the rule that
// turns the PDFKit check into the part's status. `vision-main.ts` runs the check on the runner; this
// file holds the rule, so it has unit tests.

import type { BackendRun } from "./ocr";

/** One layer as PDFKit checked it: its words, how many the layer placed, how many of those PDFKit finds, and how many on their box. */
interface LayerFound {
	words: number;
	placed: number;
	found: number;
	onBox: number;
}

export interface TextLayerCheck {
	/**
	 * Each page's ground truth on tonight's Vision boxes, standing in for a perfect transcript from any
	 * other backend. `placed / words` is the nightly's figure. A page Vision could not read tonight
	 * places none of its words; the CER already names that page, so the figure is not marked for it.
	 * Reported, not judged: like the Vision CER, it has no `.ocr-baseline.json` entry until the first
	 * nights have set one (ticket 22).
	 */
	groundTruth: LayerFound;
	/**
	 * Vision's own words, as with Vision as the backend. `ownBoxes` of them came with a box of their
	 * own; the rest share their line's box out by characters. Recorded because word boxes on macOS
	 * 13–26 are a fact still owed (spec §8), and the pinned runner is the first place to see it.
	 */
	vision: LayerFound & { ownBoxes: number };
}

/**
 * A placed word PDFKit -- what Preview searches with -- cannot find is a catastrophe, the same as a
 * CER catastrophe: the release gate reads it and blocks. Off its box is not: on close lines PDFKit
 * draws a hit two lines high (page 14), so `onBox` is a figure in the report, not a failure.
 */
export function judgeTextLayer(run: BackendRun, layer: TextLayerCheck): BackendRun {
	const { groundTruth, vision } = layer;
	if (groundTruth.found < groundTruth.placed) {
		return { ...run, status: "catastrophe", reason: `text layer: PDFKit found ${groundTruth.found} of ${groundTruth.placed} ground-truth words placed` };
	}
	if (vision.found < vision.placed) {
		return { ...run, status: "catastrophe", reason: `text layer: PDFKit found ${vision.found} of ${vision.placed} of Vision's own words` };
	}
	// The same object, so the caller can tell a check that failed from one that did not.
	return run;
}
