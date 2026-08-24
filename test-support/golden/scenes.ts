// The five synthetic scenes the render goldens need (ticket 12): each exists because a shipped
// `.rm` fixture cannot express the case -- no device page on hand has a single-point tap, a typed
// heading, ink near the raster clamp, or a malformed scene-tree tail. Without these five the
// golden format catches three of 02c's seven sabotages instead of six; the six-of-seven figure
// rests on them.
//
// A scene is described as what it is in this codebase: an `RmPage` -- ten test files already build
// them directly (tier 1 of the fixture policy). The two corrupt-node cases are the exception: the
// sabotage they exist for lives in the *parser*, so they are hand-built v6 bytes run through the
// real `parseRmV6` at load, exactly like the rm-parser tests build theirs. A generator is never
// the source of an expectation -- the goldens record what the real render pipeline produces.
//
// What these scenes deliberately CANNOT express, per the fixture policy's blind-spot rule: real
// device stroke timestamps (every hand-built stroke says "0001"; only a page written in two
// sittings produces distinct ones), real highlight `start`/`length` (the device fixtures carry
// those), and the annotated-PDF path (`renderAnnotatedPdf`), which needs a source PDF and has no
// golden yet.

import { parseRmV6, type RmPage, type RmStroke } from "../../src/rm-parser";

function point(x: number, y: number, width = 8) {
	return { x, y, speed: 0, width, direction: 0, pressure: 128 };
}

function stroke(id: string, penType: number, color: number, points: RmStroke["points"], extra: Partial<RmStroke> = {}): RmStroke {
	return { layerId: "0001", id, timestamp: "0001", penType, color, brushSize: 2, points, ...extra };
}

/** Sabotage 2's case: a single-point stroke renders as a filled disc, and a highlighter shows its blend. */
function tapAndHighlight(): RmPage {
	return {
		formatVersion: 6,
		layers: [
			{
				id: "0001",
				name: "Layer 1",
				visible: true,
				strokes: [
					// The tap: one point, which `drawStroke` turns into a filled circle (`m1c12`).
					stroke("0a01", 17, 0, [point(-100, 300)]),
					// A short line beside it, so the page also has an ordinary stroked path.
					stroke("0a02", 17, 0, [point(-60, 300), point(20, 304), point(90, 310)]),
					// A highlighter band over the line: multiply blend and the HIGHLIGHT palette color.
					stroke("0a03", 18, 5, [point(-70, 296, 24), point(100, 296, 24)]),
				],
			},
		],
	};
}

/** Sabotage 7's case: a typed heading paragraph, whose text-layer line box carries the heading size. */
function typedHeading(): RmPage {
	return {
		formatVersion: 6,
		layers: [{ id: "0001", name: "Layer 1", visible: true, strokes: [] }],
		text: {
			posX: -468,
			posY: 234,
			width: 936,
			// One run: a heading line, then two plain body lines. Character ids run from 1:20, so the
			// newline closing the heading is 1:20 + 14 = 1:34, and the style of the paragraph after it
			// is keyed by that newline's id, exactly as the device writes its style map.
			runs: [{ id: "1:20", text: "Station log 62\nThe first winter was quiet.\nThe second was not.", deleted: 0 }],
			styles: new Map([
				["0:0", 3], // the first paragraph is a heading
				["1:34", 1], // the paragraph after the heading's newline is plain
			]),
		},
	};
}

/** Sabotage 5's case: ink spanning past the 6000 px raster clamp, so `MAX_RASTER_PX` is load-bearing. */
function runawayInk(): RmPage {
	return {
		formatVersion: 6,
		layers: [
			{
				id: "0001",
				name: "Layer 1",
				visible: true,
				strokes: [
					stroke("0b01", 17, 0, [point(-3600, 0), point(3600, 60)]),
					stroke("0b02", 17, 0, [point(-3600, 4000), point(3600, 4060)]),
				],
			},
		],
	};
}

// --- the two parser cases, as hand-built v6 bytes -----------------------------------------------

