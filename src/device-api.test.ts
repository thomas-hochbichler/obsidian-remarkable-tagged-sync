import { describe, expect, it } from "vitest";
import {
	type DeviceFileStat,
	type DeviceFiles,
	documentOf,
	type HashCache,
	NO_HASH_CACHE,
	openDeviceApi,
} from "./device-api";
import { enumerateNotebookTags } from "./remarkable-tags";
import { EMPTY_SYNC_INDEX, runSync, type SyncDeps } from "./sync-engine";
import { TagRouter } from "./tag-router";
import { hashBytes } from "./sync15-hash";

const DOC = "b9ff40e1-1b3d-4479-b905-fb931ad618bc";
const OTHER = "0111bef3-3a51-4966-8b1b-c53d868d78f5";
const PAGE = "35272928-d0c0-4802-a958-ed0cf9477890";

/** A tablet, as a map of paths to bytes. Records what was asked of it, so cost can be asserted. */
function fakeDevice(contents: Record<string, string>) {
	const files = new Map(Object.entries(contents).map(([path, text]) => [path, new TextEncoder().encode(text)]));
	const mtimes = new Map([...files.keys()].map((path) => [path, 1_000]));
	const hashed: string[][] = [];
	const read: string[] = [];
	const torn = new Map<string, Uint8Array>();

	const device: DeviceFiles = {
		list: async (): Promise<DeviceFileStat[]> =>
			[...files].map(([path, bytes]) => ({ path, size: bytes.length, mtimeMs: mtimes.get(path) ?? 0 })),
		read: async (path) => {
			read.push(path);
			const half = torn.get(path);
			if (half !== undefined) {
				torn.delete(path);
				return half;
			}
			const bytes = files.get(path);
			if (bytes === undefined) throw new Error(`no ${path}`);
			return bytes;
		},
		hash: async (paths) => {
			hashed.push([...paths]);
			const out = new Map<string, string>();
			for (const path of paths) {
				const bytes = files.get(path);
				if (bytes !== undefined) out.set(path, await hashBytes(bytes));
			}
			return out;
		},
	};

	return {
		device,
		hashed,
		read,
		/** Rewrite a file the way the tablet would: new bytes, new mtime. */
		write(path: string, text: string) {
			files.set(path, new TextEncoder().encode(text));
			mtimes.set(path, (mtimes.get(path) ?? 0) + 1_000);
		},
		/** Hand back wrong bytes for the next read of a path -- what a half-written file looks like. */
		tearOnce(path: string, text: string) {
			torn.set(path, new TextEncoder().encode(text));
		},
		/** Touch without changing anything -- what a copy or a clock adjustment does. */
		touch(path: string) {
			mtimes.set(path, (mtimes.get(path) ?? 0) + 1_000);
		},
	};
}

function memoryCache(): HashCache {
	const store = new Map<string, string>();
	const key = (stat: DeviceFileStat) => `${stat.path}:${stat.size}:${stat.mtimeMs}`;
	return {
		get: (stat) => store.get(key(stat)),
		set: (stat, hash) => void store.set(key(stat), hash),
	};
}

const NOTEBOOK = {
	[`${DOC}.metadata`]: JSON.stringify({ visibleName: "Field notes", type: "DocumentType", parent: "", lastModified: "7" }),
	[`${DOC}.content`]: JSON.stringify({ fileType: "notebook", tags: [{ name: "work", timestamp: 1 }] }),
	[`${DOC}/${PAGE}.rm`]: "page bytes",
	// None of these is in the cloud's tree, and including one would change the document's hash.
	[`${DOC}.local`]: JSON.stringify({ contentFormatVersion: 2 }),
	[`${DOC}.thumbnails/${PAGE}.jpg`]: "thumbnail bytes",
	[`${DOC}/${PAGE}-metadata.json`]: JSON.stringify({ layers: [{ name: "Layer 1" }] }),
};

