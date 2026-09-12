import { describe, expect, it, vi } from "vitest";
import {
	createZoteroClient,
	createZoteroConnection,
	OWNERSHIP_TAG,
	ZoteroError,
	type NewAnnotation,
	type ZoteroConnection,
	type ZoteroRequest,
} from "./zotero-client";

/** Answers every request from one handler, and records what was asked. */
function stub(handler: (request: ZoteroRequest) => Response | Promise<Response>) {
	const calls: ZoteroRequest[] = [];
	const requester = async (request: ZoteroRequest) => {
		calls.push(request);
		return await handler(request);
	};
	return { requester, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const attachmentRow = (data: Record<string, unknown>) => ({
	data: { key: "ATT1", itemType: "attachment", contentType: "application/pdf", filename: "paper.pdf", md5: "abc", title: "Full Text PDF", ...data },
});

/** A connection over a canned handler, with the file half stubbed out -- this file is about the wire. */
function connection(handler: (request: ZoteroRequest) => Response | Promise<Response>, id: "local" | "web" = "local"): { api: ZoteroConnection; calls: ZoteroRequest[] } {
	const { requester, calls } = stub(handler);
	const api = createZoteroConnection(id, id === "local" ? "your Zotero desktop app" : "zotero.org", requester, {
		path: async () => null,
		bytes: async () => null,
	}, async () => 42);
	return { api, calls };
}

describe("reading the library", () => {
	it("keeps asking for the next page until one comes back short", async () => {
		const pages = [Array.from({ length: 100 }, (_row, index) => attachmentRow({ key: `A${index}` })), [attachmentRow({ key: "LAST" })]];
		const { api, calls } = connection(() => json(pages.shift() ?? []));
		const attachments = await api.attachments();
		expect(attachments).toHaveLength(101);
		expect(calls.map((call) => call.path)).toEqual([
			"/items?itemType=attachment&limit=100&start=0",
			"/items?itemType=attachment&limit=100&start=100",
		]);
	});

	// EPUB items are refused by the spec, and a trashed attachment is gone as far as this plugin is
	// concerned -- Zotero keeps answering for it, and a note that silently wrote into the trash would
	// be worse than one that says the item is no longer there.
	it("keeps only PDF attachments, and drops the ones in the trash", async () => {
		const { api } = connection(() =>
			json([
				attachmentRow({ key: "PDF" }),
				attachmentRow({ key: "EPUB", contentType: "application/epub+zip" }),
				attachmentRow({ key: "TRASHED", deleted: 1 }),
			]),
		);
		expect((await api.attachments()).map((attachment) => attachment.key)).toEqual(["PDF"]);
	});

	it("names a linked file by the last segment of its path", async () => {
		const { api } = connection(() => json([attachmentRow({ filename: undefined, path: "/Users/me/Papers/linked copy.pdf" })]));
		expect((await api.attachments())[0].filename).toBe("linked copy.pdf");
	});

	it("answers nothing for an attachment Zotero no longer has", async () => {
		const { api } = connection(() => json({ error: "Not found" }, 404));
		expect(await api.attachment("GONE")).toBeNull();
	});

	it("reads the creator, the year and the citation key Better BibTeX keeps in Extra", async () => {
		const { api } = connection(() =>
			json({
				data: {
					key: "ITEM",
					title: "Best Practices für Prompting",
					creators: [{ lastName: "Smith", firstName: "A." }],
					date: "June 2024",
					extra: "tex.ids: x\nCitation Key: smith2024prompting",
				},
			}),
		);
		expect(await api.parentItem("ITEM")).toEqual({
			key: "ITEM",
			title: "Best Practices für Prompting",
			creator: "Smith",
			year: "2024",
			citationKey: "smith2024prompting",
		});
	});

	it("invents no citation key where Zotero has none", async () => {
		const { api } = connection(() => json({ data: { key: "ITEM", title: "Untitled", creators: [], date: "" } }));
		expect(await api.parentItem("ITEM")).toMatchObject({ citationKey: null, creator: null, year: null });
	});

	it("searches top-level items the way Zotero's own quick search does", async () => {
		const { api, calls } = connection(() => json([]));
		await api.search("prompting & co");
		expect(calls[0].path).toBe("/items/top?q=prompting%20%26%20co&qmode=titleCreatorYear&limit=100&start=0");
	});

	// The paper is what gets tagged and what gets sent (§2.6). A tag on the PDF's own row is not
	// found, on purpose: one tag placed two ways would otherwise send the same paper twice.
	it("lists the papers carrying a tag, and only the papers", async () => {
		const { api, calls } = connection(() => json([{ data: { key: "ITEM1", itemType: "journalArticle", title: "Prompting" } }]));
		expect(await api.itemsWithTag("to remarkable")).toMatchObject([{ key: "ITEM1", title: "Prompting" }]);
		expect(calls[0].path).toBe("/items/top?tag=to%20remarkable&limit=100&start=0");
	});
});

describe("our own annotations", () => {
	const annotationRow = (data: Record<string, unknown>) => ({
		data: {
			key: "ANN1",
			version: 246,
			itemType: "annotation",
			parentItem: "ATT1",
			annotationType: "highlight",
			annotationText: "the marked words",
			annotationComment: "",
			annotationColor: "#ffd400",
			annotationPageLabel: "xii",
			annotationSortIndex: "00001|000000|00080",
			annotationPosition: '{"pageIndex":1,"rects":[[72,700,300,712]]}',
			...data,
		},
	});

	// `/items/<key>/children` answers *no* annotations at all on a live Zotero 10 (research/10 §6).
	// The ownership tag is both the filter and the reason this feature can tell its own annotations
	// from the user's.
	it("reads them by the ownership tag, never through the attachment's children", async () => {
		const { api, calls } = connection(() => json([annotationRow({}), annotationRow({ key: "OTHER", parentItem: "ATT9" })]));
		const mine = await api.ownAnnotations("ATT1");
		expect(mine.map((annotation) => annotation.key)).toEqual(["ANN1"]);
		expect(calls[0].path).toBe(`/items?itemType=annotation&tag=${OWNERSHIP_TAG}&limit=100&start=0`);
		expect(calls.every((call) => !call.path.includes("children"))).toBe(true);
	});

	it("remembers which connection read them, because a version means nothing anywhere else", async () => {
		const { api } = connection(() => json([annotationRow({})]), "web");
		expect(await api.ownAnnotations("ATT1")).toMatchObject([{ source: "web", version: 246 }]);
	});

	// The tag is the only thing that says an annotation is ours, and a user is free to put it on one
	// of their own -- an image or an ink annotation, or one whose parent Zotero no longer reports. Such
	// a row is dropped rather than re-adopted as a highlight we wrote.
	it("drops a tagged row that is not one of the three kinds we write", async () => {
		const { api } = connection(() =>
			json([
				annotationRow({}),
				annotationRow({ key: "INK", annotationType: "ink" }),
				annotationRow({ key: "ORPHAN", parentItem: undefined }),
			]),
		);
		expect((await api.ownAnnotations("ATT1")).map((annotation) => annotation.key)).toEqual(["ANN1"]);
	});

	it("reads the page out of the position, and answers none where the position is unreadable", async () => {
		const { api } = connection(() => json([annotationRow({}), annotationRow({ key: "BROKEN", annotationPosition: "not json" })]));
		expect((await api.ownAnnotations("ATT1")).map((annotation) => annotation.pageIndex)).toEqual([1, null]);
	});
});

describe("writing annotations", () => {
	const highlight: NewAnnotation = {
		type: "highlight",
		parentKey: "ATT1",
		text: "the marked words",
		comment: "a margin note",
		color: "#ffd400",
		pageLabel: "xii",
		sortIndex: "00001|000000|00080",
		position: '{"pageIndex":1,"rects":[[72,700,300,712]]}',
	};

	// ⚠️ Zotero's data layer loops over the JSON keys in the order they arrive and every `annotation*`
	// setter throws unless the type was set first. A body built by spreading the caller's object would
	// pass every test that checks fields and fail against a real Zotero.
	it("puts annotationType before every other annotation field", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NEW1" } }));
		await api.createAnnotations([highlight]);
		const sent = (calls[0].body as Record<string, unknown>[])[0];
		const annotationKeys = Object.keys(sent).filter((key) => key.startsWith("annotation"));
		expect(annotationKeys[0]).toBe("annotationType");
	});

	it("tags every annotation it creates as ours, and nothing else", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NEW1" } }));
		await api.createAnnotations([highlight]);
		expect((calls[0].body as Record<string, unknown>[])[0].tags).toEqual([{ tag: OWNERSHIP_TAG }]);
	});

	// Zotero refuses `annotationText` on a sticky note and fails the whole batch it sits in, so the
	// field is dropped here rather than taking eleven good annotations down with it.
	it("never sends highlight text on a sticky note", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NEW1" } }));
		await api.createAnnotations([{ ...highlight, type: "note", text: "should not be sent" }]);
		expect((calls[0].body as Record<string, unknown>[])[0]).not.toHaveProperty("annotationText");
	});

	it("splits a long run into batches Zotero accepts, and keeps every key on its own annotation", async () => {
		const { api, calls } = connection((request) => {
			const batch = request.body as unknown[];
			return json({ success: Object.fromEntries(batch.map((_item, index) => [String(index), `K${index}`])) });
		});
		const created = await api.createAnnotations(Array.from({ length: 60 }, () => highlight));
		expect((calls[0].body as unknown[]).length).toBe(50);
		expect((calls[1].body as unknown[]).length).toBe(10);
		expect(created.keys).toHaveLength(60);
		expect(created.keys[50]).toBe("K0");
	});

	it("says which ones Zotero refused, and keeps the others' keys", async () => {
		const { api } = connection(() => json({ success: { "0": "NEW1" }, failed: { "1": { code: 400, message: "parentItem not found" } } }));
		expect(await api.createAnnotations([highlight, highlight])).toEqual({ keys: ["NEW1", null], failures: ["parentItem not found"] });
	});

	it("sends a write token, so a retried batch is not written twice", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NEW1" } }));
		await api.createAnnotations([highlight]);
		expect(calls[0].headers?.["Zotero-Write-Token"]).toMatch(/^\w{5,32}$/);
	});

	it("patches only the fields it was given, under the version it read", async () => {
		const { api, calls } = connection(() => new Response(null, { status: 204 }));
		expect(await api.patchAnnotation("ANN1", 246, { comment: "changed" })).toBe("written");
		expect(calls[0].body).toEqual({ annotationComment: "changed" });
		expect(calls[0].headers?.["If-Unmodified-Since-Version"]).toBe("246");
	});

	// Every field §3.2 lets a refresh touch, and no others: a patch that quietly dropped one would
	// leave a stale colour or page label in Zotero with nothing to show for it.
	it("maps each refreshable field onto the name Zotero knows it by", async () => {
		const { api, calls } = connection(() => new Response(null, { status: 204 }));
		await api.patchAnnotation("ANN1", 246, {
			text: "the marked words",
			comment: "a margin note",
			color: "#a28ae5",
			pageLabel: "xii",
			sortIndex: "00001|000000|00080",
			position: '{"pageIndex":1,"rects":[]}',
		});
		expect(Object.keys(calls[0].body as object)).toEqual([
			"annotationText",
			"annotationComment",
			"annotationColor",
			"annotationPageLabel",
			"annotationSortIndex",
			"annotationPosition",
		]);
	});

	// 412 is Zotero saying the item moved under us, which is the signature of the user having edited
	// it themselves -- and §3.3 gives the user's value the win.
	it("reports a conflict rather than trying harder when the item changed underneath", async () => {
		const { api } = connection(() => new Response(null, { status: 412 }));
		expect(await api.patchAnnotation("ANN1", 246, { comment: "changed" })).toBe("conflict");
	});
});

