/**
 * A note as a print document: rendered by Obsidian, dressed for the tablet's page, then handed to
 * the print surface (send-from-the-vault spec §4.2, §4.3).
 *
 * **Obsidian's own renderer, the public one.** `MarkdownRenderer.render` gives the note exactly as
 * the reading view shows it -- highlighting, MathJax, images, embedded notes -- which is the whole
 * promise of a sent note (research 01). It needs an element that is attached and laid out, so the
 * note is rendered off-screen in the main window, at the text column's width.
 *
 * **Dressed in two halves.** Passes 1–4 change only the markup and run here, on the rendered
 * element. Passes 5–7 measure, so they run in the print page, where the width is the printed width;
 * they travel to it as the source of {@link layoutPasses}.
 */

import { type App, Component, MarkdownRenderer, type TFile } from "obsidian";
import { CAPTION_CLASS, KEEP_WHOLE_CLASS, MISSING_EMBED_CLASS, type PrintChoice, type PrintPage, printPage } from "./note-print";
import { PrintFailure, printHtmlToPdf } from "./print-surface";

/** Obsidian's rule for properties: a `---` line at the very top, up to the next `---` line. */
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Nothing to print: after the properties nothing but whitespace (spec §1). A note that holds only
 * an embed or an image is not empty -- what it shows is printed.
 */
export function isEmptyNote(markdown: string): boolean {
	return markdown.replace(FRONTMATTER, "").trim() === "";
}

