import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DIAGRAM_TIMEOUT_MS,
	dressNote,
	isEmptyNote,
	layoutPasses,
	layoutSource,
	obsidianRenderHost,
	printNote,
	type RenderHost,
	renderNote,
	SETTLE_MS,
} from "./note-document";
import { CAPTION_CLASS, KEEP_WHOLE_CLASS, MISSING_EMBED_CLASS, printPage } from "./note-print";
import { PrintFailure } from "./print-surface";

const obsidian = vi.hoisted(() => ({
	calls: [] as string[],
	renderError: null as Error | null,
}));

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		Component: class {
			load() {
				obsidian.calls.push("load");
			}
			unload() {
				obsidian.calls.push("unload");
			}
		},
		MarkdownRenderer: {
			render: async (_app: unknown, markdown: string, _el: unknown, sourcePath: string, component: unknown) => {
				obsidian.calls.push(`render ${sourcePath} ${markdown} ${component === undefined ? "without" : "with"} component`);
				if (obsidian.renderError) throw obsidian.renderError;
			},
		},
	};
});

// --- a DOM small enough to read ---------------------------------------------------------------
//
// What the passes touch and nothing more: elements and text, classes and attributes, the
// selectors they use (tags, classes, a descendant step, comma lists), and a layout the test sets
// by hand. Built from markup the renderer really emitted (test-fixtures/rendered-notes/).

type Tree = string | { t: string; a: Record<string, string>; c: Tree[] };

class FakeText {
	parent: FakeElement | null = null;
	constructor(public text: string) {}
}

class FakeElement {
	parent: FakeElement | null = null;
	nodes: (FakeElement | FakeText)[] = [];
	readonly attrs = new Map<string, string>();
	readonly style = new FakeStyle();
	/** Layout, as the test sets it: what `getBoundingClientRect` answers. */
	rect = { left: 0, height: 0 };
	/** What `getComputedStyle` answers for this element. */
	computed: Record<string, string> = {};
	viewBox?: { baseVal: { width: number } };

	constructor(readonly tag: string) {}

	get tagName(): string {
		return this.tag.toUpperCase();
	}
	get children(): FakeElement[] {
		return this.nodes.filter((node): node is FakeElement => node instanceof FakeElement);
	}
	get firstElementChild(): FakeElement | null {
		return this.children[0] ?? null;
	}
	get lastElementChild(): FakeElement | null {
		return this.children.at(-1) ?? null;
	}
	get parentElement(): FakeElement | null {
		return this.parent;
	}
	get previousElementSibling(): FakeElement | null {
		const siblings = this.parent?.children ?? [];
		return siblings[siblings.indexOf(this) - 1] ?? null;
	}
	get classList() {
		const names = () => (this.attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
		return {
			contains: (name: string) => names().includes(name),
			add: (name: string) => {
				if (!names().includes(name)) this.attrs.set("class", [...names(), name].join(" "));
			},
		};
	}
	set className(value: string) {
		this.attrs.set("class", value);
	}
	get textContent(): string {
		return this.nodes.map((node) => (node instanceof FakeText ? node.text : node.textContent)).join("");
	}
	set textContent(value: string) {
		this.nodes = [];
		this.append(new FakeText(value));
	}
	get innerHTML(): string {
		return this.nodes.map((node) => (node instanceof FakeText ? escape(node.text) : node.outerHTML)).join("");
	}
	get outerHTML(): string {
		const attrs = [...this.attrs].map(([name, value]) => ` ${name}="${escape(value)}"`).join("");
		return `<${this.tag}${attrs}>${this.innerHTML}</${this.tag}>`;
	}
	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}
	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}
	append(node: FakeElement | FakeText): void {
		node.parent = this;
		this.nodes.push(node);
	}
	prepend(node: FakeElement): void {
		node.parent = this;
		this.nodes.unshift(node);
	}
	remove(): void {
		if (this.parent) this.parent.nodes = this.parent.nodes.filter((node) => node !== this);
		this.parent = null;
	}
	replaceWith(node: FakeElement): void {
		const siblings = this.parent?.nodes ?? [];
		node.parent = this.parent;
		siblings[siblings.indexOf(this)] = node;
		this.parent = null;
	}
	getBoundingClientRect() {
		return this.rect;
	}
	closest(selector: string): FakeElement | null {
		for (let el: FakeElement | null = this; el !== null; el = el.parent) if (matches(el, selector)) return el;
		return null;
	}
	querySelectorAll(selector: string): FakeElement[] {
		const found: FakeElement[] = [];
		const walk = (el: FakeElement) => {
			for (const child of el.children) {
				if (matches(child, selector, this)) found.push(child);
				walk(child);
			}
		};
		walk(this);
		return found;
	}
	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

