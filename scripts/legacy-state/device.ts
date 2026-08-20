// The fake reMarkable the frozen legacy state was produced from.
//
// **This is part of the state, not a detail of the producer.** The upgrade test replays today's
// engine against the *same* device the old build saw; a different device would legitimately rewrite
// everything, and every assertion in the test would then mean nothing.
//
// Three entries, chosen to be the minimum worth freezing:
//
//   - one notebook under **two** tags -- the "same note written twice" case, which is where
//     duplication bugs live
//   - one notebook tagged by **folder inheritance** rather than directly, so the inherited-tag path
//     is in the state
//   - a **nested** target folder, so a mapping is more than one path segment
//
// Page bytes come from **one** tracked `.rm` fixture, and which one is deliberate:
// `normal-a-stroke-2-layers.rm` is plain ink and quotes nobody. The other two page fixtures carry
// highlight runs over third-party text -- which is exactly why ticket 16 wants them replaced -- and a
// state built on those would copy that text into a second tracked file and make the replacement job
// bigger for no test reason. Nothing here needs highlights: the upgrade assertions are about notes,
// paths, managed blocks and index rows.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncApi } from "../../src/sync-engine";

// From the working directory, not from `import.meta.url`: this is run as an esbuild bundle in
// `/tmp`, and the bundle's own URL says nothing about where the repo is.
const pageBytes = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(join(process.cwd(), "test-fixtures", "rmv6", name)));

/** The root hash the state was frozen at. Only its stability matters, not its value. */
export const ROOT_HASH = "root-legacy-state";

export const TAG_FOLDER_MAP: Record<string, string> = {
	sync: "Inbox",
	work: "Work/Notes",
	read: "Reading",
};

const ENTRIES = [
	{
		id: "folder-reading",
		hash: "h-folder-reading",
		visibleName: "Reading",
		lastModified: "1000",
		pinned: false,
		parent: "",
		type: "CollectionType",
		tags: [{ name: "read", timestamp: 0 }],
	},
	{
		id: "doc-notes",
		hash: "h-doc-notes",
		visibleName: "Field Notes",
		lastModified: "1000",
		pinned: false,
		parent: "",
		type: "DocumentType",
		fileType: "notebook",
		lastOpened: "0",
		tags: [
			{ name: "sync", timestamp: 0 },
			{ name: "work", timestamp: 0 },
		],
	},
	{
		id: "doc-paper",
		hash: "h-doc-paper",
		visibleName: "Reading List",
		lastModified: "1000",
		pinned: false,
		parent: "folder-reading",
		type: "DocumentType",
		fileType: "notebook",
		lastOpened: "0",
		tags: [],
	},
];

const CONTENT: Record<string, unknown> = {
	"doc-notes": {
		coverPageNumber: 0,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		lineHeight: -1,
		orientation: "portrait",
		pageCount: 2,
		textAlignment: "",
		textScale: 1,
		cPages: {
			lastOpened: { timestamp: "1:1", value: "" },
			original: { timestamp: "1:1", value: 0 },
			uuids: null,
			pages: [
				{ id: "page-one", idx: { timestamp: "1:1", value: "a" } },
				{ id: "page-two", idx: { timestamp: "1:1", value: "b" } },
			],
		},
	},
	"doc-paper": {
		coverPageNumber: 0,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		lineHeight: -1,
		orientation: "portrait",
		pageCount: 1,
		textAlignment: "",
		textScale: 1,
		cPages: {
			lastOpened: { timestamp: "1:1", value: "" },
			original: { timestamp: "1:1", value: 0 },
			uuids: null,
			pages: [{ id: "page-list", idx: { timestamp: "1:1", value: "a" } }],
		},
	},
};

const PAGE_HASHES: Record<string, Record<string, string>> = {
	"doc-notes": { "page-one": "h-page-one", "page-two": "h-page-two" },
	"doc-paper": { "page-list": "h-page-list" },
};

/**
 * `getHash` is keyed by the **file name**, not the hash -- `raw.getHash(fileName, hash)`.
 *
 * Getting that round the wrong way does not throw: every page comes back empty, the engine catches
 * three `EOFError`s and returns `notesWritten: 0`. A mis-wired replay freezes *nothing* and looks
 * fine, which is why `freeze.ts` refuses a run that wrote no notes.
 */
const PAGE_FILE_BYTES: Record<string, string> = {
	"doc-notes/page-one.rm": "normal-a-stroke-2-layers.rm",
	"doc-notes/page-two.rm": "normal-a-stroke-2-layers.rm",
	"doc-paper/page-list.rm": "normal-a-stroke-2-layers.rm",
};

export function legacyDevice(): SyncApi {
	return {
		listItems: async () => ENTRIES as never,
		getContent: async (id: string) => {
			const content = CONTENT[id];
			if (!content) throw new Error(`no content for ${id}`);
			return content as never;
		},
		getPdf: async () => {
			throw new Error("the legacy state has no PDF-backed document");
		},
		raw: {
			getRootHash: async () => [ROOT_HASH, 1, 4] as never,
			getEntries: async (fileName: string) => {
				const docId = fileName.replace(/\.docSchema$/, "");
				const pages = PAGE_HASHES[docId] ?? {};
				return {
					entries: Object.entries(pages).map(([pageId, hash]) => ({
						id: `${docId}/${pageId}.rm`,
						hash,
						type: 0 as const,
						subfiles: 0,
						size: 0,
					})),
				} as never;
			},
			getHash: async (fileName: string) => {
				const fixture = PAGE_FILE_BYTES[fileName];
				if (!fixture) throw new Error(`no page bytes for ${fileName}`);
				return pageBytes(fixture) as never;
			},
		},
	};
}
