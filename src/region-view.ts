// The reading side of a margin note, and the first thing this plugin has ever drawn *inside* a note.
// A `remarkable-note` block becomes a button; the button draws the piece of the embedded PDF the
// note's handwriting sits on, out of the vault's own file, on request and never before.
//
// Nothing is cached but the open document (75 ms against 6 ms for a region, measured). Drawn images
// are not kept: a note with thirty margin notes must cost nothing until somebody asks it to.

import * as obsidian from "obsidian";
import { MarkdownRenderChild, parseLinktext, setIcon, type Plugin, type TFile } from "obsidian";
import { REGION_LANGUAGE, type NoteRegion } from "./digest-builder";
import { readEmbedPath } from "./note-builder";
import { drawnBand, liesOnPage, parseRegionBlock, regionFailureMessage, RegionUnavailable, UNREADABLE_BLOCK } from "./note-region";

/**
 * How many device pixels per PDF point the band is drawn at. The spike measured a region at 6-17 ms
 * and found the scale free -- 4x cost what 1x did -- so this is chosen for legibility: a band is the
 * page's full width shown in a note's column, which shrinks the handwriting in it.
 */
const SCALE = 3;

/**
 * Ceiling on either canvas dimension, in device pixels. Browsers refuse a canvas past a few thousand
 * pixels a side and throw on the allocation rather than returning null, so the scale gives way first.
 */
const MAX_CANVAS_PX = 8192;

const SHOW_LABEL = "Show handwriting";
const HIDE_LABEL = "Hide handwriting";

// pdf.js ships with Obsidian and carries no types with it; only the handful of members used here are
// described, and the version is the app's rather than ours -- so every one of them is reached
// defensively and a miss ends as `UNDRAWABLE` rather than as a thrown promise.

interface PdfJsRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

interface PdfJsPage {
	getViewport(params: { scale: number }): { width: number; height: number };
	render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown; transform: number[] }): PdfJsRenderTask;
}

interface PdfJsDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfJsPage>;
	destroy(): Promise<void>;
}

interface PdfJsLib {
	getDocument(params: { data: Uint8Array }): { promise: Promise<PdfJsDocument> };
}

/**
 * Obsidian's own pdf.js, through the documented `loadPdfJs()` API -- probed rather than assumed, as
 * `pdf-text.ts` does: the API is missing from older app versions and from the module stub the tests
 * run against, and "no pdf.js" is a normal outcome, not a crash.
 */
async function obsidianPdfJs(): Promise<PdfJsLib> {
	const api = obsidian as unknown as { loadPdfJs?: () => Promise<unknown> };
	if (typeof api.loadPdfJs !== "function") throw new Error("this Obsidian version does not expose loadPdfJs");
	return (await api.loadPdfJs()) as PdfJsLib;
}

/**
 * The last PDF opened, kept open.
 *
 * One entry, not a pool: a reader is in one note, and the note embeds one PDF. Opening a document
 * costs 75 ms and drawing a region out of an open one costs 6-17 ms, so this is the whole difference
 * between a button that answers instantly and one that visibly waits -- while a pool would hold a
 * book's worth of PDF in memory for as long as Obsidian runs.
 */
class OpenPdf {
	private path: string | null = null;
	private document: Promise<PdfJsDocument> | null = null;

	constructor(private readonly loadLib: () => Promise<PdfJsLib> = obsidianPdfJs) {}

	async open(file: TFile, read: (file: TFile) => Promise<ArrayBuffer>): Promise<PdfJsDocument> {
		if (this.path !== file.path || this.document === null) {
			void this.close();
			this.path = file.path;
			this.document = this.load(file, read);
		}
		return this.document;
	}

	private async load(file: TFile, read: (file: TFile) => Promise<ArrayBuffer>): Promise<PdfJsDocument> {
		const pdfjs = await this.loadLib();
		// A copy: pdf.js transfers the buffer it is handed to its worker and leaves the caller with a
		// detached one, which would make the second click on the same note fail.
		return pdfjs.getDocument({ data: new Uint8Array(await read(file)).slice() }).promise;
	}

	async close(): Promise<void> {
		const closing = this.document;
		this.path = null;
		this.document = null;
		if (!closing) return;
		try {
			await (await closing).destroy();
		} catch {
			// A document that never opened has nothing to close, and a failure to free memory is not
			// something to tell the reader about.
		}
	}
}

