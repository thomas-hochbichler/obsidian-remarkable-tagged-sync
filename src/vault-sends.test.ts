import { describe, expect, it } from "vitest";
import {
	applySyncMarks,
	copiesOf,
	dropExpired,
	isCovered,
	markListedSends,
	noTagNotice,
	remapOrigins,
	SEND_RECORD_LIFETIME_MS,
	sendFor,
	stillOnTablet,
	withSend,
	type StoredVaultSends,
	type VaultSend,
} from "./vault-sends";

const DOC = "1f7c2a90-5b4e-4d1a-9c3e-7a2b8e6d0f11";
const SENT = "2026-11-13T10:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const send: VaultSend = { origin: "Specs/Login-Spec.md", kind: "note", sentAt: SENT, name: "Login-Spec", folderId: "folder-obsidian" };

const at = (offsetMs: number) => new Date(Date.parse(SENT) + offsetMs);

// The engine's tests word the sentence with one tag and with two; these are the ends of the range.
describe('the "marks but no tag" sentence (spec §6.5, §8.1)', () => {
	it("says how to map one when no tag is mapped", () => {
		expect(noTagNotice("Login-Spec", [])).toBe(
			'"Login-Spec" has marks on it but no sync tag, so nothing came back. No tag is mapped for sync yet. Map one in the settings, then tag the document or any page of it.',
		);
	});

	it("names three tags at most, as the send's hint does", () => {
		expect(noTagNotice("Login-Spec", ["a", "b", "c", "d"])).toBe(
			'"Login-Spec" has marks on it but no sync tag, so nothing came back. Tag it, or any page of it, with one of your sync tags ("a", "b", "c", …) on the tablet.',
		);
	});
});

describe("reading a send", () => {
	it("reads back exactly what was stored, every field of spec §5", () => {
		const full: VaultSend = {
			...send,
			seenAt: "2026-11-13T11:00:00.000Z",
			goneAt: "2026-11-14T09:00:00.000Z",
			kept: true,
			inkCheckedHash: "a3f9",
			saidNoTag: true,
			saidUnread: true,
			promotedTags: ["sync"],
		};

		expect(sendFor(withSend({}, DOC, full), DOC)).toEqual(full);
	});

	// Total, as `linkFor` is: `data.json` is edited by hand and written by installs of different ages.
	it.each([
		["nothing stored", {}],
		["a string", { [DOC]: "Specs/Login-Spec.md" }],
		["an array", { [DOC]: [] }],
		["null", { [DOC]: null }],
		["an entry without an origin", { [DOC]: { kind: "note", sentAt: SENT } }],
		["a kind this build does not know", { [DOC]: { origin: "Board.canvas", kind: "canvas", sentAt: SENT } }],
		["a send time that is no time", { [DOC]: { origin: "Specs/Login-Spec.md", kind: "note", sentAt: "yesterday" } }],
	])("answers null for %s", (_case, stored) => {
		expect(sendFor(stored as StoredVaultSends, DOC)).toBeNull();
	});

	it("reads an entry that lost its name or folder, without them -- the copy then counts as the user's", () => {
		const stored = { [DOC]: { origin: "Specs/Login-Spec.md", kind: "pdf", sentAt: SENT, name: 7, folderId: "" } };

		expect(sendFor(stored, DOC)).toEqual({ origin: "Specs/Login-Spec.md", kind: "pdf", sentAt: SENT });
	});

	it("keeps only the strings of a promoted-tag list", () => {
		const stored = { [DOC]: { ...send, promotedTags: ["sync", 3, null, "lesen"] } };

		expect(sendFor(stored, DOC)?.promotedTags).toEqual(["sync", "lesen"]);
	});
});

