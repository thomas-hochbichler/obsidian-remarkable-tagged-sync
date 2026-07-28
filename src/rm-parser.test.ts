import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRmV6 } from "./rm-parser";

const FIXTURE_PATH = "./test-fixtures/rmv6/normal-a-stroke-2-layers.rm";
const COLOR_FIXTURE_PATH = "./test-fixtures/rmv6/color-and-tool-v3.14.4.rm";

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
		expect(stroke.points).toHaveLength(12);
		expect(stroke.points[0]).toEqual({
			x: expect.any(Number),
			y: expect.any(Number),
			speed: expect.any(Number),
			width: expect.any(Number),
			direction: expect.any(Number),
			pressure: expect.any(Number),
		});
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

		expect(page.highlights).toEqual([{ color: 9, text: "past.", colorRgba: { r: 242, g: 158, b: 255 }, rects: [{ x: -728, y: 810, width: 276, height: 42 }] }]);
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

	it("leaves colorRgba undefined for strokes that don't carry one, including the extended palette", () => {
		const data = readFileSync(COLOR_FIXTURE_PATH);

		const page = parseRmV6(new Uint8Array(data));

		const strokes = page.layers.flatMap((layer) => layer.strokes);
		const ballpointColors = new Set(strokes.filter((stroke) => stroke.penType === 15).map((stroke) => stroke.color));
		expect(ballpointColors).toEqual(new Set([10, 11])); // PenColor.GREEN_2, PenColor.CYAN
		expect(strokes.filter((stroke) => stroke.penType === 15).every((stroke) => stroke.colorRgba === undefined)).toBe(true);
	});
});
