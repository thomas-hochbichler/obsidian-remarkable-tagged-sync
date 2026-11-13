import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Content, Entries, Entry, ItemRef } from "rmapi-js";
import { GENERATION_ATTEMPTS, lookAtEarlierCopies, moveCopyToTrash, namesInCloudFolder, sendToCloud, type CloudSendApi } from "./cloud-send";
import type { EarlierCopy, SendDocument } from "./zotero-send";

// rmapi-js cannot be loaded here -- its own package resolves `crc-32/crc32c` in a way node refuses --
// so it is stubbed the way `transport.test.ts` stubs it. The classes matter and nothing else does:
// what is under test is that a stale generation, and a hash that moved, are told apart from every
// other failure.
vi.mock("rmapi-js", () => ({
	GenerationError: class GenerationError extends Error {},
	HashNotFoundError: class HashNotFoundError extends Error {},
}));

const { GenerationError, HashNotFoundError } = (await import("rmapi-js")) as unknown as {
	GenerationError: new () => Error;
	HashNotFoundError: new (hash: string) => Error;
};

const document: SendDocument = { visibleName: "Best Practices für Prompting", bytes: new Uint8Array([37, 80, 68, 70]), folder: "Zotero" };

function folder(overrides: Partial<Entry> = {}): Entry {
	return { id: "f-1", hash: "h", visibleName: "Zotero", lastModified: "0", pinned: false, parent: "", type: "CollectionType", tags: [] } as Entry;
}

/** A send's cloud: the three calls an upload makes, and the look's and the trash's left to throw unless a test gives them. */
function api(overrides: Partial<CloudSendApi> = {}): CloudSendApi {
	const unused = (name: string) => async () => {
		throw new Error(`${name} is not called by an upload`);
	};
	return {
		listItems: async () => [],
		putFolder: async () => ({ id: "new-folder" }) as ItemRef,
		putPdf: async () => ({ id: "doc-1" }) as ItemRef,
		getContent: unused("getContent"),
		delete: unused("delete"),
		raw: { getEntries: unused("getEntries") },
		...overrides,
	};
}

describe("the cloud's Zotero folder", () => {
	it("is the one that is there, found by its name", async () => {
		const putFolder = vi.fn();
		const putPdf = vi.fn(async () => ({ id: "doc-1" }) as ItemRef);
		await sendToCloud(api({ listItems: async () => [folder()], putFolder, putPdf }), document);

		expect(putFolder).not.toHaveBeenCalled();
		// No tag (2026-09-13): the reader tags the document on the tablet.
		expect(putPdf).toHaveBeenCalledWith(document.visibleName, document.bytes, { parent: "f-1", tags: [], refresh: false });
	});

	it("is created where the account has none", async () => {
		const putPdf = vi.fn(async (_name: string, _bytes: Uint8Array, opts?: { parent?: string }) => {
			expect(opts).toMatchObject({ parent: "new-folder" });
			return { id: "doc-1" } as ItemRef;
		});
		await sendToCloud(api({ putPdf }), document);
		expect(putPdf).toHaveBeenCalled();
	});

	// A vault send records the folder (send spec §5): an earlier copy is untouched only while it is
	// still in the folder it was sent to.
	it("is named in the answer, whether it was there or made", async () => {
		expect(await sendToCloud(api({ listItems: async () => [folder()] }), document)).toEqual({ docId: "doc-1", folderId: "f-1" });
		expect(await sendToCloud(api(), document)).toEqual({ docId: "doc-1", folderId: "new-folder" });
	});

	// The same two rules the tablet's own side follows: top level, and never a document.
	it("is never a nested folder and never a document of that name", async () => {
		const nested = { ...folder({}), id: "f-2", parent: "other" } as Entry;
		const named = { ...folder({}), id: "f-3", type: "DocumentType" } as Entry;
		const putFolder = vi.fn(async () => ({ id: "new-folder" }) as ItemRef);
		await sendToCloud(api({ listItems: async () => [nested, named], putFolder }), document);
		expect(putFolder).toHaveBeenCalled();
	});

	// A vault send's look listed the account a moment before; a second listing costs ~7 s in Obsidian.
	it("is the one a look handed in, without listing the account again", async () => {
		const putFolder = vi.fn();
		const putPdf = vi.fn(async () => ({ id: "doc-1" }) as ItemRef);
		const listItems = vi.fn(async () => [folder()]);

		expect(await sendToCloud(api({ listItems, putFolder, putPdf }), { ...document, folderId: "f-7" })).toEqual({ docId: "doc-1", folderId: "f-7" });
		expect(listItems).not.toHaveBeenCalled();
		expect(putFolder).not.toHaveBeenCalled();
		expect(putPdf).toHaveBeenCalledWith(document.visibleName, document.bytes, { parent: "f-7", tags: [], refresh: false });
	});

	it("is the same one of two every time", async () => {
		const parents: (string | undefined)[] = [];
		const putPdf = vi.fn(async (_name: string, _bytes: Uint8Array, opts?: { parent?: string }) => {
			parents.push(opts?.parent);
			return { id: "doc-1" } as ItemRef;
		});
		const two = [{ ...folder(), id: "f-9" } as Entry, { ...folder(), id: "f-2" } as Entry];
		await sendToCloud(api({ listItems: async () => two, putPdf }), document);
		expect(parents).toEqual(["f-2"]);
	});
});

