import type { RasterImage } from "./page-rasterizer";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_STORED_BLOCK_SIZE = 65535;
const MOD_ADLER = 65521;

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
	if (crcTable) return crcTable;
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	crcTable = table;
	return table;
}

function crc32(bytes: Uint8Array): number {
	const table = getCrcTable();
	let crc = 0xffffffff;
	for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (const byte of bytes) {
		a = (a + byte) % MOD_ADLER;
		b = (b + a) % MOD_ADLER;
	}
	return ((b << 16) | a) >>> 0;
}

function writeU32BE(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = (value >>> 24) & 0xff;
	bytes[offset + 1] = (value >>> 16) & 0xff;
	bytes[offset + 2] = (value >>> 8) & 0xff;
	bytes[offset + 3] = value & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
	const typeAndData = new Uint8Array(typeBytes.length + data.length);
	typeAndData.set(typeBytes, 0);
	typeAndData.set(data, typeBytes.length);

	const result = new Uint8Array(4 + typeAndData.length + 4);
	writeU32BE(result, 0, data.length);
	result.set(typeAndData, 4);
	writeU32BE(result, 4 + typeAndData.length, crc32(typeAndData));
	return result;
}

/** Wraps raw scanline bytes in a zlib stream using uncompressed ("stored") deflate blocks -- valid per the DEFLATE spec and needs no compression library. */
function zlibStore(raw: Uint8Array): Uint8Array {
	const blocks: Uint8Array[] = [];
	let offset = 0;
	do {
		const len = Math.min(MAX_STORED_BLOCK_SIZE, raw.length - offset);
		const isLast = offset + len >= raw.length;
		const nlen = ~len & 0xffff;
		const block = new Uint8Array(5 + len);
		block[0] = isLast ? 1 : 0;
		block[1] = len & 0xff;
		block[2] = (len >>> 8) & 0xff;
		block[3] = nlen & 0xff;
		block[4] = (nlen >>> 8) & 0xff;
		block.set(raw.subarray(offset, offset + len), 5);
		blocks.push(block);
		offset += len;
	} while (offset < raw.length);

	const header = Uint8Array.from([0x78, 0x01]); // zlib CMF/FLG, deflate/32K window, fastest level
	const trailer = new Uint8Array(4);
	writeU32BE(trailer, 0, adler32(raw));

	const result = new Uint8Array(header.length + blocks.reduce((sum, b) => sum + b.length, 0) + trailer.length);
	let pos = 0;
	result.set(header, pos);
	pos += header.length;
	for (const block of blocks) {
		result.set(block, pos);
		pos += block.length;
	}
	result.set(trailer, pos);
	return result;
}

/**
 * Encodes a grayscale raster image as an 8-bit PNG (spec §6 / ticket 10). Both OCR backends consume
 * PNG: the LLM-vision APIs require PNG/JPEG/WEBP/GIF, and the native Vision backend hands Vision a
 * PNG on disk. This hand-rolls a minimal encoder (unfiltered scanlines, uncompressed zlib block)
 * rather than pulling in a compression dependency.
 */
export function encodeGrayscalePng(image: RasterImage): Uint8Array {
	const { width, height, pixels } = image;

	const raw = new Uint8Array(height * (width + 1)); // +1 filter-type byte per scanline
	for (let y = 0; y < height; y++) {
		const rowStart = y * (width + 1);
		raw[rowStart] = 0; // filter type: None
		raw.set(pixels.subarray(y * width, (y + 1) * width), rowStart + 1);
	}

	const ihdrData = new Uint8Array(13);
	writeU32BE(ihdrData, 0, width);
	writeU32BE(ihdrData, 4, height);
	ihdrData[8] = 8; // bit depth
	ihdrData[9] = 0; // color type: grayscale
	ihdrData[10] = 0; // compression method
	ihdrData[11] = 0; // filter method
	ihdrData[12] = 0; // interlace method

	const ihdr = chunk("IHDR", ihdrData);
	const idat = chunk("IDAT", zlibStore(raw));
	const iend = chunk("IEND", new Uint8Array(0));

	const signature = Uint8Array.from(PNG_SIGNATURE);
	const result = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
	let pos = 0;
	result.set(signature, pos);
	pos += signature.length;
	result.set(ihdr, pos);
	pos += ihdr.length;
	result.set(idat, pos);
	pos += idat.length;
	result.set(iend, pos);
	return result;
}
