import { describe, expect, it, vi } from "vitest";
import type { DigestHighlight, DigestNote, DigestPage } from "./digest-builder";
import type { AnnotationFields, ZoteroAnnotation, ZoteroAnnotationRef, ZoteroClient } from "./zotero-client";
import { ZoteroError } from "./zotero-client";
import type { ZoteroLink } from "./zotero-links";
import { executeWriteBack, planWriteBack, type WriteBackPlan } from "./zotero-writeback";

const ATTACHMENT = "5IDIN5M2";
const SOURCE = { index: 1, widthPt: 612, heightPt: 792 };

function highlight(overrides: Partial<DigestHighlight> = {}): DigestHighlight {
	return {
		id: "hl-9f21c4",
		sentence: "Die Techniken gelten für alle Modelle.",
		rects: [{ x: 72, y: 700, width: 228, height: 12 }],
		tool: "marker",
		marked: ["für alle Modelle"],
		color: null,
		notes: [],
		section: null,
		top: 80,
		...overrides,
	};
}

function note(overrides: Partial<DigestNote> = {}): DigestNote {
	return {
		id: "nt-4c8a17",
		anchor: { kind: "page" },
		text: "eine Randnotiz",
		region: null,
		rect: { x: 500, y: 600, width: 90, height: 40 },
		top: 0,
		section: null,
		...overrides,
	} as DigestNote;
}

function page(overrides: Partial<DigestPage> = {}): DigestPage {
	return { pageLabel: "xii", embedPage: 2, source: SOURCE, highlights: [highlight()], notes: [], ...overrides };
}

function link(overrides: Partial<ZoteroLink> = {}): ZoteroLink {
	return { attachmentKey: ATTACHMENT, library: "user", annotations: {}, ...overrides };
}

/** One of ours, as Zotero reports it back. Defaults agree with what `highlight()` would be written as. */
function inZotero(overrides: Partial<ZoteroAnnotation> = {}): ZoteroAnnotation {
	return {
		key: "TNZQQNN3",
		library: "user",
		source: "local",
		parentKey: ATTACHMENT,
		type: "highlight",
		pageIndex: 1,
		text: "für alle Modelle",
		comment: "",
		color: "#ffd400",
		pageLabel: "xii",
		sortIndex: "00001|000000|00080",
		position: '{"pageIndex":1,"rects":[[72,700,300,712]]}',
		version: 246,
		...overrides,
	};
}

/** What we would have recorded for the annotation above. */
const WRITTEN = {
	text: "für alle Modelle",
	comment: "",
	color: "#ffd400",
	pageLabel: "xii",
	sortIndex: "00001|000000|00080",
	position: '{"pageIndex":1,"rects":[[72,700,300,712]]}',
};

const plan = (overrides: { pages?: DigestPage[]; covered?: number[]; link?: ZoteroLink; existing?: ZoteroAnnotation[]; noteWasDeleted?: boolean } = {}): WriteBackPlan =>
	planWriteBack({
		pages: overrides.pages ?? [page()],
		covered: overrides.covered ?? [SOURCE.index],
		attachmentKey: ATTACHMENT,
		link: overrides.link ?? link(),
		existing: overrides.existing ?? [],
		noteWasDeleted: overrides.noteWasDeleted,
	});

describe("a highlight Zotero has never seen", () => {
	it("is created, with what to remember about it", () => {
		const planned = plan();

		expect(planned.creates).toHaveLength(1);
		expect(planned.creates[0].blockId).toBe("hl-9f21c4");
		expect(planned.creates[0].written).toEqual(WRITTEN);
		expect(planned.patches).toEqual([]);
	});

	it("carries a standalone margin note as a sticky of its own", () => {
		const planned = plan({ pages: [page({ notes: [note() as DigestNote & { section: string | null }] })] });

		expect(planned.creates.map((create) => create.annotation.type)).toEqual(["highlight", "note"]);
	});
});