describe("what the cloud's Zotero folder holds", () => {
	const doc = (visibleName: string, parent: string): Entry =>
		({ id: `d-${visibleName}`, hash: "h", visibleName, lastModified: "0", pinned: false, parent, type: "DocumentType", tags: [] }) as unknown as Entry;

	it("names the documents in it and nothing outside it", async () => {
		const atRoot = { ...doc("Elsewhere", "") } as { parent?: string };
		delete atRoot.parent; // rmapi-js: "" or omitted for the root
		const items = [folder(), doc("Prompting", "f-1"), atRoot as Entry, doc("Nested", "other")];
		expect(await namesInCloudFolder(api({ listItems: async () => items }), "Zotero")).toEqual(["Prompting"]);
	});

	it("names nothing where there is no such folder", async () => {
		expect(await namesInCloudFolder(api({ listItems: async () => [doc("Prompting", "")] }), "Zotero")).toEqual([]);
	});

	// A second folder of that name is the user's arrangement, and a paper filed there is on the
	// tablet all the same.
	it("looks into every folder of that name, not only the one a send would use", async () => {
		const items = [folder(), { ...folder(), id: "f-2" } as Entry, doc("Prompting", "f-2")];
		expect(await namesInCloudFolder(api({ listItems: async () => items }), "Zotero")).toEqual(["Prompting"]);
	});
});

describe("a generation that moved under the upload", () => {
	// Normal rather than exceptional: the tablet, a phone or a second Obsidian adding anything makes
	// the generation this upload read stale.
	it("is tried again, and the retry refreshes the root hash", async () => {
		let calls = 0;
		const putPdf = vi.fn(async (_name: string, _bytes: Uint8Array, _opts?: { refresh?: boolean }) => {
			if (++calls === 1) throw new GenerationError();
			return { id: "doc-1" } as ItemRef;
		});

		expect(await sendToCloud(api({ putPdf }), document)).toEqual({ docId: "doc-1", folderId: "new-folder" });
		expect(putPdf.mock.calls[0][2]).toMatchObject({ refresh: false });
		expect(putPdf.mock.calls[1][2]).toMatchObject({ refresh: true });
	});

	it("is tried again for the folder too", async () => {
		let calls = 0;
		const putFolder = vi.fn(async () => {
			if (++calls === 1) throw new GenerationError();
			return { id: "new-folder" } as ItemRef;
		});
		await sendToCloud(api({ putFolder }), document);
		expect(putFolder).toHaveBeenCalledTimes(2);
	});

	// A generation that keeps moving is a busy account, and a command the user pressed has to fail in
	// seconds rather than loop.
	it("gives up after three attempts, saying what the cloud said", async () => {
		const putPdf = vi.fn(async () => {
			throw new GenerationError();
		});
		await expect(sendToCloud(api({ putPdf }), document)).rejects.toBeInstanceOf(GenerationError);
		expect(putPdf).toHaveBeenCalledTimes(GENERATION_ATTEMPTS);
	});

	// Everything else is the caller's, unchanged: a refused token is not something to retry into.
	it("is the only failure that is retried at all", async () => {
		const putPdf = vi.fn(async () => {
			throw new Error("Unauthorized");
		});
		await expect(sendToCloud(api({ putPdf }), document)).rejects.toThrow("Unauthorized");
		expect(putPdf).toHaveBeenCalledTimes(1);
	});
});

