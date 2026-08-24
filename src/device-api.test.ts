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

	const device: DeviceFiles = {
		list: async (): Promise<DeviceFileStat[]> =>
			[...files].map(([path, bytes]) => ({ path, size: bytes.length, mtimeMs: mtimes.get(path) ?? 0 })),
		read: async (path) => {
			read.push(path);
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
	// Neither of these is in the cloud's tree, and including one would change the document's hash.
	[`${DOC}.local`]: JSON.stringify({ contentFormatVersion: 2 }),
	[`${DOC}.thumbnails/${PAGE}.jpg`]: "thumbnail bytes",
};

describe("which files belong to a document", () => {
	it("takes everything under the document's own folder", () => {
		expect(documentOf(`${DOC}/${PAGE}.rm`)).toBe(DOC);
		expect(documentOf(`${DOC}/${PAGE}/picture.png`)).toBe(DOC);
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
