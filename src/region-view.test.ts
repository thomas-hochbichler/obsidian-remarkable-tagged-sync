import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEl, createFragment, FakeApp, type FakeCanvasEl, FakeEl } from "../test-stubs/fake-obsidian";
import { REGION_LANGUAGE } from "./digest-builder";
import { UNREADABLE_BLOCK } from "./note-region";

// Gap G19 -- `region-view.ts`, 300 lines and no test file. `note-region.test.ts` covers the *contract*
// thoroughly, including a writer-to-reader round trip, and stops at the seam. Everything past it --
// whether a button is drawn, whether it opens the vault's own PDF, whether a failure reaches the
// reader instead of only the console -- ran nowhere.
//
// This is the plugin's only code that draws *inside* somebody's note, and the promise it makes is
// unusual enough to be worth a test of its own: **no image file is ever added to the vault.**

const pdfjs = vi.hoisted(() => ({
	/** Pages the document reports, and the page size in PDF points a viewport at scale 1 answers with. */
	numPages: 3,
	pageWidth: 600,
	pageHeight: 800,
	/** Every render pdf.js was asked for, with the transform that clips it to the band. */
	renders: [] as { scale: number; transform: number[]; canvas: unknown }[],
	/** Held open so a test can unload the note while a render is still running. */
	hold: null as null | (() => void),
	/** Set to make `loadPdfJs` absent, as it is on an older Obsidian. */
	present: true,
	/** Set to make opening the document fail, as a corrupt PDF would. */
	openFails: false,
	/** Documents whose `destroy` was called. */
	destroyed: 0,
	/** Renders that were cancelled rather than awaited. */
	cancelled: 0,
	opens: 0,
}));

function fakePdfJs() {
	return {
		getDocument() {
			return {
				promise: openDocument(),
			};
		},
	};
}

async function openDocument() {
	pdfjs.opens++;
	if (pdfjs.openFails) throw new Error("bad XRef entry");
	return {
		numPages: pdfjs.numPages,
		getPage: async () => fakePage(),
		destroy: async () => {
			pdfjs.destroyed++;
		},
	};
}

function fakePage() {
	return {
		getViewport({ scale }: { scale: number }) {
			return { width: pdfjs.pageWidth * scale, height: pdfjs.pageHeight * scale };
		},
		render(params: { canvasContext: unknown; transform: number[]; viewport: { width: number } }) {
			pdfjs.renders.push({
				scale: params.viewport.width / pdfjs.pageWidth,
				transform: params.transform,
				canvas: params.canvasContext,
			});
			const held = pdfjs.hold !== null;
			return {
				promise: held ? new Promise<void>((resolve) => (pdfjs.hold = resolve)) : Promise.resolve(),
				cancel() {
					pdfjs.cancelled++;
				},
			};
		},
	};
}

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	// Obsidian's own documented API. Absent on older versions and from the stub, which is why the
	// product code probes for it rather than importing it -- so a test can take it away again.
	return { ...actual, loadPdfJs: async () => (pdfjs.present ? fakePdfJs() : undefined) };
});

const NOTE_PATH = "Work/Notebook.md";
const PDF_PATH = "tagged-sync/attachments/doc-1.pdf";
const NOTE_WITH_EMBED = `> [!info]- x\n\n![[${PDF_PATH}]]\n\n<!-- tagged-sync:end -->\n`;

/** The two globals `enhance.js` supplies and vitest does not. */
vi.stubGlobal("createFragment", createFragment);
vi.stubGlobal("createEl", createEl);

interface Child {
	containerEl: FakeEl;
	onload(): void;
	onunload(): void;
}

/**
 * A vault holding the note and the PDF it embeds, with the block processor registered exactly as
 * `onload` registers it -- through the real `registerRegionProcessor`, so what is exercised is the
 * wiring and not a copy of it.
 */
