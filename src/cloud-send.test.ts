import { describe, expect, it, vi } from "vitest";
import type { Entry, SimpleEntry } from "rmapi-js";
import { GENERATION_ATTEMPTS, sendToCloud, type CloudSendApi } from "./cloud-send";
import type { SendDocument } from "./zotero-send";

// rmapi-js cannot be loaded here -- its own package resolves `crc-32/crc32c` in a way node refuses --
// so it is stubbed the way `transport.test.ts` stubs it. The class matters and nothing else does:
// what is under test is that a stale generation is told apart from every other failure.
vi.mock("rmapi-js", () => ({ GenerationError: class GenerationError extends Error {} }));

const { GenerationError } = (await import("rmapi-js")) as unknown as { GenerationError: new () => Error };

const document: SendDocument = { visibleName: "Best Practices für Prompting", bytes: new Uint8Array([37, 80, 68, 70]), folder: "Zotero", tag: "#papers" };

function folder(overrides: Partial<Entry> = {}): Entry {
	return { id: "f-1", hash: "h", visibleName: "Zotero", lastModified: "0", pinned: false, parent: "", type: "CollectionType", tags: [] } as Entry;
}

function api(overrides: Partial<CloudSendApi> = {}): CloudSendApi {
	return {
		listItems: async () => [],
		putFolder: async () => ({ id: "new-folder" }) as SimpleEntry,
		putPdf: async () => ({ id: "doc-1" }) as SimpleEntry,
		...overrides,
	};
}

describe("the cloud's Zotero folder", () => {
	it("is the one that is there, found by its name", async () => {
		const putFolder = vi.fn();
		const putPdf = vi.fn(async () => ({ id: "doc-1" }) as SimpleEntry);
		await sendToCloud(api({ listItems: async () => [folder()], putFolder, putPdf }), document);

		expect(putFolder).not.toHaveBeenCalled();
		expect(putPdf).toHaveBeenCalledWith(document.visibleName, document.bytes, { parent: "f-1", tags: ["#papers"], refresh: false });
	});

	it("is created where the account has none", async () => {
		const putPdf = vi.fn(async (_name: string, _bytes: Uint8Array, opts?: { parent?: string }) => {
			expect(opts).toMatchObject({ parent: "new-folder" });
			return { id: "doc-1" } as SimpleEntry;
		});
		await sendToCloud(api({ putPdf }), document);
		expect(putPdf).toHaveBeenCalled();
	});

	// The same two rules the tablet's own side follows: top level, and never a document.
	it("is never a nested folder and never a document of that name", async () => {
		const nested = { ...folder({}), id: "f-2", parent: "other" } as Entry;
		const named = { ...folder({}), id: "f-3", type: "DocumentType" } as Entry;
		const putFolder = vi.fn(async () => ({ id: "new-folder" }) as SimpleEntry);
		await sendToCloud(api({ listItems: async () => [nested, named], putFolder }), document);
		expect(putFolder).toHaveBeenCalled();
	});

	it("is the same one of two every time", async () => {
		const parents: (string | undefined)[] = [];
		const putPdf = vi.fn(async (_name: string, _bytes: Uint8Array, opts?: { parent?: string }) => {
			parents.push(opts?.parent);
			return { id: "doc-1" } as SimpleEntry;
		});
		const two = [{ ...folder(), id: "f-9" } as Entry, { ...folder(), id: "f-2" } as Entry];
		await sendToCloud(api({ listItems: async () => two, putPdf }), document);
		expect(parents).toEqual(["f-2"]);
	});
});

describe("a generation that moved under the upload", () => {
	// Normal rather than exceptional: the tablet, a phone or a second Obsidian adding anything makes
	// the generation this upload read stale.
	it("is tried again, and the retry refreshes the root hash", async () => {
		let calls = 0;
		const putPdf = vi.fn(async (_name: string, _bytes: Uint8Array, _opts?: { refresh?: boolean }) => {
			if (++calls === 1) throw new GenerationError();
			return { id: "doc-1" } as SimpleEntry;
		});

		expect(await sendToCloud(api({ putPdf }), document)).toEqual({ docId: "doc-1" });
		expect(putPdf.mock.calls[0][2]).toMatchObject({ refresh: false });
		expect(putPdf.mock.calls[1][2]).toMatchObject({ refresh: true });
	});

	it("is tried again for the folder too", async () => {
		let calls = 0;
		const putFolder = vi.fn(async () => {
			if (++calls === 1) throw new GenerationError();
			return { id: "new-folder" } as SimpleEntry;
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
