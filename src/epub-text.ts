// The original `.epub`'s prose, read for one purpose: correcting the quotes the device hands us.
//
// A reMarkable has no EPUB reader. It converts the book to a PDF on-device, and that conversion is
// where a quote loses letters -- `off` arrives as `oP`, a plain U+0050 with no ligature codepoint to
// map back (`.scratch/epub-sync/spec.md` §2). The `.epub` sits in the same blob set as the render,
// and it has the wording right.
//
// Everything here returns null rather than throwing. A book whose `.epub` cannot be read still gets
// its quotes, in the device's spelling: a wrong letter is a blemish, a missing quote is a lost
// annotation (spec §3).

/** A ZIP entry's name and where its data sits, read from the central directory. */
interface ZipEntry {
	name: string;
	/** 0 = stored, 8 = deflate. Anything else is left alone. */
	method: number;
	offset: number;
	compressedSize: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The EOCD is last in the file, followed only by a comment of at most 0xffff bytes. */
const MAX_EOCD_SEARCH = 0xffff + 22;

/**
 * The ZIP central directory, or null when this is not a ZIP we can read.
 *
 * Read from the end backwards, as the format requires: an EPUB's own bytes may contain the EOCD
 * signature by coincidence, and only the last one is the real record.
 */
function readCentralDirectory(bytes: Uint8Array): ZipEntry[] | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - MAX_EOCD_SEARCH); i--) {
		if (view.getUint32(i, true) === EOCD_SIGNATURE) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return null;

	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const entries: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) return null;
		const method = view.getUint16(at + 10, true);
		const compressedSize = view.getUint32(at + 20, true);
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		const offset = view.getUint32(at + 42, true);
		entries.push({ name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)), method, offset, compressedSize });
		at += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/**
 * One entry's bytes, or null when it is compressed by a method we do not implement or its local
 * header does not line up. Stored and deflate cover every EPUB in practice.
 */
async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array | null> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL_SIGNATURE) return null;
	// The local header repeats the name and extra fields with its own lengths -- the central
	// directory's are not authoritative here, and reading the wrong one lands mid-data.
	const nameLength = view.getUint16(entry.offset + 26, true);
	const extraLength = view.getUint16(entry.offset + 28, true);
	const start = entry.offset + 30 + nameLength + extraLength;
	const data = bytes.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) return data;
	if (entry.method !== 8) return null;
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };

/**
 * The readable prose of one XHTML document.
 *
 * Deliberately not a DOM parse: this runs inside Obsidian, where a parser is available, and inside
 * tests and the sync worker, where the same code must behave identically. Script and style contents
 * are dropped whole; every other tag becomes a space, so two words either side of `<em>` do not run
 * together.
 */
function textOfXhtml(xhtml: string): string {
	return xhtml
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&#x([0-9a-f]+);/gi, (_: string, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_: string, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&([a-z]+);/gi, (whole: string, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The book's prose, joined from every XHTML document in the archive.
 *
 * The spine order is not read, and does not matter: the only consumer searches this text for a
 * quote it already knows the position of (`correctQuote`). Skipping the OPF keeps a book with a
 * broken or unusual manifest readable, which is the whole point of a fallback source.
 */
export async function readEpubText(bytes: Uint8Array): Promise<string | null> {
	const entries = readCentralDirectory(bytes);
	if (!entries) return null;
	const documents = entries.filter((entry) => /\.(x?html|htm)$/i.test(entry.name));
	if (documents.length === 0) return null;

	const parts: string[] = [];
	for (const entry of documents) {
		const data = await readEntry(bytes, entry).catch(() => null);
		if (!data) continue;
		parts.push(textOfXhtml(new TextDecoder().decode(data)));
	}
	const text = parts.filter((part) => part.length > 0).join(" ");
	return text.length > 0 ? text : null;
}