async function noteWith(source: string, setup: { embed?: string; pdfMissing?: boolean; noteMissing?: boolean } = {}) {
	const app = new FakeApp();
	if (!setup.noteMissing) {
		await app.vault.createFolder("Work");
		await app.vault.create(NOTE_PATH, setup.embed ?? NOTE_WITH_EMBED);
	}
	if (!setup.pdfMissing) {
		await app.vault.createFolder("tagged-sync");
		await app.vault.createFolder("tagged-sync/attachments");
		await app.vault.createBinary(PDF_PATH, new Uint8Array([37, 80, 68, 70]).buffer);
	}

	const { registerRegionProcessor } = await import("./region-view");
	const plugin = {
		app,
		register: vi.fn(),
		registerMarkdownCodeBlockProcessor: vi.fn(),
	};
	registerRegionProcessor(plugin as never);

	const processor = plugin.registerMarkdownCodeBlockProcessor.mock.calls[0][1] as (
		source: string,
		el: FakeEl,
		ctx: { sourcePath: string; addChild(child: Child): void },
	) => void;
	const container = new FakeEl();
	let child: Child | null = null;
	processor(source, container, {
		sourcePath: NOTE_PATH,
		addChild: (added) => {
			child = added;
		},
	});
	(child as unknown as Child).onload();

	return { app, plugin, container, child: child as unknown as Child };
}

const A_BLOCK = "page: 2\nrect: 40 100 500 60";

/** The button, if one was drawn. */
const buttonIn = (container: FakeEl): FakeEl | undefined =>
	container.children.find((el) => el.classes.has("tagged-sync-region-button"));
const messageIn = (container: FakeEl): FakeEl | undefined =>
	container.children.find((el) => el.classes.has("tagged-sync-region-message"));
const figureIn = (container: FakeEl): FakeEl | undefined => container.children.find((el) => el.classes.has("tagged-sync-region"));