describe("which files belong to a document", () => {
	it("takes the pages and the pictures on them, under the document's own folder", () => {
		expect(documentOf(`${DOC}/${PAGE}.rm`)).toBe(DOC);
		expect(documentOf(`${DOC}/${PAGE}/picture.png`)).toBe(DOC);
		expect(documentOf(`${DOC}/${PAGE}/photo.jpg`)).toBe(DOC);
	});

	it("leaves out a v5 page's layer names, which the cloud does not hash either", () => {
		// A reMarkable 1 or 2 with notebooks from before software 3.0 still has these beside the pages.
		// Counting one moves that document's hash away from the cloud's, and the vault then re-renders
		// and re-transcribes it on every transport switch -- the one cost this design exists to avoid.
		// A Paper Pro has none, so the live run against one could not have shown this.
		expect(documentOf(`${DOC}/${PAGE}-metadata.json`)).toBeNull();
	});

	it("takes the siblings the cloud hashes, and no others", () => {
		expect(documentOf(`${DOC}.content`)).toBe(DOC);
		expect(documentOf(`${DOC}.epub`)).toBe(DOC);
		// `.local` is device-only: counting it would move every document's hash away from the cloud's,
		// which is the one thing that makes a transport switch expensive.
		expect(documentOf(`${DOC}.local`)).toBeNull();
	});

	it("ignores what is not a document at all", () => {
		expect(documentOf(".tree")).toBeNull();
		expect(documentOf("rm-search-index.db")).toBeNull();
	});
});

describe("the device as a SyncApi", () => {
	it("lists a document with the tags from its content file", async () => {
		const { device } = fakeDevice(NOTEBOOK);

		const [item] = await (await openDeviceApi(device, NO_HASH_CACHE)).listItems();

		expect(item.visibleName).toBe("Field notes");
		expect(item.type).toBe("DocumentType");
		expect(item.tags).toEqual([{ name: "work", timestamp: 1 }]);
	});

	it("leaves out a document the device has deleted but not yet synced away", async () => {
		const { device } = fakeDevice({
			...NOTEBOOK,
			[`${OTHER}.metadata`]: JSON.stringify({ visibleName: "Gone", type: "DocumentType", deleted: true }),
			[`${OTHER}.content`]: JSON.stringify({ fileType: "notebook" }),
		});

		const items = await (await openDeviceApi(device, NO_HASH_CACHE)).listItems();

		expect(items.map((item) => item.id)).toEqual([DOC]);
	});

	it("hands the engine a page's bytes by the name it asks for", async () => {
		const { device } = fakeDevice(NOTEBOOK);
		const api = await openDeviceApi(device, NO_HASH_CACHE);

		const bytes = await api.raw.getHash(`${DOC}/${PAGE}.rm`, "unused");

		expect(new TextDecoder().decode(bytes)).toBe("page bytes");
	});

	it("indexes the document's member files, so page hashes come from one listing", async () => {
		const { device } = fakeDevice(NOTEBOOK);
		const api = await openDeviceApi(device, NO_HASH_CACHE);

		const { entries } = await api.raw.getEntries(`${DOC}.docSchema`, "unused");

		expect(entries.map((entry) => entry.id).sort()).toEqual([`${DOC}.content`, `${DOC}.metadata`, `${DOC}/${PAGE}.rm`]);
	});
});

describe("reading a device that is still being written to", () => {
	it("reads a torn page a second time rather than handing it on", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const api = await openDeviceApi(tablet.device, NO_HASH_CACHE);
		tablet.tearOnce(`${DOC}/${PAGE}.rm`, "half a pa");

		const bytes = await api.raw.getHash(`${DOC}/${PAGE}.rm`, "unused");

		// xochitl keeps writing while a sync reads and there is no way to lock it, so the guard is to
		// notice: the bytes are hashed and compared against what the listing indexed them as.
		expect(new TextDecoder().decode(bytes)).toBe("page bytes");
	});

	it("refuses a page the device really did rewrite, rather than storing it under the old hash", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const api = await openDeviceApi(tablet.device, NO_HASH_CACHE);
		tablet.write(`${DOC}/${PAGE}.rm`, "a whole new page");

		// The engine skips this one document and the next sync picks it up, because the hash that moved
		// is the same hash the gates read. The quiet version -- rendering the new bytes under the old
		// page hash -- would be a page that looks synced and never updates again.
		await expect(api.raw.getHash(`${DOC}/${PAGE}.rm`, "unused")).rejects.toThrow("changed on the device");
	});
});