/** One `remarkable-note` block, for as long as its note is on screen. */
class RegionBlock extends MarkdownRenderChild {
	private region: NoteRegion | null = null;
	private button: HTMLButtonElement | null = null;
	private figure: HTMLElement | null = null;
	private message: HTMLElement | null = null;
	private task: PdfJsRenderTask | null = null;

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly notePath: string,
		private readonly plugin: Plugin,
		private readonly open: OpenPdf,
	) {
		super(containerEl);
	}

	onload(): void {
		this.region = parseRegionBlock(this.source);
		// No button for a block that does not say what it must -- there is nothing for it to open, and a
		// control that cannot work is worse than the sentence explaining why.
		if (this.region === null) {
			this.containerEl.createDiv({ cls: "tagged-sync-region-message", text: UNREADABLE_BLOCK });
			return;
		}
		this.button = this.containerEl.createEl("button", { cls: "tagged-sync-region-button" });
		this.label(SHOW_LABEL);
		this.button.addEventListener("click", () => void this.toggle());
	}

	onunload(): void {
		// A render still running when the note closes: pdf.js keeps drawing into a canvas nobody will
		// ever see, and its promise rejects afterwards on a child that is gone.
		this.task?.cancel();
		this.task = null;
	}

	private label(text: string): void {
		if (!this.button) return;
		this.button.empty();
		const icon = this.button.createSpan({ cls: "tagged-sync-region-icon" });
		setIcon(icon, "eye");
		this.button.createSpan({ text });
		this.button.setAttribute("aria-label", text);
	}

	/** The reason, in the note itself. Replaced on every attempt, so a fixed vault clears it by pressing the button again. */
	private explain(text: string | null): void {
		this.message?.remove();
		this.message = text === null ? null : this.containerEl.createDiv({ cls: "tagged-sync-region-message", text });
	}

	private async toggle(): Promise<void> {
		if (this.figure) {
			this.figure.remove();
			this.figure = null;
			this.label(SHOW_LABEL);
			return;
		}
		if (!this.region || !this.button) return;
		this.button.disabled = true;
		this.explain(null);
		try {
			const canvas = await this.draw(this.region);
			// The note may have closed while the PDF was opening; `onunload` cancelled the render, and
			// there is nothing left to put the canvas into.
			if (!this.figure && this.button.isConnected) {
				this.figure = this.containerEl.createDiv({ cls: "tagged-sync-region" });
				this.figure.appendChild(canvas);
				this.label(HIDE_LABEL);
			}
		} catch (error) {
			// Both, not either: the note gets the sentence because that is where the reader is, and the
			// console keeps the stack, because "the PDF could not be opened" is not a diagnosis.
			console.warn("Tagged Sync: couldn't draw the handwriting for a margin note", error);
			this.explain(regionFailureMessage(error));
		} finally {
			// Left enabled on purpose. Every one of these failures is something the reader can put right
			// -- move the PDF back, undo an edit -- and then the same button works.
			this.button.disabled = false;
		}
	}

	/**
	 * The PDF this note embeds, resolved through Obsidian's own link resolution -- so a PDF the user
	 * moved is found at its new place, because Obsidian rewrote the embed when it moved.
	 *
	 * Read fresh on every click rather than remembered: the whole point of going through the note is
	 * that the note is the thing that stays current.
	 */
	private async embeddedPdf(): Promise<TFile> {
		const { vault, metadataCache } = this.plugin.app;
		const note = vault.getFileByPath(this.notePath);
		if (!note) throw new RegionUnavailable("This note is no longer in the vault, so its handwriting cannot be shown.");
		const embed = readEmbedPath(await vault.cachedRead(note));
		if (embed === null) throw new RegionUnavailable("This note embeds no PDF, so there is nothing to show the handwriting out of.");
		const file = metadataCache.getFirstLinkpathDest(parseLinktext(embed).path, this.notePath);
		if (!file) throw new RegionUnavailable(`The PDF this note embeds (${embed}) is not in the vault, so its handwriting cannot be shown.`);
		return file;
	}

	private async draw(region: NoteRegion): Promise<HTMLCanvasElement> {
		const document = await this.open.open(await this.embeddedPdf(), (file) => this.plugin.app.vault.readBinary(file));
		// A PDF rebuilt outside the plugin, with fewer pages than when the note was written.
		if (region.page > document.numPages) {
			throw new RegionUnavailable(`The embedded PDF has no page ${region.page} any more, so this note's handwriting cannot be shown.`);
		}
		const page = await document.getPage(region.page);
		// A scale-1 viewport reports the page in PDF points, which is the unit the block stores.
		const sheet = page.getViewport({ scale: 1 });
		if (!liesOnPage(region, sheet)) {
			throw new RegionUnavailable(`This block points at a place that is not on page ${region.page}, so there is nothing to draw.`);
		}
		const band = drawnBand(region, sheet);

		// Never above `SCALE`, and never so large that the canvas cannot be allocated: a poster-sized
		// page is a legitimate document, and its band is simply drawn at fewer pixels per point.
		const scale = Math.min(SCALE, MAX_CANVAS_PX / band.width, MAX_CANVAS_PX / band.height);
		const canvas = createEl("canvas");
		canvas.width = Math.ceil(band.width * scale);
		canvas.height = Math.ceil(band.height * scale);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("this platform gave no 2d canvas context");

		// The viewport is the whole page; the transform slides the band's corner to the canvas origin,
		// so pdf.js clips to the canvas and never rasterizes the page around it. No y conversion: a
		// viewport measures y from the page top, which is the axis the block stores.
		this.task = page.render({
			canvasContext: context,
			viewport: page.getViewport({ scale }),
			transform: [1, 0, 0, 1, -band.x * scale, -band.y * scale],
		});
		await this.task.promise;
		this.task = null;
		return canvas;
	}
}

/**
 * Teaches the plugin to draw a margin note's handwriting. Registering the language is what turns this
 * from a sync tool into a viewer extension: without the plugin, the block stays two readable lines
 * under the entry's text, which is the fallback the format was chosen for.
 */
export function registerRegionProcessor(plugin: Plugin): void {
	const open = new OpenPdf();
	plugin.register(() => void open.close());
	plugin.registerMarkdownCodeBlockProcessor(REGION_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(new RegionBlock(el, source, ctx.sourcePath, plugin, open));
	});
}