class FakeStyle {
	width = "";
	readonly set = new Map<string, string>();
	setProperty(name: string, value: string, priority: string): void {
		this.set.set(name, `${value} ${priority}`);
	}
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `tag.class.class`, one step of a selector. */
function matchesCompound(el: FakeElement, compound: string): boolean {
	const [tag, ...classes] = compound.split(".");
	return (tag === "" || tag.toLowerCase() === el.tag.toLowerCase()) && classes.every((name) => el.classList.contains(name));
}

/** A comma list of descendant chains, the last step on `el`, the others on its ancestors below `scope`. */
function matches(el: FakeElement, selector: string, scope?: FakeElement): boolean {
	return selector.split(",").some((part) => {
		const steps = part.trim().split(/\s+/);
		if (!matchesCompound(el, steps.pop() ?? "")) return false;
		let ancestor = el.parent;
		for (const step of steps.reverse()) {
			while (ancestor !== null && ancestor !== scope && !matchesCompound(ancestor, step)) ancestor = ancestor.parent;
			if (ancestor === null || ancestor === scope) return false;
			ancestor = ancestor.parent;
		}
		return true;
	});
}

function build(tree: Tree): FakeElement | FakeText {
	if (typeof tree === "string") return new FakeText(tree);
	const el = new FakeElement(tree.t);
	for (const [name, value] of Object.entries(tree.a)) el.attrs.set(name, value);
	for (const child of tree.c) el.append(build(child));
	return el;
}

/** A reading view holding what the renderer emitted for one of the captured notes. */
function rendered(fixture: string): FakeElement {
	const { children } = JSON.parse(readFileSync(`./test-fixtures/rendered-notes/${fixture}.json`, "utf8")) as { children: Tree[] };
	const view = new FakeElement("div");
	view.className = "markdown-preview-view markdown-rendered";
	for (const child of children) view.append(build(child));
	return view;
}

/** A small tree by hand: `el("p", { class: "x" }, "text", el(...))`. */
function el(tag: string, attrs: Record<string, string> = {}, ...children: (FakeElement | string)[]): FakeElement {
	const element = new FakeElement(tag);
	for (const [name, value] of Object.entries(attrs)) element.attrs.set(name, value);
	for (const child of children) element.append(typeof child === "string" ? new FakeText(child) : child);
	return element;
}

const asView = (view: FakeElement) => view as unknown as HTMLElement;
const dress = (view: FakeElement, title: string) => dressNote(asView(view), title);
const texts = (els: FakeElement[]) => els.map((e) => e.textContent.trim());

const rm2 = { tablet: "rm12", textSize: "normal", toolbarRight: false } as const;
const page = printPage(rm2);

// Obsidian's own element helpers, which the dressing uses: here they make fake elements.
beforeEach(() => {
	const createEl = (tag: string, options: { cls?: string; text?: string } = {}) =>
		el(tag, options.cls === undefined ? {} : { class: options.cls }, ...(options.text === undefined ? [] : [options.text]));
	vi.stubGlobal("createEl", createEl);
	vi.stubGlobal("createSpan", (options: { cls?: string; text?: string }) => createEl("span", options));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("isEmptyNote", () => {
	it("calls a note empty when nothing but whitespace follows its properties", () => {
		expect(isEmptyNote("---\ntags:\n  - case\n---\n\n   \n")).toBe(true);
		expect(isEmptyNote("---\r\ntags: [a]\r\n---\r\n \r\n")).toBe(true);
		expect(isEmptyNote("---\n---\n")).toBe(true);
		expect(isEmptyNote(" \n\t\n")).toBe(true);
		expect(isEmptyNote("")).toBe(true);
	});

	it("does not call a note empty that shows anything, an image alone included", () => {
		expect(isEmptyNote("![[case-pic.png]]\n")).toBe(false);
		expect(isEmptyNote("---\ntags: [a]\n---\nText")).toBe(false);
		// Not properties: the closing line is missing, so the renderer shows the dashes as a rule.
		expect(isEmptyNote("---\ntext without a closing line\n")).toBe(false);
	});
});

describe("dressNote", () => {
	it("puts the file's name on top as an h1, and drops the hidden properties block", () => {
		const view = rendered("spec-lesezeichen-sync");
		expect(view.firstElementChild?.classList.contains("frontmatter")).toBe(true);

		dress(view, "Spec Lesezeichen-Sync");

		expect(view.firstElementChild?.outerHTML).toBe("<h1>Spec Lesezeichen-Sync</h1>");
		expect(view.querySelectorAll("pre.frontmatter")).toEqual([]);
	});

	it("gives a note that starts with its own h1 that title only", () => {
		const view = rendered("starts-with-h1");

		dress(view, "Case Starts with h1");

		expect(texts(view.querySelectorAll("h1"))).toEqual(["Its own title"]);
		expect(view.firstElementChild?.textContent).toBe("Its own title");
	});

	it("titles a note whose first block is no h1, even one holding only an image", () => {
		const view = rendered("only-an-image");

		dress(view, "Case Only an image");

		expect(view.firstElementChild?.outerHTML).toBe("<h1>Case Only an image</h1>");
		expect(view.querySelectorAll("img")).toHaveLength(1);
	});

	it("writes the title as text, never as markup", () => {
		const view = el("div", {}, el("p", {}, "Text"));

		dress(view, "A <b> & C");

		expect(view.firstElementChild?.outerHTML).toBe("<h1>A &lt;b&gt; &amp; C</h1>");
	});

	it("replaces each PDF, audio, video and canvas embed by one line naming its file", () => {
		const view = rendered("embeds");

		dress(view, "Case Embeds");

		expect(texts(view.querySelectorAll(`.${MISSING_EMBED_CLASS}`))).toEqual([
			"case-doc.pdf (not included)",
			"case-doc.pdf (not included)",
			"case-sound.mp3 (not included)",
			"case-clip.mp4 (not included)",
			"case-board.canvas (not included)",
		]);
		expect(view.querySelectorAll(".pdf-embed, .audio-embed, .video-embed, .canvas-embed, audio, video")).toEqual([]);
		expect(view.querySelectorAll(`p span.${MISSING_EMBED_CLASS}`)).toHaveLength(5);
	});

	it("keeps the box Obsidian draws for an embed whose target does not exist, and every image and embedded note", () => {
		const view = rendered("embeds");

		dress(view, "Case Embeds");

		expect(texts(view.querySelectorAll(".file-embed"))).toEqual([
			'"Missing note" ist noch nicht erstellt. Klicken zum Erstellen.',
			"“missing-file.pdf” konnte nicht gefunden werden.",
		]);
		expect(view.querySelectorAll(".image-embed img")).toHaveLength(3);
		expect(view.querySelectorAll(".markdown-embed table")).toHaveLength(2);
	});

	it("names an embedded file without its folder, and finds one inside an embedded note", () => {
		const view = el(
			"div",
			{},
			el("p", {}, el("span", { class: "internal-embed markdown-embed", src: "Bausteine/Teil" }, el("div", { class: "markdown-embed-content" }, el("p", {}, el("span", { class: "internal-embed pdf-embed", src: "Anhänge/Plan.pdf#page=3" }))))),
		);

		dress(view, "Note");

		expect(texts(view.querySelectorAll(`.markdown-embed .${MISSING_EMBED_CLASS}`))).toEqual(["Plan.pdf (not included)"]);
	});

	it("still says what is missing for an embed without a link", () => {
		const view = el("div", {}, el("p", {}, el("span", { class: "internal-embed video-embed" })), el("p", {}, el("span", { class: "internal-embed audio-embed", src: "" })));

		dress(view, "Note");

		expect(texts(view.querySelectorAll(`.${MISSING_EMBED_CLASS}`))).toEqual(["An embedded file (not included)", "An embedded file (not included)"]);
	});

	it("takes the address off every internal link and leaves web links and tags as they are", () => {
		const view = rendered("links");

		dress(view, "Case Links");

		const internal = view.querySelectorAll("a.internal-link");
		expect(texts(internal)).toEqual(["Baustein Fehlertexte", "the error texts", "A heading", "Nowhere", "Fehlertexte"]);
		expect(internal.map((a) => a.getAttribute("href"))).toEqual([null, null, null, null, null]);
		expect(view.querySelectorAll("a.external-link").map((a) => a.getAttribute("href"))).toEqual(["https://example.com/page", "https://example.com/bare"]);
		expect(view.querySelector("a.tag")?.getAttribute("href")).toBe("#case");
	});

	it("marks a paragraph of nothing but emphasis right after an image or a diagram as its caption", () => {
		const spec = rendered("spec-lesezeichen-sync");
		const diagram = rendered("callouts-and-tasks");

		dress(spec, "Spec Lesezeichen-Sync");
		dress(diagram, "Case Callouts and tasks");

		expect(texts(spec.querySelectorAll(`.${CAPTION_CLASS}`))).toEqual(["Abbildung 1: Platzhalterbild, um zu sehen, wie ein Bild im Druck steht."]);
		expect(texts(diagram.querySelectorAll(`p.${CAPTION_CLASS}`))).toEqual(["Figure 1: where the position goes"]);
	});

	it("marks emphasis on the line right under an image, which Markdown keeps in the image's paragraph", () => {
		const view = rendered("embeds");

		dress(view, "Case Embeds");

		expect(texts(view.querySelectorAll(`.${CAPTION_CLASS}`))).toEqual(["A caption on the line right under the image", "A caption after a blank line"]);
		expect(view.querySelector(`em.${CAPTION_CLASS}`)?.textContent).toBe("A caption on the line right under the image");
	});

	it("takes no other emphasis for a caption: after a paragraph, mixed with text, or without an image before it", () => {
		const view = el(
			"div",
			{},
			el("p", {}, el("img", { src: "a.png" })),
			el("p", {}, el("em", {}, "Half a caption"), " and more text"),
			el("p", {}, "Plain"),
			el("p", {}, el("em", {}, "After plain text")),
			el("p", {}, "Words", el("br"), el("em", {}, "under words")),
			el("p", {}, el("em", {}, "One"), el("em", {}, "Two")),
		);

		dress(view, "Note");

		expect(view.querySelectorAll(`.${CAPTION_CLASS}`)).toEqual([]);
	});

	it("takes no caption for emphasis that opens a note: the title above it is no figure", () => {
		const view = el("div", {}, el("p", {}, el("em", {}, "First")));

		dress(view, "Note");

		expect(view.querySelectorAll(`.${CAPTION_CLASS}`)).toEqual([]);
	});

	it("dresses an empty note into its title alone", () => {
		const view = rendered("empty");

		dress(view, "Case Empty");

		expect(view.innerHTML).toBe("<h1>Case Empty</h1>");
	});
});

describe("layoutPasses", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const names = { keepWhole: KEEP_WHOLE_CLASS };
	const computedStyle = () => vi.stubGlobal("getComputedStyle", (element: FakeElement) => element.computed);

	/** A Mermaid diagram whose drawing is `viewBoxWidth` units wide, with labels `labelPx` high. */
	function diagram(viewBoxWidth: number | undefined, labelPx: number | null) {
		const svg = el("svg", { height: "300" });
		if (viewBoxWidth !== undefined) svg.viewBox = { baseVal: { width: viewBoxWidth } };
		if (labelPx !== null) {
			const label = el("text");
			label.computed = { fontSize: `${labelPx}px` };
			svg.append(label);
		}
		return { block: el("div", { class: "mermaid" }, svg), svg };
	}

	it("sizes a diagram by its type, so its labels print at the diagram size", () => {
		computedStyle();
		const { block, svg } = diagram(400, 16);

		layoutPasses(asView(el("div", {}, block)), page, names);

		// 8.5 pt is 11.33 px; a 400-unit drawing with 16 px labels is 283 px wide at that size. Mermaid's
		// height goes, so the stylesheet's `height: auto` keeps the drawing in proportion.
		expect(svg.style.width).toBe("283px");
		expect(svg.getAttribute("height")).toBeNull();
	});

	it("never sizes a diagram wider than the column", () => {
		computedStyle();
		const { block, svg } = diagram(2000, 16);

		layoutPasses(asView(el("div", {}, block)), page, names);

		expect(svg.style.width).toBe(`${page.columnPx}px`);
	});

	it("leaves a diagram alone that has no viewBox or no label", () => {
		computedStyle();
		const noViewBox = diagram(undefined, 16);
		const noLabel = diagram(400, null);
		const zeroLabel = diagram(400, 0);

		layoutPasses(asView(el("div", {}, noViewBox.block, noLabel.block, zeroLabel.block)), page, names);

		for (const { svg } of [noViewBox, noLabel, zeroLabel]) {
			expect(svg.style.width).toBe("");
			expect(svg.getAttribute("height")).toBe("300");
		}
	});

	it("shifts a top-level task list so its first box starts 5 px inside the column", () => {
		computedStyle();
		const box = el("input", { class: "task-list-item-checkbox" });
		const list = el("ul", { class: "contains-task-list" }, el("li", { class: "task-list-item" }, box, "Task"));
		const view = el("div", {}, list);
		view.rect = { left: 100, height: 0 };
		view.computed = { paddingLeft: "0px" };
		list.computed = { marginLeft: "0px" };
		box.rect = { left: 98, height: 0 };

		layoutPasses(asView(view), page, names);

		expect(list.style.set.get("margin-inline-start")).toBe("7px important");
	});

	it("counts the view's own padding as outside the column, and leaves nested lists and lists without a box alone", () => {
		computedStyle();
		const box = el("input", { class: "task-list-item-checkbox" });
		const top = el("ul", { class: "contains-task-list" }, el("li", {}, box));
		const nested = el("ul", { class: "contains-task-list" }, el("li", {}, el("input", { class: "task-list-item-checkbox" })));
		const boxless = el("ul", { class: "contains-task-list" }, el("li", {}, "no box"));
		const view = el("div", {}, top, el("ol", {}, el("li", {}, "Item", nested)), boxless);
		view.rect = { left: 100, height: 0 };
		view.computed = { paddingLeft: "10px" };
		top.computed = { marginLeft: "4px" };
		box.rect = { left: 120, height: 0 };

		layoutPasses(asView(view), page, names);

		expect(top.style.set.get("margin-inline-start")).toBe("-1px important");
		expect(nested.style.set.size).toBe(0);
		expect(boxless.style.set.size).toBe(0);
	});

	it("keeps a block shorter than the keep-whole limit on one page and lets a longer one split", () => {
		computedStyle();
		const blocks = ["pre", "table", "blockquote", "img"].map((tag) => el(tag));
		const callout = el("div", { class: "callout" });
		const mermaid = el("div", { class: "mermaid" });
		const long = el("pre");
		for (const block of [...blocks, callout, mermaid]) block.rect = { left: 0, height: page.keepWholePx - 1 };
		long.rect = { left: 0, height: page.keepWholePx };

		layoutPasses(asView(el("div", {}, ...blocks, callout, mermaid, long)), page, names);

		for (const block of [...blocks, callout, mermaid]) expect(block.classList.contains(KEEP_WHOLE_CLASS)).toBe(true);
		expect(long.classList.contains(KEEP_WHOLE_CLASS)).toBe(false);
	});
});

describe("layoutSource", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("runs on its own, outside this module, with the class names handed in", () => {
		vi.stubGlobal("getComputedStyle", (element: FakeElement) => element.computed);
		const block = el("pre");
		block.rect = { left: 0, height: 10 };
		// `new Function` sees only globals: a reference to anything of this module would throw here.
		const layout = new Function(`return ${layoutSource()}`)() as (view: unknown, page: unknown) => void;

		layout(el("div", {}, block), page);

		expect(block.classList.contains(KEEP_WHOLE_CLASS)).toBe(true);
	});
});

/** A render that fills the view with `markup` and counts time only by its own sleeps. */
function fakeRender(options: { diagramsAfterMs?: number; markup?: () => FakeElement[]; fail?: unknown } = {}) {
	const calls: string[] = [];
	let clock = 0;
	const view = el("div");
	const host: RenderHost & { calls: string[]; view: FakeElement } = {
		calls,
		view,
		createView(widthPx) {
			calls.push(`create ${widthPx}`);
			const remove = view.remove.bind(view);
			view.remove = () => {
				calls.push("remove");
				remove();
			};
			return asView(view);
		},
		async render(markdown, target, sourcePath) {
			calls.push(`render ${sourcePath}`);
			if (options.fail !== undefined) throw options.fail;
			for (const child of options.markup?.() ?? [el("p", {}, markdown)]) (target as unknown as FakeElement).append(child);
			return () => calls.push("unload");
		},
		async sleep(ms) {
			calls.push(`sleep ${ms}`);
			clock += ms;
			const after = options.diagramsAfterMs;
			if (after !== undefined && clock >= after) for (const block of view.querySelectorAll(".mermaid")) if (!block.querySelector("svg")) block.append(el("svg"));
		},
		now: () => clock,
	};
	return host;
}

const file = { path: "Specs/Login-Spec.md", basename: "Login-Spec" };

describe("renderNote", () => {
	it("renders at the column's width, settles, dresses, and hands back the markup before it unloads and removes the view", async () => {
		const host = fakeRender();

		const html = await renderNote(file, "Text", page, host);

		expect(html).toBe("<h1>Login-Spec</h1><p>Text</p>");
		expect(host.calls).toEqual([`create ${page.columnPx}`, "render Specs/Login-Spec.md", `sleep ${SETTLE_MS}`, "unload", "remove"]);
	});

	it("waits for the note's diagrams to be drawn before it settles", async () => {
		const host = fakeRender({ diagramsAfterMs: 300, markup: () => [el("div", { class: "mermaid" }), el("div", { class: "mermaid" })] });

		const html = await renderNote(file, "```mermaid\nflowchart LR\n```\n\n~~~ mermaid\nflowchart TB\n~~~\n", page, host);

		expect(host.calls.filter((call) => call === "sleep 100")).toHaveLength(3);
		expect(host.calls.at(-3)).toBe(`sleep ${SETTLE_MS}`);
		expect(html).toContain("<svg></svg>");
	});

	it("gives up on diagrams after 6 s and prints what is there", async () => {
		const host = fakeRender({ markup: () => [el("div", { class: "mermaid" })] });

		await renderNote(file, "```mermaid\nflowchart LR\n```", page, host);

		expect(host.calls.filter((call) => call === "sleep 100")).toHaveLength(DIAGRAM_TIMEOUT_MS / 100);
	});

	it("does not wait for diagrams that are drawn already", async () => {
		const host = fakeRender({ markup: () => [el("div", { class: "mermaid" }, el("svg"))] });

		await renderNote(file, "```mermaid\nflowchart LR\n```", page, host);

		expect(host.calls).not.toContain("sleep 100");
	});

	it("removes the view when the render throws, with nothing to unload", async () => {
		const host = fakeRender({ fail: new Error("render broke") });

		await expect(renderNote(file, "Text", page, host)).rejects.toThrow("render broke");

		expect(host.calls).toEqual([`create ${page.columnPx}`, "render Specs/Login-Spec.md", "remove"]);
	});
});

describe("printNote", () => {
	it("prints the dressed note on the chosen tablet's page, titled by the file, with the layout passes", async () => {
		const print = vi.fn(async () => new Uint8Array([1]));

		const bytes = await printNote(file, "Text", rm2, fakeRender(), print);

		expect(bytes).toEqual(new Uint8Array([1]));
		expect(print).toHaveBeenCalledWith({ html: "<h1>Login-Spec</h1><p>Text</p>", title: "Login-Spec", page, layout: layoutSource() });
	});

	it("turns a render that threw into a print failure with its message, and prints nothing", async () => {
		const print = vi.fn(async () => new Uint8Array([1]));

		const failure = await printNote(file, "Text", rm2, fakeRender({ fail: new Error("render broke") }), print).catch((e: unknown) => e);
		const odd = await printNote(file, "Text", rm2, fakeRender({ fail: "odd" }), print).catch((e: unknown) => e);

		expect(failure).toBeInstanceOf(PrintFailure);
		expect((failure as PrintFailure).kind).toBe("failed");
		expect((failure as PrintFailure).reason).toBe("render broke");
		expect((odd as PrintFailure).reason).toBe("odd");
		expect(print).not.toHaveBeenCalled();
	});
});

describe("obsidianRenderHost", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		obsidian.calls.length = 0;
		obsidian.renderError = null;
	});

	function stubWindow() {
		const created: { cls?: string; attr?: Record<string, string> }[] = [];
		vi.stubGlobal("activeDocument", { body: { createDiv: (options: { cls: string; attr: Record<string, string> }) => (created.push(options), el("div")) } });
		vi.stubGlobal("activeWindow", { setTimeout: (callback: () => void, ms: number) => (obsidian.calls.push(`timer ${ms}`), setTimeout(callback, 0)) });
		return created;
	}

	it("renders off-screen in the active document, as a reading view at the column's width", () => {
		const created = stubWindow();

		obsidianRenderHost({} as never).createView(486);

		expect(created).toEqual([
			{ cls: "markdown-preview-view markdown-rendered", attr: { style: "position: fixed; left: -20000px; top: 0; width: 486px;" } },
		]);
	});

	it("renders under a loaded component and hands back its unload", async () => {
		stubWindow();
		const host = obsidianRenderHost({} as never);

		const unload = await host.render("Text", asView(el("div")), "Specs/Login-Spec.md");
		unload();

		expect(obsidian.calls).toEqual(["load", "render Specs/Login-Spec.md Text with component", "unload"]);
	});

	it("unloads the component itself when the render throws", async () => {
		stubWindow();
		obsidian.renderError = new Error("no renderer");

		await expect(obsidianRenderHost({} as never).render("Text", asView(el("div")), "a.md")).rejects.toThrow("no renderer");

		expect(obsidian.calls).toEqual(["load", "render a.md Text with component", "unload"]);
	});

	it("sleeps on the active window's timers and tells the time", async () => {
		stubWindow();
		const host = obsidianRenderHost({} as never);

		await host.sleep(400);

		expect(obsidian.calls).toEqual(["timer 400"]);
		expect(Math.abs(host.now() - Date.now())).toBeLessThan(1000);
	});
});