const SENT_AS = "Login-Spec";
const SEND_FOLDER = "f-1";

/** The vault's earlier copy as the cloud lists it while nobody has touched it. */
function sentCopy(overrides: Partial<Entry> = {}): Entry {
	return {
		id: "doc-a",
		hash: "hash-a",
		visibleName: SENT_AS,
		lastModified: "0",
		lastOpened: "0",
		pinned: false,
		parent: SEND_FOLDER,
		type: "DocumentType",
		fileType: "pdf",
		tags: [],
		...overrides,
	} as Entry;
}

/** The record's side of the same copy (send spec §5). */
const recorded = (docId = "doc-a"): EarlierCopy => ({ docId, name: SENT_AS, folderId: SEND_FOLDER });

/** What a document holds beyond its listing: tags on pages, and an `.rm` file a pen or highlighter left. */
interface Inside {
	readonly pageTags?: readonly string[];
	/** The `.content` as the cloud has it, where the test needs a shape other than a list of page tags. */
	readonly content?: object;
	readonly rm?: boolean;
}

type Member = "listItems" | "getContent" | "getEntries" | "delete";

/** Fails any member the object does not have: "nothing else is ever called", made checkable. */
function guarded<T extends object>(target: T): T {
	return new Proxy(target, {
		get(object, member, receiver) {
			if (typeof member === "string" && !(member in object)) throw new Error(`${member} is never called by a look or a trash`);
			return Reflect.get(object, member, receiver);
		},
	});
}

/**
 * The account a look and a trash talk to, every call written down. It has the four members those
 * two need and nothing else -- no upload, no `move`, no `purge` -- behind {@link guarded}.
 */
function account(items: readonly Entry[], inside: Readonly<Record<string, Inside>> = {}, failing?: Member) {
	const calls: string[] = [];
	const live = new Map(items.map((item) => [item.id, item]));
	const call = (member: Member, id?: string) => {
		calls.push(id === undefined ? member : `${member} ${id}`);
		if (member === failing) throw new Error(`${member} failed`);
	};
	const cloud = {
		listItems: async () => {
			call("listItems");
			return [...live.values()];
		},
		getContent: async (ref: ItemRef) => {
			call("getContent", ref.id);
			const content = inside[ref.id]?.content ?? { pageTags: (inside[ref.id]?.pageTags ?? []).map((name) => ({ name, pageId: "p-1", timestamp: 0 })) };
			return content as unknown as Content;
		},
		delete: async (ref: ItemRef) => {
			call("delete", ref.id);
			// rmapi-js finds the entry by id *and* hash, and throws when the hash has moved.
			const item = live.get(ref.id);
			if (item === undefined || item.hash !== ref.hash) throw new HashNotFoundError(ref.hash);
			live.set(ref.id, { ...item, parent: "trash", hash: `${item.hash}'` } as Entry);
			return { id: ref.id, hash: `${item.hash}'` };
		},
		raw: guarded({
			getEntries: async (ref: ItemRef): Promise<Entries> => {
				call("getEntries", ref.id);
				const file = (id: string) => ({ id, hash: `h-${id}`, type: 0 as const, subfiles: 0, size: 1 });
				return { entries: [file(`${ref.id}.pdf`), file(`${ref.id}.content`), ...(inside[ref.id]?.rm ? [file(`${ref.id}/p-1.rm`)] : [])] };
			},
		}),
	};
	return { api: guarded(cloud) as unknown as CloudSendApi, calls, live };
}