describe("a highlight that is already in Zotero", () => {
	const stored = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: WRITTEN } } });

	it("is left alone when nothing about it has changed", () => {
		const planned = plan({ link: stored, existing: [inZotero()] });

		expect(planned.creates).toEqual([]);
		expect(planned.patches).toEqual([]);
		expect(planned.unchanged.map((entry) => entry.blockId)).toEqual(["hl-9f21c4"]);
	});

	it("is refreshed, field by field, when the tablet says something new", () => {
		const grown = page({ highlights: [highlight({ notes: [note({ text: "später dazugeschrieben" })] })] });
		const planned = plan({ pages: [grown], link: stored, existing: [inZotero()] });

		expect(planned.patches).toHaveLength(1);
		expect(planned.patches[0].fields).toEqual({ comment: "später dazugeschrieben" });
		expect(planned.patches[0].annotation).toEqual({ key: "TNZQQNN3", version: 246, source: "local", library: "user" });
	});

	// ⚠️ §3.3's one-way door. The comparison is against **what we wrote**, not against what we would
	// write now: a field that differs from our own record can only have been changed by the user.
	it("never writes a field the user has edited in Zotero, then or ever after", () => {
		const edited = inZotero({ comment: "meine eigene Notiz" });
		const first = plan({ link: stored, existing: [edited] });

		expect(first.patches).toEqual([]);
		expect(first.unchanged[0].annotation.userEdited).toEqual(["comment"]);

		// The next sync, with the tablet now carrying a margin note for that highlight: still theirs.
		const later = plan({
			pages: [page({ highlights: [highlight({ notes: [note({ text: "vom Tablet" })] })] })],
			link: link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: WRITTEN, userEdited: ["comment"] } } }),
			existing: [edited],
		});
		expect(later.patches).toEqual([]);
		expect(later.unchanged[0].annotation.userEdited).toEqual(["comment"]);
	});

	it("keeps refreshing the fields the user has not touched", () => {
		const edited = inZotero({ comment: "meine eigene Notiz", pageLabel: "xii" });
		const relabelled = page({ pageLabel: "13" });
		const planned = plan({ pages: [relabelled], link: stored, existing: [edited] });

		expect(planned.patches[0].fields).toEqual({ pageLabel: "13" });
		expect(planned.patches[0].userEdited).toEqual(["comment"]);
	});

	// Deleting it in Zotero is a decision, and re-creating it on the next sync would overrule it
	// silently -- forever, because every sync would do it again.
	it("stays deleted once the user has deleted it", () => {
		const planned = plan({ link: stored, existing: [] });

		expect(planned.creates).toEqual([]);
		expect(planned.vanished.map((entry) => entry.annotation)).toEqual([{ key: "TNZQQNN3", written: WRITTEN, deleted: true }]);
	});

	it("is not created again on any later sync either", () => {
		const remembered = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: WRITTEN, deleted: true } } });
		const planned = plan({ link: remembered, existing: [] });

		expect(planned.creates).toEqual([]);
		expect(planned.patches).toEqual([]);
	});

	// The one gesture that un-remembers a deletion: deleting the vault note as well. That is "start
	// over", and the highlight is written like one Zotero has never seen (2026-09-18).
	it("is created again once the user has deleted the vault note as well", () => {
		const remembered = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: WRITTEN, deleted: true } } });
		const planned = plan({ link: remembered, existing: [], noteWasDeleted: true });

		expect(planned.vanished).toEqual([]);
		expect(planned.creates.map((create) => create.blockId)).toEqual(["hl-9f21c4"]);
	});

	it("is created again on the very sync that finds both the note and the annotation gone", () => {
		const planned = plan({ link: stored, existing: [], noteWasDeleted: true });

		expect(planned.vanished).toEqual([]);
		expect(planned.creates.map((create) => create.blockId)).toEqual(["hl-9f21c4"]);
	});

	// Only what is gone starts over. An annotation still in Zotero keeps its record, and with it the
	// fields the user took over -- a note deleted to regenerate it must not overwrite a comment.
	it("keeps what the user edited in Zotero even though they deleted the note", () => {
		const planned = plan({ link: stored, existing: [inZotero({ comment: "theirs" })], noteWasDeleted: true });

		expect(planned.creates).toEqual([]);
		expect(planned.patches).toEqual([]);
		expect(planned.unchanged[0].annotation.userEdited).toEqual(["comment"]);
	});
});

