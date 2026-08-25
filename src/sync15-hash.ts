/**
 * The cloud's own hashes, computed from files on the tablet.
 *
 * This is the piece that makes the two transports interchangeable. The sync index stores a hash per
 * document and per page, and all three change-detection gates compare stored against fetched -- so
 * if the SSH transport invented its own hash scheme, every gate would miss on the first sync after
 * a switch and the whole vault would re-render and re-transcribe. Emitting the *same* hashes the
 * cloud does means a vault can move between transports, and fail over between them, with the index
 * it already has.
 *
 * That is only possible because sync15 hashes are not a server-side secret: a file's hash is the
 * SHA-256 of its bytes, and a document's is the SHA-256 of a small text index listing its files.
 * Both are reproducible from what sits on the device -- verified byte-identical against the live
 * device and against `.tree`, the hash tree xochitl keeps while it is cloud-connected.
 *
 * Written against rmapi-js's `putEntries` (`dist/raw.js:430-473`), which is the definition of the
 * format for the cloud path in this same plugin. Where the two must agree, they agree because this
 * mirrors that function line for line.
 */

/** One line of an index file: a member file, or a whole document when this is the root index. */
export interface Sync15Entry {
	/** `<uuid>.content`, `<uuid>/<pageId>.rm`, or a bare document uuid in the root index. */
	readonly id: string;
	/** SHA-256 of the bytes, lowercase hex. */
	readonly hash: string;
	/** How many files the entry indexes -- `0` for a plain file, the member count for a document. */
	readonly subfiles: number;
	/** Bytes for a file; the summed size of the members for a document. */
	readonly size: number;
}

/** Schema 4. Schema 3 hashed concatenated member hashes instead, and reMarkable rejects it now. */
const SCHEMA_VERSION = 4;

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
	return out;
}

/** A file's hash is the SHA-256 of exactly its bytes -- no name, no length, nothing else mixed in. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
	// A fresh copy, because `subtle.digest` wants an ArrayBuffer and a Uint8Array read off a larger
	// buffer (which is what a chunked file read produces) would otherwise hash its neighbours too.
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return toHex(new Uint8Array(digest));
}

/**
 * The index file for one document, or for the root, byte for byte as the cloud stores it.
 *
 * Sorted by id because the hash is over the rendered text: two orderings of the same files are two
 * different hashes, and only one of them is the one the cloud wrote. rmapi-js sorts with
 * `localeCompare`; this sorts by code point, which agrees with it for the hex-uuid ids that occur
 * here and, unlike `localeCompare`, cannot answer differently under another locale.
 */
export function indexFileBytes(id: string, entries: readonly Sync15Entry[]): Uint8Array {
	const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const size = sorted.reduce((total, entry) => total + entry.size, 0);
	// The root's index calls itself `.`; a document's calls itself by its uuid.
	const name = id === "root" ? "." : id;
	const lines = [`${SCHEMA_VERSION}\n`, `0:${name}:${sorted.length}:${size}\n`];
	// The `0` is the schema-4 line type. Schema 3 wrote `80000000` here for collections.
	for (const entry of sorted) lines.push(`${entry.hash}:0:${entry.id}:${entry.subfiles}:${entry.size}\n`);
	return new TextEncoder().encode(lines.join(""));
}

/**
 * What a document (or the root) is, as one entry: the hash of its index file, plus the counts that
 * index reports. This is the value the sync index stores as `entryHash`, and the value
 * `getRootHash` answers with at the top.
 */
export async function indexEntry(id: string, entries: readonly Sync15Entry[]): Promise<Sync15Entry> {
	const bytes = indexFileBytes(id, entries);
	return {
		id,
		hash: await hashBytes(bytes),
		subfiles: entries.length,
		size: entries.reduce((total, entry) => total + entry.size, 0),
	};
}
