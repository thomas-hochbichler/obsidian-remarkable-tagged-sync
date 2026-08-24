/**
 * The tablet's own filesystem, wearing the shape the sync engine already reads.
 *
 * The engine takes its source as a `SyncApi` -- six methods, structurally typed -- so nothing here
 * teaches it about SSH. What this module does is answer those six from `xochitl/`, and answer them
 * with the **cloud's hashes** (see `sync15-hash`), which is what lets a vault switch between the two
 * transports, or fail over between them, without its sync index missing on every row.
 *
 * The work is deliberately split from the connection: everything below reads a {@link DeviceFiles},
 * which a test satisfies with a plain map of paths. That is the same trick `scripts/legacy-state`
 * plays on the cloud side, and it is what makes the interesting parts -- membership, hashing,
 * caching, the entry index -- testable without a tablet in the room.
 */

import type { Content, Entry, RawEntry } from "rmapi-js";
import type { SyncApi } from "./sync-engine";
import { indexEntry, type Sync15Entry } from "./sync15-hash";

/** One file on the device, as a listing reports it. Paths are relative to the xochitl directory. */
export interface DeviceFileStat {
	readonly path: string;
	readonly size: number;
	/** Modification time in milliseconds. With `size`, this is what makes a cached hash reusable. */
	readonly mtimeMs: number;
}

/** What a transport has to be able to do to a device for the rest of this module to work. */
export interface DeviceFiles {
	/** Every file under the xochitl directory, recursively. */
	list(): Promise<DeviceFileStat[]>;
	read(path: string): Promise<Uint8Array>;
	/**
	 * SHA-256 of each path, keyed by path.
	 *
	 * A method of its own rather than `read` plus a local hash because the device can do this without
	 * sending the bytes: the whole library is ~185 MB, and hashing it over the wire on first pairing
	 * would be minutes of transfer for numbers the tablet can produce in seconds.
	 */
	hash(paths: readonly string[]): Promise<Map<string, string>>;
}

/**
 * Hashes already known for a (path, size, mtime).
 *
 * Every sync needs a hash for every file in the account -- that is what the root hash is made of --
 * so without this the first gate would re-hash the whole library on every run. Keyed by all three
 * fields, so a file that changed is simply a cache miss rather than something to invalidate.
 */
export interface HashCache {
	get(stat: DeviceFileStat): string | undefined;
	set(stat: DeviceFileStat, hash: string): void;
}

/** A cache that remembers nothing -- what a one-off connection (the tag scan) wants. */
export const NO_HASH_CACHE: HashCache = { get: () => undefined, set: () => {} };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Sibling files that are part of what the cloud hashes for a document.
 *
 * An allowlist rather than a denylist, because the cost of the two mistakes is not symmetric: a file
 * wrongly *included* changes the document's hash, which silently costs the user a re-render and a
 * re-transcription of that document on every transport switch -- the one thing this whole approach
 * exists to avoid. A file wrongly excluded does the same, but only for a file type reMarkable added
 * after this was written, which is a thing to find out about rather than to guess at.
 *
 * `.local` and `.thumbnails/` are on the device and *not* in the cloud tree -- verified against the
 * device's own `.tree`.
 */
const DOCUMENT_SUFFIXES = [".content", ".metadata", ".pagedata", ".pdf", ".epub", ".template"];

/** Which document a device file belongs to, or `null` if the cloud does not hash it. */
export function documentOf(path: string): string | null {
	const slash = path.indexOf("/");
	if (slash !== -1) {
		// Everything under `<uuid>/` -- the pages, and the picture folders a page keeps beside them.
		const docId = path.slice(0, slash);
		return UUID_RE.test(docId) ? docId : null;
	}
	const dot = path.indexOf(".");
	if (dot === -1) return null;
	const docId = path.slice(0, dot);
	if (!UUID_RE.test(docId)) return null;
	return DOCUMENT_SUFFIXES.includes(path.slice(dot)) ? docId : null;
}

/** The document's files, hashed, as the sync15 index lines that name them. */
async function documentEntries(
	files: DeviceFiles,
	cache: HashCache,
	stats: readonly DeviceFileStat[],
): Promise<Sync15Entry[]> {
	const known = new Map<string, string>();
	const unknown: string[] = [];
	for (const stat of stats) {
		const cached = cache.get(stat);
		if (cached === undefined) unknown.push(stat.path);
		else known.set(stat.path, cached);
	}
	if (unknown.length > 0) {
		const fresh = await files.hash(unknown);
		for (const stat of stats) {
			const hash = fresh.get(stat.path);
			if (hash === undefined) continue;
			known.set(stat.path, hash);
			cache.set(stat, hash);
		}
	}

	const entries: Sync15Entry[] = [];
	for (const stat of stats) {
		const hash = known.get(stat.path);
		// A file that vanished between the listing and the hashing is skipped rather than fatal: the
		// device is live, and a document xochitl deleted mid-scan is not this sync's business.
		if (hash === undefined) continue;
		entries.push({ id: stat.path, hash, subfiles: 0, size: stat.size });
	}
	return entries;
}

interface DeviceDocument {
	readonly entry: Sync15Entry;
	readonly files: readonly DeviceFileStat[];
	/** Member path -> hash, for `getEntries` and for verifying a read. */
	readonly hashes: ReadonlyMap<string, string>;
}