describe("what a real reader makes of it", () => {
	it("finds notebook tags, page tags and an inherited folder tag through the ordinary tag scan", async () => {
		const folder = "11111111-2222-3333-4444-555555555555";
		const { device } = fakeDevice({
			[`${folder}.metadata`]: JSON.stringify({ visibleName: "Projects", type: "CollectionType", parent: "" }),
			[`${folder}.content`]: JSON.stringify({ tags: [{ name: "project", timestamp: 1 }] }),
			[`${DOC}.metadata`]: JSON.stringify({ visibleName: "Field notes", type: "DocumentType", parent: folder }),
			[`${DOC}.content`]: JSON.stringify({
				fileType: "notebook",
				tags: [{ name: "work", timestamp: 1 }],
				pageTags: [{ name: "idea", pageId: PAGE, timestamp: 1 }],
			}),
			[`${DOC}/${PAGE}.rm`]: "page bytes",
		});

		const [notebook] = await enumerateNotebookTags(await openDeviceApi(device, NO_HASH_CACHE));

		expect(notebook.visibleName).toBe("Field notes");
		// The folder tag is not copied onto the document by the device, so reading it means walking the
		// parent chain -- the same walk the cloud path does, over entries this module built.
		expect([...notebook.tags].sort()).toEqual(["project", "work"]);
		expect(notebook.pageTags).toEqual([{ pageId: PAGE, tag: "idea" }]);
	});
});

describe("hashes a vault can keep across a transport switch", () => {
	it("gives the same root hash for a device nothing happened to", async () => {
		const { device } = fakeDevice(NOTEBOOK);

		const [first] = await (await openDeviceApi(device, NO_HASH_CACHE)).raw.getRootHash();
		const [second] = await (await openDeviceApi(device, NO_HASH_CACHE)).raw.getRootHash();

		expect(second).toBe(first);
	});

	it("moves the root hash, the document hash and the page hash when a page is written on", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const before = await openDeviceApi(tablet.device, NO_HASH_CACHE);
		const [rootBefore] = await before.raw.getRootHash();
		const [itemBefore] = await before.listItems();
		const pageBefore = (await before.raw.getEntries(`${DOC}.docSchema`, "x")).entries.find((entry) =>
			entry.id.endsWith(".rm"),
		);

		tablet.write(`${DOC}/${PAGE}.rm`, "page bytes, and one more stroke");

		const after = await openDeviceApi(tablet.device, NO_HASH_CACHE);
		const [rootAfter] = await after.raw.getRootHash();
		const [itemAfter] = await after.listItems();
		const pageAfter = (await after.raw.getEntries(`${DOC}.docSchema`, "x")).entries.find((entry) =>
			entry.id.endsWith(".rm"),
		);

		expect(rootAfter).not.toBe(rootBefore);
		expect(itemAfter.hash).not.toBe(itemBefore.hash);
		expect(pageAfter?.hash).not.toBe(pageBefore?.hash);
	});

	it("does not move any hash when a file is only touched", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const [before] = await (await openDeviceApi(tablet.device, NO_HASH_CACHE)).raw.getRootHash();

		tablet.touch(`${DOC}/${PAGE}.rm`);

		const [after] = await (await openDeviceApi(tablet.device, NO_HASH_CACHE)).raw.getRootHash();
		// A hash is over the bytes, so a copied or clock-adjusted file re-hashes to the same value and
		// nothing downstream re-renders. Only the cache misses.
		expect(after).toBe(before);
	});
});

describe("what one session costs", () => {
	it("asks for every file's hash in one request rather than one per document", async () => {
		const { device, hashed } = fakeDevice({
			...NOTEBOOK,
			[`${OTHER}.metadata`]: JSON.stringify({ visibleName: "Second", type: "DocumentType" }),
			[`${OTHER}.content`]: JSON.stringify({ fileType: "notebook" }),
		});

		await openDeviceApi(device, NO_HASH_CACHE);

		// Per document would be one round trip per document -- on a real library over a hundred of
		// them, each paying the latency of a command that could have carried the lot.
		expect(hashed.length).toBe(1);
	});

	it("reads a document's content once however often the engine opens it", async () => {
		const { device, read } = fakeDevice(NOTEBOOK);
		const api = await openDeviceApi(device, NO_HASH_CACHE);

		await api.getContent(DOC, "unused");
		await api.getContent(DOC, "unused");
		await api.listItems();

		// The engine opens each candidate twice, and listItems has read the metadata before either.
		// On the cloud rmapi-js answers the repeats from its own cache; without the same here, every
		// document would cross the wire three times per run and be verified three times.
		expect(read.filter((path) => path === `${DOC}.content`)).toHaveLength(1);
		expect(read.filter((path) => path === `${DOC}.metadata`)).toHaveLength(1);
	});
});

