import { describe, expect, it, vi } from "vitest";
import {
	createZoteroClient,
	createZoteroConnection,
	createZoteroRenders,
	OWNERSHIP_TAG,
	renderFilename,
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
	}, async () => ({ id: 42, username: null }));
	return { api, calls };
}

describe("reading the library", () => {
	it("keeps asking for the next page until one comes back short", async () => {
		const pages = [Array.from({ length: 100 }, (_row, index) => attachmentRow({ key: `A${index}` })), [attachmentRow({ key: "LAST" })]];
		const { api, calls } = connection(() => json(pages.shift() ?? []));
		const attachments = await api.attachments("user");
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
		expect((await api.attachments("user")).map((attachment) => attachment.key)).toEqual(["PDF"]);
	});

	it("names a linked file by the last segment of its path", async () => {
		const { api } = connection(() => json([attachmentRow({ filename: undefined, path: "/Users/me/Papers/linked copy.pdf" })]));
		expect((await api.attachments("user"))[0].filename).toBe("linked copy.pdf");
	});

	// Zotero keeps an absolute linked path in the platform's own form, so on Windows it has no `/` at
	// all, and the whole path became the name the matcher compares.
	it("names a linked file on Windows by the last segment of its path", async () => {
		const { api } = connection(() => json([attachmentRow({ filename: undefined, path: "C:\\Users\\me\\Papers\\linked copy.pdf" })]));
		expect((await api.attachments("user"))[0].filename).toBe("linked copy.pdf");
	});

	it("answers nothing for an attachment Zotero no longer has", async () => {
		const { api } = connection(() => json({ error: "Not found" }, 404));
		expect(await api.attachment("GONE", "user")).toBeNull();
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
		expect(await api.parentItem("ITEM", "user")).toEqual({
			key: "ITEM",
			library: "user",
			title: "Best Practices für Prompting",
			creator: "Smith",
			year: "2024",
			citationKey: "smith2024prompting",
		});
	});

	it("invents no citation key where Zotero has none", async () => {
		const { api } = connection(() => json({ data: { key: "ITEM", title: "Untitled", creators: [], date: "" } }));
		expect(await api.parentItem("ITEM", "user")).toMatchObject({ citationKey: null, creator: null, year: null });
	});

	it("searches top-level items the way Zotero's own quick search does", async () => {
		const { api, calls } = connection(() => json([]));
		await api.search("prompting & co", "user");
		expect(calls[0].path).toBe("/items/top?q=prompting%20%26%20co&qmode=titleCreatorYear&limit=100&start=0");
	});

	// The paper is what gets tagged and what gets sent (§2.6). A tag on the PDF's own row is not
	// found, on purpose: one tag placed two ways would otherwise send the same paper twice.
	it("lists the papers carrying a tag, and only the papers", async () => {
		const { api, calls } = connection(() => json([{ data: { key: "ITEM1", itemType: "journalArticle", title: "Prompting" } }]));
		expect(await api.itemsWithTag("to remarkable", "user")).toMatchObject([{ key: "ITEM1", title: "Prompting" }]);
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
		const mine = await api.ownAnnotations("ATT1", "user");
		expect(mine.map((annotation) => annotation.key)).toEqual(["ANN1"]);
		expect(calls[0].path).toBe(`/items?itemType=annotation&tag=${OWNERSHIP_TAG}&limit=100&start=0`);
		expect(calls.every((call) => !call.path.includes("children"))).toBe(true);
	});

	it("remembers which connection read them, because a version means nothing anywhere else", async () => {
		const { api } = connection(() => json([annotationRow({})]), "web");
		expect(await api.ownAnnotations("ATT1", "user")).toMatchObject([{ source: "web", version: 246 }]);
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
		expect((await api.ownAnnotations("ATT1", "user")).map((annotation) => annotation.key)).toEqual(["ANN1"]);
	});

	it("reads the page out of the position, and answers none where the position is unreadable", async () => {
		const { api } = connection(() => json([annotationRow({}), annotationRow({ key: "BROKEN", annotationPosition: "not json" })]));
		expect((await api.ownAnnotations("ATT1", "user")).map((annotation) => annotation.pageIndex)).toEqual([1, null]);
	});
});

