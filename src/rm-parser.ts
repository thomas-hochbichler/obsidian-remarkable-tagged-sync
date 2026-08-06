// Imported from the submodule path (not the "kaitai-struct" package root) to
// dodge a CJS/ESM interop mismatch in that package's own root type declarations.
import KaitaiStream from "kaitai-struct/KaitaiStream";
// Types live in the hand-written `rmv6-generated.d.ts` beside it; see kaitai/PROVENANCE.md.
import { Rmv6 } from "./kaitai/rmv6-generated.js";
import { toArrayBuffer } from "./bytes";

export interface RmPoint {
	x: number;
	y: number;
	speed: number;
	width: number;
	direction: number;
	pressure: number;
}

export interface RmStroke {
	layerId: string;
	/** The stroke's own CRDT id (`item_id`), same hex encoding as `layerId` -- the device's stable identity for it. */
	id: string;
	/** The stroke's CRDT timestamp id, an ordinal (not a clock): strokes written in one phase share or neighbour it. */
	timestamp: string;
	penType: number;
	color: number;
	brushSize: number;
	points: RmPoint[];
	/**
	 * True color for a highlighter/shader stroke (colorId `HIGHLIGHT` is a shared
	 * placeholder -- see the tag-0x84 read below). Absent for every other tool.
	 */
	colorRgba?: { r: number; g: number; b: number };
}

export interface RmLayer {
	id: string;
	name: string | null;
	strokes: RmStroke[];
}

/** The pixel size of the device screen a scene was drawn on -- see `parseSceneInfoBody`. */
export interface RmPaperSize {
	width: number;
	height: number;
}

/** One rectangle of a text highlight, in the same frame as stroke points (x from the midline, y from the top, device pixels). */
export interface RmRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A run of highlighted document text (a `glyph_def` block). Highlighting selected text in
 * the reader records the run's rectangles here rather than as marker strokes, so a scene's
 * `strokes` alone miss every text highlight on the page.
 */
export interface RmHighlight {
	/** The run's own CRDT id (`item_id`), same hex encoding as `RmStroke.id`. */
	id: string;
	color: number;
	/** The document text the run covers, decoded from the `0x5c` subblock. May be empty (a highlight with no captured text). */
	text: string;
	/** True color, on the same `HIGHLIGHT`-placeholder terms as `RmStroke.colorRgba`. */
	colorRgba?: { r: number; g: number; b: number };
	rects: RmRect[];
}

export interface RmPage {
	formatVersion: number;
	layers: RmLayer[];
	/** Text highlights on the page, absent on a scene built by hand (e.g. a blank page stand-in). */
	highlights?: RmHighlight[];
	/** The screen the page was drawn on, when the scene declares one (absent on pre-`scene_info` firmware). */
	paperSize?: RmPaperSize;
}

const LINE_ITEM_TYPE = 3;

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A field tag is `(index << 4) | type` encoded as a LEB128 varuint, not as a byte -- so every tag
 * from index 8 up takes two bytes. Only two of the tags this parser reads are that large
 * (`color_rgba`, index 8 on a stroke and 10 on a highlight); the rest fit in one byte and encode
 * identically either way. Reading them as bytes left the continuation byte in the stream, which
 * `readColorRgba` used to skip by hand and mistook for a device quirk.
 */
function readTag(stream: KaitaiStream): number {
	return readVaruint(stream);
}

function expectTag(stream: KaitaiStream, expected: number, what: string): void {
	const actual = readTag(stream);
	if (actual !== expected) {
		throw new Error(`rm-parser: expected ${what} tag 0x${expected.toString(16)}, got 0x${actual.toString(16)}`);
	}
}

/** Reads a LEB128 varuint (7 payload bits per byte, high bit = continuation). */
function readVaruint(stream: KaitaiStream): number {
	let result = 0;
	let shift = 0;
	let byte: number;
	do {
		byte = stream.readU1();
		result |= (byte & 0x7f) << shift;
		shift += 7;
	} while (byte & 0x80);
	return result >>> 0;
}

