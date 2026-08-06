import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRmV6 } from "./rm-parser";

const FIXTURE_PATH = "./test-fixtures/rmv6/normal-a-stroke-2-layers.rm";

// Stroke x is measured from the page midline, y from the page top -- so real ink on a reMarkable
// 1/2 stays inside these bounds, and a misparsed point does not.
const RM_1_2_HALF_WIDTH_PX = 702;
const RM_1_2_HEIGHT_PX = 1872;
const COLOR_FIXTURE_PATH = "./test-fixtures/rmv6/color-and-tool-v3.14.4.rm";
const PDF_PAGE_FIXTURE_PATH = "./test-fixtures/rmv6/pdf-page-highlights-and-margin-notes.rm";

/** A little-endian uint32 as four bytes, for hand-building block bodies. */
function u32le(value: number): number[] {
	const view = new DataView(new ArrayBuffer(4));
	view.setUint32(0, value, true);
	return [...new Uint8Array(view.buffer)];
}

/** Wraps a block body in a block header and the `.rm` v6 file header, as the smallest file containing it. */
function fileWithBlock(blockType: number, body: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode("reMarkable .lines file, version=6          ");
	const block = new Uint8Array(8 + body.length);
	new DataView(block.buffer).setUint32(0, body.length, true);
	block.set([0, 1, 1, blockType], 4); // unknown_flag, min_version, current_version, block_type
	block.set(body, 8);

	const data = new Uint8Array(header.length + block.length);
	data.set(header, 0);
	data.set(block, header.length);
	return data;
}

/** Builds a `glyph_def` body -- one highlighted run of `text` covered by a single rectangle. */
function glyphBody(text: string, rect: { x: number; y: number; width: number; height: number }): Uint8Array {
	const bytes: number[] = [];
	const u32 = (value: number) => {
		const buffer = new DataView(new ArrayBuffer(4));
		buffer.setUint32(0, value, true);
		bytes.push(...new Uint8Array(buffer.buffer));
	};
	const f64 = (value: number) => {
		const buffer = new DataView(new ArrayBuffer(8));
		buffer.setFloat64(0, value, true);
		bytes.push(...new Uint8Array(buffer.buffer));
	};

	bytes.push(0x1f, 0, 0, 0x2f, 0, 0, 0x3f, 0, 0, 0x4f, 0, 0); // parent/item/left/right ids
	bytes.push(0x54);
	u32(0); // deleted_length
	bytes.push(0x6c);
	u32(0); // value subblock length -- unread, the parser reads the fields directly
	bytes.push(1); // glyph item type
	bytes.push(0x24);
	u32(0); // start
	bytes.push(0x34);
	u32(text.length);
	bytes.push(0x44);
	u32(9); // PenColor.HIGHLIGHT, the shared placeholder
	const encoded = new TextEncoder().encode(text);
	const varuint = (value: number) => {
		const out: number[] = [];
		do {
			const byte = value & 0x7f;
			value >>>= 7;
			out.push(value > 0 ? byte | 0x80 : byte);
		} while (value > 0);
		return out;
	};
	const strLen = varuint(encoded.length);
	bytes.push(0x5c);
	u32(strLen.length + 1 + encoded.length);
	bytes.push(...strLen, 1, ...encoded); // varuint length, is-ascii flag, then the text
	bytes.push(0x6c);
	u32(1 + 32);
	bytes.push(1); // one rectangle
	f64(rect.x);
	f64(rect.y);
	f64(rect.width);
	f64(rect.height);
	bytes.push(0xa4, 0x01, 0xff, 0x9e, 0xf2, 0xff); // color_rgba: leading 0x01, then BGRA
	return new Uint8Array(bytes);
}