describe("notes for pages added on the tablet (#246)", () => {
	const BODY = "<h1>Added page after p. 12</h1>\n<p>my words</p>";

	it("creates a child note under the paper, tagged as ours", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NOTE1" }, successful: { "0": { key: "NOTE1", data: { note: BODY } } } }));
		await api.createNotes([{ parentKey: "ITEM1", note: BODY }], "user");
		expect(calls[0]).toMatchObject({ method: "POST", path: "/items", body: [{ itemType: "note", parentItem: "ITEM1", note: BODY, tags: [{ tag: OWNERSHIP_TAG }] }] });
		expect(calls[0].headers?.["Zotero-Write-Token"]).toMatch(/^\w{5,32}$/);
	});

	// What is remembered is what Zotero stored, not what was sent: the next sync compares against it,
	// and a cleaner on the way in must not make our own note read as the user's edit (research 03 §3).
	it("hands back the body as Zotero stored it, and says which ones it refused", async () => {
		const { api } = connection(() =>
			json({ success: { "0": "NOTE1" }, successful: { "0": { key: "NOTE1", data: { note: "<h1>stored</h1>" } } }, failed: { "1": { code: 400, message: "Parent item not found" } } }),
		);
		expect(await api.createNotes([{ parentKey: "ITEM1", note: BODY }, { parentKey: "GONE", note: BODY }], "user")).toEqual({
			created: [{ key: "NOTE1", note: "<h1>stored</h1>" }, null],
			failures: ["Parent item not found"],
		});
	});

	it("reads only our notes under one paper", async () => {
		const { api, calls } = connection(() =>
			json([
				{ data: { key: "NOTE1", version: 7, itemType: "note", parentItem: "ITEM1", note: BODY } },
				{ data: { key: "TOP", version: 3, itemType: "note", note: "<p>standalone</p>" } },
			]),
		);
		expect(await api.ownNotes("ITEM1", "user")).toEqual([{ key: "NOTE1", library: "user", source: "local", parentKey: "ITEM1", note: BODY, version: 7 }]);
		expect(calls[0].path).toBe(`/items/ITEM1/children?itemType=note&tag=${OWNERSHIP_TAG}&limit=100&start=0`);
	});

	it("cannot say whether notes may be written where only the desktop app is connected", async () => {
		expect(await createZoteroClient({ local: connection(() => json([])).api })?.notesAccess()).toBeNull();
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
		await api.createAnnotations([highlight], "user");
		const sent = (calls[0].body as Record<string, unknown>[])[0];
		const annotationKeys = Object.keys(sent).filter((key) => key.startsWith("annotation"));
		expect(annotationKeys[0]).toBe("annotationType");
	});

	it("tags every annotation it creates as ours, and nothing else", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NEW1" } }));
		await api.createAnnotations([highlight], "user");
		expect((calls[0].body as Record<string, unknown>[])[0].tags).toEqual([{ tag: OWNERSHIP_TAG }]);
	});

	// Zotero refuses `annotationText` on a sticky note and fails the whole batch it sits in, so the
	// field is dropped here rather than taking eleven good annotations down with it.
	it("never sends highlight text on a sticky note", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NEW1" } }));
		await api.createAnnotations([{ ...highlight, type: "note", text: "should not be sent" }], "user");
		expect((calls[0].body as Record<string, unknown>[])[0]).not.toHaveProperty("annotationText");
	});

	it("splits a long run into batches Zotero accepts, and keeps every key on its own annotation", async () => {
		const { api, calls } = connection((request) => {
			const batch = request.body as unknown[];
			return json({ success: Object.fromEntries(batch.map((_item, index) => [String(index), `K${index}`])) });
		});
		const created = await api.createAnnotations(Array.from({ length: 60 }, () => highlight), "user");
		expect((calls[0].body as unknown[]).length).toBe(50);
		expect((calls[1].body as unknown[]).length).toBe(10);
		expect(created.keys).toHaveLength(60);
		expect(created.keys[50]).toBe("K0");
	});

	it("says which ones Zotero refused, and keeps the others' keys", async () => {
		const { api } = connection(() => json({ success: { "0": "NEW1" }, failed: { "1": { code: 400, message: "parentItem not found" } } }));
		expect(await api.createAnnotations([highlight, highlight], "user")).toEqual({ keys: ["NEW1", null], failures: ["parentItem not found"] });
	});

	it("sends a write token, so a retried batch is not written twice", async () => {
		const { api, calls } = connection(() => json({ success: { "0": "NEW1" } }));
		await api.createAnnotations([highlight], "user");
		expect(calls[0].headers?.["Zotero-Write-Token"]).toMatch(/^\w{5,32}$/);
	});

	it("patches only the fields it was given, under the version it read", async () => {
		const { api, calls } = connection(() => new Response(null, { status: 204 }));
		expect(await api.patchAnnotation("ANN1", 246, { comment: "changed" }, "user")).toBe("written");
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
		}, "user");
		expect(Object.keys(calls[0].body as object)).toEqual([
			"annotationText",
			"annotationComment",
			"annotationColor",
			"annotationPageLabel",
			"annotationSortIndex",
			"annotationPosition",
		]);
	});

	// ⚠️ Never `DELETE`: on the local API that is a permanent erase. `deleted: true` is the trash on
	// both APIs, and the trash is what makes an erased highlight a thing the user can take back.
	it("trashes an annotation rather than erasing it, under the version it read", async () => {
		const { api, calls } = connection(() => new Response(null, { status: 204 }));
		expect(await api.trashAnnotation("ANN1", 246, "user")).toBe("written");
		expect(calls[0]).toMatchObject({ method: "PATCH", path: "/items/ANN1", body: { deleted: true } });
		expect(calls[0].headers?.["If-Unmodified-Since-Version"]).toBe("246");
	});

	it("reports a conflict on the way to the trash, like a patch would", async () => {
		const { api } = connection(() => new Response(null, { status: 412 }));
		expect(await api.trashAnnotation("ANN1", 246, "user")).toBe("conflict");
	});

	// 412 is Zotero saying the item moved under us, which is the signature of the user having edited
	// it themselves -- and §3.3 gives the user's value the win.
	it("reports a conflict rather than trying harder when the item changed underneath", async () => {
		const { api } = connection(() => new Response(null, { status: 412 }));
		expect(await api.patchAnnotation("ANN1", 246, { comment: "changed" }, "user")).toBe("conflict");
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
		expect(await client?.attachment("GONE", "user")).toBeNull();
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
		await client?.patchAnnotation({ key: "ANN1", version: 986, source: "web", library: "user" }, { comment: "x" });
		expect(local.calls).toHaveLength(0);
		expect(web.calls).toHaveLength(1);
	});

	it("sends a trash to the connection whose version it is holding, and nowhere else", async () => {
		const local = connection(() => new Response(null, { status: 204 }), "local");
		const web = connection(() => new Response(null, { status: 204 }), "web");
		const client = createZoteroClient({ local: local.api, web: web.api });
		await client?.trashAnnotation({ key: "ANN1", version: 986, source: "web", library: "user" });
		expect(local.calls).toHaveLength(0);
		expect(web.calls).toHaveLength(1);
		await expect(createZoteroClient({ web: web.api })?.trashAnnotation({ key: "ANN1", version: 246, source: "local", library: "user" })).rejects.toThrow(ZoteroError);
	});

	it("skips a patch whose connection is gone rather than sending its version to the other one", async () => {
		const client = createZoteroClient({ web: upConnection("web", []) });
		await expect(client?.patchAnnotation({ key: "ANN1", version: 246, source: "local", library: "user" }, { comment: "x" })).rejects.toThrow(ZoteroError);
	});

	it("says which connections answered, in the words the settings line uses", async () => {
		const both = createZoteroClient({ local: upConnection("local", []), web: upConnection("web", []) });
		const localOnly = createZoteroClient({ local: upConnection("local", []) });
		const webOnly = createZoteroClient({ local: downConnection("local"), web: upConnection("web", []) });
		const neither = createZoteroClient({ local: downConnection("local") });
		expect((await both?.status())?.summary).toBe("Connected via desktop and web. The desktop app is asked first; zotero.org answers when it is closed.");
		expect((await localOnly?.status())?.summary).toBe("Connected via desktop.");
		expect((await webOnly?.status())?.summary).toBe("Connected via web.");
		expect((await neither?.status())?.summary).toBe("Not connected.");
	});

	// A pass-through that quietly does not pass through is invisible: the caller gets `undefined`
	// where it expected an answer, and the feature is off with nothing said. Walked rather than
	// listed, so a call added to the interface and forgotten here fails by name.
	it("has neither id nor username where the account is unknown", async () => {
		const { requester } = stub(() => json([]));
		const api = createZoteroConnection("web", "zotero.org", requester, { path: async () => null, bytes: async () => null }, async () => null);
		expect(await api.libraryId()).toBeNull();
		expect(await api.username()).toBeNull();
	});

	it("hands every call through to the connection that answers it", async () => {
		const asked: string[] = [];
		const { requester } = stub((request) => {
			asked.push(request.path);
			return request.path.startsWith("/items/ATT1/") ? new Response("file:///tmp/paper.pdf") : json([]);
		});
		const api = createZoteroConnection("local", "your Zotero desktop app", requester, {
			path: async () => "/tmp/paper.pdf",
			bytes: async () => new Uint8Array([1]),
		}, async () => ({ id: 1597773, username: null }));
		const client = createZoteroClient({ local: api });
		expect(await client?.libraryId()).toBe(1597773);
		// The one call that is not handed through: the username is zotero.org's alone, and a client
		// with only the desktop app simply has none rather than asking a connection that cannot know.
		expect(await client?.username()).toBeNull();
		expect(await client?.attachments()).toEqual([]);
		expect(await client?.parentItem("ITEM", "user")).not.toBeNull();
		expect(await client?.search("x")).toEqual([]);
		expect(await client?.itemsWithTag("to-remarkable")).toEqual([]);
		expect(await client?.filePath("ATT1", "user")).toBe("/tmp/paper.pdf");
		expect(await client?.fileBytes("ATT1", "user")).toEqual(new Uint8Array([1]));
		expect(await client?.ownAnnotations("ATT1", "user")).toEqual([]);
		expect((await client?.createAnnotations([{ type: "note", parentKey: "ATT1" }], "user"))?.keys).toEqual([null]);
		expect(asked).toHaveLength(6);
	});

	// The desktop app never hands over bytes, only a path (§2.4). Its `null` says nothing about
	// zotero.org, which may well have the file: Zotero's "download files as needed", or a path the
	// desktop named that could not be read. Ending there sent the user to the file dialog under
	// "Zotero has no copy of this PDF online" without zotero.org ever being asked.
	const withBytes = (id: "local" | "web", bytes: () => Promise<Uint8Array | null>) =>
		createZoteroConnection(id, id, stub(() => json([])).requester, { path: async () => null, bytes }, async () => null);

	it("downloads from zotero.org when the desktop app has no bytes to give", async () => {
		const client = createZoteroClient({ local: withBytes("local", async () => null), web: withBytes("web", async () => new Uint8Array([7])) });
		expect(await client?.fileBytes("ATT1", "user")).toEqual(new Uint8Array([7]));
	});

	it("goes on to the file dialog, not an error, when zotero.org cannot be reached for the download", async () => {
		const unreachable = async (): Promise<never> => {
			throw new ZoteroError("unreachable", "offline");
		};
		const client = createZoteroClient({ local: withBytes("local", async () => null), web: withBytes("web", unreachable) });
		expect(await client?.fileBytes("ATT1", "user")).toBeNull();
	});

	// A 500 is zotero.org's answer, not a connection that could not be asked: the dialog would hide it
	// behind "no copy online" when the copy is there and the server is what failed.
	it("reports zotero.org failing the download rather than hiding it behind the file dialog", async () => {
		const failing = async (): Promise<never> => {
			throw new ZoteroError("server", "zotero.org answered 500 for that PDF.");
		};
		const client = createZoteroClient({ local: withBytes("local", async () => null), web: withBytes("web", failing) });
		await expect(client?.fileBytes("ATT1", "user")).rejects.toMatchObject({ reason: "server" });
	});
});

