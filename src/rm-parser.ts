// Imported from the submodule path (not the "kaitai-struct" package root) to
// dodge a CJS/ESM interop mismatch in that package's own root type declarations.
import KaitaiStream from "kaitai-struct/KaitaiStream";
// Types live in the hand-written `rmv6-generated.d.ts` beside it; see kaitai/PROVENANCE.md.
import { Rmv6 } from "./kaitai/rmv6-generated.js";
import { toArrayBuffer } from "./bytes";
import { layoutText, SENTINEL_ANCHOR_BOTTOM, SENTINEL_ANCHOR_TOP } from "./text-layout";

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

/**
 * A scene-tree node's placement. The node's strokes are stored in an unplaced frame and belong at
 * this offset: `originX` is stored outright, while the y is *not* -- `anchorId` names a character in
 * the page's typed text (`RmText`) and the y is that character's laid-out line position.
 *
 * Absent when the node carries no anchor group, which is every node of the 74 corpus pages that have
 * no typed text. The group is all-or-nothing: a node has all four fields or none.
 */
export interface RmAnchor {
	/** The character id the node hangs from, as `part1:part2` -- the key form `RmText.charIds` uses. */
	anchorId: string;
	/** The x translation, in the same frame and unit as stroke points. */
	originX: number;
}

export interface RmLayer {
	id: string;
	name: string | null;
	strokes: RmStroke[];
	/**
	 * The device's layer-panel eye toggle. Absent means the node carried no flag; nothing drops ink
	 * for it either way (a hidden layer still holds the user's writing, and the OCR path reads the
	 * same scene), it is reported instead.
	 */
	visible?: boolean;
	/** The node's placement, or absent when it carries no anchor group. */
	anchor?: RmAnchor;
	/**
	 * Whether this node's strokes were placed, and why not when they weren't. Absent for a node that
	 * carries no anchor at all, which is the overwhelming majority and is not a failure.
	 *
	 * Nobody is obliged to read it, but a consumer that wants to tell the user "this page's writing
	 * may appear overlapped" needs to know we knew -- the alternative is guessing from the geometry,
	 * which measures badly.
	 */
	placement?: "applied" | "no-text" | "unknown-anchor";
}

/** One run of the page's typed text: a stretch of characters sharing a starting CRDT id. */
export interface RmTextRun {
	/** The run's starting character id, as `part1:part2`. */
	id: string;
	text: string;
	/**
	 * Non-zero for a tombstoned run: the characters were typed and deleted, so their ids still
	 * occupy the id space but the run occupies no line when the text is laid out.
	 */
	deleted: number;
}

/**
 * A notebook page's typed text (the `root_text` block). Distinct from `RmHighlight`, which is text
 * highlighted in an annotated PDF: this is text the user typed on the device, and it both places
 * anchored handwriting (`RmAnchor`) and is drawn in its own right.
 */
