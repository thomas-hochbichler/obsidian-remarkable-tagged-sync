import { afterEach, describe, expect, it, vi } from "vitest";
import { printPage, printStylesheet, SEND_CLASS } from "./note-print";
import {
	DOM_READY_TIMEOUT_MS,
	lightBodyClass,
	obsidianHost,
	PAGE_TIMEOUT_MS,
	pageScript,
	PRINT_PAGE_URL,
	PRINT_TIMEOUT_MS,
	PrintFailure,
	type PrintDocument,
	type PrintHost,
	printHtmlToPdf,
	type PrintWebview,
} from "./print-surface";

const page = printPage({ tablet: "rm12", textSize: "normal", toolbarRight: false });
const note: PrintDocument = { html: "<h2>Login</h2><p>Text</p>", title: "Login-Spec", page };
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

/**
 * A `<webview>` that records every call in order. `dom-ready` arrives on the next tick unless the
 * test holds it back; the two methods answer as the test sets them.
 */
function fakeWebview(options: { domReady?: boolean; methods?: boolean } = {}) {
	const calls: string[] = [];
	const webview = {
		calls,
		attributes: {} as Record<string, string>,
		script: "",
		printOptions: undefined as unknown,
		pageResult: Promise.resolve<unknown>(true),
		printResult: Promise.resolve<Uint8Array>(PDF),
		addEventListener(type: "dom-ready", listener: () => void) {
			calls.push(`listen ${type}`);
			if (options.domReady !== false) queueMicrotask(listener);
		},
		executeJavaScript(code: string) {
			calls.push("executeJavaScript");
			webview.script = code;
			return webview.pageResult;
		},
		printToPDF(printOptions: unknown) {
			calls.push("printToPDF");
			webview.printOptions = printOptions;
			return webview.printResult;
		},
		remove() {
			calls.push("remove");
		},
	};
	if (options.methods === false) {
		return Object.assign(webview, { executeJavaScript: undefined, printToPDF: undefined });
	}
	return webview;
}

