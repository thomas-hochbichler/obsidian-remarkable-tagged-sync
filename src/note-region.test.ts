import { describe, expect, it } from "vitest";
import { renderDigest } from "./digest-builder";
import { drawnBand, liesOnPage, parseRegionBlock, regionFailureMessage, RegionUnavailable } from "./note-region";

/** The block a digest entry carries, exactly as `digest-builder.ts` writes it. */
const BLOCK = "page: 3\nrect: 384 246 140 24";

describe("parseRegionBlock", () => {
	it("reads the two fields the digest writes", () => {
		expect(parseRegionBlock(BLOCK)).toEqual({ page: 3, x: 384, y: 246, width: 140, height: 24 });
	});

	it("does not care about the order of the fields, or about blank lines around them", () => {
		expect(parseRegionBlock("\nrect: 384 246 140 24\n\npage: 3\n")).toEqual(parseRegionBlock(BLOCK));
	});

	/** So a block written by a later version of the plugin still opens here. */
	it("ignores a field it does not know", () => {
		expect(parseRegionBlock(`${BLOCK}\nversion: 2`)).toEqual(parseRegionBlock(BLOCK));
	});

	it("reads a rectangle that is not whole points", () => {
		expect(parseRegionBlock("page: 1\nrect: 12.5 20.25 100 8.5")).toEqual({ page: 1, x: 12.5, y: 20.25, width: 100, height: 8.5 });
	});

	/**
	 * The block is editable text in the user's own vault. Null is what the caller turns into a sentence
	 * in the note -- drawing nothing and saying nothing is the one answer the format rules out.
	 */
	it("refuses a block that does not say what it must", () => {
		expect(parseRegionBlock("")).toBeNull();
		expect(parseRegionBlock("page: 3")).toBeNull();
		expect(parseRegionBlock("rect: 384 246 140 24")).toBeNull();
		// A number short, a number too many, and a word where a number belongs.
		expect(parseRegionBlock("page: 3\nrect: 384 246 140")).toBeNull();
		expect(parseRegionBlock("page: 3\nrect: 384 246 140 24 8")).toBeNull();
		expect(parseRegionBlock("page: 3\nrect: 384 246 140 tall")).toBeNull();
		// Somebody typed a sentence into it.
		expect(parseRegionBlock("page: 3\nwhat is this box")).toBeNull();
	});

	it("refuses a page that is not a page, and a rectangle with no area", () => {
		expect(parseRegionBlock("page: 0\nrect: 384 246 140 24")).toBeNull();
		expect(parseRegionBlock("page: -1\nrect: 384 246 140 24")).toBeNull();
		expect(parseRegionBlock("page: 2.5\nrect: 384 246 140 24")).toBeNull();
		expect(parseRegionBlock("page: last\nrect: 384 246 140 24")).toBeNull();
		expect(parseRegionBlock("page: 3\nrect: 384 246 0 24")).toBeNull();
		expect(parseRegionBlock("page: 3\nrect: 384 246 140 -24")).toBeNull();
	});
});

describe("drawnBand", () => {
	const region = { page: 3, x: 384, y: 246, width: 140, height: 24 };
	const A4 = { width: 600, height: 840 };

	/**
	 * The decision this function *is*: not the ink's own box -- which renders as a white rectangle with
	 * handwriting in it, since a margin note stands where nothing is printed -- but a band across the
	 * page at its height, which brings the text it was written beside along with it.
	 */
	it("spans the page's width at the height of the ink", () => {
		expect(drawnBand(region, A4)).toEqual({ x: 30, y: 238, width: 540, height: 40 });
	});

	it("keeps the same air above and below however tall the note is", () => {
		expect(drawnBand({ ...region, height: 200 }, A4).height).toBe(216);
	});

	/** It knows a rectangle and a page width, and nothing about the layout -- so where the note sits cannot change what it draws. */
	it("does not depend on where the ink sits across the page", () => {
		expect(drawnBand({ ...region, x: 20 }, A4)).toEqual(drawnBand(region, A4));
	});

	/** Otherwise a note written at the very top or bottom pads its band out past the paper, and the strip beyond it draws as nothing. */
	it("stays inside the sheet", () => {
		expect(drawnBand({ ...region, y: 2 }, A4)).toMatchObject({ y: 0, height: 34 });
		expect(drawnBand({ ...region, y: 830 }, A4)).toMatchObject({ y: 822, height: 18 });
	});
});

describe("liesOnPage", () => {
	const page = { width: 600, height: 840 };

	it("accepts ink on the page, and ink that hangs over its edge", () => {
		expect(liesOnPage({ page: 1, x: 384, y: 246, width: 140, height: 24 }, page)).toBe(true);
		expect(liesOnPage({ page: 1, x: 560, y: 246, width: 140, height: 24 }, page)).toBe(true);
		expect(liesOnPage({ page: 1, x: -20, y: -5, width: 140, height: 24 }, page)).toBe(true);
	});

	/** A rectangle nobody typed wrong lands on its page by construction; one that misses it entirely can only have been edited. */
	it("refuses a rectangle that misses the page altogether", () => {
		expect(liesOnPage({ page: 1, x: 384, y: 900, width: 140, height: 24 }, page)).toBe(false);
		expect(liesOnPage({ page: 1, x: 700, y: 246, width: 140, height: 24 }, page)).toBe(false);
		expect(liesOnPage({ page: 1, x: 384, y: -100, width: 140, height: 24 }, page)).toBe(false);
	});
});

describe("regionFailureMessage", () => {
	/**
	 * The reasons a reader can act on -- a PDF that moved, a page that is not there -- are written
	 * where the cause is known and printed word for word. Nothing rewrites or softens them on the way.
	 */
	it("passes a known reason through untouched", () => {
		expect(regionFailureMessage(new RegionUnavailable("The embedded PDF has no page 99 any more."))).toBe(
			"The embedded PDF has no page 99 any more.",
		);
	});

	/** Everything else says what it can without pretending to know why -- and never says nothing. */
	it("says what it can about a failure nobody anticipated", () => {
		expect(regionFailureMessage(new TypeError("canvas is null"))).toBe(
			"The handwriting could not be drawn from the embedded PDF (TypeError: canvas is null).",
		);
		expect(regionFailureMessage("out of memory")).toContain("out of memory");
	});
});

/**
 * The two halves of the format sit in different modules -- the digest writes the block, the reader
 * parses it -- and nothing but this test holds them to the same spelling.
 */
describe("the block a digest entry carries", () => {
	it("parses back to exactly what the digest was given", () => {
		const region = { page: 7, x: 384, y: 246, width: 140, height: 24 };
		const markdown = renderDigest("doc.pdf", [
			{
				pageLabel: "7",
				embedPage: 7,
				highlights: [],
				notes: [{ id: "nt-1", anchor: { kind: "page" }, text: "check table 2", region, top: 0, section: null }],
			},
		]);

		const block = /```remarkable-note\n([\s\S]*?)```/.exec(markdown.replace(/^> ?/gm, ""));
		expect(block).not.toBeNull();
		expect(parseRegionBlock(block![1])).toEqual(region);
	});
});