/** Lets the click handler's promise chain finish -- `dispatch` cannot await it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function press(container: FakeEl): Promise<void> {
	buttonIn(container)?.dispatch("click");
	await settle();
}

beforeEach(() => {
	pdfjs.numPages = 3;
	pdfjs.pageWidth = 600;
	pdfjs.pageHeight = 800;
	pdfjs.renders.length = 0;
	pdfjs.hold = null;
	pdfjs.present = true;
	pdfjs.openFails = false;
	pdfjs.destroyed = 0;
	pdfjs.cancelled = 0;
	pdfjs.opens = 0;
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the block, before anybody presses anything", () => {
	it("draws a button and nothing else -- no PDF is opened until it is asked for", async () => {
		// A note with thirty margin notes must cost nothing until somebody wants one drawn.
		const { container } = await noteWith(A_BLOCK);

		expect(buttonIn(container)).toBeDefined();
		expect(figureIn(container)).toBeUndefined();
		expect(pdfjs.opens).toBe(0);
	});

	it("takes Obsidian's own icon-button class, which is the only way it can be styled at all", async () => {
		// `app.css` reaches every other button through `button:not(.clickable-icon)`, which outranks a
		// plain class of ours -- the button would keep its grey face and its border whatever we wrote.
		const { container } = await noteWith(A_BLOCK);

		expect(buttonIn(container)?.classes.has("clickable-icon")).toBe(true);
		expect(buttonIn(container)?.attributes.type).toBe("button");
	});

	it("says so in the note, without a button, when the block cannot be read", async () => {
		// A control that cannot work is worse than the sentence explaining why.
		const { container } = await noteWith("page: two\nrect: nonsense");

		expect(buttonIn(container)).toBeUndefined();
		expect(messageIn(container)?.text).toBe(UNREADABLE_BLOCK);
	});

	it("keeps a click on the button out of the editor's caret handling", async () => {
		// Live Preview puts the caret where a click lands, and a block the caret sits inside falls back
		// to its own source -- so pressing the button showed the reader `page:` and `rect:` instead of
		// the handwriting. An entry's block sits in a callout, which Live Preview keeps editable all
		// the way down, so the event has to not reach the ancestor at all.
		const { container } = await noteWith(A_BLOCK);
		const button = buttonIn(container)!;

		const outcomes = ["pointerdown", "mousedown", "click"].map((type) => ({ type, ...button.dispatch(type) }));

		expect(outcomes.map((outcome) => outcome.stopped)).toEqual([true, true, true]);
		// Not on the click: a button has no default action worth suppressing, and preventing it is how
		// a control stops behaving like one.
		expect(outcomes.map((outcome) => outcome.defaultPrevented)).toEqual([true, true, false]);
	});
});

describe("pressing the button", () => {
	it("draws the band out of the vault's own PDF, and adds no file to the vault", async () => {
		// The promise this whole design exists for. A rendered image written next to the note would be
		// a second copy of the handwriting, in a file nobody asked for, in every vault that opens a
		// digest.
		const { app, container } = await noteWith(A_BLOCK);
		const before = app.vault.getAllLoadedFiles().map((file) => file.path);

		await press(container);

		expect(figureIn(container)).toBeDefined();
		expect(pdfjs.renders).toHaveLength(1);
		expect(app.vault.getAllLoadedFiles().map((file) => file.path)).toEqual(before);
	});

	it("sizes the canvas to the band and slides the band's corner to its origin", async () => {
		// The viewport is the whole page; the transform is what makes pdf.js clip to the canvas instead
		// of rasterising the page around it. `rect: 40,100,500,60` on an 800pt page bands y 100..160
		// with the padding `note-region.ts` adds, at the page's full width.
		const { container } = await noteWith(A_BLOCK);

		await press(container);

		const canvas = figureIn(container)!.children[0] as FakeCanvasEl;
		const [, , , , dx, dy] = pdfjs.renders[0].transform;
		expect(canvas.width).toBeGreaterThan(0);
		expect(canvas.height).toBeGreaterThan(0);
		// x is always the page's left edge -- a band is the full width -- and y follows the ink.
		expect(Math.abs(dx)).toBe(0);
		expect(dy).toBeLessThan(0);
		expect(pdfjs.renders[0].scale).toBe(3);
	});

	it("gives back the page rather than the band when the band is too big for a canvas", async () => {
		// A poster-sized page is a legitimate document. Browsers throw on a canvas past a few thousand
		// pixels a side rather than returning null, so the scale gives way first.
		pdfjs.pageWidth = 20_000;
		pdfjs.pageHeight = 20_000;
		const { container } = await noteWith("page: 1\nrect: 0 0 20000 20000");

		await press(container);

		const canvas = figureIn(container)!.children[0] as FakeCanvasEl;
		expect(pdfjs.renders[0].scale).toBeLessThan(3);
		expect(canvas.width).toBeLessThanOrEqual(8192);
		expect(canvas.height).toBeLessThanOrEqual(8192);
	});

	it("keeps a click on the handwriting out of the editor too", async () => {
		// The same trap as the button, and worse: a reader looking at their own handwriting clicks on
		// it, the caret lands inside the block, and Live Preview replaces the image with `page:` and
		// `rect:`. Their handwriting disappears under their own click.
		const { container } = await noteWith(A_BLOCK);
		await press(container);

		expect(figureIn(container)!.dispatch("click").stopped).toBe(true);
		expect(figureIn(container)!.dispatch("mousedown").defaultPrevented).toBe(true);
	});

	it("hides the handwriting again on a second press, without reopening anything", async () => {
		const { container } = await noteWith(A_BLOCK);

		await press(container);
		expect(figureIn(container)).toBeDefined();

		await press(container);
		expect(figureIn(container)).toBeUndefined();
		expect(pdfjs.renders).toHaveLength(1);
	});

	it("keeps the document open between two notes' blocks, and opens it once", async () => {
		// 75 ms to open a document against 6 ms to draw a region out of an open one, measured. This is
		// the whole difference between a button that answers instantly and one that visibly waits.
		const { container } = await noteWith(A_BLOCK);

		await press(container);
		await press(container); // hide
		await press(container); // show again

		expect(pdfjs.opens).toBe(1);
		expect(pdfjs.renders).toHaveLength(2);
	});
});

describe("what the reader is told when it cannot be drawn", () => {
	async function failureFrom(source: string, setup: Parameters<typeof noteWith>[1] = {}): Promise<string> {
		const { container } = await noteWith(source, setup);
		await press(container);
		return messageIn(container)?.text ?? "";
	}

	it("names a note that is no longer in the vault", async () => {
		expect(await failureFrom(A_BLOCK, { noteMissing: true })).toContain("no longer in the vault");
	});

	it("names a note that embeds no PDF", async () => {
		expect(await failureFrom(A_BLOCK, { embed: "just some text\n" })).toContain("embeds no PDF");
	});

	it("names the PDF by path when the embed points at nothing", async () => {
		const said = await failureFrom(A_BLOCK, { pdfMissing: true });

		expect(said).toContain("is not in the vault");
		expect(said).toContain(PDF_PATH);
	});

	it("names the page when the PDF has been rebuilt with fewer pages", async () => {
		pdfjs.numPages = 1;

		expect(await failureFrom(A_BLOCK)).toContain("no page 2 any more");
	});

	it("says the block points off the page when the rectangle does not touch it", async () => {
		expect(await failureFrom("page: 1\nrect: 9000 9000 10 10")).toContain("not on page 1");
	});

	it("passes an unexpected failure through in the reader's own words, and keeps the stack in the console", async () => {
		// Both, not either: the note gets the sentence because that is where the reader is, and the
		// console keeps the stack, because "the PDF could not be opened" is not a diagnosis.
		pdfjs.openFails = true;

		const said = await failureFrom(A_BLOCK);

		expect(said).toContain("could not be drawn from the embedded PDF");
		expect(said).toContain("bad XRef entry");
		expect(console.warn).toHaveBeenCalled();
	});

	it("says so on an Obsidian with no pdf.js, rather than throwing into a promise nobody awaits", async () => {
		pdfjs.present = false;
		vi.resetModules();

		expect(await failureFrom(A_BLOCK)).toContain("could not be drawn");
	});

	it("leaves the button pressable, because every one of these is something the reader can put right", async () => {
		const { container } = await noteWith(A_BLOCK, { pdfMissing: true });

		await press(container);

		expect(buttonIn(container)?.disabled).toBe(false);
	});

	it("clears the last failure when the button is pressed again", async () => {
		// A fixed vault has to be able to clear the sentence by pressing the button, or the note keeps
		// explaining a problem that is gone.
		const { app, container } = await noteWith(A_BLOCK, { pdfMissing: true });
		await press(container);
		expect(messageIn(container)).toBeDefined();

		await app.vault.createFolder("tagged-sync");
		await app.vault.createFolder("tagged-sync/attachments");
		await app.vault.createBinary(PDF_PATH, new Uint8Array([37, 80, 68, 70]).buffer);
		await press(container);

		expect(messageIn(container)).toBeUndefined();
		expect(figureIn(container)).toBeDefined();
	});
});

describe("a note that closes while it is still drawing", () => {
	it("cancels the render rather than leaving pdf.js drawing into a canvas nobody will see", async () => {
		// Its promise would reject afterwards, on a child that is gone.
		pdfjs.hold = () => undefined;
		const { container, child } = await noteWith(A_BLOCK);

		buttonIn(container)?.dispatch("click");
		await settle();
		child.onunload();

		expect(pdfjs.cancelled).toBe(1);
	});
});

describe("what the plugin registers", () => {
	it("registers the language the block format was chosen for, and a cleanup that closes the PDF", async () => {
		// Without the plugin the block stays two readable lines under the entry's text, which is the
		// fallback the format exists for.
		const { plugin } = await noteWith(A_BLOCK);

		expect(plugin.registerMarkdownCodeBlockProcessor.mock.calls[0][0]).toBe(REGION_LANGUAGE);
		expect(plugin.register).toHaveBeenCalledOnce();
	});

	it("closes the open document when the plugin unloads", async () => {
		const { plugin, container } = await noteWith(A_BLOCK);
		await press(container);

		(plugin.register.mock.calls[0][0] as () => void)();
		await settle();

		expect(pdfjs.destroyed).toBe(1);
	});
});
