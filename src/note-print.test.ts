import { describe, expect, it } from "vitest";
import { CAPTION_CLASS, KEEP_WHOLE_CLASS, MISSING_EMBED_CLASS, type PrintChoice, type PrintPage, printOptions, printPage, printStylesheet, SEND_CLASS } from "./note-print";
import { PAPER_PRO, RM_1_2 } from "./pdf-renderer";

const rm2: PrintChoice = { tablet: "rm12", textSize: "normal", toolbarRight: false };
const pro: PrintChoice = { tablet: "paperPro", textSize: "normal", toolbarRight: false };

/** Every rule of the stylesheet as `[selector, body]`, so a test can ask about selectors and values apart. */
function rules(css: string): [string, string][] {
	return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => [match[1].trim(), match[2].trim()]);
}

describe("printPage", () => {
	it("prints on the reMarkable 1, 2 and Paper Pure's own screen, with a 486 px column", () => {
		const page = printPage(rm2);

		expect(page.widthIn).toBeCloseTo(6.2124, 4);
		expect(page.heightIn).toBeCloseTo(8.2832, 4);
		expect(page.columnPx).toBe(486);
		expect(page.keepWholePx).toBe(248);
	});

	it("prints on the Paper Pro's own screen, with a 569 px column", () => {
		const page = printPage(pro);

		expect(page.widthIn).toBeCloseTo(7.0742, 4);
		expect(page.heightIn).toBeCloseTo(9.4323, 4);
		expect(page.columnPx).toBe(569);
		expect(page.keepWholePx).toBe(287);
	});

	it("takes the page from the renderer's device frames, not from a number of its own", () => {
		expect(printPage(rm2).widthIn).toBe(RM_1_2.widthPt / 72);
		expect(printPage(pro).heightIn).toBe(PAPER_PRO.heightPt / 72);
	});

	it.each([
		["rm12", "normal", 10, 7, 8.5],
		["rm12", "large", 12, 8.4, 10.2],
		["paperPro", "normal", 10, 7, 8.5],
		["paperPro", "large", 12, 8.4, 10.2],
	] as const)("sets %s at %s in %d pt, code in %d pt and diagram type in %d pt", (tablet, textSize, body, code, diagram) => {
		const page = printPage({ tablet, textSize, toolbarRight: false });

		expect([page.bodyPt, page.codePt, page.diagramPt]).toEqual([body, code, diagram]);
	});

	it("keeps the wide margin on the left, where the toolbar is", () => {
		expect(printPage(rm2).margins).toEqual({ top: 0.45, right: 0.4, bottom: 0.45, left: 0.75 });
	});

	it("swaps only left and right for a tablet in left-handed mode", () => {
		for (const choice of [rm2, pro]) {
			const page = printPage(choice);
			const mirrored = printPage({ ...choice, toolbarRight: true });

			expect(mirrored.margins).toEqual({ ...page.margins, left: page.margins.right, right: page.margins.left });
			expect(mirrored.columnPx).toBe(page.columnPx);
		}
	});
});

describe("printOptions", () => {
	it("passes the page and margins in inches, the background, and both outline options", () => {
		const page = printPage(rm2);

		expect(printOptions(page)).toEqual({
			pageSize: { width: page.widthIn, height: page.heightIn },
			margins: { top: 0.45, right: 0.4, bottom: 0.45, left: 0.75 },
			printBackground: true,
			generateDocumentOutline: true,
			generateTaggedPDF: true,
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])("refuses a page or margin of %d before Electron sees it", (bad) => {
		const page = printPage(rm2);

		expect(() => printOptions({ ...page, widthIn: bad })).toThrow(/widthIn/);
		expect(() => printOptions({ ...page, heightIn: bad })).toThrow(/heightIn/);
		expect(() => printOptions({ ...page, margins: { ...page.margins, left: bad } })).toThrow(/left/);
		expect(() => printOptions({ ...page, margins: { ...page.margins, top: bad } })).toThrow(/top/);
	});

	it("refuses margins that leave no room for text", () => {
		const page = printPage(rm2);
		const across: PrintPage = { ...page, margins: { ...page.margins, left: page.widthIn - page.margins.right } };
		const down: PrintPage = { ...page, margins: { ...page.margins, bottom: page.heightIn } };

		expect(() => printOptions(across)).toThrow(/no room/);
		expect(() => printOptions(down)).toThrow(/no room/);
	});
});

describe("printStylesheet", () => {
	it("scopes every rule to the print wrapper and the printed note", () => {
		for (const [selector] of rules(printStylesheet(printPage(rm2)))) {
			for (const part of selector.split(",")) expect(part.trim()).toMatch(new RegExp(`^\\.print \\.(markdown-preview-view)?\\.?${SEND_CLASS}\\b`));
		}
	});

	it("sets the body size and line height on the note, and code in its own size", () => {
		const normal = printStylesheet(printPage(rm2));
		const large = printStylesheet(printPage({ ...rm2, textSize: "large" }));

		expect(normal).toContain(`.print .markdown-preview-view.${SEND_CLASS} { font-size: 10pt !important; line-height: 1.45 !important; padding: 0 !important;`);
		expect(large).toContain("font-size: 12pt !important; line-height: 1.45");
		expect(normal).toContain("font-size: 7pt !important; line-height: 1.35");
		expect(large).toContain("font-size: 8.4pt !important; line-height: 1.35");
	});

	it("keeps headings with what follows, wraps code and sizes tables by their content", () => {
		const css = printStylesheet(printPage(rm2));

		expect(css).toMatch(/h6 \{ break-after: avoid; \}/);
		expect(css).toMatch(/li \{ orphans: 3; widows: 3; \}/);
		expect(css).toMatch(/pre code \{ white-space: pre-wrap !important; overflow-wrap: anywhere;/);
		expect(css).toMatch(/pre \{ padding: 6px 8px !important; \}/);
		expect(css).toMatch(/table \{ table-layout: auto; width: 100% !important; max-width: 100% !important; font-size: 0\.78em !important; \}/);
		expect(css).toMatch(/td \{ font-size: inherit !important; padding: 3px 5px !important; overflow-wrap: anywhere; vertical-align: top; \}/);
		expect(css).toMatch(/th code \{ white-space: normal !important;/);
		expect(css).toMatch(/svg \{ max-width: 100% !important; height: auto; \}/);
	});

	it("styles the caption, the missing embed and the kept-whole block by their classes", () => {
		const css = printStylesheet(printPage(rm2));

		expect(css).toContain(`p.${CAPTION_CLASS} { font-size: 0.85em !important;`);
		expect(css).toContain(`.${MISSING_EMBED_CLASS} { font-size: 0.85em; color: var(--text-muted); }`);
		expect(css).toContain(`.${KEEP_WHOLE_CLASS} { break-inside: avoid; }`);
	});

	it("places nothing left of the text column: a checkbox is pulled back no further than its list's own indent", () => {
		const negatives = rules(printStylesheet(printPage(rm2))).flatMap(([selector, body]) =>
			[...body.matchAll(/([\w-]+):\s*(-[\d.]+\w*)/g)].map((match) => ({ selector, property: match[1], value: match[2] })),
		);
		const indent = printStylesheet(printPage(rm2)).match(/contains-task-list \{ padding-inline-start: ([\d.]+em)/)?.[1];

		expect(negatives).toEqual([{ selector: expect.stringContaining("task-list-item-checkbox"), property: "margin-inline-start", value: `-${indent}` }]);
	});
});
