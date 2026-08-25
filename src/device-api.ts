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
import { mapWithConcurrency } from "./concurrency";
import { hashBytes, indexEntry, type Sync15Entry } from "./sync15-hash";

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
	hash(paths: readonly string[], onProgress?: (done: number, total: number) => void): Promise<Map<string, string>>;
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
 * How many small files to read from the device at once, while listing the account.
 *
 * Measured on a real tablet over Wi-Fi, 116 documents, two small files each: **78 s** one after
 * another, 7.4 s at six in flight, 4.3 s at sixteen, **1.0 s at thirty-two**. The listing is almost
 * entirely waiting, so the number is about how many round trips overlap and nothing else.
 *
 * It bounds only this listing, where every file is a few kilobytes of JSON. Pages and PDFs are
 * fetched by the engine, under its own limit, so nothing here can put a large file in flight
 * thirty-two times over.
 */
const DEVICE_READ_PARALLELISM = 32;

/**
 * Sibling files that are part of what the cloud hashes for a document.
 *
 * An allowlist rather than a denylist, because the cost of the two mistakes is not symmetric: a file
 * wrongly *included* changes the document's hash, which silently costs the user a re-render and a
 * re-transcription of that document on every transport switch -- the one thing this whole approach
 * exists to avoid. A file wrongly excluded does the same, but only for a file type reMarkable added
 * after this was written, which is a thing to find out about rather than to guess at.
 *
 * Checked against a real device's own `.tree` -- the hash tree xochitl keeps -- across a
 * 115-document library: the only extensions the cloud hashes are `.content`, `.metadata`,
 * `.pagedata`, `.pdf`, `.epub`, `.template`, and the `.rm`/`.png`/`.jpg` inside a document's folder.
 * `.local`, `.thumbnails/` and per-page `-metadata.json` appear in that tree **zero** times, so they
 * are on the device and not in the account.
 */
const DOCUMENT_SUFFIXES = [".content", ".metadata", ".pagedata", ".pdf", ".epub", ".template"];

/**
 * The same allowlist, one level in: what the cloud hashes *inside* a document's folder.
 *
 * An allowlist here too, and for a reason that took a bug to see. `<page>-metadata.json` -- the
 * v5-era file that held a page's layer names, which v6 folded into the `.rm` itself -- is one of
 * the three kinds of file the `.tree` check found **zero** records of, alongside `.local` and
 * `.thumbnails/`. It is still on the disk of any reMarkable 1 or 2 that has notebooks from before
 * software 3.0, and taking everything under the folder counted it: that document's hash then stops
 * matching the cloud's, and every transport switch re-renders and re-transcribes it -- precisely
 * the cost this whole design exists to avoid.
 *
 * Invisible on a Paper Pro, which is v6 only and has no such file to include, so the live run
 * against one could not have caught it.
 */
const MEMBER_SUFFIXES = [".rm", ".png", ".jpg"];

/** Which document a device file belongs to, or `null` if the cloud does not hash it. */
export function documentOf(path: string): string | null {
	const slash = path.indexOf("/");
	if (slash !== -1) {
		const docId = path.slice(0, slash);
		if (!UUID_RE.test(docId)) return null;
		// The last segment, because a page's pictures sit one folder deeper again.
		const name = path.slice(path.lastIndexOf("/") + 1);
		const suffix = name.lastIndexOf(".");
		return suffix !== -1 && MEMBER_SUFFIXES.includes(name.slice(suffix)) ? docId : null;
	}
	const dot = path.indexOf(".");
	if (dot === -1) return null;
	const docId = path.slice(0, dot);
	if (!UUID_RE.test(docId)) return null;
	return DOCUMENT_SUFFIXES.includes(path.slice(dot)) ? docId : null;
}

/**
 * A hash for every file in the account, asked for in **one** request.
 *
 * The account, not the document: a first pairing has to hash thousands of files, and asking per
 * document would be one round trip per document -- on a real library, over a hundred of them, each
 * paying the latency of a command that could have carried the lot. What the cache already knows is
 * never asked for again, so a steady-state sync usually asks for nothing at all.
 */
async function hashAll(
	files: DeviceFiles,
	cache: HashCache,
	stats: readonly DeviceFileStat[],
	report?: (message: string) => void,
): Promise<Map<string, string>> {
	const known = new Map<string, string>();
	const unknown: string[] = [];
	for (const stat of stats) {
		const cached = cache.get(stat);
		if (cached === undefined) unknown.push(stat.path);
		else known.set(stat.path, cached);
	}
	if (unknown.length === 0) return known;

	// The first pairing hashes the whole library -- on a real account thousands of files and a minute
	// of work -- and a minute of a status bar saying "starting…" reads as a plugin that has hung.
	const fresh = await files.hash(unknown, (done, total) =>
		report?.(`Tagged Sync: reading your reMarkable (${done} of ${total} files)`),
	);
	for (const stat of stats) {
		const hash = fresh.get(stat.path);
		if (hash === undefined) continue;
		known.set(stat.path, hash);
		cache.set(stat, hash);
	}
	return known;
}