describe("two connections, one client", () => {
	const upConnection = (id: "local" | "web", rows: unknown[]) => connection(() => json(rows), id).api;
	const downConnection = (id: "local" | "web") =>
		connection(() => {
			throw new ZoteroError("unreachable", "nothing there");
		}, id).api;

	it("asks the desktop first when both are configured", async () => {
		const local = upConnection("local", [attachmentRow({ key: "FROM-LOCAL" })]);
		const web = upConnection("web", [attachmentRow({ key: "FROM-WEB" })]);
		const client = createZoteroClient({ local, web });
		expect((await client?.attachments())?.map((attachment) => attachment.key)).toEqual(["FROM-LOCAL"]);
	});

	it("falls back to the web when the desktop is not there", async () => {
		const client = createZoteroClient({ local: downConnection("local"), web: upConnection("web", [attachmentRow({ key: "FROM-WEB" })]) });
		expect((await client?.attachments())?.map((attachment) => attachment.key)).toEqual(["FROM-WEB"]);
	});

	// The difference that matters: "I could not ask" is worth asking elsewhere, "the answer is no" is
	// not. A second question about an item the desktop says is gone could only find a stale copy.
	it("does not ask the web a question the desktop already answered", async () => {
		const local = connection(() => json({ error: "Not found" }, 404), "local");
		const web = connection(() => json(attachmentRow({})), "web");
		const client = createZoteroClient({ local: local.api, web: web.api });
		expect(await client?.attachment("GONE")).toBeNull();
		expect(web.calls).toHaveLength(0);
	});

	it("is absent altogether when nothing is configured", () => {
		expect(createZoteroClient({})).toBeNull();
	});

	// ⚠️ A version read from one connection is meaningless to the other -- 246 locally was 986 on the
	// web for the same item. Sent to the wrong one it is either a 412 the writer reads as "the user
	// edited this", or a silent overwrite of an edit the user really made.
	it("sends a patch back to the connection whose version it is holding", async () => {
		const local = connection(() => new Response(null, { status: 204 }), "local");
		const web = connection(() => new Response(null, { status: 204 }), "web");
		const client = createZoteroClient({ local: local.api, web: web.api });
		await client?.patchAnnotation({ key: "ANN1", version: 986, source: "web" }, { comment: "x" });
		expect(local.calls).toHaveLength(0);
		expect(web.calls).toHaveLength(1);
	});

	it("skips a patch whose connection is gone rather than sending its version to the other one", async () => {
		const client = createZoteroClient({ web: upConnection("web", []) });
		await expect(client?.patchAnnotation({ key: "ANN1", version: 246, source: "local" }, { comment: "x" })).rejects.toThrow(ZoteroError);
	});

	it("says which connections answered, in the words the settings line uses", async () => {
		const both = createZoteroClient({ local: upConnection("local", []), web: upConnection("web", []) });
		const localOnly = createZoteroClient({ local: upConnection("local", []) });
		const webOnly = createZoteroClient({ local: downConnection("local"), web: upConnection("web", []) });
		const neither = createZoteroClient({ local: downConnection("local") });
		expect((await both?.status())?.summary).toBe("Connected via desktop and web.");
		expect((await localOnly?.status())?.summary).toBe("Connected via desktop.");
		expect((await webOnly?.status())?.summary).toBe("Connected via web.");
		expect((await neither?.status())?.summary).toBe("Not connected.");
	});

	// A pass-through that quietly does not pass through is invisible: the caller gets `undefined`
	// where it expected an answer, and the feature is off with nothing said. Walked rather than
	// listed, so a call added to the interface and forgotten here fails by name.
	it("hands every call through to the connection that answers it", async () => {
		const asked: string[] = [];
		const { requester } = stub((request) => {
			asked.push(request.path);
			return request.path.startsWith("/items/ATT1/") ? new Response("file:///tmp/paper.pdf") : json([]);
		});
		const api = createZoteroConnection("local", "your Zotero desktop app", requester, {
			path: async () => "/tmp/paper.pdf",
			bytes: async () => new Uint8Array([1]),
		}, async () => 1597773);
		const client = createZoteroClient({ local: api });
		expect(await client?.libraryId()).toBe(1597773);
		expect(await client?.attachments()).toEqual([]);
		expect(await client?.parentItem("ITEM")).not.toBeNull();
		expect(await client?.search("x")).toEqual([]);
		expect(await client?.itemsWithTag("to-remarkable")).toEqual([]);
		expect(await client?.filePath("ATT1")).toBe("/tmp/paper.pdf");
		expect(await client?.fileBytes("ATT1")).toEqual(new Uint8Array([1]));
		expect(await client?.ownAnnotations("ATT1")).toEqual([]);
		expect((await client?.createAnnotations([{ type: "note", parentKey: "ATT1" }]))?.keys).toEqual([null]);
		expect(asked).toHaveLength(6);
	});
});

