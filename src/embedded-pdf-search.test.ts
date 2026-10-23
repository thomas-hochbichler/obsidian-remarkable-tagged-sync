import { describe, expect, it } from "vitest";
import { searchEmbeddedPdf } from "./embedded-pdf-search";

// The component tree as Obsidian 1.14.5 builds it for a note with an embedded PDF: the view's
// components keep their children in `_children`, and a PDF embed carries `containerEl` (the
// `.pdf-embed` element) and `viewer`, whose `child` holds the find bar once the PDF has loaded
// (research/25 §2, bundle offsets ≈2677287 and ≈2658087). Internal, unminified names.

function pdfEmbed(containerEl: object, child: unknown) {
	return { containerEl, file: { extension: "pdf" }, viewer: { child } };
}

/** The real `showSearch` is a method that reads `this`, so a detached call would fail here as there. */
function findBar() {
	return {
		opened: 0,
		showSearch(this: { opened: number }) {
			this.opened++;
		},
	};
}

describe("Cmd+F in an embedded PDF", () => {
	it("opens the embed's own find bar", () => {
		const el = {};
		const bar = findBar();
		const view = { _children: [{ _children: [pdfEmbed(el, { findBar: bar })] }] };
		let tabs = 0;

		searchEmbeddedPdf(view, el, () => tabs++);
		expect(bar.opened).toBe(1);
		expect(tabs).toBe(0);
	});

	it("opens the PDF in a tab while the embed's viewer has not loaded yet", () => {
		const el = {};
		const view = { _children: [pdfEmbed(el, null)] };
		let tabs = 0;

		searchEmbeddedPdf(view, el, () => tabs++);
		expect(tabs).toBe(1);
	});

	it("opens the PDF in a tab when an Obsidian update has moved the find bar", () => {
		const el = {};
		const view = { _children: [pdfEmbed(el, { pdfViewer: {} })] };
		let tabs = 0;

		searchEmbeddedPdf(view, el, () => tabs++);
		expect(tabs).toBe(1);
	});

	it("opens the PDF in a tab when the tree no longer leads to the embed", () => {
		const el = {};
		const bar = findBar();
		// The same embed and element as the first test; only the children's key is renamed.
		const view = { children: [pdfEmbed(el, { findBar: bar })] };
		let tabs = 0;

		searchEmbeddedPdf(view, el, () => tabs++);
		expect(bar.opened).toBe(0);
		expect(tabs).toBe(1);
	});

	it("opens the PDF in a tab when no note view is on screen to search under", () => {
		let tabs = 0;

		searchEmbeddedPdf(undefined, {}, () => tabs++);
		expect(tabs).toBe(1);
	});

	it("opens the find bar of the embed that has the focus, not another one in the note", () => {
		const first = findBar();
		const second = findBar();
		const el = {};
		const view = { _children: [pdfEmbed({}, { findBar: first }), { _children: [pdfEmbed(el, { findBar: second })] }] };

		searchEmbeddedPdf(view, el, () => undefined);
		expect([first.opened, second.opened]).toEqual([0, 1]);
	});
});