/** The document's files as the sync15 index lines that name them, given hashes already in hand. */
function documentEntries(hashes: ReadonlyMap<string, string>, stats: readonly DeviceFileStat[]): Sync15Entry[] {
	const entries: Sync15Entry[] = [];
	for (const stat of stats) {
		const hash = hashes.get(stat.path);
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
 *
 * A document the tablet has tombstoned is indexed here and hidden by `listItems`, which is not an
 * oversight to tidy up. Deciding it here would mean reading every `.metadata` before a single hash
 * could be taken, to save a root hash that has to move anyway -- the account did change. The
 * residual is that while a tombstone sits there unsynced, this root hash and the cloud's disagree,
 * which costs one full scan and re-renders nothing: the per-document hashes, which are what protect
 * the renders, are untouched by it.
 */
async function readAccount(files: DeviceFiles, cache: HashCache, report?: (message: string) => void) {
	const byDocument = new Map<string, DeviceFileStat[]>();
	for (const stat of await files.list()) {
		const docId = documentOf(stat.path);
		if (docId === null) continue;
		const group = byDocument.get(docId);
		if (group === undefined) byDocument.set(docId, [stat]);
		else group.push(stat);
	}

	const hashes = await hashAll(files, cache, [...byDocument.values()].flat(), report);
	const documents = new Map<string, DeviceDocument>();
	for (const [docId, stats] of byDocument) {
		const entries = documentEntries(hashes, stats);
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
 * The account is indexed once, here, so all three of the engine's gates are answered out of one
 * snapshot. The engine's doubled document opens -- once while scanning, once while working -- are
 * then served from the small-text cache below rather than fetched again, which is what rmapi-js's
 * own cache does for the cloud path.
 */
export async function openDeviceApi(
	files: DeviceFiles,
	cache: HashCache,
	report?: (message: string) => void,
): Promise<SyncApi> {
	const { documents, root } = await readAccount(files, cache, report);

	/**
	 * Small text files this session has already fetched, mirroring what rmapi-js caches on the cloud
	 * side -- and for the same reason.
	 *
	 * The engine opens each candidate document twice, once while scanning and once while working, and
	 * `listItems` has read its `.metadata` before either. Without this that is three fetches and three
	 * verifications of the same few kilobytes per document per run, which on the cloud costs nothing
	 * because rmapi-js answers the repeats from its own cache. Only `.content` and `.metadata` are
	 * held: they are small, they are the ones read repeatedly, and holding pages or PDFs would trade a
	 * saved round trip for the whole library in memory -- the same line rmapi-js draws.
	 */
	const textCache = new Map<string, Uint8Array>();
	const isSmallText = (path: string): boolean => path.endsWith(".content") || path.endsWith(".metadata");

	/**
	 * A member file's bytes, checked against the hash this session indexed it under.
	 *
	 * The device is *live*: xochitl keeps writing while a sync reads, so a file can move between the
	 * listing that hashed it and the read that fetches it. Nobody in this field locks -- the tablet
	 * offers no way to -- so the guard is to notice instead, by hashing what was actually read.
	 *
	 * A second read covers a genuinely torn one. If it still disagrees the file really did change, and
	 * throwing is right: the engine skips that one document and the next sync picks it up, because the
	 * hash that moved is the same hash the gates read. What must never happen is the quiet version --
	 * rendering half-written bytes and recording them under the old page hash, which is a page that
	 * looks synced and never updates again.
	 */
	const readMember = async (docId: string, path: string): Promise<Uint8Array> => {
		const document = documents.get(docId);
		if (document === undefined) throw new Error(`No document ${docId} on the device.`);
		const held = textCache.get(path);
		if (held !== undefined) return held;
		const expected = document.hashes.get(path);
		let bytes = await files.read(path);
		if (expected !== undefined && (await hashBytes(bytes)) !== expected) {
			// A second read covers a genuinely torn one; a second disagreement means the file really did
			// change, and is refused rather than rendered under a hash that no longer describes it.
			bytes = await files.read(path);
			if ((await hashBytes(bytes)) !== expected) {
				throw new Error(`${path} changed on the device while it was being read.`);
			}
		}
		if (isSmallText(path)) textCache.set(path, bytes);
		return bytes;
	};

	const contentOf = async (docId: string): Promise<Content> => {
		const bytes = await readMember(docId, `${docId}.content`);
		return parseJson(bytes) as Content;
	};

	return {
		async listItems(): Promise<Entry[]> {
			// Two small files per document, and on a real account that is a couple of hundred reads. Done
			// one after another they cost a round trip each and the listing took **78 seconds** on a
			// tablet over Wi-Fi -- before a sync had looked at anything. SFTP is happy to have many
			// requests in flight, so they go in parallel; the limit matches the engine's own for opening
			// documents, which is what the connection is sized for anyway.
			const listed = await mapWithConcurrency<[string, DeviceDocument], Entry | null>([...documents], DEVICE_READ_PARALLELISM, async ([docId, document]) => {
				const metadataFile = document.files.find((file) => file.path === `${docId}.metadata`);
				if (metadataFile === undefined) return null;
				const metadata = parseJson(await readMember(docId, metadataFile.path)) as DeviceMetadata;
				// The device keeps a tombstone until the next cloud sync clears it; the cloud listing has
				// no such row, so honouring it is what keeps the two transports listing the same account.
				if (metadata.deleted === true) return null;

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
					return { ...common, type: "CollectionType" as const, tags: await folderTags(docId) };
				}
				const content = (await contentOf(docId)) as { fileType?: string; tags?: Entry["tags"] };
				return {
					...common,
					type: "DocumentType" as const,
					fileType: (content.fileType as "epub" | "pdf" | "notebook") ?? "notebook",
					lastOpened: metadata.lastOpened ?? "0",
					tags: content.tags ?? [],
				};
			});
			return listed.filter((item) => item !== null);
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
