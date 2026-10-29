import { describe, expect, it } from "vitest";
import type { RenderState } from "./zotero-client";
import type { LinkedRender } from "./zotero-links";
import { GROUP_LIBRARY, judgeRender, NEEDS_WEB, NO_PARENT_ITEM, NOT_WHOLE_DOCUMENT, planRender, type RenderInput } from "./zotero-render";

const MD5 = "5d41402abc4b2a76b9719d911017c592";

function input(overrides: Partial<RenderInput> = {}): RenderInput {
	return { switchedOn: true, md5: MD5, library: "user", paperKey: "PAPER1", web: true, recorded: undefined, ...overrides };
}

describe("the render planner (Zotero spec §4.3)", () => {
	it("looks for one of ours under the paper on the first whole-document sync", () => {
		expect(planRender(input())).toEqual({ kind: "find", parentKey: "PAPER1" });
	});

	it("checks the attachment when the render's MD5 differs from the one uploaded last", () => {
		expect(planRender(input({ recorded: { key: "REN1", parentKey: "PAPER1", md5: "old" } }))).toEqual({ kind: "check", render: { key: "REN1", parentKey: "PAPER1", md5: "old" } });
	});

	it("sends nothing when the render is the one uploaded last", () => {
		expect(planRender(input({ recorded: { key: "REN1", parentKey: "PAPER1", md5: MD5 } }))).toEqual({ kind: "unchanged" });
	});

	it("checks an attachment that was created but never got its file", () => {
		expect(planRender(input({ recorded: { key: "REN1", parentKey: "PAPER1" } }))).toEqual({ kind: "check", render: { key: "REN1", parentKey: "PAPER1" } });
	});

	// Removing the document tag leaves a page-scoped unit or none at all (the row after), and neither
	// touches the record: back again, the same attachment is checked.
	it("updates the same attachment when the document tag returns", () => {
		const recorded = { key: "REN1", parentKey: "PAPER1", md5: "old" };
		expect(planRender(input({ md5: null, recorded }))).toEqual({ kind: "none" });
		expect(planRender(input({ recorded }))).toEqual({ kind: "check", render: recorded });
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

	it("never touches a render the user made theirs, changed or not", () => {
		for (const theirs of ["changed", "annotated", "moved", "trashed"] as const) {
			expect(planRender(input({ recorded: { key: "REN1", parentKey: "PAPER1", md5: "old", theirs } }))).toEqual({ kind: "none" });
			expect(planRender(input({ md5: null, recorded: { key: "REN1", parentKey: "PAPER1", md5: "old", theirs } }))).toEqual({ kind: "none" });
		}
	});

	it("starts over once the vault note is deleted after the user trashed or moved the render", () => {
		for (const theirs of ["trashed", "moved"] as const) {
			expect(planRender(input({ noteWasDeleted: true, recorded: { key: "REN1", parentKey: "PAPER1", md5: "old", theirs } }))).toEqual({ kind: "create", parentKey: "PAPER1" });
		}
	});

	// Their file is still under the paper: a second render beside it, or theirs overwritten, would undo what they did.
	it("does not start over for a render the user changed or annotated", () => {
		for (const theirs of ["changed", "annotated"] as const) {
			expect(planRender(input({ noteWasDeleted: true, recorded: { key: "REN1", parentKey: "PAPER1", md5: "old", theirs } }))).toEqual({ kind: "none" });
		}
	});
});

describe("what the user did to the render (Zotero spec §4.3)", () => {
	const RECORDED: LinkedRender = { key: "REN1", parentKey: "PAPER1", md5: "ours-last" };

	function state(overrides: Partial<RenderState> = {}): RenderState {
		return { key: "REN1", parentKey: "PAPER1", title: "Annotated PDF", filename: "annotated_paper.pdf", md5: "ours-last", trashed: false, annotated: false, ...overrides };
	}

	it("replaces the file under the MD5 Zotero holds", () => {
		expect(judgeRender(MD5, RECORDED, state())).toEqual({ kind: "upload", holds: "ours-last", filename: "annotated_paper.pdf" });
	});

	it("keeps the title and file name the user gave it, and still replaces the bytes", () => {
		expect(judgeRender(MD5, RECORDED, state({ title: "My copy", filename: "mine.pdf" }))).toEqual({ kind: "upload", holds: "ours-last", filename: "mine.pdf" });
	});

	it("takes a file whose MD5 is neither this render nor the last one uploaded for the user's", () => {
		expect(judgeRender(MD5, RECORDED, state({ md5: "rotated-in-zotero" }))).toEqual({ kind: "theirs", theirs: "changed" });
	});

	it("records a render Zotero already holds, from another device, without sending it", () => {
		expect(judgeRender(MD5, RECORDED, state({ md5: MD5 }))).toEqual({ kind: "unchanged" });
	});

	it("leaves a render that carries the user's annotations", () => {
		expect(judgeRender(MD5, RECORDED, state({ annotated: true }))).toEqual({ kind: "theirs", theirs: "annotated" });
	});

	it("leaves a render moved to another paper or made standalone", () => {
		expect(judgeRender(MD5, RECORDED, state({ parentKey: "PAPER2" }))).toEqual({ kind: "theirs", theirs: "moved" });
		expect(judgeRender(MD5, RECORDED, state({ parentKey: null }))).toEqual({ kind: "theirs", theirs: "moved" });
	});

	it("leaves a render trashed, erased, or under a paper in the trash", () => {
		expect(judgeRender(MD5, RECORDED, state({ trashed: true }))).toEqual({ kind: "theirs", theirs: "trashed" });
		expect(judgeRender(MD5, RECORDED, null)).toEqual({ kind: "theirs", theirs: "trashed" });
	});

	it("fills an attachment that never got its file", () => {
		expect(judgeRender(MD5, { key: "REN1", parentKey: "PAPER1" }, state({ md5: null }))).toEqual({ kind: "upload", holds: null, filename: "annotated_paper.pdf" });
	});

	// Spec §4.2's accepted loss: with no MD5 of ours to compare, a re-found file is ours to replace.
	it("replaces a re-found render once, whatever file it holds", () => {
		expect(judgeRender(MD5, { key: "REN1", parentKey: "PAPER1" }, state({ md5: "rotated-in-zotero" }))).toEqual({ kind: "upload", holds: "rotated-in-zotero", filename: "annotated_paper.pdf" });
	});
});