describe("what comes back from Zotero", () => {
	it("turns a rejected key into a word the status line can use", async () => {
		const { api } = connection(() => json({ error: "Invalid key" }, 401));
		await expect(api.attachments("user")).rejects.toMatchObject({ reason: "unauthorized" });
	});

	// 403 is two answers: the desktop's "the local API is off", which a user can fix in Zotero's
	// settings, and the web's "this key may not write", which they fix on zotero.org. Sending a web
	// user to a desktop toggle they do not have would point at nothing.
	it("tells a switched-off local API apart from a key that may not write", async () => {
		const off = connection(() => new Response("Local API is not enabled", { status: 403 }));
		const readOnly = connection(() => new Response("Forbidden", { status: 403 }), "web");
		await expect(off.api.attachments("user")).rejects.toMatchObject({ reason: "not-enabled" });
		await expect(readOnly.api.attachments("user")).rejects.toMatchObject({ reason: "unauthorized" });
	});

	it("refuses to page forever when a server keeps answering full pages", async () => {
		const { api, calls } = connection(() => json(Array.from({ length: 100 }, () => attachmentRow({}))));
		await expect(api.attachments("user")).rejects.toMatchObject({ reason: "server" });
		expect(calls.length).toBeLessThanOrEqual(100);
	});

	it("does not take a non-JSON answer for data", async () => {
		const { api } = connection(() => new Response("<html>proxy error</html>", { status: 200 }));
		await expect(api.attachments("user")).rejects.toMatchObject({ reason: "server" });
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

describe("group libraries (ticket 26)", () => {
	const GROUP = { group: 4711 };
	const LAB = { id: 4711, name: "Lab reading group" };
	const groupRow = (id: number, name: string) => ({ id, version: 1, data: { id, name, description: "" } });

	it("lists the groups a connection can see, by id and name, under the user prefix", async () => {
		const { api, calls } = connection(() => json([groupRow(4711, "Lab reading group"), { id: 12, data: {} }]));
		expect(await api.groups()).toEqual([LAB]);
		expect(calls[0]).toMatchObject({ library: "user", path: "/groups?limit=100&start=0" });
	});

	// A key is unique only within a library, so every row says which one it came from, and every
	// request says which one it is for -- the connection turns that into the prefix.
	it("asks each enabled library on its own prefix and stamps every row with where it came from", async () => {
		const { api, calls } = connection(() => json([attachmentRow({})]));
		const client = createZoteroClient({ local: api, groups: [LAB] });
		expect((await client?.attachments())?.map((attachment) => attachment.library)).toEqual(["user", GROUP]);
		expect(calls.map((call) => call.library)).toEqual(["user", GROUP]);
		expect((await client?.search("x"))?.map((item) => item.library)).toEqual(["user", GROUP]);
		expect((await client?.itemsWithTag("t"))?.map((item) => item.library)).toEqual(["user", GROUP]);
		expect(client?.libraries).toEqual(["user", GROUP]);
	});

	// The desktop app holds only the groups it syncs, so "not found" on a group listing is the one
	// not-found that is about the connection rather than about the item.
	it("falls through to the web for a group the desktop app does not hold, and lists it empty when nobody holds it", async () => {
		const local = connection((request) => (request.library === "user" ? json([attachmentRow({})]) : json({ error: "Not found" }, 404)), "local");
		const web = connection((request) => (request.library === "user" ? json([]) : json([attachmentRow({ key: "G1" })])), "web");
		expect((await createZoteroClient({ local: local.api, web: web.api, groups: [LAB] })?.attachments())?.map((attachment) => attachment.key)).toEqual(["ATT1", "G1"]);
		expect((await createZoteroClient({ local: local.api, groups: [LAB] })?.attachments())?.map((attachment) => attachment.key)).toEqual(["ATT1"]);
	});

	// 403 on a write is the library's answer -- the desktop's `Write access denied` for a group the
	// user may only read -- and the other connection would say the same. A refused *read* is still
	// the key, and still worth asking the other connection.
	it("reads a refused write as read-only and never tries the other connection with it", async () => {
		const local = connection(() => new Response("Write access denied", { status: 403 }), "local");
		const web = connection(() => json({ success: { "0": "NEW" } }), "web");
		const client = createZoteroClient({ local: local.api, web: web.api });
		await expect(client?.createAnnotations([{ type: "note", parentKey: "ATT1" }], GROUP)).rejects.toMatchObject({ reason: "read-only", connection: "local" });
		expect(web.calls).toHaveLength(0);
		await expect(local.api.attachments("user")).rejects.toMatchObject({ reason: "unauthorized" });
	});

	// zotero.org refuses a write with the same 403 when the key was made without "Allow write
	// access" (e2e 2026-09-18). The error says which connection refused, so the pass can point at
	// the key rather than at a library membership.
	it("says that a refused write came from zotero.org", async () => {
		const web = connection(() => new Response("Forbidden", { status: 403 }), "web");
		const client = createZoteroClient({ web: web.api });
		await expect(client?.createAnnotations([{ type: "note", parentKey: "ATT1" }], "user")).rejects.toMatchObject({ reason: "read-only", connection: "web" });
		await expect(client?.patchAnnotation({ key: "ANN1", version: 3, library: "user", source: "web" }, { comment: "x" })).rejects.toMatchObject({ reason: "read-only", connection: "web" });
	});

	it("routes a patch by the annotation's library as well as by its source", async () => {
		const { api, calls } = connection(() => new Response(null, { status: 204 }));
		await createZoteroClient({ local: api })?.patchAnnotation({ key: "ANN1", version: 1, source: "local", library: GROUP }, { comment: "x" });
		expect(calls[0]).toMatchObject({ library: GROUP, path: "/items/ANN1" });
	});

	it("names a library the way a person would", () => {
		const client = createZoteroClient({ local: connection(() => json([])).api, groups: [LAB] });
		expect(client?.libraryName("user")).toBe("your library");
		expect(client?.libraryName(GROUP)).toBe("Lab reading group");
		expect(client?.libraryName({ group: 99 })).toBe("group 99");
	});

	// The web API puts the id on the row and again inside `data`; the local API's rows differ in
	// what they carry. Either place will do; no id or no name is not a library anyone can switch on.
	it("takes a group's id from inside the row where the outer one is missing, and drops a row without a name", async () => {
		const { api } = connection(() => json([{ data: { id: 4711, name: "Lab reading group" } }, { id: 5, data: {} }, { data: { name: "unnumbered" } }]));
		expect(await api.groups()).toEqual([LAB]);
	});

	it("answers one attachment by key, and nothing for an item that is not a usable PDF", async () => {
		const pdf = connection(() => json(attachmentRow({})));
		expect(await pdf.api.attachment("ATT1", GROUP)).toMatchObject({ key: "ATT1", library: GROUP });
		const epub = connection(() => json(attachmentRow({ contentType: "application/epub+zip" })));
		expect(await epub.api.attachment("ATT1", "user")).toBeNull();
		const gone = connection(() => json({ error: "Not found" }, 404));
		expect(await gone.api.parentItem("GONE", "user")).toBeNull();
	});

	it("reads a refused patch as the library's answer, not as a conflict", async () => {
		const { api } = connection(() => new Response("Internal Server Error", { status: 500 }));
		await expect(api.patchAnnotation("ANN1", 1, { comment: "x" }, "user")).rejects.toBeInstanceOf(ZoteroError);
	});

	// "Not found" on a group is the connection not holding it (see above); anything else a group
	// listing says is an answer about the request, and is reported rather than read as an empty group.
	it("reports a group listing that fails for any reason but not-found", async () => {
		const { api } = connection((request) => (request.library === "user" ? json([]) : new Response("Internal Server Error", { status: 500 })));
		await expect(createZoteroClient({ local: api, groups: [LAB] })?.attachments()).rejects.toBeInstanceOf(ZoteroError);
	});

	it("refuses to patch an annotation read from a connection that is no longer set up", async () => {
		const client = createZoteroClient({ local: connection(() => json([])).api });
		await expect(client?.patchAnnotation({ key: "ANN1", version: 1, source: "web", library: "user" }, { comment: "x" })).rejects.toMatchObject({ reason: "unreachable" });
	});
});

describe("the render as a Zotero attachment (Zotero spec §4.1)", () => {
	const FILE = { bytes: new Uint8Array([1, 2, 3]), md5: "5289df737df57326fcdd22597afb1fac", filename: "annotated_paper.pdf" };
	const SLOT = { url: "https://zoterofilestorage.s3.amazonaws.com/", contentType: "multipart/form-data; boundary=B", prefix: "<", suffix: ">", uploadKey: "UK1" };

	/** The renders over a canned handler, with what was put into file storage recorded. */
	function renders(handler: (request: ZoteroRequest) => Response | Promise<Response>, stored: Response = new Response(null, { status: 201 })) {
		const { requester, calls } = stub(handler);
		const puts: { url: string; contentType: string; body: Uint8Array }[] = [];
		const api = createZoteroRenders(requester, async (url, contentType, body) => {
			puts.push({ url, contentType, body });
			return stored;
		});
		return { api, calls, puts };
	}

	/** Authorise answers `first`; registering answers 204. */
	const upload = (first: Response) => (request: ZoteroRequest) => (request.form?.upload === undefined ? first : new Response(null, { status: 204 }));

	it("names the file after the paper's own", () => {
		expect(renderFilename("Smith 2024.pdf")).toBe("annotated_Smith 2024.pdf");
		expect(renderFilename("notes")).toBe("annotated_notes.pdf");
	});

	it("creates a stored PDF under the paper, titled and tagged as ours", async () => {
		const { api, calls } = renders(() => json({ success: { "0": "REN1" } }));
		expect(await api.create("PAPER1", "annotated_paper.pdf")).toBe("REN1");
		expect(calls[0]).toMatchObject({ method: "POST", library: "user", path: "/items" });
		expect(calls[0].body).toEqual([
			{
				itemType: "attachment",
				parentItem: "PAPER1",
				linkMode: "imported_file",
				title: "Annotated PDF",
				contentType: "application/pdf",
				filename: "annotated_paper.pdf",
				tags: [{ tag: OWNERSHIP_TAG }],
			},
		]);
		expect(calls[0].headers?.["Zotero-Write-Token"]).toMatch(/^\w{5,32}$/);
	});

	it("says why Zotero refused to create it", async () => {
		const { api } = renders(() => json({ failed: { "0": { code: 400, message: "Parent item PAPER1 not found" } } }));
		await expect(api.create("PAPER1", "annotated_paper.pdf")).rejects.toThrow("Parent item PAPER1 not found");
		await expect(renders(() => json({ failed: {} })).api.create("PAPER1", "annotated_paper.pdf")).rejects.toThrow("without saying why");
	});

	it("does not upload into an authorisation that names no place to put the file", async () => {
		const { api, puts } = renders(upload(json({ url: SLOT.url, contentType: SLOT.contentType })));
		await expect(api.upload("REN1", FILE, null)).rejects.toMatchObject({ reason: "server" });
		expect(puts).toEqual([]);
	});

	it("reports a register that fails for any reason but a changed file", async () => {
		const { api } = renders((request) => (request.form?.upload === undefined ? json(SLOT) : new Response("Internal Server Error", { status: 500 })));
		await expect(api.upload("REN1", FILE, null)).rejects.toMatchObject({ reason: "server" });
	});

	it("uploads a first file: authorise for a new file, put the bytes between prefix and suffix, register", async () => {
		const { api, calls, puts } = renders(upload(json(SLOT)));
		expect(await api.upload("REN1", FILE, null)).toBe("uploaded");
		expect(calls[0]).toMatchObject({ method: "POST", library: "user", path: "/items/REN1/file", headers: { "If-None-Match": "*" } });
		expect(calls[0].form).toMatchObject({ md5: FILE.md5, filename: "annotated_paper.pdf", filesize: "3" });
		expect(Number(calls[0].form?.mtime)).toBeGreaterThan(1_000_000_000_000);
		expect(puts).toEqual([{ url: SLOT.url, contentType: SLOT.contentType, body: new Uint8Array([60, 1, 2, 3, 62]) }]);
		expect(calls[1]).toMatchObject({ method: "POST", path: "/items/REN1/file", form: { upload: "UK1" }, headers: { "If-None-Match": "*" } });
	});

	it("replaces a file under the MD5 Zotero holds, on both requests", async () => {
		const { api, calls } = renders(upload(json(SLOT)));
		expect(await api.upload("REN1", FILE, "0123456789abcdef0123456789abcdef")).toBe("uploaded");
		expect(calls.map((call) => call.headers)).toEqual([{ "If-Match": "0123456789abcdef0123456789abcdef" }, { "If-Match": "0123456789abcdef0123456789abcdef" }]);
	});

	it("sends nothing when Zotero already has these bytes", async () => {
		const { api, calls, puts } = renders(upload(json({ exists: 1 })));
		expect(await api.upload("REN1", FILE, FILE.md5)).toBe("exists");
		expect(calls).toHaveLength(1);
		expect(puts).toEqual([]);
	});

	// Live in ticket 08: a stale `If-Match` is "412 ETag does not match current version of file".
	it("reports a file that changed underneath, on authorise or on register", async () => {
		expect(await renders(upload(new Response("ETag does not match current version of file", { status: 412 }))).api.upload("REN1", FILE, "stale")).toBe("changed");
		expect(await renders(upload(new Response("conflict", { status: 409 }))).api.upload("REN1", FILE, "stale")).toBe("changed");
		const late = renders((request) => (request.form?.upload === undefined ? json(SLOT) : new Response(null, { status: 412 })));
		expect(await late.api.upload("REN1", FILE, "stale")).toBe("changed");
	});

	// Zotero's file-upload doc: "413 Request Entity Too Large -- The upload would exceed the storage
	// quota of the library owner." No body or header to read; the status is the whole answer.
	it("reports a full Zotero Storage and puts nothing into it", async () => {
		const { api, puts } = renders(upload(new Response(null, { status: 413 })));
		expect(await api.upload("REN1", FILE, null)).toBe("quota");
		expect(puts).toEqual([]);
	});

	it("does not register a file the storage did not take", async () => {
		const { api, calls } = renders(upload(json(SLOT)), new Response("SlowDown", { status: 500 }));
		await expect(api.upload("REN1", FILE, null)).rejects.toMatchObject({ reason: "server" });
		expect(calls).toHaveLength(1);
	});

	it("reads a refused upload as the library's answer", async () => {
		const { api } = renders(upload(new Response("File editing denied", { status: 403 })));
		await expect(api.upload("REN1", FILE, null)).rejects.toMatchObject({ reason: "read-only" });
	});

	it("reads one render's state: names, paper, MD5, and whether it or its paper is in the trash", async () => {
		const items: Record<string, unknown> = {
			REN1: { key: "REN1", parentItem: "PAPER1", title: "My copy", filename: "annotated_paper.pdf", md5: "abc", contentType: "application/pdf" },
			PAPER1: { key: "PAPER1", itemType: "journalArticle" },
		};
		const { api } = renders((request) => json({ data: items[request.path.slice("/items/".length)] }));
		expect(await api.state("REN1")).toEqual({ key: "REN1", parentKey: "PAPER1", title: "My copy", filename: "annotated_paper.pdf", md5: "abc", trashed: false });
		items.PAPER1 = { key: "PAPER1", deleted: 1 };
		expect(await api.state("REN1")).toMatchObject({ trashed: true });
		items.REN1 = { ...(items.REN1 as object), deleted: 1, parentItem: undefined };
		expect(await api.state("REN1")).toMatchObject({ parentKey: null, trashed: true });
		items.REN1 = { key: "REN1" };
		expect(await api.state("REN1")).toEqual({ key: "REN1", parentKey: null, title: "", filename: null, md5: null, trashed: false });
	});

	it("answers nothing for a render Zotero no longer has", async () => {
		const { api } = renders(() => json({ error: "Not found" }, 404));
		expect(await api.state("REN1")).toBeNull();
	});

	it("marks our renders in the attachment listing", async () => {
		const { api } = connection(() => json([attachmentRow({ key: "PDF" }), attachmentRow({ key: "REN1", tags: [{ tag: "to-read" }, { tag: OWNERSHIP_TAG }] })]));
		expect((await api.attachments("user")).map((attachment) => [attachment.key, attachment.ours])).toEqual([
			["PDF", false],
			["REN1", true],
		]);
	});

	it("is there only where zotero.org is", () => {
		const local = connection(() => json([])).api;
		const web = { ...connection(() => json([]), "web").api, renders: renders(() => json([])).api };
		expect(createZoteroClient({ local })?.renders).toBeNull();
		expect(createZoteroClient({ local, web })?.renders).toBe(web.renders);
	});
});