describe("when the mapping is lost but the annotations are not", () => {
	// A vault restored from a backup, a reset `data.json`, a second machine that synced the vault and
	// not the plugin data. Without re-adoption the next sync creates a second copy of every highlight,
	// and nothing but deleting them by hand puts that right.
	it("adopts our own annotation rather than writing a second copy of it", () => {
		const planned = plan({ existing: [inZotero()] });

		expect(planned.creates).toEqual([]);
		expect(planned.unchanged[0].annotation.key).toBe("TNZQQNN3");
	});

	it("matches on type, page and text together, never on one of them", () => {
		const otherPage = inZotero({ key: "OTHER1", pageIndex: 7 });
		const otherText = inZotero({ key: "OTHER2", text: "etwas ganz anderes" });
		const underline = inZotero({ key: "OTHER3", type: "underline" });
		const planned = plan({ existing: [otherPage, otherText, underline] });

		expect(planned.creates).toHaveLength(1);
		expect(planned.unchanged).toEqual([]);
	});

	it("gives two entries two annotations, never the same one twice", () => {
		const twin = highlight({ id: "hl-second" });
		const planned = plan({ pages: [page({ highlights: [highlight(), twin] })], existing: [inZotero(), inZotero({ key: "SECOND" })] });

		expect(planned.unchanged.map((entry) => entry.annotation.key)).toEqual(["TNZQQNN3", "SECOND"]);
	});

	it("refreshes an adopted annotation to what the tablet says", () => {
		const drifted = inZotero({ comment: "was einmal dort stand" });
		const planned = plan({ existing: [drifted] });

		// Nothing about it reads as "the user edited it": we have no record of writing it, so there is
		// nothing to compare against and the tablet is the truth for it again.
		expect(planned.patches[0].fields).toEqual({ comment: "" });
	});
});

describe("what is not written at all", () => {
	it("skips a page the reader added on the device", () => {
		const added = page({ pageLabel: null, source: null, highlights: [highlight()], notes: [note() as DigestNote & { section: string | null }] });
		const planned = plan({ pages: [added] });

		expect(planned.creates).toEqual([]);
		expect(planned.skipped).toBe(2);
	});

	it("skips a margin note there is nothing to say about", () => {
		const planned = plan({ pages: [page({ highlights: [], notes: [note({ text: "" }) as DigestNote & { section: string | null }] })] });

		expect(planned.creates).toEqual([]);
		expect(planned.skipped).toBe(1);
	});

	it("skips an entry that has no place on its page", () => {
		const planned = plan({ pages: [page({ highlights: [highlight({ rects: [] })] })] });

		expect(planned.creates).toEqual([]);
		expect(planned.skipped).toBe(1);
	});

	// The user's own highlights are never in `existing` at all -- the client filters by the ownership
	// tag on the server -- so this is the plan's half of that promise: it invents nothing about them.
	it("never touches an annotation that is not one of ours", () => {
		const planned = plan({ link: link({ annotations: {} }), existing: [] });

		expect(planned.patches).toEqual([]);
		expect(planned.vanished).toEqual([]);
	});
});

