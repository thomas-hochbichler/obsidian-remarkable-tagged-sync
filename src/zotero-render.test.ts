import { describe, expect, it } from "vitest";
import { GROUP_LIBRARY, NEEDS_WEB, NO_PARENT_ITEM, NOT_WHOLE_DOCUMENT, planRender, type RenderInput } from "./zotero-render";

const MD5 = "5d41402abc4b2a76b9719d911017c592";

function input(overrides: Partial<RenderInput> = {}): RenderInput {
	return { switchedOn: true, md5: MD5, library: "user", paperKey: "PAPER1", web: true, recorded: undefined, ...overrides };
}

describe("the render planner (Zotero spec §4.3)", () => {
	it("creates the attachment on the first whole-document sync", () => {
		expect(planRender(input())).toEqual({ kind: "create", parentKey: "PAPER1" });
	});

	it("replaces the file when the render's MD5 differs from the one uploaded last, naming that MD5", () => {
		expect(planRender(input({ recorded: { key: "REN1", parentKey: "PAPER1", md5: "old" } }))).toEqual({ kind: "replace", render: { key: "REN1", parentKey: "PAPER1", md5: "old" } });
	});

	it("sends nothing when the render is the one uploaded last", () => {
		expect(planRender(input({ recorded: { key: "REN1", parentKey: "PAPER1", md5: MD5 } }))).toEqual({ kind: "unchanged" });
	});

	it("uploads into an attachment that was created but never got its file", () => {
		expect(planRender(input({ recorded: { key: "REN1", parentKey: "PAPER1" } }))).toEqual({ kind: "replace", render: { key: "REN1", parentKey: "PAPER1" } });
	});

	it("does nothing while the switch is off, whatever else holds", () => {
		expect(planRender(input({ switchedOn: false }))).toEqual({ kind: "none" });
		expect(planRender(input({ switchedOn: false, md5: null, web: false }))).toEqual({ kind: "none" });
	});

	it("says to tag the whole document for a page-scoped unit with no render yet", () => {
		expect(planRender(input({ md5: null }))).toEqual({ kind: "not-added", reason: NOT_WHOLE_DOCUMENT });
	});

	it("leaves a page-scoped unit's line to the render the document tag already added", () => {
		expect(planRender(input({ md5: null, recorded: { key: "REN1", parentKey: "PAPER1", md5: MD5 } }))).toEqual({ kind: "none" });
	});

	it("adds nothing to a group library", () => {
		expect(planRender(input({ library: { group: 42 } }))).toEqual({ kind: "not-added", reason: GROUP_LIBRARY });
	});

	it("adds nothing without a zotero.org connection", () => {
		expect(planRender(input({ web: false }))).toEqual({ kind: "not-added", reason: NEEDS_WEB });
		expect(planRender(input({ web: false, recorded: { key: "REN1", parentKey: "PAPER1", md5: "old" } }))).toEqual({ kind: "not-added", reason: NEEDS_WEB });
	});

	it("adds nothing to a PDF with no parent item", () => {
		expect(planRender(input({ paperKey: null }))).toEqual({ kind: "not-added", reason: NO_PARENT_ITEM });
	});
});
