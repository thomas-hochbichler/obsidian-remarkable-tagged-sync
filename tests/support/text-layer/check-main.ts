// `npm run check:text-layer`, on a Mac.
//
// Reads the 15 public reference pages the way a sync does -- the shipped Vision driver over a
// `renderPagesToPdf` render -- lays the text layer over the render with `addTextLayer`, and asks
// PDFKit, what Preview searches with, to find every placed word again (`checkWithPdfKit`).
//
// Two layers, each checked on its own: Vision's own words, as with Vision as the backend (one reading
// for transcript and boxes), and each page's ground truth placed on Vision's boxes by `placeWords`,
// standing in for a perfect transcript from any other backend.
//
// Writes the layered PDFs to `.scratch/searchable-pdf/check/`, lists every word found off its box, and
// exits non-zero when PDFKit does not find a word at all. Only the public reference pages go through
// here. The nightly's Vision job runs the same check (`vision-main.ts`).

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Platform } from "obsidian";
import { placeWords } from "../../../src/layer-alignment";
import { renderPagesToPdf } from "../../../src/pdf-renderer";
import { parseRmV6, type RmPage } from "../../../src/rm-parser";
import type { LayerLine } from "../../../src/text-layer";
import { createVisionOcrBackend } from "../../../src/vision-ocr-runtime";
import { checkWithPdfKit, printCheck } from "./pdfkit-check";

Platform.isDesktop = true;
Platform.isMacOS = true;

const REFERENCE = join(process.cwd(), "test-fixtures", "ocr-reference");
const SCENES = join(REFERENCE, "scenes");
const OUT_DIR = join(process.cwd(), ".scratch", "searchable-pdf", "check");

async function main() {
	const files = readdirSync(SCENES).filter((name) => name.endsWith(".rm")).sort();
	const scenes = files.map((name) => parseRmV6(readFileSync(join(SCENES, name))));
	mkdirSync(OUT_DIR, { recursive: true });

	const render = await renderPagesToPdf(scenes);
	const result = await createVisionOcrBackend().recognize(scenes);
	if (result.pages === null) throw new Error(`Vision ${result.status} here: nothing to check`);
	const reads: LayerLine[][] = result.pages.map((page) => page.layer ?? []);

	// Page NN's ground truth is the body of `pages/NN-*.md`, after its frontmatter.
	const truths = readdirSync(join(REFERENCE, "pages")).sort();
	const placed = reads.map((lines, page) => {
		const truth = readFileSync(join(REFERENCE, "pages", truths[page]), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
		return placeWords(truth, lines);
	});

	const visionFound = await check("Vision's words", "reference.pdf", files, scenes, render, reads);
	const truthFound = await check("ground truth on Vision's boxes", "reference-ground-truth.pdf", files, scenes, render, placed);
	if (!visionFound || !truthFound) process.exit(1);
}

/** Lays `reads` over the render, writes it to `OUT_DIR/name`, and says whether PDFKit found every word. */
async function check(label: string, name: string, files: string[], scenes: RmPage[], render: Uint8Array, reads: LayerLine[][]): Promise<boolean> {
	const layeredPath = join(OUT_DIR, name);
	const result = await checkWithPdfKit(render, scenes, reads, layeredPath);
	const pageId = (page: number) => files[page].slice(0, 2);

	// What folding changed: Vision's own spelling beside the one written into the layer.
	for (const { page, from, to } of result.folded) console.log(`folded: page ${pageId(page)} "${from}" -> "${to}"`);
	printCheck(label, result, pageId, ` -> ${layeredPath}`);
	// Off its box is listed, not failed: on close lines PDFKit draws a hit two lines high (page 14),
	// which moves its centre without the word being anywhere else. A word not found at all is a fault.
	return result.found === result.words;
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
