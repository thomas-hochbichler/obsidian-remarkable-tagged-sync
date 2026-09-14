/**
 * Putting a Zotero PDF on the tablet: spec §2.4 and §2.5.
 *
 * The whole of what this may do is {@link SendTransport}, and it has **one method**. That is the
 * promise of §1.2 written as a type rather than as a comment: there is no update here, no delete, no
 * move and no rename, so no version of this code can take something off the user's tablet or change
 * a document that is already on it. A transport that grows a second method is a change somebody has
 * to make on purpose.
 *
 * Everything else in this file is arithmetic over what is already known -- what to call the document,
 * which tag it gets, whether it is there already -- so the policy of §2.4 is testable without a
 * tablet, and the two transports are left with nothing but the talking.
 */

import { md5Hex } from "./file-md5";
import type { ZoteroAttachment, ZoteroClient, ZoteroItem } from "./zotero-client";
import { linkFor, withLink, withoutLink, type StoredZoteroLinks, type ZoteroLink } from "./zotero-links";

/** One document, as it is handed to a transport. Add-only: see the file header. */
export interface SendDocument {
	/** What the tablet shows in *My files*. See {@link tabletName}. */
	readonly visibleName: string;
	readonly bytes: Uint8Array;
	/** The tablet folder, by name. Created when it is not there; looked up by name, never renamed (§2.4). */
	readonly folder: string;
	// No sync tag, on purpose (decided 2026-09-13, after the live test): a tag put on by the plugin is
	// one the reader never chose, and with one mapped tag it went on without a question. The paper is
	// on the tablet; the reader tags it there when they want it back, like every other document.
}

export interface SendTransport {
	/** Names this route in the send dialog and in a failure: "reMarkable's cloud" / "your reMarkable". */
	readonly label: string;
	/** Adds one PDF and answers with the id the tablet gave it. The only method, on purpose. */
	putPdf(document: SendDocument): Promise<{ docId: string }>;
}

/** Said when the vault has no route to a tablet at all (§2.4, last line). */
export const SEND_NEEDS_TRANSPORT = "Send needs the reMarkable cloud connection or an SSH-paired tablet.";

/** The default tablet folder, and the name the setting starts at. */
export const DEFAULT_SEND_FOLDER = "Zotero";

/** The name the setting for §2.6's send tag *suggests*. It starts empty: the step is opt-in. */
export const DEFAULT_SEND_TAG = "to-remarkable";

/**
 * How long a name the tablet gets. 120 characters, from §2.4.
 *
 * Counted in characters and cut between them: the reMarkable shows the name in a fixed-width card
 * and a title that runs past it is elided there anyway, so the cut is about what the plugin sends,
 * not about what fits. Whole code points, so a cut never lands inside a surrogate pair and leaves
 * half an emoji in the file list.
 */
export const MAX_TABLET_NAME = 120;

// `/` and `:` are what the reMarkable's own file list will not take; everything else it does.
const NAME_UNSAFE = /[/:]/g;

/**
 * What the document is called on the tablet: the parent item's title, or the attachment's filename.
 *
 * The item's title and not the attachment's, because the attachment's is usually "Full Text PDF" --
 * which is what every second document in the library would then be called. The filename is the
 * fallback rather than the first choice for the same reason it is a poor title: it is
 * `Smith_2024_prompting-final-v3.pdf` as often as it is anything a reader would recognise.
 *
 * No key suffix (§2.4). The tablet's file list is the reader's, not an index of ours, and the link
 * that makes this document findable again lives in `data.json`.
 */
export function tabletName(item: ZoteroItem | null, attachment: ZoteroAttachment): string {
	// A trailing `.pdf` goes: a document on the tablet is a document, not a file, and the reMarkable's
	// own upload drops it too. §2.3's matcher compares names with and without it either way.
	const fallback = (attachment.filename ?? "").replace(/\.pdf$/i, "");
	const named = [item?.title ?? "", fallback].map((part) => part.replace(NAME_UNSAFE, "-").trim()).find((part) => part !== "");
	// The key is the last resort rather than one of the candidates: an item with no title and an
	// attachment with no filename is rare, and a document called `ATT1` is at least findable again.
	return [...(named ?? attachment.key)].slice(0, MAX_TABLET_NAME).join("").trim();
}

/**
 * The two routes a send can take, each `null` when it is not available.
 *
 * `ssh` is null for three different reasons -- not paired, not Pro, or the toggle in §2.4 is off --
 * and they are the caller's to tell apart. What is decided here is only which one wins.
 */
export interface SendRoutes {
	readonly cloud: SendTransport | null;
	readonly ssh: SendTransport | null;
}