describe("what the record covers", () => {
	it("covers a document the vault sent, and no other", () => {
		const sends = withSend({}, DOC, send);

		expect([isCovered(sends, DOC), isCovered(sends, "another-doc")]).toEqual([true, false]);
	});

	// Another install of this vault wrote it, so the document is still this vault's own.
	it("covers a document whose entry this build cannot read", () => {
		expect(isCovered({ [DOC]: { origin: "Board.canvas", kind: "canvas" } }, DOC)).toBe(true);
	});

	it("does not take a key of the map's prototype for an entry", () => {
		expect(isCovered({}, "constructor")).toBe(false);
	});

	it("finds every earlier copy of one origin, oldest first, and nothing of another", () => {
		const sends = {
			"doc-new": { ...send, sentAt: "2026-11-14T10:00:00.000Z" },
			"doc-old": send,
			"doc-other": { ...send, origin: "Specs/Signup-Spec.md" },
			"doc-unreadable": { origin: "Specs/Login-Spec.md" },
		};

		expect(copiesOf(sends, "Specs/Login-Spec.md").map((copy) => copy.docId)).toEqual(["doc-old", "doc-new"]);
	});
});

describe("writing a send", () => {
	it("carries the fields a newer build wrote on the same entry", () => {
		const stored = { [DOC]: { ...send, pageCount: 7 } };

		expect(withSend(stored, DOC, { ...send, kept: true })[DOC]).toEqual({ ...send, kept: true, pageCount: 7 });
	});

	it("leaves an entry it cannot read where it is when another is written", () => {
		const stored = { "doc-unreadable": "written by a newer build" };

		expect(withSend(stored, DOC, send)["doc-unreadable"]).toBe("written by a newer build");
	});

	it("does not write through the map it was given", () => {
		const stored: StoredVaultSends = {};
		withSend(stored, DOC, send);

		expect(stored).toEqual({});
	});
});

describe("what a sync listing says (spec §5)", () => {
	const NOW = "2026-11-13T12:00:00.000Z";

	it("marks a listed copy seen", () => {
		expect(sendFor(markListedSends({ [DOC]: send }, [DOC], NOW), DOC)?.seenAt).toBe(NOW);
	});

	it("leaves a copy no listing has found yet alone -- the listing lags the upload", () => {
		const marked = sendFor(markListedSends({ [DOC]: send }, [], NOW), DOC);

		expect([marked?.seenAt, marked?.goneAt]).toEqual([undefined, undefined]);
	});

	it("marks a copy gone once a listing misses it after having found it", () => {
		const seen = { ...send, seenAt: SENT };

		expect(sendFor(markListedSends({ [DOC]: seen }, [], NOW), DOC)?.goneAt).toBe(NOW);
	});

	it("keeps the first miss as the time it went", () => {
		const gone = { ...send, seenAt: SENT, goneAt: "2026-11-13T11:00:00.000Z" };

		expect(sendFor(markListedSends({ [DOC]: gone }, [], NOW), DOC)?.goneAt).toBe("2026-11-13T11:00:00.000Z");
	});

	it("takes the gone mark off a copy that turns up again -- restored from the trash", () => {
		const gone = { ...send, seenAt: SENT, goneAt: "2026-11-13T11:00:00.000Z" };
		const back = sendFor(markListedSends({ [DOC]: gone }, [DOC], NOW), DOC);

		expect([back?.goneAt, back?.seenAt]).toEqual([undefined, NOW]);
	});

	it("leaves an entry it cannot read untouched", () => {
		const stored = { [DOC]: { origin: "Board.canvas", kind: "canvas", seenAt: SENT } };

		expect(markListedSends(stored, [], NOW)).toEqual(stored);
	});

	it("is still on the tablet a day after the send while no listing has found it, and not after", () => {
		expect([stillOnTablet(send, at(23 * HOUR)), stillOnTablet(send, at(DAY))]).toEqual([true, false]);
	});

	it("is on the tablet once seen, however long ago, and not once gone", () => {
		const seen = { ...send, seenAt: SENT };

		expect([stillOnTablet(seen, at(90 * DAY)), stillOnTablet({ ...seen, goneAt: SENT }, at(HOUR))]).toEqual([true, false]);
	});
});