/** Advances past a CRDT id (1-byte part1 + varuint part2) without decoding it. */
function skipCrdtId(stream: KaitaiStream): void {
	stream.readU1(); // part1
	while (stream.readU1() & 0x80) {
		// consume varuint continuation bytes (part2)
	}
}

/** Reads a CRDT id and returns its raw encoding as hex, for identity comparisons against layer ids read elsewhere in the spec. */
function readCrdtIdHex(stream: KaitaiStream, raw: Uint8Array): string {
	const start = stream.pos;
	skipCrdtId(stream);
	return hex(raw.subarray(start, stream.pos));
}

/** Consumes the next tag and returns true if it matches `expected`; otherwise leaves the stream position unchanged. */
function tryTag(stream: KaitaiStream, expected: number): boolean {
	if (stream.pos >= stream.size) return false;
	const start = stream.pos;
	try {
		if (readTag(stream) === expected) return true;
	} catch {
		// A truncated varuint at the end of a body is simply not the tag we were looking for.
	}
	stream.seek(start);
	return false;
}

/**
 * Bytes per point, by the `line_def` block's own version. Version 1 stores all six fields as
 * f32 (24 bytes); version 2 packs them (14 bytes: two f32 coordinates, two u16, two u8). The
 * parser read every file as version 2, so a version-1 file decoded one point's bytes as parts
 * of the next -- yielding coordinates like 1.5e38 and widths in the thousands. It went unnoticed
 * because nothing read `width` for a pen and the renderers clamp absurd coordinates away
 * (`detectCanvas` bounds outliers, `scrolledCanvas` caps at 20 screens).
 */
const POINT_BYTES_V1 = 24;
const POINT_BYTES_V2 = 14;

/** v1 records speed/width as pixels and pressure as 0..1; v2's integer units are 4x, 4x and 255x those. */
function readPointV1(stream: KaitaiStream): RmPoint {
	const x = stream.readF4le();
	const y = stream.readF4le();
	const speed = stream.readF4le();
	const direction = stream.readF4le();
	const width = stream.readF4le();
	const pressure = stream.readF4le();
	return {
		x,
		y,
		speed: Math.round(speed * 4),
		width: Math.round(width * 4),
		direction: Math.round((255 * direction) / (2 * Math.PI)),
		pressure: Math.round(pressure * 255),
	};
}

function readPointV2(stream: KaitaiStream): RmPoint {
	return {
		x: stream.readF4le(),
		y: stream.readF4le(),
		speed: stream.readU2le(),
		width: stream.readU2le(),
		direction: stream.readU1(),
		pressure: stream.readU1(),
	};
}

/**
 * Hand-parses a `line_def` block body (a pen stroke), which the Kaitai spec
 * leaves as raw bytes -- see kaitai/rmv6.ksy's `rm_raw_body` doc and
 * kaitai/PROVENANCE.md for why. Returns null for tombstoned lines (deleted,
 * carrying no stroke data). `blockVersion` selects the point layout above.
 */
