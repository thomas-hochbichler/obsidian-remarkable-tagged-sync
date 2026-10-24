// The PDFKit check, on a Mac: lays a text layer over a render with `addTextLayer` and asks PDFKit,
// what Preview searches with, to find every placed word again. A word counts as found on its box when
// PDFKit's hit sits within half a line height of where the layer put it.
//
// Two callers: `npm run check:text-layer` by hand, and the nightly's Vision job (spec §7.4).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inkBounds } from "../../../src/page-rasterizer";
import { notebookCanvas, notebookPageFrame } from "../../../src/pdf-renderer";
import type { RmPage } from "../../../src/rm-parser";
import { addTextLayer, foldWord, type LayerLine, visionBoxToPdf, wordBoxes } from "../../../src/text-layer";

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

export interface PdfKitCheck {
	/** Words the layer holds, how many PDFKit finds, and how many of those on their box. */
	words: number;
	found: number;
	onBox: number;
	/** Each word not found or found off its box: page index, the word as written, the distance in points. */
	missed: { page: number; text: string; distance?: number }[];
	/** Each word folding changed: page index, Vision's spelling, the one written into the layer. */
	folded: { page: number; from: string; to: string }[];
}

const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

/** Prints a check's figures, then every word not found or found off its box, under its page id. */
export function printCheck(label: string, check: PdfKitCheck, pageId: (page: number) => string, where = ""): void {
	console.log(`text layer, ${label}: ${check.words} words placed, ${check.found} found by PDFKit, ${check.onBox} on their box${where}`);
	for (const { page, text, distance } of check.missed) {
		console.log(`  page ${pageId(page)}: "${text}" ${distance === undefined ? "not found" : `found ${distance.toFixed(1)} pt off`}`);
	}
}

/** Lays `reads` over `render`, writes the result to `layeredPath`, and checks every word with PDFKit. */
export async function checkWithPdfKit(render: Uint8Array, scenes: RmPage[], reads: LayerLine[][], layeredPath: string): Promise<PdfKitCheck> {
	const layered = await addTextLayer(render, scenes, reads);
	writeFileSync(layeredPath, layered);

	// What the layer wrote for a word, and so what a search has to ask for: the word, folded to WinAnsi.
	const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
	const encodable = new Set(font.getCharacterSet());
	const drawn = (text: string) => foldWord(text, encodable);

	const folded: PdfKitCheck["folded"] = [];
	reads.forEach((lines, page) => {
		for (const { text } of lines.flatMap((line) => line.words)) {
			if (drawn(text) !== text) folded.push({ page, from: text, to: drawn(text) });
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

	const scratch = join(tmpdir(), `text-layer-check-${process.pid}-${basename(layeredPath)}`);
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
	return {
		words: placed.length,
		found: placed.filter((word) => matched.has(word)).length,
		onBox: placed.length - missed.length,
		missed: missed.map((word) => ({ page: word.page, text: word.text, distance: matched.get(word) })),
		folded,
	};
}