const FILE_HEADER = new TextEncoder().encode("reMarkable .lines file, version=6          ");

function u32le(value: number): number[] {
	const view = new DataView(new ArrayBuffer(4));
	view.setUint32(0, value, true);
	return [...new Uint8Array(view.buffer)];
}

function block(blockType: number, body: number[]): Uint8Array {
	const data = new Uint8Array(8 + body.length);
	new DataView(data.buffer).setUint32(0, body.length, true);
	data.set([0, 1, 1, blockType], 4); // unknown_flag, min_version, current_version, block_type
	data.set(body, 8);
	return data;
}

function file(...blocks: Uint8Array[]): Uint8Array {
	const total = blocks.reduce((n, b) => n + b.length, FILE_HEADER.length);
	const data = new Uint8Array(total);
	data.set(FILE_HEADER, 0);
	let at = FILE_HEADER.length;
	for (const b of blocks) {
		data.set(b, at);
		at += b.length;
	}
	return data;
}

const LAYER_NAME = [...new TextEncoder().encode("Layer 1")];

/** A layer_def whose tail simply ends after the label: kept, fail-soft, no anchor and no visibility. */
function truncatedNodeBytes(): Uint8Array {
	const body = [
		0x1f, 1, 5, // node_id
		0x2c, ...u32le(4 + 3 + 4 + 1 + 1 + LAYER_NAME.length), // label subblock length
		0x1f, 1, 6, // label timestamp
		0x2c, ...u32le(1 + 1 + LAYER_NAME.length), // label string subblock
		LAYER_NAME.length, 1, ...LAYER_NAME, // varuint length, is-ascii flag, the name
	];
	// A layer_def block (type 1) makes the node a visible layer, so the golden records its name.
	return file(block(1, [0x1f, 1, 5]), block(2, body));
}

/**
 * A layer_def whose tail is malformed mid-field: a length-prefixed LWW subblock whose declared
 * length runs off the end of the block. This is the one input in the repo that actually reaches
 * `rm-parser.ts`'s fail-soft catch -- a tail that merely ends does not (ticket 12's correction to
 * 02c on sabotage 3). The node loses its tail, never its identity.
 */
function corruptNodeTailBytes(): Uint8Array {
	const body = [
		0x1f, 1, 5,
		// The label's length must be exact here -- the parser seeks to its end before reading the
		// tail, so a padded length (which the truncated case above tolerates) would swallow the
		// first bytes of the malformed subblock and the tail would never be read at all.
		0x2c, ...u32le(3 + 1 + 4 + 1 + 1 + LAYER_NAME.length),
		0x1f, 1, 6,
		0x2c, ...u32le(1 + 1 + LAYER_NAME.length),
		LAYER_NAME.length, 1, ...LAYER_NAME,
		// The malformed tail: an LWW subblock whose declared length fits, but whose value type (an
		// f64) demands eight bytes where one remains -- the read runs off the end of the file, which
		// is the one shape that reaches the parser's fail-soft catch. A tail that merely ends, or a
		// length that overruns, is walked away from cleanly and never throws (ticket 12's correction
		// to 02c on sabotage 3).
		0x3c, ...u32le(5),
		0x1f, 1, 7, 0x38, 0,
	];
	return file(block(1, [0x1f, 1, 5]), block(2, body));
}

export interface SyntheticScene {
	name: string;
	page: RmPage;
}

export function syntheticScenes(): SyntheticScene[] {
	return [
		{ name: "synthetic-tap-and-highlight", page: tapAndHighlight() },
		{ name: "synthetic-typed-heading", page: typedHeading() },
		{ name: "synthetic-runaway-ink", page: runawayInk() },
		// Parsed through the real parser at load, so a parser sabotage shows in these two goldens.
		{ name: "synthetic-truncated-node", page: parseRmV6(truncatedNodeBytes()) },
		{ name: "synthetic-corrupt-node-tail", page: parseRmV6(corruptNodeTailBytes()) },
	];
}
