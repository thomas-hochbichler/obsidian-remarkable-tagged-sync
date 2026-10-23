// `npm run check:text-layer`, on a Mac.
//
// Reads the 15 public reference pages the way a sync with Apple Vision as the backend does -- the
// shipped Vision driver over a `renderPagesToPdf` render, one reading for transcript and word boxes --
// lays the text layer over the render with `addTextLayer`, and asks PDFKit, what Preview searches with,
// to find every placed word again. A word counts as found on its box when PDFKit's hit sits within half
// a line height of where the layer put it.
//
// Writes the layered PDF to `.scratch/searchable-pdf/check/reference.pdf`, lists every word found off
// its box, and exits non-zero when PDFKit does not find a word at all. Only the public reference pages
// go through here.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform } from "obsidian";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inkBounds } from "../../src/page-rasterizer";
import { notebookCanvas, notebookPageFrame, renderPagesToPdf } from "../../src/pdf-renderer";
import { parseRmV6 } from "../../src/rm-parser";
import { addTextLayer, foldWord, type LayerLine, visionBoxToPdf, wordBoxes } from "../../src/text-layer";
import { createVisionOcrBackend } from "../../src/vision-ocr-runtime";

Platform.isDesktop = true;
Platform.isMacOS = true;

const SCENES = join(process.cwd(), "test-fixtures", "ocr-reference", "scenes");
const OUT_DIR = join(process.cwd(), ".scratch", "searchable-pdf", "check");

/** Every selection PDFKit finds for each query, with the page it is on and its bounds in PDF points. */
const PDFKIT_FIND_JXA = `
ObjC.import('Foundation');
ObjC.import('PDFKit');
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  var queries = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[1], 4, $())));
  var hits = {};
  for (var q = 0; q < queries.length; q++) {
    var sels = doc.findStringWithOptions($(queries[q]), 0);
    var found = [];
    for (var i = 0; i < sels.count; i++) {
      var sel = sels.objectAtIndex(i);
      var page = sel.pages.objectAtIndex(0);
      var b = sel.boundsForPage(page);
      found.push({ page: Number(doc.indexForPage(page)), x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height });
    }
    hits[queries[q]] = found;
  }
  return JSON.stringify(hits);
}
`;

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A word where the layer put it: its line's height, centred on its own box -- `addTextLayer`'s rule. */
interface Placed extends Box {
	page: number;
	text: string;
}

const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

async function main() {
	const files = readdirSync(SCENES).filter((name) => name.endsWith(".rm")).sort();
	const scenes = files.map((name) => parseRmV6(readFileSync(join(SCENES, name))));
	mkdirSync(OUT_DIR, { recursive: true });

	const render = await renderPagesToPdf(scenes);
	const result = await createVisionOcrBackend().recognize(scenes);
	if (result.pages === null) throw new Error(`Vision ${result.status} here: nothing to check`);
	const reads: LayerLine[][] = result.pages.map((page) => page.layer ?? []);
	const layered = await addTextLayer(render, scenes, reads);
	const layeredPath = join(OUT_DIR, "reference.pdf");
	writeFileSync(layeredPath, layered);

	// What the layer wrote for a word, and so what a search has to ask for: the word, folded to WinAnsi.
	const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
	const encodable = new Set(font.getCharacterSet());
	const drawn = (text: string) => foldWord(text, encodable);

	// What folding changed: Vision's own spelling beside the one written into the layer.
	reads.forEach((lines, page) => {
		for (const { text } of lines.flatMap((line) => line.words)) {
			if (drawn(text) !== text) console.log(`folded: page ${files[page].slice(0, 2)} "${text}" -> "${drawn(text)}"`);
		}
	});

	const device = notebookCanvas(scenes);
	const placed: Placed[] = [];
	reads.forEach((lines, page) => {
		const ink = inkBounds(scenes[page]);
		if (!ink) return;
		const frame = notebookPageFrame(scenes[page], device);
		for (const line of lines) {
			const lineRect = visionBoxToPdf(line.box, ink, frame);
			wordBoxes(line).forEach((box, i) => {
				const rect = visionBoxToPdf(box, ink, frame);
				placed.push({ page, text: drawn(line.words[i].text), x: rect.x, y: rect.y + rect.height / 2 - lineRect.height / 2, w: rect.width, h: lineRect.height });
			});
		}
	});

	const scratch = join(tmpdir(), `text-layer-check-${process.pid}`);
	mkdirSync(scratch, { recursive: true });
	writeFileSync(join(scratch, "queries.json"), JSON.stringify([...new Set(placed.map((word) => word.text))]));
	writeFileSync(join(scratch, "find.js"), PDFKIT_FIND_JXA);
	const hits = JSON.parse(
		execFileSync("/usr/bin/osascript", ["-l", "JavaScript", join(scratch, "find.js"), layeredPath, join(scratch, "queries.json")], { maxBuffer: 64 * 1024 * 1024 }).toString(),
	) as Record<string, (Box & { page: number })[]>;

	// One hit per word and one word per hit, nearest pairs first: "und" four times on a page, or "der"
	// inside "oder", must not let one hit count for several words.
	const matched = new Map<Placed, number>();
	const groups = new Map<string, Placed[]>();
	for (const word of placed) {
		const key = `${word.page}\u0000${word.text}`;
		groups.set(key, [...(groups.get(key) ?? []), word]);
	}
	for (const words of groups.values()) {
		const pageHits = (hits[words[0].text] ?? []).filter((hit) => hit.page === words[0].page);
		const pairs = words
			.flatMap((word) => pageHits.map((hit) => ({ word, hit, distance: Math.hypot(centre(hit).x - centre(word).x, centre(hit).y - centre(word).y) })))
			.sort((a, b) => a.distance - b.distance);
		const used = new Set<Box>();
		for (const { word, hit, distance } of pairs) {
			if (matched.has(word) || used.has(hit)) continue;
			matched.set(word, distance);
			used.add(hit);
		}
	}

	const missed = placed.filter((word) => !matched.has(word) || matched.get(word)! > word.h / 2);
	const found = placed.filter((word) => matched.has(word)).length;
	console.log(`text layer: ${placed.length} words placed, ${found} found by PDFKit, ${placed.length - missed.length} on their box -> ${layeredPath}`);
	for (const word of missed) {
		const page = files[word.page].slice(0, 2);
		const distance = matched.get(word);
		console.log(`  page ${page}: "${word.text}" ${distance === undefined ? "not found" : `found ${distance.toFixed(1)} pt off`}`);
	}
	// Off its box is listed, not failed: on close lines PDFKit draws a hit two lines high (page 14),
	// which moves its centre without the word being anywhere else. A word not found at all is a fault.
	if (found < placed.length) process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