/** Timers that fire only when the test says so, by how long they were set for. */
function fakeHost(webview: PrintWebview & { calls: string[]; attributes: Record<string, string> }, electronVersion = "43.8.9") {
	const timers = new Map<number, { ms: number; callback: () => void }>();
	let next = 1;
	const host: PrintHost & { expire(ms: number): void; pending(): number[] } = {
		createWebview(attributes) {
			webview.calls.push("create");
			webview.attributes = attributes;
			return webview;
		},
		windowStyles: () => ({ bodyClass: "theme-dark mod-macos", bodyStyle: "--font-text-size: 16px;", headStyles: [".theme { color: red; }"] }),
		electronVersion,
		setTimeout(callback, ms) {
			timers.set(next, { ms, callback });
			return next++;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		expire(ms) {
			for (const [id, timer] of timers) {
				if (timer.ms !== ms) continue;
				timers.delete(id);
				timer.callback();
			}
		},
		pending: () => [...timers.values()].map((timer) => timer.ms),
	};
	return host;
}

/** Lets the print run up to the next wait that only a timer can end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function failure(promise: Promise<unknown>): Promise<PrintFailure> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(PrintFailure);
	return error as PrintFailure;
}

describe("printHtmlToPdf", () => {
	it("opens the print page, waits for it, lays the note out, prints, and removes the webview", async () => {
		const webview = fakeWebview();
		const host = fakeHost(webview);

		const bytes = await printHtmlToPdf(note, host);

		expect(bytes).toBe(PDF);
		expect(webview.calls).toEqual(["create", "listen dom-ready", "executeJavaScript", "printToPDF", "remove"]);
		expect(webview.attributes.src).toBe(PRINT_PAGE_URL);
		expect(host.pending()).toEqual([]);
	});

	it("gives the webview the text column's width and a real height, off the screen", async () => {
		const webview = fakeWebview();

		await printHtmlToPdf(note, fakeHost(webview));

		expect(webview.attributes.style).toContain("width: 486px");
		expect(webview.attributes.style).toContain("height: 1000px");
		expect(webview.attributes.style).toContain("left: -20000px");
	});

	it("prints with the page's own options, the outline among them", async () => {
		const webview = fakeWebview();

		await printHtmlToPdf(note, fakeHost(webview));

		expect(webview.printOptions).toEqual({
			pageSize: { width: page.widthIn, height: page.heightIn },
			margins: page.margins,
			printBackground: true,
			generateDocumentOutline: true,
			generateTaggedPDF: true,
		});
	});

	it("says this Obsidian cannot print in the background when the element is no webview", async () => {
		const webview = fakeWebview({ methods: false });

		const error = await failure(printHtmlToPdf(note, fakeHost(webview)));

		expect(error.kind).toBe("unsupported");
		expect(error.reason).toBe("this Obsidian cannot print in the background");
		expect(webview.calls).toEqual(["create", "remove"]);
	});

	it("gives up after 15 s without dom-ready: the print view did not open", async () => {
		const webview = fakeWebview({ domReady: false });
		const host = fakeHost(webview);

		const printing = printHtmlToPdf(note, host);
		await settle();
		expect(host.pending()).toEqual([DOM_READY_TIMEOUT_MS]);
		host.expire(DOM_READY_TIMEOUT_MS);
		const error = await failure(printing);

		expect(error.kind).toBe("timeout");
		expect(error.reason).toBe("the print view did not open");
		expect(webview.calls).not.toContain("executeJavaScript");
		expect(webview.calls.at(-1)).toBe("remove");
	});

	it("gives up on a print page that stops answering, and never prints", async () => {
		const webview = fakeWebview();
		webview.pageResult = new Promise(() => {});
		const host = fakeHost(webview);

		const printing = printHtmlToPdf(note, host);
		await settle();
		host.expire(PAGE_TIMEOUT_MS);
		const error = await failure(printing);

		expect(error.kind).toBe("timeout");
		expect(error.reason).toBe("the print view stopped answering");
		expect(webview.calls).not.toContain("printToPDF");
		expect(webview.calls.at(-1)).toBe("remove");
	});

	it("passes on the message of a layout pass that threw, and never prints", async () => {
		const webview = fakeWebview();
		webview.pageResult = Promise.reject(new Error("view is null"));

		const error = await failure(printHtmlToPdf(note, fakeHost(webview)));

		expect(error.kind).toBe("failed");
		expect(error.reason).toBe("view is null");
		expect(error.restartFirst).toBe(false);
		expect(webview.calls).not.toContain("printToPDF");
		expect(webview.calls.at(-1)).toBe("remove");
	});

	it("passes on a refused print's message, without the restart sentence on Electron 40 and later", async () => {
		const webview = fakeWebview();
		webview.printResult = Promise.reject(new Error("Printing failed"));

		const error = await failure(printHtmlToPdf(note, fakeHost(webview, "40.0.0")));

		expect(error.kind).toBe("failed");
		expect(error.reason).toBe("Printing failed");
		expect(error.restartFirst).toBe(false);
		expect(webview.calls.at(-1)).toBe("remove");
	});

	it("passes on a refusal that is not an Error as its text", async () => {
		const webview = fakeWebview();
		webview.printResult = Promise.reject("Printing failed");

		const error = await failure(printHtmlToPdf(note, fakeHost(webview)));

		expect(error.reason).toBe("Printing failed");
	});

	it("asks for a restart after a refused print below Electron 40, where one refusal blocks every later print", async () => {
		const webview = fakeWebview();
		webview.printResult = Promise.reject(new Error("Printing failed"));

		const error = await failure(printHtmlToPdf(note, fakeHost(webview, "39.2.1")));

		expect(error.reason).toBe("Printing failed");
		expect(error.restartFirst).toBe(true);
	});

	it("takes an empty answer from the print as a failure", async () => {
		const webview = fakeWebview();
		webview.printResult = Promise.resolve(new Uint8Array(0));

		const error = await failure(printHtmlToPdf(note, fakeHost(webview, "38.0.0")));

		expect(error.kind).toBe("failed");
		expect(error.reason).toBe("the print came back empty");
		expect(error.restartFirst).toBe(true);
		expect(webview.calls.at(-1)).toBe("remove");
	});

	it("gives up on a print that does not finish in a minute", async () => {
		const webview = fakeWebview();
		webview.printResult = new Promise(() => {});
		const host = fakeHost(webview);

		const printing = printHtmlToPdf(note, host);
		await settle();
		host.expire(PRINT_TIMEOUT_MS);
		const error = await failure(printing);

		expect(error.kind).toBe("failed");
		expect(error.reason).toBe("the print did not finish in 60 seconds");
		expect(webview.calls.at(-1)).toBe("remove");
	});

	it("refuses a page with impossible numbers before it creates anything", async () => {
		const webview = fakeWebview();

		const error = await failure(printHtmlToPdf({ ...note, page: { ...page, widthIn: Number.NaN } }, fakeHost(webview)));

		expect(error.kind).toBe("failed");
		expect(error.reason).toContain("widthIn");
		expect(webview.calls).toEqual([]);
	});

	it("prints one note at a time: a second print while one runs is told another send is running", async () => {
		const webview = fakeWebview({ domReady: false });
		const host = fakeHost(webview);

		const first = printHtmlToPdf(note, host);
		const second = await failure(printHtmlToPdf(note, fakeHost(fakeWebview())));
		host.expire(DOM_READY_TIMEOUT_MS);
		await failure(first);

		expect(second.kind).toBe("busy");
		expect(second.reason).toBe("Another send is still running.");
		await expect(printHtmlToPdf(note, fakeHost(fakeWebview()))).resolves.toBe(PDF);
	});
});

describe("pageScript", () => {
	const styles = { bodyClass: "theme-dark mod-macos", bodyStyle: "--font-text-size: 16px;", headStyles: [".theme { color: red; }"] };

	/** What the script carries, read back out of its JSON literal. */
	function payload(script: string) {
		const json = /const P = (.*);\n/.exec(script)?.[1];
		return JSON.parse(json ?? "null") as { html: string; title: string; bodyClass: string; bodyStyle: string; styles: string[]; viewClass: string };
	}

	it("carries the note, its title and the main window's look, light, with our stylesheet last", () => {
		const carried = payload(pageScript(note.html, note.title, page, undefined, styles));

		expect(carried.html).toBe(note.html);
		expect(carried.title).toBe("Login-Spec");
		expect(carried.bodyClass).toBe("mod-macos theme-light");
		expect(carried.bodyStyle).toBe("--font-text-size: 16px;");
		expect(carried.styles).toEqual([".theme { color: red; }", printStylesheet(page)]);
	});

	it("puts the note in div.print, the one wrapper Obsidian's print stylesheet shows, under the public class", () => {
		const script = pageScript(note.html, note.title, page, undefined, styles);

		expect(payload(script).viewClass).toBe(`markdown-preview-view markdown-rendered ${SEND_CLASS}`);
		expect(script).toContain(`wrapper.className = "print"`);
	});

	it("waits for every image and for the fonts, each bounded", () => {
		const script = pageScript(note.html, note.title, page, undefined, styles);

		expect(script).toContain(`img.addEventListener("load"`);
		expect(script).toContain(`img.addEventListener("error"`);
		expect(script).toContain("bounded(document.fonts.ready, P.fontsMs)");
	});

	it("runs the layout passes after the images and fonts, on the view and the page", () => {
		const script = pageScript(note.html, note.title, page, "(view, page) => view.dataset.done = page.columnPx", styles);

		expect(script).toContain("await ((view, page) => view.dataset.done = page.columnPx)(view, P.page);");
		expect(script.indexOf("document.fonts.ready")).toBeLessThan(script.indexOf("(view, P.page)"));
	});

	it("is a script that parses, with and without layout passes", () => {
		for (const layout of [undefined, "async (view) => {}"]) {
			expect(() => new Function(`return ${pageScript("<p>`${x}`</p> ", 'A "quoted" name', page, layout, styles)}`)).not.toThrow();
		}
	});
});

