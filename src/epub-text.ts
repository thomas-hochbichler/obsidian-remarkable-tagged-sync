// The original `.epub`, read for two things the device's render gets wrong: the wording of a quote,
// and the name of a chapter.
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

/** What the `.epub` is read for: the author's own wording, and the book's own names for its parts. */
export interface EpubBook {
	/** The book's prose, joined from every XHTML document in the archive. */
	text: string;
	/** The chapter names the navigation carries, in navigation order. Empty when the book has no readable navigation. */
	chapters: string[];
}

/** Every `<navLabel>` of an EPUB 2 `.ncx`, in document order -- which is reading order, and is what `playOrder` says too. */
function labelsOfNcx(ncx: string): string[] {
	return [...ncx.matchAll(/<navLabel[^>]*>\s*<text[^>]*>([\s\S]*?)<\/text>/gi)].map((match) => textOfXhtml(match[1]));
}

/** Every link of an EPUB 3 navigation document's table of contents, in document order. */
function labelsOfNav(xhtml: string): string[] {
	const toc = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(xhtml);
	if (!toc) return [];
	return [...toc[1].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => textOfXhtml(match[1]));
}

/**
 * The chapter names, from whichever of the two forms this book carries them in: EPUB 2's `.ncx` or
 * EPUB 3's navigation document. Both are on the test device -- *Alice* has an `.ncx`, an article
 * captured by the "Read on reMarkable" extension has only a `nav.xhtml` -- so both are read.
 *
 * Where the chapters *sit* is deliberately not read. A name is only ever used to rename a heading the
 * render already found (`chapter-names.ts`), and matching by name needs no positions.
 */
async function readNavigation(bytes: Uint8Array, entries: ZipEntry[], documents: string[]): Promise<string[]> {
	const ncx = entries.find((entry) => /\.ncx$/i.test(entry.name));
	if (ncx) {
		const data = await readEntry(bytes, ncx).catch(() => null);
		const labels = data ? labelsOfNcx(new TextDecoder().decode(data)).filter((label) => label.length > 0) : [];
		if (labels.length > 0) return labels;
	}
	for (const document of documents) {
		const labels = labelsOfNav(document).filter((label) => label.length > 0);
		if (labels.length > 0) return labels;
	}
	return [];
}

/**
 * The book, or null when this is not an archive we can read prose out of.
 *
 * The spine order is not read, and does not matter: the prose's only consumer searches it for a
 * quote it already knows the position of (`correctQuote`). Skipping the OPF keeps a book with a
 * broken or unusual manifest readable, which is the whole point of a fallback source -- and is why
 * the navigation is looked for by file shape rather than through the manifest that names it.
 */
export async function readEpubBook(bytes: Uint8Array): Promise<EpubBook | null> {
	const entries = readCentralDirectory(bytes);
	if (!entries) return null;
	const documents = entries.filter((entry) => /\.(x?html|htm)$/i.test(entry.name));
	if (documents.length === 0) return null;

	const parts: string[] = [];
	const xhtml: string[] = [];
	for (const entry of documents) {
		const data = await readEntry(bytes, entry).catch(() => null);
		if (!data) continue;
		const document = new TextDecoder().decode(data);
		xhtml.push(document);
		parts.push(textOfXhtml(document));
	}
	const text = parts.filter((part) => part.length > 0).join(" ");
	if (text.length === 0) return null;

	return { text, chapters: await readNavigation(bytes, entries, xhtml) };
}