describe("a highlight the reader erased on the tablet", () => {
	const stored = link({ annotations: { "hl-old": { key: "OLD1", written: WRITTEN } } });

	it("is trashed while it still reads exactly as we wrote it", () => {
		const planned = plan({ link: stored, existing: [inZotero({ key: "OLD1" })] });

		expect(planned.trashes.map((trash) => trash.annotation)).toEqual([{ key: "OLD1", version: 246, source: "local", library: "user" }]);
		expect(planned.trashes[0].record).toEqual({ key: "OLD1", written: WRITTEN, deleted: true });
		expect(planned.vanished).toEqual([]);
	});

	// The trash is for what is still only ours. A comment, a colour, a page label the user changed
	// in Zotero is something they built on the highlight, and erasing the ink does not take it back.
	it("stays when the user has built on it in Zotero, and is remembered as theirs", () => {
		const planned = plan({ link: stored, existing: [inZotero({ key: "OLD1", comment: "meine eigene Notiz" })] });

		expect(planned.trashes).toEqual([]);
		expect(planned.unchanged).toEqual([{ blockId: "hl-old", annotation: { key: "OLD1", written: WRITTEN, userEdited: ["comment"] } }]);
	});

	it("stays when a field was already surrendered on an earlier sync", () => {
		const surrendered = link({ annotations: { "hl-old": { key: "OLD1", written: WRITTEN, userEdited: ["color"] } } });
		const planned = plan({ link: surrendered, existing: [inZotero({ key: "OLD1" })] });

		expect(planned.trashes).toEqual([]);
	});

	it("is only remembered as gone when Zotero no longer has it either", () => {
		const planned = plan({ link: stored, existing: [] });

		expect(planned.trashes).toEqual([]);
		expect(planned.vanished).toEqual([{ blockId: "hl-old", annotation: { key: "OLD1", written: WRITTEN, deleted: true } }]);
	});

	it("is not trashed twice, or recreated, once it is in the trash", () => {
		const trashed = link({ annotations: { "hl-old": { key: "OLD1", written: WRITTEN, deleted: true } } });
		const planned = plan({ link: trashed, existing: [] });

		expect(planned.trashes).toEqual([]);
		expect(planned.vanished).toEqual([]);
		expect(planned.creates.map((create) => create.blockId)).toEqual(["hl-9f21c4"]);
	});

	// ⚠️ "Not in the digest" and "not offered to Zotero" are different facts. A highlight on a page
	// whose text layer could not be read, or one with no rectangles, is skipped -- and still on the
	// tablet. Trashing it would remove an annotation for a highlight the reader can see.
	it("is told apart from a highlight that is still there but could not be offered", () => {
		const kept = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: WRITTEN }, "nt-4c8a17": { key: "NOTE1", written: { comment: "eine Randnotiz" } } } });
		const unreadable = page({ source: null, highlights: [highlight()], notes: [note() as DigestNote & { section: string | null }] });
		const planned = plan({ pages: [unreadable], link: kept, existing: [inZotero(), inZotero({ key: "NOTE1", type: "note", text: "", comment: "eine Randnotiz" })] });

		expect(planned.trashes).toEqual([]);
		expect(planned.skipped).toBe(2);
	});

	// ⚠️ A digest that failed to build speaks for no page, and one page of a page-scoped document
	// speaks for that page only: a highlight it does not mention may be on a page it never saw.
	it("is never decided on a page the digest was not given", () => {
		const failed = plan({ pages: [], covered: [], link: stored, existing: [inZotero({ key: "OLD1" })] });
		expect(failed.trashes).toEqual([]);
		expect(failed.unchanged).toEqual([]);

		// A page-scoped unit for page 0, while the annotation was written on page 1.
		const otherPage = plan({ pages: [], covered: [0], link: stored, existing: [inZotero({ key: "OLD1" })] });
		expect(otherPage.trashes).toEqual([]);
	});

	// The reader cleared the page. It produces no digest entry at all, and it is still a page the
	// digest was given -- which is the only thing that lets the last highlight on a page be erased.
	it("is decided on a page the digest was given even when that page has nothing left on it", () => {
		const planned = plan({ pages: [], covered: [1], link: stored, existing: [inZotero({ key: "OLD1" })] });

		expect(planned.trashes.map((trash) => trash.blockId)).toEqual(["hl-old"]);
	});

	// A mapping written before positions were remembered, or one whose position says no page, cannot
	// say which page it sits on -- and "erased" is only decided for pages the digest looked at.
	it("leaves alone an annotation whose written page cannot be read", () => {
		const { position: _position, ...withoutPosition } = WRITTEN;
		const unplaced = link({
			annotations: {
				"hl-old": { key: "OLD1", written: withoutPosition },
				"hl-older": { key: "OLD2", written: { ...WRITTEN, position: '{"rects":[]}' } },
			},
		});
		const planned = plan({ link: unplaced, existing: [inZotero({ key: "OLD1" }), inZotero({ key: "OLD2" })] });

		expect(planned.trashes).toEqual([]);
		expect(planned.vanished).toEqual([]);
	});
});