function parseStrokeBody(raw: Uint8Array, blockVersion: number): RmStroke | null {
	const stream = new KaitaiStream(toArrayBuffer(raw));

	expectTag(stream, 0x1f, "parent_id");
	const layerId = readCrdtIdHex(stream, raw);
	expectTag(stream, 0x2f, "item_id");
	const id = readCrdtIdHex(stream, raw);
	expectTag(stream, 0x3f, "left_id");
	skipCrdtId(stream);
	expectTag(stream, 0x4f, "right_id");
	skipCrdtId(stream);
	expectTag(stream, 0x54, "deleted_length");
	const deletedLength = stream.readU4le();
	if (deletedLength !== 0) return null;

	expectTag(stream, 0x6c, "value subblock");
	stream.readU4le(); // subblock byte length; unused, we read fields directly
	const itemType = stream.readU1();
	if (itemType !== LINE_ITEM_TYPE) return null;

	expectTag(stream, 0x14, "tool");
	const penType = stream.readU4le();
	expectTag(stream, 0x24, "color");
	const color = stream.readU4le();
	expectTag(stream, 0x38, "thickness_scale");
	const brushSize = stream.readF8le();
	expectTag(stream, 0x44, "starting_length");
	stream.readF4le();
	expectTag(stream, 0x5c, "points");
	const pointsLen = stream.readU4le();

	const pointBytes = blockVersion === 1 ? POINT_BYTES_V1 : POINT_BYTES_V2;
	const points: RmPoint[] = [];
	for (let i = 0; i < Math.floor(pointsLen / pointBytes); i++) {
		points.push(blockVersion === 1 ? readPointV1(stream) : readPointV2(stream));
	}

	// timestamp (tag 0x6f, a CRDT id) always follows the points; an optional move_id (0x7f)
	// may follow it, then an optional color_rgba (0x84) -- the real color for a highlighter/
	// shader stroke, since `color` above is just the shared HIGHLIGHT placeholder for those.
	expectTag(stream, 0x6f, "timestamp");
	const timestamp = readCrdtIdHex(stream, raw);
	if (tryTag(stream, 0x7f)) skipCrdtId(stream);
	return { layerId, id, timestamp, penType, color, brushSize, points, colorRgba: readColorRgba(stream, STROKE_COLOR_RGBA_TAG) };
}

/** The optional true-color field's tag, which differs by block: index 8 on a stroke, index 10 on a highlight. */
const STROKE_COLOR_RGBA_TAG = 0x84;
const HIGHLIGHT_COLOR_RGBA_TAG = 0xa4;

/** Reads the optional `color_rgba` field at the end of a stroke or highlight body, if present. */
function readColorRgba(stream: KaitaiStream, tag: number): RmStroke["colorRgba"] {
	// The tag is a varuint, so index 8 (`0x84 0x01`) and index 10 (`0xa4 0x01`) are two bytes and
	// `tryTag` consumes both. That second byte was previously read here as a device quirk -- a
	// "single 0x01 between the tag and the BGRA word" -- which happened to land on the right offset
	// while misnaming what it was. Reading only four bytes shifts every channel and drops red
	// entirely (yellow 255,237,117 reads as 237,117,1), which is the bug that comment was chasing.
	if (!tryTag(stream, tag)) return undefined;
	const packed = stream.readU4le(); // little-endian uint32, packed BGRA
	return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff };
}

/**
 * Hand-parses a `layer_def` block body (rmscene's `SceneTreeBlock`), which the Kaitai spec
 * leaves as raw bytes -- the former fixed-layout `rm_layer_definition` type scanned for
 * 0x2f/0x4c terminator bytes, which a CrdtId containing either byte truncated, throwing on
 * the misaligned bytes that followed and aborting the whole page parse. Returns the layer's
 * id (raw CrdtId encoding as hex, matching ids read elsewhere); the rest of the body
 * (node id, is_update, parent id) is ignored.
 */
function parseLayerDefBody(raw: Uint8Array): string {
	const stream = new KaitaiStream(toArrayBuffer(raw));

	expectTag(stream, 0x1f, "tree_id");
	return readCrdtIdHex(stream, raw);
}

/**
 * Hand-parses a `layer_names` block body (rmscene's `TreeNodeBlock`), which the Kaitai
 * spec leaves as raw bytes -- the former fixed-layout `rm_layer_name` type read the
 * label's LWW-timestamp CrdtId as exactly two bytes and threw (aborting the whole page
 * parse) on files whose timestamp needed more than one varuint byte. Returns the layer's
 * id (raw CrdtId encoding as hex, matching ids read elsewhere) and its name; the rest of
 * the body (visibility, anchor fields) is ignored.
 */
