import { describe, expect, it } from "vitest";
import { linkedDocumentIds, linkFor, wasDeclined, withDeclinedLink, withLink, withoutLink, type ZoteroLink } from "./zotero-links";

const DOC = "576dc0a6-323b-468e-bd69-a2ae6c25dbb9";

const link: ZoteroLink = {
	attachmentKey: "5IDIN5M2",
	library: "user",
	sentAt: "2026-09-11T10:00:00Z",
	sentMd5: "2de21c18668a0faba572b4c7f7ecd1f5",
	annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: { text: "the marked words", comment: "" } } },
};

describe("reading a link", () => {
	it("reads back exactly what was stored", () => {
		expect(linkFor(withLink({}, DOC, link), DOC)).toEqual(link);
	});

	// Total, in the same sense `migrateSettings` is: `data.json` is a file users edit and installs of
	// different ages write, so every shape has to have an answer rather than a throw.
	it.each([
		["nothing stored at all", {}],
		["a document that is not in the map", { other: link }],
		["a string where a link should be", { [DOC]: "5IDIN5M2" }],
		["an array", { [DOC]: [] }],
		["null", { [DOC]: null }],
		["a link with no attachment key", { [DOC]: { library: "user", annotations: {} } }],
	])("answers 'not linked' for %s", (_case, stored) => {
		expect(linkFor(stored as Record<string, unknown>, DOC)).toBeNull();
	});

	// Group libraries are refused by the spec, so a link into one is not ours to act on -- but it is
	// also not ours to delete: it can only have been written by an install that does handle it.
	it("does not act on a link into a library this build does not handle, and does not drop it either", () => {
		const stored = { [DOC]: { attachmentKey: "ABC", library: "group", annotations: {} } };
		expect(linkFor(stored, DOC)).toBeNull();
		expect(withLink(stored, "another-doc", link)[DOC]).toBe(stored[DOC]);
	});

	it("keeps the send stamps apart from a document that was matched rather than sent", () => {
		const matched = linkFor({ [DOC]: { attachmentKey: "5IDIN5M2", library: "user", annotations: {} } }, DOC);
		expect(matched).not.toBeNull();
		expect(matched).not.toHaveProperty("sentAt");
		expect(matched).not.toHaveProperty("sentMd5");
	});
});

describe("the annotations we have written", () => {
	// Without a key the entry says nothing: it can neither be refreshed nor recognised as deleted, and
	// keeping it would answer "already in Zotero" for an annotation that is not there.
	it("drops an entry that names no annotation", () => {
		const stored = { [DOC]: { attachmentKey: "A", library: "user", annotations: { "hl-1": { written: {} }, "hl-2": { key: "K2", written: {} } } } };
		expect(Object.keys(linkFor(stored, DOC)?.annotations ?? {})).toEqual(["hl-2"]);
	});

	// The memory of a decision, and the only thing that tells "the user deleted it" from "never
	// created" -- §3.3 keeps it deleted.
	it("remembers that the user deleted one of ours", () => {
		const stored = { [DOC]: { attachmentKey: "A", library: "user", annotations: { "hl-1": { key: "K1", deleted: true } } } };
		expect(linkFor(stored, DOC)?.annotations["hl-1"]).toEqual({ key: "K1", written: {}, deleted: true });
	});

	// ⚠️ An empty comment is a value we wrote, not an absence. Dropped, it would read as "we never
	// wrote this field" -- and then a field the user cleared by hand would be written over on the next
	// sync, which is exactly what §3.3 promises never happens.
	it("keeps an empty value we wrote, because that is a value and not an absence", () => {
		const stored = { [DOC]: { attachmentKey: "A", library: "user", annotations: { "hl-1": { key: "K1", written: { comment: "", text: "x" } } } } };
		expect(linkFor(stored, DOC)?.annotations["hl-1"].written).toEqual({ comment: "", text: "x" });
	});

	it("keeps only the fields a refresh may compare, whatever else the entry carries", () => {
		const stored = {
			[DOC]: {
				attachmentKey: "A",
				library: "user",
				annotations: { "hl-1": { key: "K1", written: { comment: "ours", colour: "#fff", version: 246 } } },
			},
		};
		expect(linkFor(stored, DOC)?.annotations["hl-1"].written).toEqual({ comment: "ours" });
	});
});

describe("changing the map", () => {
	// `data.json` is handed around whole and saved by whoever saves next; a mutation here would reach
	// the file through a caller that never asked to write.
	it("leaves the map it was given alone", () => {
		const before = withLink({}, DOC, link);
		withLink(before, "second", link);
		withoutLink(before, DOC);
		expect(Object.keys(before)).toEqual([DOC]);
	});

	it("replaces a link rather than merging into it, because a re-send is a new document", () => {
		const replaced = withLink(withLink({}, DOC, link), DOC, { attachmentKey: "OTHER", library: "user", annotations: {} });
		expect(linkFor(replaced, DOC)).toEqual({ attachmentKey: "OTHER", library: "user", annotations: {} });
	});

	it("forgets one document without touching the rest", () => {
		const two = withLink(withLink({}, DOC, link), "second", link);
		expect(Object.keys(withoutLink(two, DOC))).toEqual(["second"]);
	});

	it("lists the documents this build can act on, and no others", () => {
		const stored = { ...withLink({}, DOC, link), broken: "nonsense", group: { attachmentKey: "A", library: "group" } };
		expect(linkedDocumentIds(stored)).toEqual([DOC]);
	});
});

describe("a question the user closed", () => {
	// Without a record of the asking, a duplicate file hash opens the same picker on every single
	// sync -- for somebody who has already decided this document is not a Zotero paper.
	it("is remembered, and reads as unlinked everywhere else", () => {
		const stored = withDeclinedLink({}, DOC);

		expect(wasDeclined(stored, DOC)).toBe(true);
		expect(linkFor(stored, DOC)).toBeNull();
		expect(linkedDocumentIds(stored)).toEqual([]);
	});

	it("is not what an ordinary unlinked document looks like", () => {
		expect(wasDeclined({}, DOC)).toBe(false);
		expect(wasDeclined(withLink({}, DOC, link), DOC)).toBe(false);
	});

	// The *Link to Zotero item…* command is how somebody changes their mind, and the link it writes
	// outranks the shrug that came before it.
	it("gives way to a link written later", () => {
		const stored = withLink(withDeclinedLink({}, DOC), DOC, link);

		expect(wasDeclined(stored, DOC)).toBe(false);
		expect(linkFor(stored, DOC)).toEqual(link);
	});
});