describe("what an earlier copy of a vault send is now (send spec §3)", () => {
	it("is untouched where the listing, the page tags and the files all say nobody was there", async () => {
		const { api, calls } = account([folder(), sentCopy()]);

		expect(await lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).toEqual({
			copies: [{ docId: "doc-a", state: "untouched", ref: { id: "doc-a", hash: "hash-a" } }],
			strangerNamed: false,
			folderId: "f-1",
		});
		expect(calls).toEqual(["listItems", "getContent doc-a", "getEntries doc-a"]);
	});

	// Sent a minute ago and the listing lags, or deleted on the tablet: either way, nothing to clear.
	it("is gone when the listing does not show it", async () => {
		const { api, calls } = account([folder()]);

		expect((await lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).copies).toEqual([{ docId: "doc-a", state: "gone" }]);
		expect(calls).toEqual(["listItems"]);
	});

	it("is gone when it is in the trash, or in a folder that is", async () => {
		const trashedFolder = { ...folder(), id: "f-old", visibleName: "Old", parent: "trash" } as Entry;
		const { api, calls } = account([folder(), trashedFolder, sentCopy({ parent: "trash" }), sentCopy({ id: "doc-b", parent: "f-old" })]);

		const look = await lookAtEarlierCopies(api, [recorded(), { ...recorded("doc-b"), folderId: "f-old" }], "Zotero", SENT_AS);
		expect(look.copies).toEqual([
			{ docId: "doc-a", state: "gone" },
			{ docId: "doc-b", state: "gone" },
		]);
		expect(calls).toEqual(["listItems"]);
	});

	// Everything up to the document tag comes free with the listing, so a copy that fails one of
	// those costs no further request (§3, the costs of the test).
	it.each([
		["moved to another folder", { parent: "f-other" }],
		["moved to the top level", { parent: "" }],
		["renamed (P16)", { visibleName: "Login-Spec — reviewed" }],
		["pinned (P16)", { pinned: true }],
		["tagged, mapped or not", { tags: [{ name: "review", timestamp: 0 }] }],
		["tagged in the legacy shape", { tags: ["review"] }],
	] as const)("is the user's when %s, and the tablet is not asked anything more", async (_how, change) => {
		const { api, calls } = account([folder(), sentCopy(change as Partial<Entry>)]);

		expect((await lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).copies).toEqual([
			{ docId: "doc-a", state: "users", ref: { id: "doc-a", hash: "hash-a" } },
		]);
		expect(calls).toEqual(["listItems"]);
	});

	it("is the user's when a page carries a tag, which costs no file list", async () => {
		const { api, calls } = account([folder(), sentCopy()], { "doc-a": { pageTags: ["review"] } });

		expect((await lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).copies[0]).toMatchObject({ state: "users" });
		expect(calls).toEqual(["listItems", "getContent doc-a"]);
	});

	// A `.content` the tablet never rewrote may carry no page-tag list at all, or a null one.
	it.each([
		["no page-tag list", {}],
		["a null page-tag list", { pageTags: null }],
	])("reads %s as no page tag", async (_shape, content) => {
		const { api } = account([folder(), sentCopy()], { "doc-a": { content } });

		expect((await lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).copies[0]).toMatchObject({ state: "untouched" });
	});

	// An `.rm` may outlive its strokes; the error falls on the safe side.
	it("is the user's when any page has an .rm file, erased ink included", async () => {
		const { api, calls } = account([folder(), sentCopy()], { "doc-a": { rm: true } });

		expect((await lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).copies[0]).toMatchObject({ state: "users" });
		expect(calls).toEqual(["listItems", "getContent doc-a", "getEntries doc-a"]);
	});

	it.each([
		["its folder", { docId: "doc-a", name: SENT_AS }],
		["its name", { docId: "doc-a", folderId: SEND_FOLDER }],
	])("is the user's when the record lost %s, and the tablet is not asked anything more", async (_what, copy: EarlierCopy) => {
		const { api, calls } = account([folder(), sentCopy()]);

		expect((await lookAtEarlierCopies(api, [copy], "Zotero", SENT_AS)).copies[0]).toMatchObject({ state: "users" });
		expect(calls).toEqual(["listItems"]);
	});

	it("is looked at in one listing for several copies, answered in the order asked", async () => {
		const { api, calls } = account([folder(), sentCopy(), sentCopy({ id: "doc-c", hash: "hash-c", visibleName: "Renamed" })]);

		const look = await lookAtEarlierCopies(api, [recorded("doc-b"), recorded(), recorded("doc-c")], "Zotero", SENT_AS);
		expect(look.copies.map((copy) => `${copy.docId} ${copy.state}`)).toEqual(["doc-b gone", "doc-a untouched", "doc-c users"]);
		expect(calls.filter((made) => made === "listItems")).toHaveLength(1);
	});
});