describe("what comes back from Zotero", () => {
	it("turns a rejected key into a word the status line can use", async () => {
		const { api } = connection(() => json({ error: "Invalid key" }, 401));
		await expect(api.attachments()).rejects.toMatchObject({ reason: "unauthorized" });
	});

	// 403 is two answers: the desktop's "the local API is off", which a user can fix in Zotero's
	// settings, and the web's "this key may not write", which they fix on zotero.org. Sending a web
	// user to a desktop toggle they do not have would point at nothing.
	it("tells a switched-off local API apart from a key that may not write", async () => {
		const off = connection(() => new Response("Local API is not enabled", { status: 403 }));
		const readOnly = connection(() => new Response("Forbidden", { status: 403 }), "web");
		await expect(off.api.attachments()).rejects.toMatchObject({ reason: "not-enabled" });
		await expect(readOnly.api.attachments()).rejects.toMatchObject({ reason: "unauthorized" });
	});

	it("refuses to page forever when a server keeps answering full pages", async () => {
		const { api, calls } = connection(() => json(Array.from({ length: 100 }, () => attachmentRow({}))));
		await expect(api.attachments()).rejects.toMatchObject({ reason: "server" });
		expect(calls.length).toBeLessThanOrEqual(100);
	});

	it("does not take a non-JSON answer for data", async () => {
		const { api } = connection(() => new Response("<html>proxy error</html>", { status: 200 }));
		await expect(api.attachments()).rejects.toMatchObject({ reason: "server" });
	});
});

describe("the timeout both connections share", () => {
	it("stops waiting for a server that never answers", async () => {
		vi.stubGlobal("window", {
			setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
			clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		});
		const { withZoteroTimeout } = await import("./zotero-client");
		await expect(withZoteroTimeout(new Promise(() => {}), 5, "zotero.org")).rejects.toMatchObject({ reason: "unreachable" });
		vi.unstubAllGlobals();
	});
});