/**
 * The cloud first, the tablet second, `null` for a vault that has neither.
 *
 * Not a preference about speed. The SSH route ends in `systemctl restart xochitl` -- the only way a
 * file on the disk becomes a document in the app (see `ssh-send.ts`) -- which closes whatever the
 * reader has open. The cloud costs them nothing, so it is tried wherever it is there, and the route
 * that interrupts a person is the fallback rather than the default.
 */
export function sendTransport(routes: SendRoutes): SendTransport | null {
	return routes.cloud ?? routes.ssh;
}

/** Which PDF of an item is meant (§2.4): none to send, one, or a question. */
export type PdfChoice =
	| { readonly kind: "none" }
	| { readonly kind: "use"; readonly attachment: ZoteroAttachment }
	| { readonly kind: "ask"; readonly options: ZoteroAttachment[] };

/**
 * The PDFs of one item, as a choice.
 *
 * Several is ordinary rather than exceptional -- a preprint beside the published version, a scan
 * beside the publisher's file -- and the two are not interchangeable: the one the reader annotates is
 * the one the highlights go back onto. Picking either for them would put a page number on a passage
 * that is on another page in the file they meant.
 */
export function pdfChoice(attachments: readonly ZoteroAttachment[], itemKey: string): PdfChoice {
	const mine = attachments.filter((attachment) => attachment.parentKey === itemKey);
	if (mine.length === 0) return { kind: "none" };
	if (mine.length === 1) return { kind: "use", attachment: mine[0] };
	return { kind: "ask", options: mine };
}

/**
 * What this attachment already is on the tablet (§2.5).
 *
 * Two lists rather than one verdict, because they are answered in different places: `present` is the
 * question the user is asked ("already there -- send another copy?"), `vanished` is a repair the send
 * does on its own. A document the user deleted from the tablet leaves a link behind that points at
 * nothing, and the next send is the only moment anything can notice.
 */
export interface SendState {
	/** Documents still on the tablet whose link points at this attachment. */
	readonly present: string[];
	/** Links pointing at this attachment whose document is gone from the tablet -- replaced by the send. */
	readonly vanished: string[];
}

export function sendState(links: StoredZoteroLinks, attachmentKey: string, onTablet: ReadonlySet<string>): SendState {
	const present: string[] = [];
	const vanished: string[] = [];
	for (const docId of Object.keys(links)) {
		if (linkFor(links, docId)?.attachmentKey !== attachmentKey) continue;
		(onTablet.has(docId) ? present : vanished).push(docId);
	}
	return { present, vanished };
}

/**
 * What the run's listing says about the linked documents: the ones it found are marked seen, the
 * ones it had found before and finds no more are marked gone.
 *
 * Read off the listing every sync already makes rather than by asking again, and off the *whole*
 * listing rather than the index: a document sent without a sync tag (which is every document Send
 * puts there, since 2026-09-13) never earns an index row, so the rows cannot say whether it is
 * still there. A link never seen is left alone -- the listing right after a send can lag the upload
 * (seen live 2026-09-12: uploaded 08:23:50, absent at 08:23:55), and {@link documentsOnTablet} gives
 * such a link a day. A gone link that turns up again is seen again: the user put it back.
 */
export function markListed(links: StoredZoteroLinks, documentIds: readonly string[], nowIso: string): StoredZoteroLinks {
	const listed = new Set(documentIds);
	let next = links;
	for (const docId of Object.keys(links)) {
		const link = linkFor(links, docId);
		if (link === null) continue;
		if (listed.has(docId)) {
			const { goneAt: _back, ...seen } = link;
			next = withLink(next, docId, { ...seen, seenAt: nowIso });
		} else if (link.seenAt !== undefined && link.goneAt === undefined) {
			next = withLink(next, docId, { ...link, goneAt: nowIso });
		}
	}
	return next;
}

/**
 * Which linked documents are still on the tablet -- the `onTablet` set {@link sendState} asks for.
 *
 * Judged from what the syncs' listings recorded on the links ({@link markListed}) rather than by
 * listing now, and that is a deliberate trade: listing costs a round trip on the cloud and a full
 * index-and-hash pass over SSH, minutes of work in front of a person who pressed Send. What the
 * last sync saw is the same fact, one sync old -- and a document deleted on the tablet is missed by
 * the very next listing, so the paper comes back on the next sync, not a day later.
 *
 * The second rule is what makes that safe: a link **no listing has found yet** counts as present
 * for a day after its send. Without it the listing lag of 2026-09-12 read every fresh send as
 * vanished and the tag-driven send put a second copy on the tablet per run. A day and not an hour
 * because the send and the sync can travel different roads -- a cloud send read back over SSH turns
 * up only when the tablet next pulls from the cloud, and a tablet asleep in a bag for an afternoon
 * must not earn a second copy per hour. After the day, a document no listing ever found is let go,
 * so a paper deleted before any listing caught it does come back.
 */
