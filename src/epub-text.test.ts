import { describe, expect, it } from "vitest";
import { readEpubBook } from "./epub-text";

/** CRC-32, the one field a ZIP reader may well check even though ours does not. */
function crc32(bytes: Uint8Array): number {
	let crc = ~0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A real ZIP: local headers, then the central directory, then the EOCD. `deflate` picks method 8. */
async function makeZip(files: { name: string; content: string; deflate?: boolean }[]): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const file of files) {
		const raw = encoder.encode(file.content);
		const data = file.deflate ? await deflateRaw(raw) : raw;
		const name = encoder.encode(file.name);
		const local = new Uint8Array(30 + name.length + data.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(8, file.deflate ? 8 : 0, true);
		localView.setUint32(14, crc32(raw), true);
		localView.setUint32(18, data.length, true);
		localView.setUint32(22, raw.length, true);
		localView.setUint16(26, name.length, true);
		local.set(name, 30);
		local.set(data, 30 + name.length);
		locals.push(local);

		const central = new Uint8Array(46 + name.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(10, file.deflate ? 8 : 0, true);
		centralView.setUint32(16, crc32(raw), true);
		centralView.setUint32(20, data.length, true);
		centralView.setUint32(24, raw.length, true);
		centralView.setUint16(28, name.length, true);
		centralView.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);
		offset += local.length;
	}

	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(8, files.length, true);
	eocdView.setUint16(10, files.length, true);
	eocdView.setUint32(12, centralSize, true);
	eocdView.setUint32(16, offset, true);

	const total = [...locals, ...centrals, eocd];
	const out = new Uint8Array(total.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of total) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

describe("readEpubBook", () => {
	it("reads the prose out of every XHTML document, stored or deflated", async () => {
		const zip = await makeZip([
			{ name: "mimetype", content: "application/epub+zip" },
			{ name: "OEBPS/chapter1.xhtml", content: "<html><body><h1>CHAPTER I.</h1><p>Alice was beginning to get very tired.</p></body></html>" },
			{ name: "OEBPS/chapter2.xhtml", content: "<html><body><p>Down, down, down.</p></body></html>", deflate: true },
		]);

		expect((await readEpubBook(zip))?.text).toBe("CHAPTER I. Alice was beginning to get very tired. Down, down, down.");
	});

	it("keeps the word boundary an inline tag stands for, and drops script and style whole", async () => {
		const zip = await makeZip([
			{
				name: "a.xhtml",
				// Without a space for the tag, "fell" and "off" would run together as one word and no
				// quote spanning the emphasis could ever be found again.
				content: "<html><head><style>p { color: red }</style></head><body><p>I fell<em>off</em>the top</p><script>x()</script></body></html>",
			},
		]);

		expect((await readEpubBook(zip))?.text).toBe("I fell off the top");
	});

	it("decodes the entities a book's punctuation is written with", async () => {
		const zip = await makeZip([{ name: "a.xhtml", content: "<p>&ldquo;Well!&rdquo; thought Alice &amp; her sister &#8212; then &#x2026;</p>" }]);

		expect((await readEpubBook(zip))?.text).toBe("“Well!” thought Alice & her sister — then …");
	});

	// Every failure is a null, never a throw: the quote still gets written in the device's spelling.
	it("returns null for bytes that are not a ZIP", async () => {
		expect(await readEpubBook(new TextEncoder().encode("not a zip at all"))).toBeNull();
	});

	it("reads the record at the end of the file, not a book's own bytes that look like one", async () => {
		// The end-of-directory signature is four ordinary bytes, and a book is free to contain them. Only
		// the last one in the file is the real record -- reading the first turns a perfectly good book
		// into an unreadable one.
		const zip = await makeZip([{ name: "a.xhtml", content: "<p>Alice found PK\u0005\u0006 written on the wall.</p>" }]);

		expect((await readEpubBook(zip))?.text).toBe("Alice found PK\u0005\u0006 written on the wall.");
	});

	it("returns null for an archive with no XHTML in it", async () => {
		expect(await readEpubBook(await makeZip([{ name: "mimetype", content: "application/epub+zip" }]))).toBeNull();
	});

	// The two forms a book carries its chapter names in, both of them on the test device.
	describe("the navigation", () => {
		const NCX = `<ncx><navMap>
			<navPoint><navLabel><text>CHAPTER I. Down the Rabbit-Hole</text></navLabel><content src="chapter1.xhtml"/></navPoint>
			<navPoint><navLabel><text>CHAPTER II. The Pool of Tears</text></navLabel><content src="chapter2.xhtml"/></navPoint>
		</navMap></ncx>`;

		it("reads an EPUB 2 book's chapter names off its .ncx", async () => {
			const zip = await makeZip([
				{ name: "OEBPS/chapter1.xhtml", content: "<p>Alice was beginning to get very tired.</p>" },
				{ name: "OEBPS/toc.ncx", content: NCX },
			]);

			expect((await readEpubBook(zip))?.chapters).toEqual(["CHAPTER I. Down the Rabbit-Hole", "CHAPTER II. The Pool of Tears"]);
		});

		it("reads an EPUB 3 book's chapter names off its navigation document", async () => {
			const zip = await makeZip([
				{ name: "OEBPS/article.xhtml", content: "<p>Sonnet 5 is our best model.</p>" },
				{ name: "OEBPS/nav.xhtml", content: `<html><body><nav epub:type="toc" id="toc"><ol><li><a href='article.xhtml'>Introducing Claude Sonnet 5</a></li></ol></nav></body></html>` },
			]);

			expect((await readEpubBook(zip))?.chapters).toEqual(["Introducing Claude Sonnet 5"]);
		});

		it("falls through to the navigation document when the .ncx names nothing", async () => {
			// A book may carry both forms, and an empty `.ncx` is not an answer -- it is the older form
			// left behind by a converter. Stopping at it costs the book every chapter name it has.
			const zip = await makeZip([
				{ name: "OEBPS/article.xhtml", content: "<p>Sonnet 5 is our best model.</p>" },
				{ name: "OEBPS/toc.ncx", content: "<ncx><navMap></navMap></ncx>" },
				{ name: "OEBPS/nav.xhtml", content: `<html><body><nav epub:type="toc"><ol><li><a href='article.xhtml'>Introducing Claude Sonnet 5</a></li></ol></nav></body></html>` },
			]);

			expect((await readEpubBook(zip))?.chapters).toEqual(["Introducing Claude Sonnet 5"]);
		});

		it("takes only the table of contents, not every list of links in the book", async () => {
			const zip = await makeZip([
				{
					name: "nav.xhtml",
					content: `<html><body><nav epub:type="landmarks"><a href="cover.xhtml">Cover</a></nav><nav epub:type="toc"><a href="c1.xhtml">Chapter One</a></nav></body></html>`,
				},
			]);

			expect((await readEpubBook(zip))?.chapters).toEqual(["Chapter One"]);
		});

		// No navigation is not a failure: the headings the render found are then all there is, and they
		// stay exactly as they are.
		it("reports no chapters for a book that carries no navigation", async () => {
			const zip = await makeZip([{ name: "a.xhtml", content: "<p>Just prose.</p>" }]);

			expect((await readEpubBook(zip))?.chapters).toEqual([]);
		});
	});
});