describe("carrying out the plan", () => {
	function fakeClient(overrides: Partial<ZoteroClient> = {}): ZoteroClient {
		return {
			createAnnotations: vi.fn(async (items: unknown[]) => ({ keys: items.map((_item, index) => `NEW${index}`), failures: [] })),
			patchAnnotation: vi.fn(async () => "written" as const),
			trashAnnotation: vi.fn(async () => "written" as const),
			...overrides,
		} as unknown as ZoteroClient;
	}

	// Ticket 26: a library that refuses writes is not one failed request. Nothing after it can land
	// either, so the run ends as a skip the pass can name, not as "0 of 12 written, retry next sync".
	it("gives up on a library that refuses writes, so the pass can name it", async () => {
		const client = fakeClient({
			createAnnotations: vi.fn(async () => {
				throw new ZoteroError("read-only", "Zotero refused to write into that library.");
			}),
		});
		await expect(executeWriteBack(client, link(), plan())).rejects.toMatchObject({ reason: "read-only" });
	});

	it("records the key Zotero gave each new annotation", async () => {
		const result = await executeWriteBack(fakeClient(), link(), plan());

		expect(result.annotations["hl-9f21c4"]).toEqual({ key: "NEW0", written: WRITTEN });
		expect(result.written).toBe(1);
		expect(result.total).toBe(1);
	});

	// Add-and-refresh is what makes this safe: the created ones are mapped, the rest are created on
	// the next sync, and the status line says how far it got (§3.4.3).
	it("keeps what landed when Zotero refuses one of a batch", async () => {
		const client = fakeClient({ createAnnotations: vi.fn(async () => ({ keys: ["NEW0", null], failures: ["parentItem not found"] })) });
		const twoPages = [page({ highlights: [highlight(), highlight({ id: "hl-second" })] })];
		const result = await executeWriteBack(client, link(), plan({ pages: twoPages }));

		expect(result.annotations["hl-9f21c4"].key).toBe("NEW0");
		expect(result.annotations["hl-second"]).toBeUndefined();
		expect(result.written).toBe(1);
		expect(result.total).toBe(2);
		expect(result.failures).toEqual(["parentItem not found"]);
	});

	it("reports a failure that is not Zotero's own words, rather than swallowing it", async () => {
		const client = fakeClient({
			createAnnotations: vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		});
		const result = await executeWriteBack(client, link(), plan());

		expect(result.written).toBe(0);
		expect(result.failures).toEqual(["fetch failed"]);
		// Nothing was recorded, so the next sync creates it -- which is the whole of "resume".
		expect(result.annotations).toEqual({});
	});

	it("stops at the first failure and keeps everything before it", async () => {
		const client = fakeClient({
			patchAnnotation: vi.fn(async () => {
				throw new ZoteroError("unreachable", "The Zotero desktop app is not running.");
			}),
		});
		const stored = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: { ...WRITTEN, comment: "alt" } } } });
		const planned = plan({ link: stored, existing: [inZotero({ comment: "alt" })] });
		const result = await executeWriteBack(client, stored, planned);

		expect(result.written).toBe(0);
		expect(result.failures).toEqual(["The Zotero desktop app is not running."]);
	});

	// 412 is Zotero saying the item moved between our read and our write, which in practice is the
	// user editing it by hand in that window. Their value wins from then on, exactly as if we had seen
	// it in the read.
	it("hands a field over when Zotero says the item changed under us", async () => {
		const client = fakeClient({ patchAnnotation: vi.fn(async () => "conflict" as const) });
		const stored = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: { ...WRITTEN, comment: "alt" } } } });
		const planned = plan({ link: stored, existing: [inZotero({ comment: "alt" })] });
		const result = await executeWriteBack(client, stored, planned);

		expect(result.annotations["hl-9f21c4"].userEdited).toEqual(["comment"]);
		expect(result.written).toBe(0);
	});

	it("remembers a deletion the user made, so the next sync does not undo it", async () => {
		const stored = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: WRITTEN } } });
		const result = await executeWriteBack(fakeClient(), stored, plan({ link: stored, existing: [] }));

		expect(result.annotations["hl-9f21c4"].deleted).toBe(true);
		expect(result.total).toBe(0);
	});

	it("asks Zotero for nothing when there is nothing to do", async () => {
		const client = fakeClient();
		const stored = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: WRITTEN } } });
		await executeWriteBack(client, stored, plan({ link: stored, existing: [inZotero()] }));

		expect(client.createAnnotations as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		expect(client.patchAnnotation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("records a trashed annotation as deleted, so it is never recreated", async () => {
		const client = fakeClient();
		const stored = link({ annotations: { "hl-old": { key: "OLD1", written: WRITTEN } } });
		const result = await executeWriteBack(client, stored, plan({ pages: [page({ highlights: [] })], link: stored, existing: [inZotero({ key: "OLD1" })] }));

		expect(client.trashAnnotation).toHaveBeenCalledWith({ key: "OLD1", version: 246, source: "local", library: "user" });
		expect(result.annotations["hl-old"]).toEqual({ key: "OLD1", written: WRITTEN, deleted: true });
		expect(result.written).toBe(1);
	});

	// Between our read and the trash the user touched it: the same 412 a patch gets, with the same
	// answer. Nothing is recorded, and the next sync reads the edit and keeps the annotation for good.
	it("leaves an annotation alone when it changed under us on the way to the trash", async () => {
		const client = fakeClient({ trashAnnotation: vi.fn(async () => "conflict" as const) });
		const stored = link({ annotations: { "hl-old": { key: "OLD1", written: WRITTEN } } });
		const result = await executeWriteBack(client, stored, plan({ pages: [page({ highlights: [] })], link: stored, existing: [inZotero({ key: "OLD1" })] }));

		expect(result.annotations["hl-old"]).toEqual({ key: "OLD1", written: WRITTEN });
		expect(result.written).toBe(0);
		expect(result.total).toBe(1);
	});

	it("sends a patch back to the connection its version came from", async () => {
		const sent: { ref: ZoteroAnnotationRef; fields: AnnotationFields }[] = [];
		const client = fakeClient({
			patchAnnotation: vi.fn(async (ref: ZoteroAnnotationRef, fields: AnnotationFields) => {
				sent.push({ ref, fields });
				return "written" as const;
			}),
		});
		const stored = link({ annotations: { "hl-9f21c4": { key: "TNZQQNN3", written: { ...WRITTEN, comment: "alt" } } } });
		await executeWriteBack(client, stored, plan({ link: stored, existing: [inZotero({ comment: "alt", source: "web", version: 986 })] }));

		expect(sent[0].ref).toEqual({ key: "TNZQQNN3", version: 986, source: "web", library: "user" });
	});

	it("stops at a trash that fails, with the failure named", async () => {
		const client = fakeClient({
			trashAnnotation: vi.fn(async () => {
				throw new ZoteroError("unreachable", "The Zotero desktop app is not running.");
			}),
		});
		const stored = link({ annotations: { "hl-old": { key: "OLD1", written: WRITTEN } } });
		const planned = plan({ link: stored, existing: [inZotero({ key: "OLD1" })] });
		const result = await executeWriteBack(client, stored, planned);

		expect(result.written).toBe(0);
		expect(result.failures).toEqual(["The Zotero desktop app is not running."]);
		expect(result.annotations["hl-old"]).toEqual({ key: "OLD1", written: WRITTEN });
	});
});