function parseLayerNameBody(raw: Uint8Array): { id: string; name: string } {
	const stream = new KaitaiStream(toArrayBuffer(raw));

	expectTag(stream, 0x1f, "node_id");
	const id = readCrdtIdHex(stream, raw);
	expectTag(stream, 0x2c, "label subblock");
	stream.readU4le(); // subblock byte length; unused, we read fields directly
	expectTag(stream, 0x1f, "label timestamp");
	skipCrdtId(stream);
	expectTag(stream, 0x2c, "label string subblock");
	stream.readU4le(); // string subblock byte length; unused
	const strLen = readVaruint(stream);
	stream.readU1(); // is_ascii encoding flag; UTF-8 decodes regardless
	const name = new TextDecoder().decode(stream.readBytes(strLen));

	return { id, name };
}

const GLYPH_ITEM_TYPE = 1;
/** A rectangle is four little-endian doubles: x, y, width, height. */
const RECT_BYTES = 32;

/**
 * Hand-parses a `glyph_def` block body -- a run of highlighted document text. Same tagged-value
 * shape as a stroke body, with the run's `start`/`length` skipped, its highlighted text decoded
 * from the `0x5c` subblock, and its rectangles read in the scene's own coordinate frame.
 * Returns null for tombstoned runs, and for anything whose rectangle block doesn't add up.
 */
function parseGlyphBody(raw: Uint8Array): RmHighlight | null {
	const stream = new KaitaiStream(toArrayBuffer(raw));

	expectTag(stream, 0x1f, "parent_id");
	skipCrdtId(stream);
	expectTag(stream, 0x2f, "item_id");
	const id = readCrdtIdHex(stream, raw);
	expectTag(stream, 0x3f, "left_id");
	skipCrdtId(stream);
	expectTag(stream, 0x4f, "right_id");
	skipCrdtId(stream);
	expectTag(stream, 0x54, "deleted_length");
	if (stream.readU4le() !== 0) return null;

	expectTag(stream, 0x6c, "value subblock");
	stream.readU4le(); // subblock byte length; unused, we read fields directly
	if (stream.readU1() !== GLYPH_ITEM_TYPE) return null;

	expectTag(stream, 0x24, "start");
	stream.readU4le();
	expectTag(stream, 0x34, "length");
	stream.readU4le();
	expectTag(stream, 0x44, "color");
	const color = stream.readU4le();
	expectTag(stream, 0x5c, "text");
	// The subblock is: u32 subLen, varuint strLen, u8 is_ascii, then strLen UTF-8 bytes. Decode the
	// text, then realign to subStart+subLen so the rectangle parse below is unaffected by how the
	// inner string was encoded (matching the old seek-past-the-whole-subblock behaviour).
	const subLen = stream.readU4le();
	const subStart = stream.pos;
	const strLen = readVaruint(stream);
	stream.readU1(); // is_ascii encoding flag; UTF-8 decodes regardless
	const text = new TextDecoder().decode(stream.readBytes(strLen));
	stream.seek(subStart + subLen);

	expectTag(stream, 0x6c, "rectangles");
	const rectsLength = stream.readU4le();
	const count = stream.readU1();
	if (rectsLength !== 1 + count * RECT_BYTES) return null;
	const rects: RmRect[] = [];
	for (let i = 0; i < count; i++) {
		rects.push({ x: stream.readF8le(), y: stream.readF8le(), width: stream.readF8le(), height: stream.readF8le() });
	}

	return { id, color, text, colorRgba: readColorRgba(stream, HIGHLIGHT_COLOR_RGBA_TAG), rects };
}

/** Index 5 of the `scene_info` block: the paper size, a length-prefixed subblock (tag = index<<4 | type, type 0xc = length-prefixed). */
const PAPER_SIZE_TAG = 0x5c;

