import { describe, expect, it } from "vitest";
import type { BackendRun } from "./ocr";
import { judgeTextLayer, type TextLayerCheck } from "./vision";

const PASSING: BackendRun = { status: "pass", pages: {}, medianCer: 0.157 };

// Ticket 16's figures on this Mac: every placed word found, a few off their box.
const ALL_FOUND: TextLayerCheck = {
	groundTruth: { words: 784, placed: 684, found: 684, onBox: 679 },
	vision: { words: 742, ownBoxes: 742, placed: 742, found: 742, onBox: 737 },
};

describe("the Vision part's text layer check (searchable-pdf spec §7.4)", () => {
	it("leaves the part as it was when PDFKit finds every placed word, off its box or not", () => {
		expect(judgeTextLayer(PASSING, ALL_FOUND)).toBe(PASSING);
	});

	it("turns the part into a catastrophe when PDFKit does not find a ground-truth word the layer placed", () => {
		const run = judgeTextLayer(PASSING, { ...ALL_FOUND, groundTruth: { ...ALL_FOUND.groundTruth, found: 683 } });
		expect(run.status).toBe("catastrophe");
		expect(run.reason).toBe("text layer: PDFKit found 683 of 684 ground-truth words placed");
	});

	it("turns the part into a catastrophe when PDFKit does not find one of Vision's own words", () => {
		const run = judgeTextLayer(PASSING, { ...ALL_FOUND, vision: { ...ALL_FOUND.vision, found: 741 } });
		expect(run.status).toBe("catastrophe");
		expect(run.reason).toBe("text layer: PDFKit found 741 of 742 of Vision's own words");
	});
});