export interface RmText {
	/** The text box's top-left corner, in the same frame as stroke points. */
	posX: number;
	posY: number;
	/** The text box's width, which is what line breaking wraps against. */
	width: number;
	runs: RmTextRun[];
	/** Every character id the text occupies -> the paragraph-relative style code that applies at it. */
	styles: Map<string, number>;
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
	/** The text the user typed on the page, when it has any (72 of the 80 corpus pages have none). */
	text?: RmText;
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

/**
 * Reads a CRDT id as its two parts. `part1:part2` is the form the device's own anchor ids and text
 * character ids are compared in -- unlike `readCrdtIdHex`, which preserves the raw encoding and so
 * cannot be matched against an id written with a different varuint length.
 */
function readCrdtIdKey(stream: KaitaiStream): string {
	const part1 = stream.readU1();
	return `${part1}:${readVaruint(stream)}`;
}

/** A tag's field index and value type, the two halves of `(index << 4) | type`. */
function tagParts(tag: number): { index: number; type: number } {
	return { index: tag >> 4, type: tag & 0x0f };
}

const LWW_TYPE = 0x0c;

/**
 * Reads one LWW ("last writer wins") field: a length-prefixed subblock holding a timestamp CRDT id
 * and then the value. Returns null and rewinds if the next tag is not an LWW field or the subblock
 * would run past the body, which is how a caller walks an optional, open-ended tail.
 *
 * The value is returned by type rather than decoded to one shape, because the four fields this
 * parser wants out of a tail are a CRDT id, a u8 and two f32s.
 */
function readLww(stream: KaitaiStream): { index: number; valueType: number; id?: string; num?: number } | null {
	const start = stream.pos;
	if (stream.size - stream.pos < 5) return null;
	let tag: number;
	try {
		tag = readTag(stream);
	} catch {
		stream.seek(start);
		return null;
	}
	const { index, type } = tagParts(tag);
	if (type !== LWW_TYPE) {
		stream.seek(start);
		return null;
	}
	const length = stream.readU4le();
	if (length > stream.size - stream.pos) {
		stream.seek(start);
		return null;
	}
	const end = stream.pos + length;
	readTag(stream); // the value's own timestamp, which no consumer reads
	skipCrdtId(stream);
	const valueTag = readTag(stream);
	const valueType = tagParts(valueTag).type;
	const field: { index: number; valueType: number; id?: string; num?: number } = { index, valueType };
	if (valueType === 0x0f) field.id = readCrdtIdKey(stream);
	else if (valueType === 0x01) field.num = stream.readU1();
	else if (valueType === 0x04) field.num = stream.readF4le();
	else if (valueType === 0x08) field.num = stream.readF8le();
	stream.seek(end);
	return field;
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
 * id (raw CrdtId encoding as hex, matching ids read elsewhere), its name, its visibility
 * and its placement.
 *
 * The tail after the label is a run of LWW fields: `visible` at index 3, then -- on a node whose
 * strokes are anchored to typed text -- `anchor_id`, `anchor_type`, `anchor_threshold` and
 * `anchor_origin_x` at indices 7 to 10. `anchor_type` and `anchor_threshold` are device constants
 * (2 and ~35.75 on every node of every corpus page) that no renderer reads.
 *
 * Every field is optional and read best-effort: an unreadable tail costs the node its placement,
 * never the page its ink.
 */
function parseLayerNameBody(raw: Uint8Array): { id: string; name: string; visible?: boolean; anchor?: RmAnchor } {
	const stream = new KaitaiStream(toArrayBuffer(raw));

	expectTag(stream, 0x1f, "node_id");
	const id = readCrdtIdHex(stream, raw);
	expectTag(stream, 0x2c, "label subblock");
	// The label's own length, which the tail read below seeks to: the string inside may be shorter
	// than the subblock (a renamed layer keeps the longer allocation), so reading fields
	// sequentially would leave the cursor mid-field.
	const labelLength = stream.readU4le();
	const labelEnd = stream.pos + labelLength;
	expectTag(stream, 0x1f, "label timestamp");
	skipCrdtId(stream);
	expectTag(stream, 0x2c, "label string subblock");
	stream.readU4le(); // string subblock byte length; unused
	const strLen = readVaruint(stream);
	stream.readU1(); // is_ascii encoding flag; UTF-8 decodes regardless
	const name = new TextDecoder().decode(stream.readBytes(strLen));
	stream.seek(labelEnd);

	let visible: boolean | undefined;
	let anchorId: string | undefined;
	let originX: number | undefined;
	try {
		for (let field = readLww(stream); field !== null; field = readLww(stream)) {
			if (field.index === VISIBLE_INDEX && field.num !== undefined) visible = field.num !== 0;
			else if (field.index === ANCHOR_ID_INDEX) anchorId = field.id;
			else if (field.index === ANCHOR_ORIGIN_X_INDEX) originX = field.num;
		}
	} catch {
		// Best effort by design -- see the doc comment. Whatever was read before the failure stands.
	}

	const anchor = anchorId !== undefined && originX !== undefined ? { anchorId, originX } : undefined;
	return { id, name, visible, anchor };
}

const VISIBLE_INDEX = 3;
const ANCHOR_ID_INDEX = 7;
const ANCHOR_ORIGIN_X_INDEX = 10;

const TEXT_STYLE_INDEX = 2;
const TEXT_POSITION_INDEX = 3;
const TEXT_WIDTH_INDEX = 4;

/**
 * Hand-parses a `root_text` block body (rmscene's `RootTextBlock`) -- the text the user typed on the
 * page, as opposed to `glyph_def`'s highlights of a PDF's own text. The body is a list of runs, then
 * an open-ended tail of length-prefixed subblocks holding the per-paragraph style map (index 2) and
 * the text box's geometry (index 3, plus a tagged f32 width at index 4).
 *
 * Returns null rather than throwing on anything it cannot read: a page whose text is unreadable
 * renders its ink unplaced, which is wrong and visible, rather than not at all.
 */
function parseRootTextBody(raw: Uint8Array): RmText | null {
	const stream = new KaitaiStream(toArrayBuffer(raw));
	try {
		expectTag(stream, 0x1f, "text block id");
		skipCrdtId(stream);
		expectTag(stream, 0x2c, "text subblock");
		stream.readU4le();
		expectTag(stream, 0x1c, "items subblock");
		stream.readU4le();
		expectTag(stream, 0x1c, "items inner subblock");
		stream.readU4le();

		const runs: RmTextRun[] = [];
		const count = readVaruint(stream);
		for (let i = 0; i < count; i++) {
			expectTag(stream, 0x0c, "text run subblock");
			const runLength = stream.readU4le();
			const end = stream.pos + runLength;
			readTag(stream);
			const id = readCrdtIdKey(stream);
			readTag(stream); // left id
			skipCrdtId(stream);
			readTag(stream); // right id
			skipCrdtId(stream);
			readTag(stream);
			const deleted = stream.readU4le();
			// A live run carries its string in one more length-prefixed subblock; a tombstoned one
			// does not. Matched on the tag's *type*, not the whole tag: the index varies by run.
			let text = "";
			if (stream.pos < end) {
				const stringStart = stream.pos;
				if (tagParts(readTag(stream)).type === LWW_TYPE) {
					stream.readU4le();
					const length = readVaruint(stream);
					stream.readU1(); // is_ascii encoding flag; UTF-8 decodes regardless
					text = new TextDecoder().decode(stream.readBytes(length));
				} else {
					stream.seek(stringStart);
				}
			}
			runs.push({ id, text, deleted });
			stream.seek(end);
		}

		const styles = new Map<string, number>();
		let posX: number | undefined;
		let posY: number | undefined;
		let width: number | undefined;
		// The tail's subblocks are ordered but not all present; walk them rather than assuming offsets.
		while (stream.size - stream.pos >= 5) {
			const start = stream.pos;
			const tag = readTag(stream);
			const { index, type } = tagParts(tag);
			if (index === TEXT_POSITION_INDEX && type === LWW_TYPE) {
				stream.readU4le();
				posX = stream.readF8le();
				posY = stream.readF8le();
				if (tryTag(stream, (TEXT_WIDTH_INDEX << 4) | 0x04)) width = stream.readF4le();
				break;
			}
			if (type !== LWW_TYPE) {
				stream.seek(start);
				break;
			}
			const length = stream.readU4le();
			if (length > stream.size - stream.pos) {
				stream.seek(start);
				break;
			}
			const end = stream.pos + length;
			if (index === TEXT_STYLE_INDEX) readStyleMap(stream, end, styles);
			stream.seek(end);
		}

		if (posX === undefined || posY === undefined || width === undefined) return null;
		return { posX, posY, width, runs, styles };
	} catch {
		return null;
	}
}

/**
 * The per-paragraph style map: `count × { charId, timestamp, { u8 style, ... } }`. An entry names the
 * character a style takes effect at, so the codes are read as-is and interpreted by the layout.
 *
 * The value subblock is not always two bytes -- a heading's carries five more after the style code --
 * so an entry is skipped to the length the subblock declares. Reading only the code and walking on
 * desynchronised the rest of the map: on the corpus's one styled page the last two entries came back
 * as two nonsense ids, and the two paragraphs they styled silently lost their list marker.
 */
function readStyleMap(stream: KaitaiStream, end: number, styles: Map<string, number>): void {
	try {
		expectTag(stream, 0x1c, "style map subblock");
		stream.readU4le();
		const count = readVaruint(stream);
		for (let i = 0; i < count && stream.pos < end; i++) {
			const charId = readCrdtIdKey(stream);
			readTag(stream);
			skipCrdtId(stream);
			readTag(stream);
			const valueLength = stream.readU4le();
			const valueEnd = stream.pos + valueLength;
			readTag(stream);
			styles.set(charId, stream.readU1());
			stream.seek(valueEnd);
		}
	} catch {
		// An unreadable style map costs the page its styles, never its ink.
	}
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

/**
 * Moves each anchored node's strokes to where the device draws them, in place.
 *
 * A node's strokes are stored in an unplaced frame: `anchor_origin_x` is the x offset, and the y is
 * the laid-out line position of the character `anchor_id` names. Doing this here rather than in each
 * renderer is what makes `RmPage` mean one thing -- ink where the device put it -- for every
 * consumer, including the digest's margin-note clustering, which groups strokes *by geometry* and so
 * silently produces wrong groups on unplaced coordinates rather than merely drawing them wrong.
 *
 * Fail-soft throughout: a node whose anchor names a character the text does not contain, or a page
 * with anchors and no readable text, keeps its ink exactly where the file put it. That is wrong and
 * visible, which beats a page that renders nothing.
 */
function placeAnchoredStrokes(layers: RmLayer[], text: RmText | undefined): void {
	if (!layers.some((layer) => layer.anchor)) return;
	const layout = text ? layoutText(text) : null;

	for (const layer of layers) {
		const anchor = layer.anchor;
		if (!anchor) continue;
		if (!layout) {
			layer.placement = "no-text";
			continue;
		}
		// The two sentinels name no character by design -- they pin a node to the top of the text or
		// below its end. An id that names no character for any other reason is an anchor that outlived
		// the character it hung from; the device resolves that to the top too, so we do and say so.
		let y: number | undefined;
		if (anchor.anchorId === SENTINEL_ANCHOR_TOP) y = layout.topY;
		else if (anchor.anchorId === SENTINEL_ANCHOR_BOTTOM) y = layout.bottomY;
		else y = layout.yOfChar.get(anchor.anchorId);

		if (y === undefined) {
			layer.placement = "unknown-anchor";
			y = layout.topY;
		} else {
			layer.placement = "applied";
		}
		for (const stroke of layer.strokes)
			for (const point of stroke.points) {
				point.x += anchor.originX;
				point.y += y;
			}
	}
}

/** Parses a firmware-v6 `.rm` page binary into a scene model (layers + strokes). */
export function parseRmV6(data: Uint8Array | ArrayBuffer): RmPage {
	const doc = new Rmv6(new KaitaiStream(toArrayBuffer(data)));

	const layerOrder: string[] = [];
	const layerNames = new Map<string, string>();
	const layerVisible = new Map<string, boolean>();
	const layerAnchors = new Map<string, RmAnchor>();
	const strokesByLayer = new Map<string, RmStroke[]>();
	const highlights: RmHighlight[] = [];
	let paperSize: RmPaperSize | undefined;
	let text: RmText | undefined;

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
					const node = parseLayerNameBody(block.body.raw);
					layerNames.set(node.id, node.name);
					if (node.visible !== undefined) layerVisible.set(node.id, node.visible);
					if (node.anchor) layerAnchors.set(node.id, node.anchor);
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
			case Rmv6.BlockTypes.TEXT_DEF: {
				try {
					text = parseRootTextBody(block.body.raw) ?? undefined;
				} catch (error) {
					console.warn("Tagged Sync: failed to parse the page's typed text, skipping it", error);
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
		visible: layerVisible.get(id),
		anchor: layerAnchors.get(id),
	}));
	placeAnchoredStrokes(layers, text);

	return { formatVersion: doc.frontmatter.header.versionNumber, layers, highlights, paperSize, text };
}