describe("lightBodyClass", () => {
	it("replaces theme-dark by theme-light and keeps every other class", () => {
		expect(lightBodyClass("theme-dark mod-macos is-focused")).toBe("mod-macos is-focused theme-light");
	});

	it("leaves a light body light, without a second theme-light", () => {
		expect(lightBodyClass("theme-light  mod-macos")).toBe("theme-light mod-macos");
	});
});

describe("obsidianHost", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("attaches the webview to the active document and reads the look from it", () => {
		const steps: string[] = [];
		const created = { tag: "" };
		const style = (text: string | null) => ({ textContent: text });
		vi.stubGlobal("createEl", (tag: string, options: { attr: Record<string, string> }) => {
			steps.push(...Object.entries(options.attr).map(([name, value]) => `${name}=${value}`));
			return Object.assign(created, { tag });
		});
		vi.stubGlobal("activeDocument", {
			body: {
				className: "theme-dark",
				getAttribute: () => null,
				appendChild: (el: unknown) => steps.push(el === created ? "attached" : "something else"),
			},
			head: { querySelectorAll: () => [style(".a {}"), style(null)] },
		});
		const clearTimeout = vi.fn();
		vi.stubGlobal("window", { setTimeout: () => 7, clearTimeout });
		// A pop-out's timers never fire once it closes (Obsidian 1.15.1), so the deadlines must not use them.
		vi.stubGlobal("activeWindow", { setTimeout: () => 99, clearTimeout: vi.fn() });

		const host = obsidianHost();
		const webview = host.createWebview({ src: PRINT_PAGE_URL, style: "width: 486px" });

		expect(webview).toBe(created);
		expect(created.tag).toBe("webview");
		expect(steps).toEqual([`src=${PRINT_PAGE_URL}`, "style=width: 486px", "attached"]);
		expect(host.windowStyles()).toEqual({ bodyClass: "theme-dark", bodyStyle: "", headStyles: [".a {}", ""] });
		expect(host.setTimeout(() => {}, 5)).toBe(7);
		host.clearTimeout(7);
		expect(clearTimeout).toHaveBeenCalledWith(7);
		expect(host.electronVersion).toBe(process.versions.electron ?? "");
	});
});
