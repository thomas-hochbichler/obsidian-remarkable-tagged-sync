/**
 * The print surface: a dressed note in, PDF bytes out (send-from-the-vault spec §4.5).
 *
 * **The one place that knows about `<webview>`.** Research 02 chose Electron's documented
 * `<webview>.printToPDF` over Obsidian's own hidden print window, which is private and broke in
 * 1.15.1; and over a typesetter of our own, which would be ~1,500 lines before images or non-Latin
 * text. Both reasons can change, so nothing else in the send may know how a note becomes bytes --
 * another mechanism replaces this file and nothing more.
 *
 * The page is Obsidian's own `help.html`, because it already loads `app.css` and with it Obsidian's
 * print stylesheet. That stylesheet shows `div.print` and hides everything else (a page without the
 * wrapper printed blank), and `help.html` hard-codes `theme-dark` and knows nothing of the vault's
 * theme, snippets or fonts. So the main window's body classes, body style and head styles travel
 * with the note, with `theme-light` in place of `theme-dark` in every vault: the tablet is a page.
 *
 * **Every wait is bounded.** On Obsidian 1.13.4 to 1.15.0 a hidden window's timers may be throttled,
 * and the user is standing in front of a send; the worst case has to be the failure notice, never a
 * send that hangs.
 */

import { type PrintPage, printOptions, printStylesheet, type PrintToPdfOptions, SEND_CLASS } from "./note-print";

/** What a print is made of: the dressed note, the PDF's title (the file's name) and its page. */
export interface PrintDocument {
	/** The rendered and dressed note, as the inner HTML of the note's view. */
	readonly html: string;
	readonly title: string;
	readonly page: PrintPage;
	/**
	 * The passes that measure layout (spec §4.3, passes 5–7), as the source of a function
	 * `(view, page) => void | Promise<void>` that runs in the print page: there the width is the
	 * printed width, and in the main window it is not. Written by the note's dressing (ticket 12).
	 */
	readonly layout?: string;
}

/**
 * Why nothing was printed, as the send's notice says it (spec §4.5's table, and §8 for `busy`).
 *
 * `restartFirst` is set when a print was refused on Electron below 40: there every PDF print of the
 * app waits on one promise, and a refused one leaves it refused until Obsidian restarts (research
 * 02), so trying again without a restart only fails again. The notice appends
 * {@link RESTART_SENTENCE} after its reason.
 */
export class PrintFailure extends Error {
	constructor(
		readonly kind: "unsupported" | "timeout" | "failed" | "busy",
		readonly reason: string,
		readonly restartFirst = false,
	) {
		super(reason);
		this.name = "PrintFailure";
	}
}

export const RESTART_SENTENCE = "Restart Obsidian before you try again.";

/** As much of a `<webview>` as a print needs. Narrow on purpose, so a test can be a plain object. */
export interface PrintWebview {
	addEventListener(type: "dom-ready", listener: () => void, options: { once: true }): void;
	/** Missing where Obsidian runs without the `<webview>` tag: the element is then a plain unknown one. */
	executeJavaScript?: (code: string) => Promise<unknown>;
	printToPDF?: (options: PrintToPdfOptions) => Promise<Uint8Array>;
	remove(): void;
}

/** The main window's look, as the print page has to copy it. */
export interface WindowStyles {
	readonly bodyClass: string;
	readonly bodyStyle: string;
	/** The text of every `<style>` in the head: the theme, the user's snippets, MathJax. */
	readonly headStyles: readonly string[];
}