describe("the hash cache", () => {
	it("hashes nothing again on a second sync of an untouched device", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const cache = memoryCache();

		await openDeviceApi(tablet.device, cache);
		const firstRound = tablet.hashed.flat().length;
		tablet.hashed.length = 0;
		await openDeviceApi(tablet.device, cache);

		expect(firstRound).toBeGreaterThan(0);
		// Without this the first gate would re-hash the whole library every run, which on a real
		// account is the difference between a sync that costs one listing and one that costs 185 MB.
		expect(tablet.hashed.flat()).toEqual([]);
	});

	it("hashes only the file that changed", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const cache = memoryCache();
		await openDeviceApi(tablet.device, cache);
		tablet.hashed.length = 0;

		tablet.write(`${DOC}/${PAGE}.rm`, "changed");
		await openDeviceApi(tablet.device, cache);

		expect(tablet.hashed.flat()).toEqual([`${DOC}/${PAGE}.rm`]);
	});
});


/**
 * The engine, over the device.
 *
 * The unit tests above prove the six methods answer correctly; this proves the *engine* reads them
 * the way it reads the cloud -- specifically that the top-level gate, which is what makes an idle
 * sync cost one listing instead of a library, closes over hashes this module computed. The stores
 * throw if touched, which is half the assertion: an idle run must not reach the vault at all.
 */
function refusingDeps(api: SyncDeps["api"]): SyncDeps {
	const refuse = (what: string) => () => {
		throw new Error(`an unchanged device must not reach the ${what}`);
	};
	return {
		api,
		tagRouter: new TagRouter({ nothing: "Target" }),
		noteStore: { read: refuse("vault"), exists: refuse("vault"), write: refuse("vault"), delete: refuse("vault") } as never,
		attachmentStore: { ensureFolder: refuse("vault"), writeBinary: refuse("vault") },
		ocrBackend: { transcribe: refuse("OCR backend") } as never,
		marginNotes: false,
		now: () => "2026-08-24T00:00:00.000Z",
	};
}

describe("the engine over the device", () => {
	it("records the device's root hash on a run, and does nothing at all on the next one", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const cache = memoryCache();

		// Nothing is tagged into the router, so the first run plans no work and only records where the
		// device stood -- which is exactly the state an idle vault is in every day after the first.
		const first = await runSync(refusingDeps(await openDeviceApi(tablet.device, cache)), EMPTY_SYNC_INDEX);
		expect(first.notesWritten).toBe(0);
		expect(first.index.rootHash).not.toBeNull();

		tablet.hashed.length = 0;
		const second = await openDeviceApi(tablet.device, cache);
		const result = await runSync(refusingDeps(second), first.index);

		// Identity, not equality: the engine's own pinned contract for "nothing to do", now met by a
		// root hash this module computed off a filesystem rather than one a server handed over.
		expect(result.index).toBe(first.index);
		// And it cost nothing: the second session hashed no file, because the cache answered for all
		// of them.
		expect(tablet.hashed.flat()).toEqual([]);
	});

	it("notices on the next run that a page was written on", async () => {
		const tablet = fakeDevice(NOTEBOOK);
		const cache = memoryCache();
		const first = await runSync(refusingDeps(await openDeviceApi(tablet.device, cache)), EMPTY_SYNC_INDEX);

		tablet.write(`${DOC}/${PAGE}.rm`, "page bytes, and one more stroke");
		const result = await runSync(refusingDeps(await openDeviceApi(tablet.device, cache)), first.index);

		// The gate opens. Nothing is written because nothing is tagged into the router, but the run is
		// no longer the identity short-circuit -- which is the signal a real vault would act on.
		expect(result.index).not.toBe(first.index);
		expect(result.index.rootHash).not.toBe(first.index.rootHash);
	});
});
