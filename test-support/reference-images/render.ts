// The reference images: the PNG each backend is actually given, produced from the committed scenes.
//
// Not a picture of the page -- the *input*. Ticket 15: with the image, the ground truth and the CER
// all published, a stranger can audit the measurement end to end instead of taking the numbers on
// trust. It also answers page 15 by sight: an 852 x 7469 strip explains in one look why a service
// that resizes to 294 x 2576 reads it worse than a model running on the reader's own machine.
//
// Same `rasterizePage` pipeline the backends use, with no options, so the committed image is
// pixel-for-pixel what was measured. Nothing here may diverge from that: the moment it does, the page
// shows a reader an input that was never sent to anything.
//
// The one deliberate difference is the PNG *encoding*. `src/png-encoder.ts` writes uncompressed
// ("stored") deflate blocks on purpose -- it hand-rolls the format rather than pulling a compression
// dependency into the plugin -- which costs 20 MB for these fifteen pages and would put that in every
// clone, and again in the history on every rasterizer change. A build script has `node:zlib`, so
// these are written with real deflate: **0.30 MB, the same pixels**. The test below decodes what is
// committed and compares the pixels, so the claim the images carry is checked rather than asserted.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { type RasterImage, rasterizePage } from "../../src/page-rasterizer";
import { parseRmV6 } from "../../src/rm-parser";

export const FIXTURES = join(process.cwd(), "test-fixtures", "ocr-reference");
export const IMAGES_DIR = join(FIXTURES, "images");

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
	crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const body = new Uint8Array(4 + data.length);
	body.set(Uint8Array.from(type, (c) => c.charCodeAt(0)));
	body.set(data, 4);
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(body, 4);
	view.setUint32(8 + data.length, crc32(body));
	return out;
}

/** Filter byte 0 in front of every row -- unfiltered, exactly as `encodeGrayscalePng` writes them. */
function scanlines(image: RasterImage): Uint8Array {
	const out = new Uint8Array(image.height * (image.width + 1));
	for (let y = 0; y < image.height; y++) {
		out.set(image.pixels.subarray(y * image.width, (y + 1) * image.width), y * (image.width + 1) + 1);
	}
	return out;
}

/** 8-bit grayscale, unfiltered, one deflate-compressed IDAT. */
export function encodePublicationPng(image: RasterImage): Uint8Array {
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, image.width);
	view.setUint32(4, image.height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // colour type: grayscale
	const parts = [Uint8Array.from(PNG_SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines(image), { level: 9 })), chunk("IEND", new Uint8Array(0))];
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * Reads one of these images back to the pixels it carries, so the test can check what is committed
 * rather than trust it. Deliberately narrow: it understands the file this module writes and nothing
 * else, which is the only file it is ever pointed at.
 */
export function decodePublicationPng(png: Uint8Array): RasterImage {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let width = 0;
	let height = 0;
	const idat: Uint8Array[] = [];
	for (let at = PNG_SIGNATURE.length; at < png.length; ) {
		const length = view.getUint32(at);
		const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
		const data = png.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(at + 8);
			height = view.getUint32(at + 12);
			if (data[8] !== 8 || data[9] !== 0) throw new Error("not the 8-bit grayscale PNG this module writes");
		}
		if (type === "IDAT") idat.push(data);
		at += 12 + length;
	}
	const rows = inflateSync(Buffer.concat(idat));
	const pixels = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const start = y * (width + 1);
		if (rows[start] !== 0) throw new Error(`row ${y} is filtered; this module writes unfiltered rows only`);
		pixels.set(rows.subarray(start + 1, start + 1 + width), y * width);
	}
	return { width, height, pixels };
}

export interface ReferenceImage {
	/** `05-table`: the page id and its trait, so a filename says what it shows. */
	name: string;
	id: string;
	/** What the backends were given. The PNG below is only an encoding of it. */
	raster: RasterImage;
	png: Uint8Array;
}

/** `13-corrections-de.md` -> `corrections`; the same rule the published series names its traits by. */
function traitOf(pageFile: string): string {
	const match = /^\d+-(.+?)(?:-(?:de|en))?\.md$/.exec(pageFile);
	if (!match) throw new Error(`cannot read a trait out of ${pageFile}`);
	return match[1];
}

/** Every reference page's image, in page order. */
export function referenceImages(): ReferenceImage[] {
	const traits = new Map(readdirSync(join(FIXTURES, "pages")).filter((n) => n.endsWith(".md")).sort().map((n) => [n.slice(0, 2), traitOf(n)]));
	return readdirSync(join(FIXTURES, "scenes"))
		.filter((name) => name.endsWith(".rm"))
		.sort()
		.map((file) => {
			const id = file.slice(0, 2);
			const trait = traits.get(id);
			if (trait === undefined) throw new Error(`scene ${file} has no reference page`);
			const raster = rasterizePage(parseRmV6(readFileSync(join(FIXTURES, "scenes", file))));
			return { name: `${id}-${trait}`, id, raster, png: encodePublicationPng(raster) };
		});
}