describe("parseRmV6", () => {
	it("parses a real v6 page fixture into a scene model", () => {
		const data = readFileSync(FIXTURE_PATH);

		const page = parseRmV6(new Uint8Array(data));

		expect(page.formatVersion).toBe(6);
		expect(page.layers.map((layer) => layer.name)).toEqual(["Layer 1", "Layer 2", "", ""]);
		expect(page.layers.flatMap((layer) => layer.strokes)).toHaveLength(2);

		const stroke = page.layers.flatMap((layer) => layer.strokes)[0];
		expect(stroke.penType).toBe(17);
		expect(stroke.color).toBe(0);
		expect(stroke.brushSize).toBeCloseTo(2);
		// This fixture's line_def blocks are version 1, whose points are six f32s (24 bytes) rather
		// than version 2's packed 14. Read as 14, it decoded one point's bytes as parts of the next
		// and yielded 12 points with coordinates like 1.5e38 -- which `expect.any(Number)` happily
		// accepted. Assert the values, not just their type.
		expect(stroke.points).toHaveLength(7);
		for (const point of stroke.points) {
			// Every point of this stroke sits within a few px of the same spot on a 1404px-wide page.
			expect(Math.abs(point.x)).toBeLessThan(RM_1_2_HALF_WIDTH_PX);
			expect(Math.abs(point.y)).toBeLessThan(RM_1_2_HEIGHT_PX);
			// v1 records width in px; the parser scales it to v2's quarter-px so consumers see one unit.
			expect(point.width).toBe(16);
			expect(point.pressure).toBeGreaterThanOrEqual(0);
			expect(point.pressure).toBeLessThanOrEqual(255);
		}
	});

	it("reads a scene-tree node's visibility and its placement out of the layer_names tail", () => {
		// The fixture's two unnamed group nodes are both anchored to the page's single typed
		// character. anchor_type and anchor_threshold are device constants and deliberately not carried.
		const page = parseRmV6(new Uint8Array(readFileSync(FIXTURE_PATH)));

		expect(page.layers.map((layer) => layer.visible)).toEqual([true, true, true, true]);
		expect(page.layers.map((layer) => layer.anchor)).toEqual([
			undefined,
			undefined,
			{ anchorId: "1:14", originX: -464 },
			{ anchorId: "1:14", originX: -464 },
		]);
	});

	it("reads the page's typed text, its box and its runs", () => {
		const page = parseRmV6(new Uint8Array(readFileSync(FIXTURE_PATH)));

		expect(page.text).toEqual({
			posX: -468,
			posY: 234,
			width: 936,
			runs: [{ id: "1:14", text: "A", deleted: 0 }],
			styles: new Map(),
		});
	});

	it("leaves text absent on a page that has none, rather than inventing an empty box", () => {
		const page = parseRmV6(new Uint8Array(readFileSync(COLOR_FIXTURE_PATH)));

		expect(page.text).toBeUndefined();
		expect(page.layers.every((layer) => layer.anchor === undefined)).toBe(true);
	});

	it("keeps a node whose tail stops after the label, instead of losing it to a missing anchor", () => {
		// Fail-soft is binding: the tail after the label is optional and read best-effort, so a body
		// that simply ends there costs the node its placement and its visibility -- never its identity.
		const name = new TextEncoder().encode("Layer 1");
		const body = new Uint8Array([
			0x1f, 1, 5, // node_id
			0x2c, ...u32le(4 + 3 + 4 + 1 + 1 + name.length), // label subblock length
			0x1f, 1, 6, // label timestamp
			0x2c, ...u32le(1 + 1 + name.length), // label string subblock
			name.length, 1, ...name, // varuint length, is-ascii flag, the name
		]);

		// The block parses to completion rather than throwing, which is what the page's ink depends on.
		expect(() => parseRmV6(fileWithBlock(2, body))).not.toThrow();
		expect(parseRmV6(fileWithBlock(2, body)).formatVersion).toBe(6);
	});

	it("accepts an ArrayBuffer as well as a Uint8Array", () => {
		const data = readFileSync(FIXTURE_PATH);
		const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

		const page = parseRmV6(arrayBuffer);

		expect(page.formatVersion).toBe(6);
	});

	it("skips a malformed stroke block instead of failing the whole page", () => {
		const header = new TextEncoder().encode("reMarkable .lines file, version=6          ");
		const badBody = new Uint8Array(4); // far too short to be a real line_def body
		const block = new Uint8Array(8 + badBody.length);
		new DataView(block.buffer).setUint32(0, badBody.length, true);
		block[4] = 0; // unknown_flag
		block[5] = 1; // min_version
		block[6] = 1; // current_version
		block[7] = 5; // block_type: line_def
		block.set(badBody, 8);

		const data = new Uint8Array(header.length + block.length);
		data.set(header, 0);
		data.set(block, header.length);

		const page = parseRmV6(data);

		expect(page.formatVersion).toBe(6);
		expect(page.layers).toEqual([]);
	});

	it("does not fail the page on a layer_info block whose ids are longer than one varuint byte", () => {
		// Shape observed in real files with high CrdtIds (issue: page skipped with
		// ValidationNotEqualError expected [84] got [0]): ids are variable-length
		// varuints, which the former fixed-width rm_layer_info type misread.
		const body = new Uint8Array([
			0x1f, 0x00, 0xb4, 0x01, // parent id with a two-byte varuint
			0x2f, 0x00, 0xb5, 0x01, // item id, also two varuint bytes
			0x3f, 0x00, 0x00, // left id
			0x4f, 0x00, 0x00, // right id
			0x54, 0x00, 0x00, 0x00, 0x00, // deleted_length = 0
			0x6c, 0x04, 0x00, 0x00, 0x00, 0x02, 0x2f, 0x00, 0x0c, // value subblock: child node id
		]);

		const page = parseRmV6(fileWithBlock(4, body));

		expect(page.formatVersion).toBe(6);
		expect(page.layers).toEqual([]);
	});

	it("reads a layer name whose LWW timestamp id is longer than two bytes", () => {
		// Shape observed in real files (issue: page skipped with ValidationNotEqualError
		// expected [44] got [1]): the label's timestamp CrdtId is varuint-encoded, which
		// the former fixed-width rm_layer_name type read as exactly two bytes.
		const name = new TextEncoder().encode("Layer 1");
		const bytes: number[] = [];
		const u32 = (value: number) => {
			const buffer = new DataView(new ArrayBuffer(4));
			buffer.setUint32(0, value, true);
			bytes.push(...new Uint8Array(buffer.buffer));
		};
		bytes.push(0x1f, 0x00, 0x0b); // node id
		bytes.push(0x2c); // label LWW-string subblock
		u32(3 + 1 + 4 + 1 + 1 + 1 + name.length);
		bytes.push(0x1f, 0x01, 0x90, 0x01); // timestamp id with a two-byte varuint (three bytes total)
		bytes.push(0x2c); // string subblock
		u32(1 + 1 + name.length);
		bytes.push(name.length, 0x01, ...name); // varuint length, is-ascii flag, then the name
		bytes.push(0x3c, 0x07, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x0c, 0x21, 0x01); // visible LWW bool

		const layerDef = new Uint8Array([0x1f, 0x00, 0x0b, 0x2f, 0x00, 0x00, 0x4c, 0x01, 0x00, 0x00, 0x00, 0x1f]);
		const nameBlock = fileWithBlock(2, new Uint8Array(bytes));
		const defBlock = fileWithBlock(1, layerDef).slice(43); // strip the file header, keep the block
		const data = new Uint8Array(nameBlock.length + defBlock.length);
		data.set(nameBlock, 0);
		data.set(defBlock, nameBlock.length);

		const page = parseRmV6(data);

		expect(page.layers).toEqual([{ id: "000b", name: "Layer 1", strokes: [] }]);
	});

	it("reads a layer_def whose ids contain bytes the old terminator scan tripped on", () => {
		// The former fixed-layout rm_layer_definition read up to the next 0x2f/0x4c byte as
		// terminators, so a CrdtId containing 0x4c (or 0x2f) truncated the scan and threw
		// on the misaligned bytes that followed, aborting the whole page parse.
		const body = new Uint8Array([
			0x1f, 0x00, 0x0b, // tree id
			0x2f, 0x00, 0x4c, // node id whose second byte is the old unknown_00 terminator
			0x31, 0x01, // is_update
			0x4c, 0x03, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x01, // parent-id subblock
		]);

		const page = parseRmV6(fileWithBlock(1, body));

		expect(page.layers).toEqual([{ id: "000b", name: null, strokes: [] }]);
	});

	it("reads the true color of a SHADER/HIGHLIGHT stroke from its optional color_rgba field", () => {
		const data = readFileSync(COLOR_FIXTURE_PATH);

		const page = parseRmV6(new Uint8Array(data));

		const strokes = page.layers.flatMap((layer) => layer.strokes);
		const shaderStroke = strokes.find((stroke) => stroke.penType === 23);
		expect(shaderStroke?.color).toBe(9); // PenColor.HIGHLIGHT -- a shared placeholder
		// Raw field is `84 01 1c 1e 21 40`: the tag, a leading 0x01, then BGRA. Reading the four
		// bytes straight after the tag (as rmscene does) would yield {30, 28, 1} -- every channel
		// shifted one byte, and blue picking up the leading 0x01 that every device file carries.
		expect(shaderStroke?.colorRgba).toEqual({ r: 33, g: 30, b: 28 });
	});

	it("reads a text highlight's rectangles and true color from a glyph_def block", () => {
		// Byte layout taken from a real device file: a `glyph_def` body is the same CRDT
		// tagged-value stream as a stroke's, ending in the run's text, its rectangles, and the
		// same leading-0x01 color_rgba quirk (at index 10 here rather than a stroke's index 8).
		const page = parseRmV6(fileWithBlock(3, glyphBody("past.", { x: -728, y: 810, width: 276, height: 42 })));

		expect(page.highlights).toEqual([{ id: "0000", color: 9, text: "past.", colorRgba: { r: 242, g: 158, b: 255 }, rects: [{ x: -728, y: 810, width: 276, height: 42 }] }]);
	});

	it("decodes a highlighted run longer than a single varuint byte", () => {
		const longText = "word ".repeat(60).trim(); // 299 bytes -- its length needs a 2-byte varuint

		const page = parseRmV6(fileWithBlock(3, glyphBody(longText, { x: 0, y: 0, width: 1, height: 1 })));

		expect(page.highlights?.[0]?.text).toBe(longText);
	});

	it("skips a malformed glyph_def block instead of failing the whole page", () => {
		const truncated = glyphBody("past.", { x: 0, y: 0, width: 1, height: 1 }).slice(0, 20);

		const page = parseRmV6(fileWithBlock(3, truncated));

		expect(page.highlights).toEqual([]);
	});

	// The digest anchors every entry on the device's own CRDT ids, so a note keeps its block id
	// across re-syncs no matter how the transcription changes -- ids that repeat would collapse
	// two annotations into one entry.
	it("gives every stroke and every highlight of a real PDF page its own CRDT id", () => {
		const data = readFileSync(PDF_PAGE_FIXTURE_PATH);

		const page = parseRmV6(new Uint8Array(data));

		const strokeIds = page.layers.flatMap((layer) => layer.strokes).map((stroke) => stroke.id);
		const highlightIds = (page.highlights ?? []).map((highlight) => highlight.id);
		expect(strokeIds).toHaveLength(65);
		expect(highlightIds).toHaveLength(9);
		expect(strokeIds.every((id) => id.length > 0)).toBe(true);
		expect(highlightIds.every((id) => id.length > 0)).toBe(true);
		expect(new Set(strokeIds).size).toBe(strokeIds.length);
		expect(new Set(highlightIds).size).toBe(highlightIds.length);
	});

	it("reads a stroke's timestamp id, which margin-note clustering uses to tell writing phases apart", () => {
		const data = readFileSync(PDF_PAGE_FIXTURE_PATH);

		const page = parseRmV6(new Uint8Array(data));

		const strokes = page.layers.flatMap((layer) => layer.strokes);
		expect(strokes.every((stroke) => stroke.timestamp.length > 0)).toBe(true);
	});

	it("leaves colorRgba undefined for strokes that don't carry one, including the extended palette", () => {
		const data = readFileSync(COLOR_FIXTURE_PATH);

		const page = parseRmV6(new Uint8Array(data));

		const strokes = page.layers.flatMap((layer) => layer.strokes);
		const ballpointColors = new Set(strokes.filter((stroke) => stroke.penType === 15).map((stroke) => stroke.color));
		expect(ballpointColors).toEqual(new Set([10, 11])); // PenColor.GREEN_2, PenColor.CYAN
		expect(strokes.filter((stroke) => stroke.penType === 15).every((stroke) => stroke.colorRgba === undefined)).toBe(true);
	});
});