/** What the print surface takes from its surroundings, handed in so the order of it can be tested. */
export interface PrintHost {
	/** A `<webview>` with these attributes, attached to the document. */
	createWebview(attributes: Record<string, string>): PrintWebview;
	windowStyles(): WindowStyles;
	/** `process.versions.electron`. */
	readonly electronVersion: string;
	setTimeout(callback: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

/** The page every print is laid out in. `app://` so it loads Obsidian's own `app.css`. */
export const PRINT_PAGE_URL = "app://obsidian.md/help.html";

export const DOM_READY_TIMEOUT_MS = 15_000;
/** Per image, all at once: one image from a slow server must not stop the note. */
export const IMAGE_TIMEOUT_MS = 5_000;
export const FONTS_TIMEOUT_MS = 5_000;
/**
 * Everything the print page does: styles, the note, the images, the fonts and the layout passes.
 * The in-page waits are bounded on their own; this one guards against a page that stops answering.
 */
export const PAGE_TIMEOUT_MS = 30_000;
/** The prototype printed a long note in under two seconds; a minute is a print that is stuck. */
export const PRINT_TIMEOUT_MS = 60_000;

/**
 * The webview's height. Its width is the text column's, so that heights measured in the page --
 * the keep-whole pass -- are the printed heights; the height only has to be real.
 */
const WEBVIEW_HEIGHT_PX = 1000;

let printing = false;

/**
 * The dressed note as a PDF on its page, or a {@link PrintFailure}.
 *
 * One print at a time: a second webview beside the first would double the memory for nothing, and
 * on Electron below 40 two prints share one queue anyway.
 */
export async function printHtmlToPdf(document: PrintDocument, host: PrintHost = obsidianHost()): Promise<Uint8Array> {
	if (printing) throw new PrintFailure("busy", "Another send is still running.");
	printing = true;
	try {
		return await print(document, host);
	} finally {
		printing = false;
	}
}

async function print({ html, title, page, layout }: PrintDocument, host: PrintHost): Promise<Uint8Array> {
	// Checked before anything is created: on Electron below 40 a print refused for a bad number
	// would block every later one until a restart.
	let options: PrintToPdfOptions;
	try {
		options = printOptions(page);
	} catch (error) {
		throw new PrintFailure("failed", messageOf(error));
	}

	const webview = host.createWebview({
		src: PRINT_PAGE_URL,
		style: `position: fixed; left: -20000px; top: 0; width: ${page.columnPx}px; height: ${WEBVIEW_HEIGHT_PX}px;`,
	});
	try {
		if (!canPrint(webview)) throw new PrintFailure("unsupported", "this Obsidian cannot print in the background");

		const ready = await within(
			host,
			new Promise<true>((resolve) => webview.addEventListener("dom-ready", () => resolve(true), { once: true })),
			DOM_READY_TIMEOUT_MS,
		);
		if (ready === undefined) throw new PrintFailure("timeout", "the print view did not open");

		let laidOut: unknown;
		try {
			laidOut = await within(host, webview.executeJavaScript(pageScript(html, title, page, layout, host.windowStyles())), PAGE_TIMEOUT_MS);
		} catch (error) {
			throw new PrintFailure("failed", messageOf(error));
		}
		if (laidOut === undefined) throw new PrintFailure("timeout", "the print view stopped answering");

		const restartFirst = electronMajor(host.electronVersion) < 40;
		let bytes: Uint8Array | undefined;
		try {
			bytes = await within(host, webview.printToPDF(options), PRINT_TIMEOUT_MS);
		} catch (error) {
			throw new PrintFailure("failed", messageOf(error), restartFirst);
		}
		if (bytes === undefined) throw new PrintFailure("failed", `the print did not finish in ${PRINT_TIMEOUT_MS / 1000} seconds`, restartFirst);
		if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new PrintFailure("failed", "the print came back empty", restartFirst);
		return bytes;
	} finally {
		webview.remove();
	}
}

/**
 * The script the print page runs, ending in `true` once the note is ready to print.
 *
 * Built as text because `executeJavaScript` takes text: everything it needs travels as one JSON
 * literal, and the layout passes as a function's source.
 */
export function pageScript(html: string, title: string, page: PrintPage, layout: string | undefined, styles: WindowStyles): string {
	const payload = {
		html,
		title,
		page,
		bodyClass: lightBodyClass(styles.bodyClass),
		bodyStyle: styles.bodyStyle,
		// Ours last, so it wins over the theme and the user's snippets (spec §4.4).
		styles: [...styles.headStyles, printStylesheet(page)],
		viewClass: `markdown-preview-view markdown-rendered ${SEND_CLASS}`,
		imageMs: IMAGE_TIMEOUT_MS,
		fontsMs: FONTS_TIMEOUT_MS,
	};
	return `(async () => {
	const P = ${JSON.stringify(payload)};
	const bounded = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
	document.title = P.title;
	document.body.className = P.bodyClass;
	document.body.setAttribute("style", P.bodyStyle);
	for (const text of P.styles) {
		const style = document.createElement("style");
		style.textContent = text;
		document.head.appendChild(style);
	}
	const wrapper = document.createElement("div");
	wrapper.className = "print";
	const view = document.createElement("div");
	view.className = P.viewClass;
	view.innerHTML = P.html;
	wrapper.appendChild(view);
	document.body.replaceChildren(wrapper);
	await Promise.all(Array.from(document.images, (img) => img.complete ? null : bounded(new Promise((resolve) => {
		img.addEventListener("load", resolve, { once: true });
		img.addEventListener("error", resolve, { once: true });
	}), P.imageMs)));
	await bounded(document.fonts.ready, P.fontsMs);
	${layout === undefined ? "" : `await (${layout})(view, P.page);`}
	return true;
})()`;
}

/** Always light: the tablet is a page, whatever the vault looks like on a screen (research 01). */
export function lightBodyClass(bodyClass: string): string {
	const classes = bodyClass.split(/\s+/).filter((name) => name !== "" && name !== "theme-dark");
	return classes.includes("theme-light") ? classes.join(" ") : [...classes, "theme-light"].join(" ");
}

/**
 * Whether the element really is a `<webview>`. Without the tag, `createEl("webview")` still gives an
 * element -- an unknown one, with neither method.
 */
function canPrint(webview: PrintWebview): webview is Required<PrintWebview> {
	return typeof webview.executeJavaScript === "function" && typeof webview.printToPDF === "function";
}

/** The promise's value, or `undefined` once `ms` have passed without one. */
function within<T>(host: PrintHost, promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer = 0;
	const expiry = new Promise<undefined>((resolve) => {
		timer = host.setTimeout(() => resolve(undefined), ms);
	});
	return Promise.race([promise, expiry]).finally(() => host.clearTimeout(timer));
}

/** `NaN` for a version that is not one, which compares as neither below nor above 40. */
function electronMajor(version: string): number {
	return Number.parseInt(version.split(".")[0], 10);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The surroundings in Obsidian: its active document, the Electron it runs on, and the main window's
 * timers. Not the active window's: a pop-out's timers never fire once it closes (Obsidian 1.15.1),
 * and these are the deadlines that end a print which hangs.
 */
export function obsidianHost(): PrintHost {
	const doc = activeDocument;
	return {
		createWebview(attributes) {
			// Attributes before attaching: a webview starts loading `src` as soon as it is in the document.
			// The cast because Obsidian types `createEl` for the tags the DOM knows, and `webview` is
			// Electron's.
			const webview = createEl("webview" as keyof HTMLElementTagNameMap, { attr: attributes });
			doc.body.appendChild(webview);
			return webview;
		},
		windowStyles: () => ({
			bodyClass: doc.body.className,
			bodyStyle: doc.body.getAttribute("style") ?? "",
			headStyles: Array.from(doc.head.querySelectorAll("style"), (style) => style.textContent ?? ""),
		}),
		electronVersion: process.versions.electron ?? "",
		setTimeout: (callback, ms) => window.setTimeout(callback, ms),
		clearTimeout: (id) => window.clearTimeout(id),
	};
}