/** A Mermaid fence at the start of a line, as the renderer finds one. */
const MERMAID_FENCE = /^[ \t]*(?:```|~~~)[ \t]*mermaid\b/gm;
/** How long a note's diagrams may take in all. Mermaid draws after the render's promise settled. */
export const DIAGRAM_TIMEOUT_MS = 6_000;
const DIAGRAM_POLL_MS = 100;
/**
 * A fixed pause after the render and the diagrams: callout icons and embeds finish on a frame of
 * their own that nothing announces (research 01). The prototype's number; all nine rounds used it.
 */
export const SETTLE_MS = 400;

/** What the render takes from Obsidian, handed in so its order and its waits can be tested. */
export interface RenderHost {
	/** An element attached to the document, off-screen, `widthPx` wide, classed as a reading view. */
	createView(widthPx: number): HTMLElement;
	/**
	 * `MarkdownRenderer.render` into `view` under a loaded `Component`; resolves to that component's
	 * unload, which must run once the markup has been read.
	 */
	render(markdown: string, view: HTMLElement, sourcePath: string): Promise<() => void>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

/**
 * The note rendered and dressed (passes 1–4), as the inner HTML of its view.
 *
 * Blocks drawn by other plugins (Dataview, Bases) get no wait of their own: nothing tells when they
 * are done, so a sent note promises nothing for them (spec §4.2).
 */
export async function renderNote(file: Pick<TFile, "path" | "basename">, markdown: string, page: PrintPage, host: RenderHost): Promise<string> {
	const view = host.createView(page.columnPx);
	let unload = (): void => {};
	try {
		unload = await host.render(markdown, view, file.path);
		await diagramsDrawn(view, markdown.match(MERMAID_FENCE)?.length ?? 0, host);
		await host.sleep(SETTLE_MS);
		dressNote(view, file.basename);
		return view.innerHTML;
	} finally {
		unload();
		view.remove();
	}
}

/** Until each of the note's Mermaid blocks holds its drawing, or the time is up. */
async function diagramsDrawn(view: HTMLElement, expected: number, host: RenderHost): Promise<void> {
	const deadline = host.now() + DIAGRAM_TIMEOUT_MS;
	while (expected > 0 && view.querySelectorAll(".mermaid svg").length < expected && host.now() < deadline) {
		await host.sleep(DIAGRAM_POLL_MS);
	}
}

/** The renderer's own extra for a note with properties: hidden, and in the way of "the first block". */
const FRONTMATTER_BLOCK = "frontmatter";

/**
 * The kinds of embed a page cannot hold, by the class the renderer gives each (read on its output,
 * ticket 12): a PDF becomes a whole viewer with a toolbar, audio and video a player, a canvas a
 * drawing cut to the embed's box.
 */
const UNPRINTABLE_EMBEDS = ["pdf-embed", "audio-embed", "video-embed", "canvas-embed"];

/**
 * Passes 1–4 of spec §4.3, on the element the renderer filled: the title, embeds that cannot be
 * printed, internal links, captions. Markup only -- nothing here reads layout.
 */
export function dressNote(view: HTMLElement, title: string): void {
	addTitle(view, title);
	replaceUnprintableEmbeds(view);
	unlinkInternalLinks(view);
	markCaptions(view);
}

/**
 * Pass 1. The file's name as an `h1` on top, unless the note's first block is an `h1` of its own:
 * one title, never two (06 #4). The hidden properties block goes first, so it neither prints nor
 * counts as the first block.
 */
function addTitle(view: HTMLElement, title: string): void {
	for (const block of Array.from(view.children)) {
		if (block.tagName === "PRE" && block.classList.contains(FRONTMATTER_BLOCK)) block.remove();
	}
	if (view.firstElementChild?.tagName === "H1") return;
	view.prepend(createEl("h1", { text: title }));
}

/**
 * Pass 2. A PDF, audio, video or canvas embed becomes one small line naming its file (06 #6). An
 * embed whose target does not exist keeps the box Obsidian draws for it: that box already says so.
 */
function replaceUnprintableEmbeds(view: HTMLElement): void {
	for (const embed of Array.from(view.querySelectorAll(".internal-embed"))) {
		if (!UNPRINTABLE_EMBEDS.some((kind) => embed.classList.contains(kind))) continue;
		embed.replaceWith(createSpan({ cls: MISSING_EMBED_CLASS, text: `${embedFileName(embed)} (not included)` }));
	}
}

/**
 * `Specs/board.canvas#x` → `board.canvas`: the link the embed was written with, without the part
 * after `#`. The renderer always sets it; without one the line still says what is missing.
 */
function embedFileName(embed: Element): string {
	const link = embed.getAttribute("src")?.split("#")[0] ?? "";
	return link.slice(link.lastIndexOf("/") + 1) || "An embedded file";
}

/**
 * Pass 3. An internal link stays underlined text and loses its address: in the PDF it would point
 * at a vault path the tablet cannot open. A web link keeps its address and does not spell it out.
 */
function unlinkInternalLinks(view: HTMLElement): void {
	for (const link of Array.from(view.querySelectorAll("a.internal-link"))) link.removeAttribute("href");
}

/**
 * Pass 4. Emphasis right under an image or a diagram is its caption (round 8: the user asked for
 * smaller type there). Two shapes: a paragraph of nothing but emphasis that directly follows the
 * figure, and emphasis on the line right under an image, which Markdown keeps in the image's own
 * paragraph.
 */
function markCaptions(view: HTMLElement): void {
	for (const paragraph of Array.from(view.querySelectorAll("p"))) {
		if (isOnlyEmphasis(paragraph) && isFigure(paragraph.previousElementSibling)) paragraph.classList.add(CAPTION_CLASS);
		const last = paragraph.lastElementChild;
		if (last?.tagName === "EM" && last.previousElementSibling?.tagName === "BR" && isFigure(last.previousElementSibling.previousElementSibling)) {
			last.classList.add(CAPTION_CLASS);
		}
	}
}

/** The paragraph is one `em` holding all of its text. */
function isOnlyEmphasis(paragraph: Element): boolean {
	const only = paragraph.children.length === 1 ? paragraph.firstElementChild : null;
	return only?.tagName === "EM" && paragraph.textContent?.trim() === only.textContent?.trim();
}

/** An image, or a block holding one, or a diagram. */
function isFigure(el: Element | null): boolean {
	if (el === null) return false;
	return el.tagName === "IMG" || el.classList.contains("mermaid") || el.querySelector("img, .mermaid") !== null;
}

/** The class names the layout passes set, handed in because their source runs where no import reaches. */
export interface LayoutNames {
	readonly keepWhole: string;
}

/**
 * Passes 5–7 of spec §4.3, run in the print page after its images and fonts.
 *
 * **Self-contained on purpose:** it travels as its own source text ({@link layoutSource}), so it may
 * use nothing but its parameters and the page's globals -- no import, no module constant.
 */
export function layoutPasses(view: HTMLElement, page: PrintPage, names: LayoutNames): void {
	const px = (value: string | null | undefined): number => Number.parseFloat(value ?? "") || 0;

	// Pass 5 (round 7: "the type in the diagram is far too large"). Mermaid lays a diagram out at
	// its own type size and the reading view stretches it to the column, so its labels come out at
	// whatever the column makes of them. Size each by its type instead; never wider than the column.
	// The height follows from the stylesheet's `height: auto` once Mermaid's own attribute is gone.
	for (const svg of Array.from(view.querySelectorAll<SVGSVGElement>(".mermaid svg"))) {
		const label = svg.querySelector("text, foreignObject div, foreignObject span");
		const viewBoxWidth = svg.viewBox?.baseVal?.width ?? 0;
		const labelPx = label === null ? 0 : px(getComputedStyle(label).fontSize);
		if (viewBoxWidth <= 0 || labelPx <= 0) continue;
		const width = Math.min(page.columnPx, Math.round((viewBoxWidth * ((page.diagramPt * 96) / 72)) / labelPx));
		svg.style.width = `${width}px`;
		svg.removeAttribute("height");
	}

	// Pass 6 (rounds 6, 8, 9). The stylesheet pulls each checkbox into its list's indent; a top-level
	// task list is then shifted so its first box starts 5 px inside the column's left edge. The print
	// clips at the page's left margin, which is the column's edge -- with `overflow: visible` on the
	// view just the same, so it is the page area, not the reading view's scrolling (ticket 12, F6).
	// On the edge itself the box lost its left border; 5 px inside it is whole. Nested lists keep
	// their indent.
	const columnLeft = view.getBoundingClientRect().left + px(getComputedStyle(view).paddingLeft);
	for (const list of Array.from(view.querySelectorAll<HTMLElement>("ul.contains-task-list"))) {
		if (list.parentElement?.closest("li")) continue;
		const box = list.querySelector("input.task-list-item-checkbox");
		if (box === null) continue;
		const shift = box.getBoundingClientRect().left - columnLeft - 5;
		// "important", or the stylesheet's own `margin-inline-start: 0 !important` wins over it.
		list.style.setProperty("margin-inline-start", `${px(getComputedStyle(list).marginLeft) - shift}px`, "important");
	}

	// Pass 7 (round 5). A block shorter than about a third of the printable height is kept on one
	// page; a longer one splits, or it would leave most of a page blank before it.
	for (const block of Array.from(view.querySelectorAll("pre, table, .callout, img, .mermaid, blockquote"))) {
		if (block.getBoundingClientRect().height < page.keepWholePx) block.classList.add(names.keepWhole);
	}
}

/** {@link layoutPasses} as the print surface takes it: the source of a `(view, page)` function. */
export function layoutSource(): string {
	const names: LayoutNames = { keepWhole: KEEP_WHOLE_CLASS };
	return `(view, page) => (${layoutPasses.toString()})(view, page, ${JSON.stringify(names)})`;
}

/**
 * The note as PDF bytes on the tablet's page: rendered, dressed, printed. Any failure is a
 * {@link PrintFailure}; a render that threw passes on its message (spec §4.5).
 *
 * The caller has refused an empty note ({@link isEmptyNote}) before.
 */
export async function printNote(
	file: Pick<TFile, "path" | "basename">,
	markdown: string,
	choice: PrintChoice,
	host: RenderHost,
	print: typeof printHtmlToPdf = printHtmlToPdf,
): Promise<Uint8Array> {
	const page = printPage(choice);
	let html: string;
	try {
		html = await renderNote(file, markdown, page, host);
	} catch (error) {
		throw new PrintFailure("failed", error instanceof Error ? error.message : String(error));
	}
	return print({ html, title: file.basename, page, layout: layoutSource() });
}

/** The render in Obsidian: its active document, its public renderer, its window's timers. */
export function obsidianRenderHost(app: App): RenderHost {
	const doc = activeDocument;
	const win = activeWindow;
	return {
		createView(widthPx) {
			return doc.body.createDiv({
				cls: "markdown-preview-view markdown-rendered",
				attr: { style: `position: fixed; left: -20000px; top: 0; width: ${widthPx}px;` },
			});
		},
		async render(markdown, view, sourcePath) {
			const component = new Component();
			component.load();
			try {
				await MarkdownRenderer.render(app, markdown, view, sourcePath, component);
			} catch (error) {
				component.unload();
				throw error;
			}
			return () => component.unload();
		},
		sleep: (ms) => new Promise((resolve) => win.setTimeout(resolve, ms)),
		now: () => Date.now(),
	};
}