/**
 * Reads the whole account: every document's files, hashed, indexed, and rolled up into a root hash.
 *
 * This is the expensive call and it happens once per session, because all three of the engine's
 * change-detection gates are answered out of it -- the root hash it compares first, the per-document
 * hashes it compares next, and the per-page hashes it compares last are all already here.
 */
async function readAccount(files: DeviceFiles, cache: HashCache) {
	const byDocument = new Map<string, DeviceFileStat[]>();
	for (const stat of await files.list()) {
		const docId = documentOf(stat.path);
		if (docId === null) continue;
		const group = byDocument.get(docId);
		if (group === undefined) byDocument.set(docId, [stat]);
		else group.push(stat);
	}

	const documents = new Map<string, DeviceDocument>();
	for (const [docId, stats] of byDocument) {
		const entries = await documentEntries(files, cache, stats);
		if (entries.length === 0) continue;
		documents.set(docId, {
			entry: await indexEntry(docId, entries),
			files: stats,
			hashes: new Map(entries.map((entry) => [entry.id, entry.hash])),
		});
	}

	const root = await indexEntry(
		"root",
		[...documents.values()].map((document) => document.entry),
	);
	return { documents, root };
}

function parseJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder().decode(bytes));
}

/** The `.metadata` fields this plugin reads. Anything else the device writes there is ignored. */
interface DeviceMetadata {
	visibleName?: string;
	lastModified?: string;
	lastOpened?: string;
	parent?: string;
	pinned?: boolean;
	type?: string;
	deleted?: boolean;
}

/**
 * Builds the six-method surface the engine reads, for one connection.
 *
 * The account is read once, here, and the returned object answers out of that snapshot -- which is
 * also what makes the engine's doubled reads (it opens each document once while scanning and once
 * while working) free, exactly as rmapi-js's content-addressed cache makes them free on the cloud.
 */
export async function openDeviceApi(files: DeviceFiles, cache: HashCache): Promise<SyncApi> {
	const { documents, root } = await readAccount(files, cache);

	/** A member file's bytes, checked against the hash the index gave for it. */
	const readMember = async (docId: string, path: string): Promise<Uint8Array> => {
		const document = documents.get(docId);
		if (document === undefined) throw new Error(`No document ${docId} on the device.`);
		return await files.read(path);
	};

	const contentOf = async (docId: string): Promise<Content> => {
		const bytes = await readMember(docId, `${docId}.content`);
		return parseJson(bytes) as Content;
	};

	return {
		async listItems(): Promise<Entry[]> {
			const items: Entry[] = [];
			for (const [docId, document] of documents) {
				const metadataFile = document.files.find((file) => file.path === `${docId}.metadata`);
				if (metadataFile === undefined) continue;
				const metadata = parseJson(await files.read(metadataFile.path)) as DeviceMetadata;
				// The device keeps a tombstone until the next cloud sync clears it; the cloud listing has
				// no such row, so honouring it is what keeps the two transports listing the same account.
				if (metadata.deleted === true) continue;

				const common = {
					id: docId,
					hash: document.entry.hash,
					visibleName: metadata.visibleName ?? docId,
					lastModified: metadata.lastModified ?? "0",
					pinned: metadata.pinned ?? false,
					parent: metadata.parent ?? "",
				};
				if (metadata.type === "CollectionType") {
					// A folder's tags are what makes a tagged folder route everything inside it, so they are
					// read here from the same place a document's are.
					const tags = await folderTags(docId);
					items.push({ ...common, type: "CollectionType", tags });
					continue;
				}
				const content = (await contentOf(docId)) as { fileType?: string; tags?: Entry["tags"] };
				items.push({
					...common,
					type: "DocumentType",
					fileType: (content.fileType as "epub" | "pdf" | "notebook") ?? "notebook",
					lastOpened: metadata.lastOpened ?? "0",
					tags: content.tags ?? [],
				});
			}
			return items;
		},

		getContent: (id: string): Promise<Content> => contentOf(id),

		getPdf: (id: string): Promise<Uint8Array> => readMember(id, `${id}.pdf`),

		raw: {
			getRootHash: async (): Promise<[string, number, 4]> => {
				// The generation is the cloud's optimistic-concurrency counter for *writes*, and this
				// transport never writes. The engine reads the hash and nothing else.
				return [root.hash, 0, 4];
			},

			getEntries: async (fileName: string) => {
				const docId = fileName.endsWith(".docSchema") ? fileName.slice(0, -".docSchema".length) : fileName;
				const document = documents.get(docId);
				if (document === undefined) throw new Error(`No document ${docId} on the device.`);
				const entries: RawEntry[] = [...document.hashes].map(([id, hash]) => ({
					id,
					hash,
					type: 0 as const,
					subfiles: 0,
					size: document.files.find((file) => file.path === id)?.size ?? 0,
				}));
				return { entries, id: docId, size: document.entry.size };
			},

			getHash: async (fileName: string): Promise<Uint8Array> => {
				const docId = documentOf(fileName);
				if (docId === null) throw new Error(`${fileName} is not a document file.`);
				return await readMember(docId, fileName);
			},
		},
	};

	/** A collection's tags live in its `.content`, same as a document's. */
	async function folderTags(docId: string): Promise<Entry["tags"]> {
		const document = documents.get(docId);
		if (document?.files.some((file) => file.path === `${docId}.content`) !== true) return [];
		const content = (await contentOf(docId)) as { tags?: Entry["tags"] };
		return content.tags ?? [];
	}
}
