/**
 * A source PDF's text layer, read through Obsidian's bundled pdf.js (`loadPdfJs()`), whose
 * customized build returns character-level bounding boxes from
 * `getTextContent({ includeChars: true })`. The chars power quote re-derivation and
 * marker-ink→text; they are never rendered to the user directly.
 *
 * The build is undocumented, so the shapes below are pinned against observed behavior (via
 * PDF++'s typings, src/typings.d.ts in RyotaUshio/obsidian-pdf-plus): each text item carries
 * `chars: { c, u, r }[]` with `r = [x1, y1, x2, y2]` in PDF user-space points, bottom-left
 * origin. Anything off-shape degrades to "no text layer", never a failed sync.
 */

interface PdfJsChar {
	c: string;
	/** The character's unicode text -- what PDF++ concatenates when extracting text by rect. */
	u: string;
	/** [x1, y1, x2, y2]: bottom-left and top-right corners, PDF user-space points. */
	r: number[];
}

interface PdfJsTextItem {
	/** Present only on Obsidian's customized build, and only with `includeChars: true`. */
	chars?: PdfJsChar[];
}

interface PdfJsPage {
	getTextContent(options: { includeChars: boolean }): Promise<{ items: PdfJsTextItem[] }>;
}

interface PdfJsDocument {
	numPages: number;
	/** 1-based, per pdf.js convention. */
	getPage(pageNumber: number): Promise<PdfJsPage>;
	destroy(): Promise<unknown>;
}

interface PdfJsModule {
	getDocument(options: { data: Uint8Array }): { promise: Promise<PdfJsDocument> };
}

/** Obsidian's `loadPdfJs`, injected so this module never imports `obsidian` and tests stub the whole build. */
export type PdfJsLoader = () => Promise<PdfJsModule>;

/** One text-layer character: its text plus bounding box in PDF user-space points (origin bottom-left). */
export interface TextLayerChar {
	text: string;
	/** [x1, y1, x2, y2]: bottom-left and top-right corners. */
	rect: [number, number, number, number];
}

/** A page's characters in text order, or null when the page has no usable text layer (scanned page, or extraction failed). */
export type PageChars = TextLayerChar[] | null;

export interface PdfTextLayer {
	/** Text-layer chars of the 0-based source page. */
	pageChars(pageIndex: number): Promise<PageChars>;
	/** Releases the underlying pdf.js document. */
	destroy(): Promise<void>;
}

function toChar(char: PdfJsChar): TextLayerChar | null {
	const rect = char.r;
	if (typeof char.u !== "string" || !Array.isArray(rect) || rect.length < 4 || rect.slice(0, 4).some((edge) => !Number.isFinite(edge))) return null;
	return { text: char.u, rect: [rect[0], rect[1], rect[2], rect[3]] };
}

/**
 * Opens a source PDF's text layer, or null when pdf.js can't be loaded or can't read the
 * document -- the per-feature degradation point: with a null text layer every consumer keeps
 * today's behavior (spec F1).
 */
export async function openPdfTextLayer(loadPdfJs: PdfJsLoader, pdfBytes: Uint8Array): Promise<PdfTextLayer | null> {
	let doc: PdfJsDocument;
	try {
		const pdfjs = await loadPdfJs();
		// pdf.js transfers the bytes to its worker, detaching the buffer -- hand over a copy so
		// the caller's bytes (also used for rendering and the attachment) stay intact.
		doc = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
	} catch (error) {
		console.warn("Tagged Sync: PDF text layer unavailable, features degrade to device text", error);
		return null;
	}

	return {
		async pageChars(pageIndex: number): Promise<PageChars> {
			if (pageIndex < 0 || pageIndex >= doc.numPages) return null;
			try {
				const page = await doc.getPage(pageIndex + 1);
				const { items } = await page.getTextContent({ includeChars: true });
				const chars = items
					.flatMap((item) => item.chars ?? [])
					.map(toChar)
					.filter((char): char is TextLayerChar => char !== null);
				// A page whose "text" is all whitespace is a scanned page in practice: nothing to anchor to.
				return chars.some((char) => char.text.trim() !== "") ? chars : null;
			} catch (error) {
				console.warn(`Tagged Sync: text layer of page ${pageIndex + 1} unreadable, page degrades to device text`, error);
				return null;
			}
		},
		async destroy(): Promise<void> {
			try {
				await doc.destroy();
			} catch {
				// Releasing a document the viewer already tore down must not fail a finished sync.
			}
		},
	};
}