export function documentsOnTablet(links: StoredZoteroLinks, now: Date): Set<string> {
	const present = new Set<string>();
	for (const docId of Object.keys(links)) {
		const link = linkFor(links, docId);
		if (link === null || link.goneAt !== undefined) continue;
		if (link.seenAt !== undefined) present.add(docId);
		else if (link.sentAt !== undefined && now.getTime() - Date.parse(link.sentAt) < SENT_GRACE_MS) present.add(docId);
	}
	return present;
}

/** How long a sent document that no listing has found yet is still taken to be on the tablet. See {@link documentsOnTablet}. */
export const SENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** How the bytes were come by, for the one sentence the send reports afterwards. */
export type BytesSource = "file" | "download" | "picked";

export interface SendBytes {
	readonly bytes: Uint8Array;
	readonly source: BytesSource;
}

/** Said in the file dialog the third path opens (§2.4). */
export const PICK_THE_FILE = "Zotero has no copy of this PDF online. Pick the file.";

export interface SendDeps {
	readonly client: ZoteroClient;
	readonly transport: SendTransport;
	/** Reads a file off this machine, or `null` when it is not there any more. */
	readonly readFile: (path: string) => Promise<Uint8Array | null>;
	/** The one file dialog, opened only when neither Zotero connection can hand the PDF over. */
	readonly pickFile: () => Promise<Uint8Array | null>;
	readonly now: () => Date;
}

/**
 * The PDF itself: the file on this machine, then the download, then the user.
 *
 * In that order because of what each one costs. The local path is a read off the disk the library is
 * already on; the download is a round trip and is not always possible at all (a linked file, or a
 * library whose storage is not synced to zotero.org); the dialog costs the user's attention, so it
 * is the last resort rather than the first question.
 *
 * `null` means the user closed the dialog, which is an answer and not a failure.
 */
export async function sendBytes(deps: SendDeps, attachment: ZoteroAttachment): Promise<SendBytes | null> {
	const path = await deps.client.filePath(attachment.key);
	const onDisk = path === null ? null : await deps.readFile(path);
	if (onDisk !== null) return { bytes: onDisk, source: "file" };

	const downloaded = await deps.client.fileBytes(attachment.key);
	if (downloaded !== null) return { bytes: downloaded, source: "download" };

	const picked = await deps.pickFile();
	return picked === null ? null : { bytes: picked, source: "picked" };
}

export interface SendRequest {
	readonly attachment: ZoteroAttachment;
	readonly item: ZoteroItem | null;
	readonly folder: string;
	readonly links: StoredZoteroLinks;
	/** The links this send replaces -- `vanished` from {@link sendState}, and nothing else. */
	readonly replacing?: readonly string[];
}

export interface SendResult {
	readonly docId: string;
	readonly visibleName: string;
	readonly source: BytesSource;
	/** The map to save. The caller writes `data.json`; nothing here does. */
	readonly links: StoredZoteroLinks;
}

/**
 * Sends one attachment and records what was sent, or answers `null` when the user closed the file
 * dialog.
 *
 * The link is written **after** the upload and only then: a link is a claim that a document on the
 * tablet is this Zotero item, and an upload that failed leaves no document to claim. `sentMd5` is
 * the hash of the bytes that actually went up rather than the `md5` Zotero reports -- Zotero's is
 * null for a linked file and describes its own copy in any case, while this one describes the file
 * the reader will be annotating.
 */
export async function sendToTablet(deps: SendDeps, request: SendRequest): Promise<SendResult | null> {
	const bytes = await sendBytes(deps, request.attachment);
	if (bytes === null) return null;

	const visibleName = tabletName(request.item, request.attachment);
	const { docId } = await deps.transport.putPdf({ visibleName, bytes: bytes.bytes, folder: request.folder });

	const link: ZoteroLink = {
		attachmentKey: request.attachment.key,
		library: "user",
		sentAt: deps.now().toISOString(),
		sentMd5: md5Hex(bytes.bytes),
		annotations: {},
	};
	// The stale links go before the new one is written, so a send that replaces two vanished documents
	// leaves exactly one link behind rather than three.
	const cleaned = (request.replacing ?? []).reduce((links, docId) => withoutLink(links, docId), request.links);
	return { docId, visibleName, source: bytes.source, links: withLink(cleaned, docId, link) };
}
