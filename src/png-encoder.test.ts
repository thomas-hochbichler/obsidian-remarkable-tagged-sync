import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeGrayscalePng } from "./png-encoder";
import type { RasterImage } from "./page-rasterizer";

function readU32BE(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

interface DecodedChunk {
	type: string;
	data: Uint8Array;
}

/** Minimal chunk reader for assertions -- not a full PNG decoder. */
function readChunks(png: Uint8Array): DecodedChunk[] {
	const chunks: DecodedChunk[] = [];
	let offset = 8; // past the signature
	while (offset < png.length) {
		const length = readU32BE(png, offset);
		const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
		const data = png.subarray(offset + 8, offset + 8 + length);
		chunks.push({ type, data });
		offset += 12 + length; // length + type + data + crc
	}
	return chunks;
}

describe("encodeGrayscalePng", () => {
	it("writes a valid PNG signature and IHDR for a small image", () => {
		const image: RasterImage = { width: 2, height: 3, pixels: new Uint8Array(6).fill(255) };

		const png = encodeGrayscalePng(image);

		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		const chunks = readChunks(png);
		expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);

		const ihdr = chunks[0].data;
		expect(readU32BE(ihdr, 0)).toBe(2); // width
		expect(readU32BE(ihdr, 4)).toBe(3); // height
		expect(ihdr[8]).toBe(8); // bit depth
		expect(ihdr[9]).toBe(0); // color type: grayscale
	});

	it("round-trips pixel data through a real zlib inflate", () => {
		const pixels = new Uint8Array([10, 20, 30, 40, 50, 60]); // 3x2
		const image: RasterImage = { width: 3, height: 2, pixels };

		const png = encodeGrayscalePng(image);
		const idat = readChunks(png).find((c) => c.type === "IDAT")!.data;
		const raw = inflateSync(idat);

		// Each scanline is a leading filter-type byte (0 = None) followed by the row's pixels.
		expect([...raw]).toEqual([0, 10, 20, 30, 0, 40, 50, 60]);
	});

	it("round-trips a full reMarkable-page-sized image", () => {
		const width = 1404;
		const height = 1872;
		const pixels = new Uint8Array(width * height);
		for (let i = 0; i < pixels.length; i++) pixels[i] = i % 256;
		const image: RasterImage = { width, height, pixels };

		const png = encodeGrayscalePng(image);
		const idat = readChunks(png).find((c) => c.type === "IDAT")!.data;
		const raw = inflateSync(idat);

		for (let y = 0; y < height; y++) {
			const rowStart = y * (width + 1);
			expect(raw[rowStart]).toBe(0);
			expect([...raw.subarray(rowStart + 1, rowStart + 1 + width)]).toEqual([...pixels.subarray(y * width, (y + 1) * width)]);
		}
	});

	it("produces chunks with valid CRC-32s (per the PNG spec's reference algorithm)", () => {
		// Independent reference implementation (PNG spec Annex D), not shared with png-encoder.ts.
		function referenceCrc32(bytes: Uint8Array): number {
			let crc = 0xffffffff;
			for (const byte of bytes) {
				crc ^= byte;
				for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
			}
			return (crc ^ 0xffffffff) >>> 0;
		}

		const image: RasterImage = { width: 2, height: 2, pixels: new Uint8Array([0, 64, 128, 255]) };
		const png = encodeGrayscalePng(image);

		let offset = 8;
		while (offset < png.length) {
			const length = readU32BE(png, offset);
			const typeAndData = png.subarray(offset + 4, offset + 8 + length);
			const storedCrc = readU32BE(png, offset + 8 + length);
			expect(storedCrc).toBe(referenceCrc32(typeAndData));
			offset += 12 + length;
		}
	});
});