describe("a document of the same name in the send folder that the vault did not send there (send spec §3)", () => {
	// Another vault, a manual upload, a Zotero paper in a shared folder: the new one lands beside it.
	it("is reported and never classed or looked into", async () => {
		const { api, calls } = account([folder(), sentCopy({ id: "doc-x", hash: "hash-x" })]);

		expect(await lookAtEarlierCopies(api, [], "Zotero", SENT_AS)).toEqual({ copies: [], strangerNamed: true, folderId: "f-1" });
		expect(calls).toEqual(["listItems"]);
	});

	it("is never one of this origin's own copies, whatever state they are in", async () => {
		const { api } = account([folder(), sentCopy({ pinned: true })]);

		expect((await lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).strangerNamed).toBe(false);
	});

	it("is looked for only in the folder the new one goes into", async () => {
		const second = { ...folder(), id: "f-9" } as Entry;
		const elsewhere = [sentCopy({ id: "doc-x", parent: "f-other" }), sentCopy({ id: "doc-y", parent: "f-9" }), sentCopy({ id: "doc-z", parent: "trash" })];

		expect((await lookAtEarlierCopies(account([folder(), second, ...elsewhere]).api, [], "Zotero", SENT_AS)).strangerNamed).toBe(false);
		// No folder yet: the send makes it, and nothing can be in it.
		expect((await lookAtEarlierCopies(account([sentCopy({ id: "doc-x", parent: "" })]).api, [], "Zotero", SENT_AS)).strangerNamed).toBe(false);
	});
});

describe("the send folder as the look found it (ticket 16: one listing per vault send)", () => {
	// The upload takes this id instead of listing the whole account a second time.
	it("is named by its id -- the lowest of two, as the upload would pick -- and not at all where the account has none", async () => {
		const second = { ...folder(), id: "f-9" } as Entry;
		const nested = { ...folder(), id: "f-0", parent: "f-other" } as Entry;

		expect((await lookAtEarlierCopies(account([second, folder(), nested]).api, [], "Zotero", SENT_AS)).folderId).toBe("f-1");
		expect(await lookAtEarlierCopies(account([nested]).api, [], "Zotero", SENT_AS)).not.toHaveProperty("folderId");
	});
});

describe("a look that fails (send spec §3, P17)", () => {
	// Rejecting as a whole is what lets the send say one thing: nothing was checked, nothing cleared.
	it.each(["listItems", "getContent", "getEntries"] as const)("rejects as a whole when %s throws", async (member) => {
		const { api } = account([folder(), sentCopy()], {}, member);

		await expect(lookAtEarlierCopies(api, [recorded()], "Zotero", SENT_AS)).rejects.toThrow(`${member} failed`);
	});
});

describe("moving an earlier copy to the tablet's trash (ADR 0001)", () => {
	it("moves exactly the copy the look listed, by its id and hash, and calls nothing else", async () => {
		const { api, calls, live } = account([folder(), sentCopy()]);

		expect(await moveCopyToTrash(api, { id: "doc-a", hash: "hash-a" })).toBe(true);
		expect(calls).toEqual(["delete doc-a"]);
		expect(live.get("doc-a")?.parent).toBe("trash");
	});

	// F11: opened or written on between the look and the clearing, the copy is not what was listed.
	it("leaves a copy that changed since the look where it is, and says it was not cleared", async () => {
		const { api, live } = account([folder(), sentCopy({ hash: "hash-after-the-pen" })]);

		expect(await moveCopyToTrash(api, { id: "doc-a", hash: "hash-a" })).toBe(false);
		expect(live.get("doc-a")).toMatchObject({ parent: SEND_FOLDER, hash: "hash-after-the-pen" });
	});

	it("hands every other failure to the caller unchanged", async () => {
		const { api } = account([folder(), sentCopy()], {}, "delete");

		await expect(moveCopyToTrash(api, { id: "doc-a", hash: "hash-a" })).rejects.toThrow("delete failed");
	});
});

describe("what a send may ask of the cloud", () => {
	// Checked by `tsc` (the release gates run it over the tests): a member added to the type -- a
	// `move`, a `purge`, a rename -- fails here, and has to be added on purpose (ADR 0001).
	it("is the upload's three calls, the look's two reads and the trash, and nothing more", () => {
		expectTypeOf<keyof CloudSendApi>().toEqualTypeOf<"listItems" | "putFolder" | "putPdf" | "getContent" | "delete" | "raw">();
		expectTypeOf<keyof CloudSendApi["raw"]>().toEqualTypeOf<"getEntries">();
	});
});
