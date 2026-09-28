import { describe, expect, it } from "vitest";
import { readProperty, writeProperty } from "./frontmatter-values";

const NOTE = "---\ntitle: Day\nmood: gut\ntags:\n  - work\n  - \"a: b\"\nrefs: [x, 'y']\nempty: []\nblank:\n# a comment\n---\nBody";

describe("readProperty", () => {
	it("reads a scalar, a block list, an inline list and an empty one", () => {
		expect(readProperty(NOTE, "mood")).toBe("gut");
		expect(readProperty(NOTE, "tags")).toEqual(["work", "a: b"]);
		expect(readProperty(NOTE, "refs")).toEqual(["x", "y"]);
		expect(readProperty(NOTE, "empty")).toEqual([]);
	});

	it("is null for a key that is absent or blank, and for a note with no block", () => {
		expect(readProperty(NOTE, "none")).toBeNull();
		expect(readProperty(NOTE, "blank")).toBeNull();
		expect(readProperty("Body only", "mood")).toBeNull();
	});
});

describe("writeProperty", () => {
	it("replaces a scalar in place and leaves every other line as it was", () => {
		expect(writeProperty(NOTE, "mood", "ok")).toBe(NOTE.replace("mood: gut", "mood: ok"));
	});

	it("replaces a block list with a block list, and an inline list with one", () => {
		expect(writeProperty(NOTE, "tags", ["work", "home"])).toBe(NOTE.replace('tags:\n  - work\n  - "a: b"', "tags:\n  - work\n  - home"));
		expect(writeProperty(NOTE, "refs", ["z"])).toBe(NOTE.replace("refs: [x, 'y']", "refs:\n  - z"));
	});

	it("adds a missing key at the end of the block, quoting what YAML would misread", () => {
		const out = writeProperty(NOTE, "project", "Alpha: Beta");
		expect(out).toContain('# a comment\nproject: "Alpha: Beta"\n---\nBody');
		expect(writeProperty(NOTE, "x", "")).toContain('x: ""');
		expect(writeProperty(NOTE, "x", "- dash")).toContain('x: "- dash"');
	});

	it("removes a key with null, and gives a note without a block one only when there is something to write", () => {
		expect(writeProperty(NOTE, "mood", null)).toBe(NOTE.replace("mood: gut\n", ""));
		expect(writeProperty("Body", "mood", "gut")).toBe("---\nmood: gut\n---\nBody");
		expect(writeProperty("Body", "mood", null)).toBe("Body");
		expect(writeProperty(NOTE, "none", null)).toBe(NOTE);
	});
});
