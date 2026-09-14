import { describe, expect, it } from "vitest";
import type { ZoteroAttachment } from "./zotero-client";
import type { ZoteroLink } from "./zotero-links";
import { matchZoteroAttachment, type MatchInput } from "./zotero-match";

// The nine rows of spec §2.3, one test each, plus the rule that is not written as code: titles are
// never compared. A wrong link writes one reader's highlights onto another paper, in a place the
// user has no reason to look -- so every row here is about refusing to guess.

const MD5 = "2de21c18668a0faba572b4c7f7ecd1f5";

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: "ATT1", library: "user", parentKey: "ITEM1", filename: "paper.pdf", md5: MD5, title: "Full Text PDF", ...overrides };
}

function link(overrides: Partial<ZoteroLink> = {}): ZoteroLink {
	return { attachmentKey: "ATT1", library: "user", annotations: {}, ...overrides };
}

function match(input: Partial<MatchInput> = {}) {
	return matchZoteroAttachment({
		link: null,
		declined: false,
		attachments: [attachment()],
		md5: null,
		visibleName: "Something else.pdf",
		...input,
	});
}

describe("a document that is already linked", () => {
	// Send links at upload, so its documents never reach the hash and filename rows at all.
	it("is used as it stands, whatever else the library now looks like", () => {
		const twin = attachment({ key: "ATT2", filename: "paper.pdf", md5: MD5 });
		expect(match({ link: link(), attachments: [attachment(), twin], md5: MD5, visibleName: "paper.pdf" })).toEqual({
			kind: "linked",
			attachment: attachment(),
		});
	});

	// The file in Zotero being replaced is not a change of identity: the link is by key, and the new
	// file has a new hash that would match nothing.
	it("survives the file behind it being replaced", () => {
		const replaced = attachment({ md5: "0000000000000000000000000000ffff" });
		expect(match({ link: link(), attachments: [replaced], md5: MD5 })).toEqual({ kind: "linked", attachment: replaced });
	});

	// The note keeps everything it has and loses its Zotero part; write-back does not run. The link
	// stays in `data.json`, because the user may put the item back and nothing else remembers what
	// this document was.
	it("says the item is gone when Zotero no longer has it", () => {
		expect(match({ link: link({ attachmentKey: "TRASHED" }), attachments: [attachment()] })).toEqual({
			kind: "gone",
			attachmentKey: "TRASHED",
		});
	});
});

describe("a document that arrived some other way", () => {
	it("links silently when exactly one attachment has these bytes", () => {
		expect(match({ md5: MD5 })).toEqual({ kind: "link", attachment: attachment(), evidence: "hash" });
	});

	// A paper filed under two entries, or a duplicate nobody merged. The bytes cannot say which entry
	// was meant, and picking either would be a coin toss the user never sees.
	it("asks when two attachments have the same bytes", () => {
		const second = attachment({ key: "ATT2", parentKey: "ITEM2" });
		const result = match({ md5: MD5, attachments: [attachment(), second] });

		expect(result.kind).toBe("ask");
		expect(result.kind === "ask" && result.candidates.map((candidate) => candidate.key)).toEqual(["ATT1", "ATT2"]);
		expect(result.kind === "ask" && result.evidence).toBe("hash");
	});

	// ⚠️ A linked file on the web connection has no `md5` at all. Compared without both guards,
	// `null === null` would match every linked file in the library to a document whose bytes could not
	// be read -- silently, and by the rule that is supposed to be the certain one.
	it("never takes two absent hashes for the same bytes", () => {
		expect(match({ md5: null, attachments: [attachment({ md5: null })] })).toEqual({ kind: "none" });
	});

	it("offers the one attachment whose filename is the tablet's document name, and still asks", () => {
		const result = match({ visibleName: "paper.pdf" });

		expect(result.kind).toBe("ask");
		expect(result.kind === "ask" && result.evidence).toBe("filename");
	});

	// Seen both ways on a real device: the reMarkable app keeps `.pdf` when a file is dragged in, and
	// other paths drop it.
	it("compares the name with and without the extension the device may have kept", () => {
		expect(match({ visibleName: "paper" }).kind).toBe("ask");
		expect(match({ visibleName: "paper.pdf" }).kind).toBe("ask");
		expect(match({ visibleName: "PAPER.PDF" }).kind).toBe("ask");
	});

	it("says nothing at all when two files in the library carry that name", () => {
		const second = attachment({ key: "ATT2", md5: "0000000000000000000000000000ffff" });
		expect(match({ visibleName: "paper.pdf", attachments: [attachment({ md5: null }), second] })).toEqual({ kind: "none" });
	});

	// ⚠️ The rule that is not written as code. To a human these are the same paper; to this function
	// they are not evidence of anything, and a wrong link is worse than no link.
	it("never guesses from a title that merely looks like the same paper", () => {
		const zotero = attachment({ filename: "Prompting (Smith 2024).pdf", md5: null, title: "Best Practices für Prompting" });
		expect(match({ visibleName: "Smith 2024 - Prompting.pdf", attachments: [zotero] })).toEqual({ kind: "none" });
	});

	// ⚠️ An attachment can have no filename at all (a linked file whose path Zotero did not report),
	// and a tablet document can have an empty name. Stripped and compared without the guard, both come
	// out as "" and every nameless attachment matches every nameless document.
	it("takes two missing names for nothing rather than for each other", () => {
		expect(match({ visibleName: "", attachments: [attachment({ filename: null, md5: null })] })).toEqual({ kind: "none" });
		expect(match({ visibleName: "", attachments: [attachment({ filename: "", md5: null })] })).toEqual({ kind: "none" });
	});

	it("leaves a document alone when there is nothing to go on", () => {
		expect(match({ attachments: [] })).toEqual({ kind: "none" });
	});
});

describe("asking once", () => {
	// Without this, a duplicate hash opens the same picker on every single sync -- for a user who has
	// already decided that this document is not a Zotero paper.
	it("does not ask a second time about a question the user closed", () => {
		expect(match({ declined: true, md5: MD5 })).toEqual({ kind: "none" });
		expect(match({ declined: true, visibleName: "paper.pdf" })).toEqual({ kind: "none" });
	});

	// Because a decision the user made in the *Link to Zotero item…* command outranks their earlier
	// shrug, and the link that command writes replaces the marker outright.
	it("still uses a link written after that question was closed", () => {
		expect(match({ declined: true, link: link() })).toEqual({ kind: "linked", attachment: attachment() });
	});
});

describe("with nothing to match against", () => {
	// No connection means no library listing: `attachments` is empty, matching decides nothing, and
	// the sync runs exactly as it does today (§2.3, last row).
	it("decides nothing when the library could not be read", () => {
		expect(match({ attachments: [], md5: MD5, visibleName: "paper.pdf" })).toEqual({ kind: "none" });
	});

	// A document already linked keeps its link even then: it is a fact in `data.json`, not something
	// that needs Zotero to be reachable -- but the attachment cannot be confirmed, so it reads as gone
	// and the note simply loses its Zotero part for that run.
	it("reports a linked document as gone rather than inventing an attachment", () => {
		expect(match({ link: link(), attachments: [] })).toEqual({ kind: "gone", attachmentKey: "ATT1" });
	});
});