describe("how long an entry lives (spec §11 P5)", () => {
	const GONE = "2026-11-14T10:00:00.000Z";
	const gone = { ...send, seenAt: SENT, goneAt: GONE };
	const sinceGone = (offsetMs: number) => new Date(Date.parse(GONE) + offsetMs);

	it("keeps a gone copy for 30 days, so one restored from the trash is still the vault's own", () => {
		expect(dropExpired({ [DOC]: gone }, sinceGone(SEND_RECORD_LIFETIME_MS - HOUR))).toEqual({ [DOC]: gone });
	});

	it("drops it 30 days after it went", () => {
		expect(dropExpired({ [DOC]: gone }, sinceGone(SEND_RECORD_LIFETIME_MS))).toEqual({});
	});

	it("keeps a copy that is still on the tablet, however old its send", () => {
		const seen = { ...send, seenAt: "2027-03-01T10:00:00.000Z" };

		expect(dropExpired({ [DOC]: seen }, at(365 * DAY))).toEqual({ [DOC]: seen });
	});

	it("drops a copy no listing ever found 30 days after its send -- it never earns a gone mark", () => {
		expect([dropExpired({ [DOC]: send }, at(SEND_RECORD_LIFETIME_MS - HOUR)), dropExpired({ [DOC]: send }, at(SEND_RECORD_LIFETIME_MS))]).toEqual([{ [DOC]: send }, {}]);
	});

	it("never drops an entry it cannot read -- it has no date to trust", () => {
		const stored = { [DOC]: { origin: "Board.canvas", kind: "canvas", sentAt: SENT, goneAt: SENT } };

		expect(dropExpired(stored, at(365 * DAY))).toEqual(stored);
	});
});

describe("following the origin through renames (spec §5)", () => {
	it("follows a renamed origin", () => {
		const sends = remapOrigins({ [DOC]: send }, { kind: "file", from: "Specs/Login-Spec.md", to: "Specs/Auth-Spec.md" });

		expect(sendFor(sends ?? {}, DOC)?.origin).toBe("Specs/Auth-Spec.md");
	});

	it("follows every origin below a renamed folder, and only those", () => {
		const sends = {
			"doc-a": send,
			"doc-b": { ...send, origin: "Specs/2026/Signup-Spec.md" },
			"doc-c": { ...send, origin: "Specs2/Other.md" },
		};

		const moved = remapOrigins(sends, { kind: "folder", from: "Specs", to: "Archive/Specs" }) ?? {};

		expect(["doc-a", "doc-b", "doc-c"].map((docId) => sendFor(moved, docId)?.origin)).toEqual(["Archive/Specs/Login-Spec.md", "Archive/Specs/2026/Signup-Spec.md", "Specs2/Other.md"]);
	});

	// `null` is how the caller learns not to write `data.json`, a synced file.
	it("answers null for a rename of something else", () => {
		expect(remapOrigins({ [DOC]: send }, { kind: "file", from: "Inbox/Scratch.md", to: "Inbox/Ideas.md" })).toBeNull();
	});

	it("moves the origin of an entry it cannot otherwise read, and keeps the rest of it", () => {
		const stored = { [DOC]: { origin: "Boards/Plan.canvas", kind: "canvas", pages: 3 } };

		expect(remapOrigins(stored, { kind: "folder", from: "Boards", to: "Old" })).toEqual({ [DOC]: { origin: "Old/Plan.canvas", kind: "canvas", pages: 3 } });
	});

	it("leaves an entry without an origin where it is", () => {
		const stored = { "doc-junk": "written by a newer build", [DOC]: send };

		expect(remapOrigins(stored, { kind: "file", from: send.origin, to: "Auth.md" })?.["doc-junk"]).toBe("written by a newer build");
	});
});

describe("what a sync hands back (spec §5)", () => {
	it("sets the marks on the live entry and keeps everything else on it", () => {
		const live = { [DOC]: { ...send, origin: "Specs/Auth-Spec.md", pageCount: 7 } };

		const applied = applySyncMarks(live, { [DOC]: { inkCheckedHash: "b71c", saidNoTag: true, promotedTags: ["sync"] } });

		expect(applied[DOC]).toEqual({ ...send, origin: "Specs/Auth-Spec.md", pageCount: 7, inkCheckedHash: "b71c", saidNoTag: true, promotedTags: ["sync"] });
	});

	it("keeps a send recorded while the sync ran", () => {
		const live = { [DOC]: send, "doc-new": { ...send, sentAt: "2026-11-13T10:05:00.000Z" } };

		expect(applySyncMarks(live, { [DOC]: { saidUnread: true } })["doc-new"]).toBe(live["doc-new"]);
	});

	it("makes no entry for a document that has none by then", () => {
		expect(applySyncMarks({}, { [DOC]: { saidNoTag: true } })).toEqual({});
	});
});