/**
 * Reads the `scene_info` block's paper size -- the device screen in pixels (1404x1872 for a
 * reMarkable 1/2/Paper Pure, 1620x2160 for a Paper Pro). This is the file's only record of
 * which device drew the page, and so of that device's DPI, which the renderer needs to place
 * ink at the right scale (see `pdf-renderer`'s `declaredCanvas`).
 *
 * The body is a tagged-value stream like `line_def`'s, and every field before the paper size
 * is a length-prefixed subblock -- so walking them by length to tag 0x5c reads it without
 * decoding any of them. Anything that doesn't match that shape returns null rather than a
 * guess: the caller falls back to inferring the device from the strokes themselves.
 */
function parseSceneInfoBody(raw: Uint8Array): RmPaperSize | null {
	const stream = new KaitaiStream(toArrayBuffer(raw));
	// Every iteration needs a tag byte plus a 4-byte length.
	while (stream.size - stream.pos >= 5) {
		const tag = stream.readU1();
		if ((tag & 0x0f) !== 0x0c) return null;
		const length = stream.readU4le();
		if (tag === PAPER_SIZE_TAG) return length >= 8 ? { width: stream.readU4le(), height: stream.readU4le() } : null;
		if (length > stream.size - stream.pos) return null;
		stream.seek(stream.pos + length);
	}
	return null;
}

/** Parses a firmware-v6 `.rm` page binary into a scene model (layers + strokes). */
export function parseRmV6(data: Uint8Array | ArrayBuffer): RmPage {
	const doc = new Rmv6(new KaitaiStream(toArrayBuffer(data)));

	const layerOrder: string[] = [];
	const layerNames = new Map<string, string>();
	const strokesByLayer = new Map<string, RmStroke[]>();
	const highlights: RmHighlight[] = [];
	let paperSize: RmPaperSize | undefined;

	for (const block of doc.blocks) {
		switch (block.blockType) {
			case Rmv6.BlockTypes.LAYER_DEF: {
				try {
					layerOrder.push(parseLayerDefBody(block.body.raw));
				} catch (error) {
					console.warn("Tagged Sync: failed to parse a layer definition, skipping it", error);
				}
				break;
			}
			case Rmv6.BlockTypes.LAYER_NAMES: {
				try {
					const layerName = parseLayerNameBody(block.body.raw);
					layerNames.set(layerName.id, layerName.name);
				} catch (error) {
					console.warn("Tagged Sync: failed to parse a layer name, skipping it", error);
				}
				break;
			}
			case Rmv6.BlockTypes.LINE_DEF: {
				let stroke: RmStroke | null;
				try {
					stroke = parseStrokeBody(block.body.raw, block.currentVersion);
				} catch (error) {
					console.warn("Tagged Sync: failed to parse a stroke, skipping it", error);
					stroke = null;
				}
				if (stroke) {
					const strokes = strokesByLayer.get(stroke.layerId) ?? [];
					strokes.push(stroke);
					strokesByLayer.set(stroke.layerId, strokes);
				}
				break;
			}
			case Rmv6.BlockTypes.GLYPH_DEF: {
				try {
					const highlight = parseGlyphBody(block.body.raw);
					if (highlight) highlights.push(highlight);
				} catch (error) {
					console.warn("Tagged Sync: failed to parse a text highlight, skipping it", error);
				}
				break;
			}
			case Rmv6.BlockTypes.SCENE_INFO: {
				try {
					paperSize = parseSceneInfoBody(block.body.raw) ?? undefined;
				} catch (error) {
					console.warn("Tagged Sync: failed to read the scene's paper size", error);
				}
				break;
			}
			default:
				break;
		}
	}

	const layers: RmLayer[] = layerOrder.map((id) => ({
		id,
		name: layerNames.get(id) ?? null,
		strokes: strokesByLayer.get(id) ?? [],
	}));

	return { formatVersion: doc.frontmatter.header.versionNumber, layers, highlights, paperSize };
}
