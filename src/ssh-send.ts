/**
 * Putting one PDF onto the tablet's own disk, over SSH (spec §2.4, proven in
 * `.scratch/zotero-integration/research/13-ssh-send-samples.md`).
 *
 * The device has no upload endpoint we can reach and no directory watch: files dropped into
 * `xochitl/` are simply not noticed. The measurement went looking for a restart-free path and found
 * none on a Paper Pro -- no `WebInterfaceEnabled`, no listener on port 80, nothing on the LAN at all
 * -- so the send ends with `systemctl restart xochitl`, and the setting that enables it says so in
 * words before the user turns it on. The home screen is back after about six seconds; the new
 * document is indexed in the background after that.
 *
 * The three files are the ones rmapi-js's own `putPdf` uploads, and the run proved xochitl accepts
 * them on disk rather than only through the cloud. It writes the rest itself on the next start --
 * `.pagedata`, `.local`, `.thumbnails/` -- which is why only three are written here: what the tablet
 * fills in for itself is not ours to guess at.
 */

import type { DeviceFileStat } from "./device-api";
import { mapWithConcurrency } from "./concurrency";
import type { SendDocument } from "./zotero-send";

/** What a send needs of a connection: the read half it already has, plus writing and one command. */
export interface DeviceSendTarget {
	list(): Promise<DeviceFileStat[]>;
	read(path: string): Promise<Uint8Array>;
	/** Writes one file under the xochitl directory, creating it. Nothing here ever writes a path twice. */
	write(path: string, bytes: Uint8Array): Promise<void>;
	exec(command: string): Promise<string>;
}

/** The one command that makes a file on the disk a document in the app. See the file header. */
export const RESTART_COMMAND = "systemctl restart xochitl";

/** What the setting says before the user turns SSH send on (§2.4, in the spec's own words). */
export const SSH_SEND_RESTART_NOTE =
	"Sending over SSH restarts the tablet's reading app; the document you have open is closed first.";

/** Same limit and same reason as the account listing in `device-api`: this is round trips, not bytes. */
const METADATA_READ_PARALLELISM = 32;

const TOP_LEVEL_METADATA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.metadata$/;

interface DeviceMetadata {
	visibleName?: string;
	type?: string;
	parent?: string;
	deleted?: boolean;
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 4));

/**
 * The tablet's `Zotero` folder: the one that is there, or a new one.
 *
 * **By name, at the top level, and never renamed** (§2.4). A folder is the user's; renaming theirs
 * because our setting changed would move their documents out from under them, and matching one
 * nested inside another folder would let a stray `Zotero` folder somewhere in their tree collect
 * papers they cannot find. Several at the top level is not a state we make -- it is one the user can
 * -- and the lowest id wins so that two sends in a row agree.
 */
export async function findOrCreateFolder(device: DeviceSendTarget, name: string, newId: () => string): Promise<string> {
	const existing = folderIds(await topLevelMetadata(device), name);
	if (existing.length > 0) return existing[0];

	const id = newId();
	const now = Date.now();
	await device.write(`${id}.content`, encode({ tags: [] }));
	await device.write(
		`${id}.metadata`,
		encode({ lastModified: String(now), createdTime: String(now), parent: "", pinned: false, type: "CollectionType", visibleName: name }),
	);
	return id;
}

/**
 * Every readable top-level `.metadata` file, by document id.
 *
 * A `.metadata` that cannot be read is left out: it is not a folder we may use nor a document we
 * can name, and it is not this command's business to repair -- the device is live and a
 * half-written file is an ordinary sight.
 */
async function topLevelMetadata(device: DeviceSendTarget): Promise<Map<string, DeviceMetadata>> {
	const files = await device.list();
	const candidates = files.map((file) => file.path).filter((path) => TOP_LEVEL_METADATA.test(path));
	const read = await mapWithConcurrency(candidates, METADATA_READ_PARALLELISM, async (path): Promise<[string, DeviceMetadata] | null> => {
		try {
			return [path.replace(/\.metadata$/, ""), JSON.parse(new TextDecoder().decode(await device.read(path))) as DeviceMetadata];
		} catch {
			return null;
		}
	});
	return new Map(read.filter((entry): entry is [string, DeviceMetadata] => entry !== null));
}

/** Every live top-level folder of that name, lowest id first. */
function folderIds(metadata: ReadonlyMap<string, DeviceMetadata>, name: string): string[] {
	return [...metadata]
		.filter(([, m]) => m.type === "CollectionType" && m.visibleName === name && (m.parent ?? "") === "" && m.deleted !== true)
		.map(([id]) => id)
		.sort();
}

/**
 * The names of the live documents in the tablet's `Zotero` folder -- {@link SendTransport.namesIn}.
 * In every folder of that name, as on the cloud side: a second one is the user's arrangement.
 */
export async function namesInDeviceFolder(device: DeviceSendTarget, name: string): Promise<string[]> {
	const metadata = await topLevelMetadata(device);
	const folders = new Set(folderIds(metadata, name));
	return [...metadata.values()]
		.filter((m) => m.type === "DocumentType" && folders.has(m.parent ?? "") && m.deleted !== true)
		.map((m) => m.visibleName)
		.filter((name): name is string => typeof name === "string");
}

/**
 * The document's own three files, in the order that makes the half-written state harmless.
 *
 * The PDF first and the `.metadata` last: until the metadata is there, xochitl has nothing that says
 * those bytes are a document, so a connection that drops part-way leaves stray files rather than an
 * entry that opens onto nothing. Nothing is deleted either way -- a failed send costs disk, which is
 * the cheapest thing on the device to cost.
 */
async function writeDocument(device: DeviceSendTarget, docId: string, document: SendDocument, parent: string, newId: () => string): Promise<void> {
	const now = Date.now();
	await device.write(`${docId}.pdf`, document.bytes);
	await device.write(
		`${docId}.content`,
		encode({
			coverPageNumber: -1,
			documentMetadata: {},
			extraMetadata: {},
			fileType: "pdf",
			fontName: "",
			formatVersion: 1,
			lineHeight: -1,
			margins: 125,
			orientation: "portrait",
			// The count xochitl re-reads from the PDF itself on first open. rmapi-js fakes it at one and
			// says so in its own source; a document uploaded through the cloud carries exactly this.
			originalPageCount: 1,
			pageCount: 1,
			pageTags: [],
			pages: [newId()],
			redirectionPageMap: [0],
			sizeInBytes: String(document.bytes.length),
			tags: [],
			textAlignment: "justify",
			textScale: 1,
			zoomMode: "bestFit",
		}),
	);
	await device.write(
		`${docId}.metadata`,
		encode({
			createdTime: String(now),
			lastModified: String(now),
			lastOpened: "0",
			lastOpenedPage: 0,
			parent,
			pinned: false,
			type: "DocumentType",
			visibleName: document.visibleName,
		}),
	);
}

/**
 * Adds one PDF to the tablet and restarts its reading app. Answers the id the document now has.
 *
 * The restart is last and is not optional: without it the files sit on the disk and *My files* never
 * shows them, which the measurement watched happen twice before concluding it.
 */
export async function sendOverSsh(device: DeviceSendTarget, document: SendDocument, newId: () => string = () => crypto.randomUUID()): Promise<{ docId: string }> {
	const parent = await findOrCreateFolder(device, document.folder, newId);
	const docId = newId();
	await writeDocument(device, docId, document, parent, newId);
	await device.exec(RESTART_COMMAND);
	return { docId };
}
