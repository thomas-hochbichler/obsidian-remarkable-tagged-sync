// Repairing the colour operator the reMarkable leaves empty when it renders an EPUB to a PDF.
//
// The device writes `scn` and `SCN` with no operands at all -- 60 times on one page of *Alice*, each
// one right after `/CSp cs`, each one immediately before the text it is supposed to paint. macOS
// reads the broken operator as "no change" and paints the text black; pdf.js, which is what Obsidian
// renders a PDF embed with, keeps the last colour it did see. That colour is the `1 1 1` of the
// page's own white background, so the whole book arrives as white text on white paper: the reader
// opens the note and the page is blank, with only our own highlights floating on it.
//
// Not every device render has it -- an article captured by the "Read on reMarkable" extension had
// none -- so this repairs what it finds and leaves everything else byte for byte alone.

import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, type PDFPage } from "pdf-lib";

/** What a colour operator would mean if the device had written one: black, in the DeviceRGB space these all sit in. */
const BLACK_RGB = "0 0 0";

/**
 * The same content stream with every operand-less `scn`/`SCN` given black, or null when there was
 * nothing to repair -- which is the common case, and the caller then leaves the stream untouched.
 *
 * An operator that *does* have operands is left alone, including the pattern form (`/P0 scn`), whose
 * operand is a name rather than a number.
 */
export function repairBareColourOps(content: string): string | null {
	let repaired = 0;
	const out = content.replace(/(?<![A-Za-z])(scn|SCN)(?![A-Za-z])/g, (match, op: string, offset: number) => {
		const before = content.slice(Math.max(0, offset - 48), offset);
		// The operand of a colour operator is a number, or a pattern name. Anything else in front of it
		// -- another operator, a `q`, the start of the stream -- means it was given nothing to set.
		if (/(\d|\/[^\s/]+)\s*$/.test(before)) return match;
		repaired++;
		return `${BLACK_RGB} ${op}`;
	});
	return repaired > 0 ? out : null;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Latin-1, because a content stream is bytes: its text is ASCII operators around binary string operands, and a UTF-8 round trip would rewrite those. */
const decode = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
const encode = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

/**
 * Repairs one content stream in place. Returns true when it changed.
 *
 * Only `FlateDecode` and uncompressed streams are touched; anything else is left as it is rather
 * than guessed at. A stream that cannot be inflated is left alone too -- a page drawn in the colour
 * the device meant is worth having, and a page we corrupted trying is not.
 */
async function repairStream(doc: PDFDocument, ref: PDFRef): Promise<boolean> {
	const stream = doc.context.lookup(ref);
	if (!(stream instanceof PDFRawStream)) return false;
	const filter = stream.dict.get(PDFName.of("Filter"));
	const flate = String(filter ?? "").includes("FlateDecode");
	if (filter !== undefined && !flate) return false;

	let content: string;
	try {
		content = decode(flate ? await inflate(stream.contents) : stream.contents);
	} catch {
		return false;
	}

	const repaired = repairBareColourOps(content);
	if (repaired === null) return false;

	const bytes = encode(repaired);
	const dict = stream.dict;
	if (flate) dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
	doc.context.assign(ref, PDFRawStream.of(dict, flate ? await deflate(bytes) : bytes));
	return true;
}

/**
 * Repairs a page's own content streams, before it is embedded somewhere else and its bytes are
 * copied as they stand.
 */
export async function repairPagePaint(doc: PDFDocument, page: PDFPage): Promise<boolean> {
	const contents = page.node.get(PDFName.of("Contents"));
	// One stream, or an array of them: both are legal, and a device that splits its page across
	// several would otherwise keep the half we never looked at.
	const array = doc.context.lookup(contents);
	const refs = contents instanceof PDFRef ? [contents] : array instanceof PDFArray ? array.asArray().filter((entry): entry is PDFRef => entry instanceof PDFRef) : [];
	let repaired = false;
	for (const ref of refs) repaired = (await repairStream(doc, ref)) || repaired;
	return repaired;
}
