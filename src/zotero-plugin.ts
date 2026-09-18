/**
 * Everything the plugin does with Zotero outside the sync engine: the run's Zotero half, and the
 * three places a person reaches it (spec §2.3, §2.4, §5).
 *
 * Here rather than in `main.ts` because none of it is wiring. "Refuse before opening a dialog",
 * "ask once and remember the refusal", "a second copy is offered, never assumed" -- those are
 * decisions with a spec row each, and a decision that lives inside a `Plugin` subclass is a decision
 * no test can reach. {@link ZoteroHost} is the whole of what this needs from the plugin, and a test
 * builds one as an object literal.
 *
 * The gate is the **capability**, not the configuration (§5). A vault that has never had Pro
 * registers none of this, so the palette of the free plugin is exactly the palette it had before
 * this feature existed; a Pro vault that has not pasted an API key yet finds the commands and is
 * told what to do. A command that is there and refuses is how a plugin advertises, and the free
 * plugin is not an advertisement.
 */

import { type App, type Command, type EventRef, Menu, Notice, TFile } from "obsidian";
import { confirmDialog } from "./confirm-modal";
import { pickPdfFile, readLocalFile } from "./desktop-files";
import type { Entitlement } from "./licence-state";
import { rowForNotePath } from "./note-rename";
import { NOTE_NOT_SYNCED_NOTICE } from "./re-transcribe-prompt";
import { LONG_NOTICE_MS } from "./sync-notices";
import type { TaggedSyncData } from "./settings-store";
import { sameLibrary, type ZoteroClient, type ZoteroLibrary } from "./zotero-client";
import { askWhichAttachment, askWhichPdf, askZoteroItem } from "./zotero-link-dialog";
import { linkFor, type StoredZoteroLinks, withLink } from "./zotero-links";
import type { VaultNoteKeys } from "./zotero-note";
import {
	DEFAULT_SEND_FOLDER,
	documentsOnTablet,
	pdfChoice,
	PICK_THE_FILE,
	SEND_NEEDS_TRANSPORT,
	sendState,
	sendToTablet,
	sendTransport,
	tabletName,
	type SendRoutes,
	type SendTransport,
	SEND_COMMAND,
} from "./zotero-send";
import { askWhatToSend, NO_PDF, type SendChoice } from "./zotero-send-dialog";
import { sendTaggedPapers } from "./zotero-tag-send";
import { webConfigured, zoteroProAllowed, zoteroUnavailable } from "./zotero-settings";
import { createZoteroPass, type ZoteroPass } from "./zotero-sync";

/** The slice of the plugin this file reaches for. Narrow on purpose: a test builds it as a literal. */
export interface ZoteroHost {
	readonly app: App;
	readonly data: TaggedSyncData;
	entitlement(): Entitlement;
	/** `null` for a free vault, a lapsed licence and an unconfigured one alike -- see `zotero-settings.ts`. */
	zoteroClient(): ZoteroClient | null;
	/** Persists `data` as it stands. The caller has already changed it. */
	save(): Promise<void>;
	/** The clock the rest of the plugin runs on, so a test can pin a date. */
	now(): Date;
	/** Which routes a send may take right now -- the two transports, gated (§2.4). */
	sendRoutes(): SendRoutes;
	/** Where a long job says what it is doing. */
	report(state: "busy" | "ok" | "stopped", message: string): void;
	addCommand(command: Command): unknown;
	registerEvent(ref: EventRef): void;
}

export { SEND_COMMAND } from "./zotero-send";
export const SEND_TAGGED_COMMAND = "Send tagged Zotero papers to reMarkable";
const ITEM_GONE = "That Zotero item is no longer in your library.";
const LINKED = "Linked. The next sync writes this note's highlights into your Zotero library.";

/**
 * The Zotero half of one run, or `undefined` when this vault has none (spec §3.4, §5).
 *
 * Built per run, because the library listing it memoises is only good for one (see
 * `createZoteroPass`). The engine of a vault without Zotero simply has no Zotero half, which is the
 * whole of "refused in place": nothing downstream carries an `if` about a licence.
 */
export function zoteroPassFor(host: ZoteroHost, interactive: boolean): ZoteroPass | undefined {
	const client = host.zoteroClient();
	if (client === null) return undefined;
	return createZoteroPass({
		client,
		links: () => host.data.zoteroLinks,
		saveLinks: async (links) => {
			host.data.zoteroLinks = links;
			await host.save();
		},
		vaultNotes: () => zoteroKeyedNotes(host.app),
		// Only where the web connection is configured, which is what decides whether the note gets a
		// web-library link at all (spec §4). The id itself can come from either connection -- the
		// desktop app knows it too -- but a vault that only talks to Zotero on this machine has no
		// business printing a zotero.org URL into a note.
		webUserId: async () => {
			if (!webConfigured(host.data.zotero)) return null;
			const id = await client.libraryId();
			return id === null ? null : String(id);
		},
		// ⚠️ Not in a background run. A picker nobody is there to answer would either hang the sync or
		// have to be answered for them, and "ask once" (§2.3) means the one asking is spent for good.
		ask: interactive ? (question) => askWhichAttachment(host.app, question) : undefined,
		// Spec §5: the free half links and names the paper; only Pro writes into the library.
		mayWriteBack: zoteroProAllowed(host.entitlement()),
		now: () => host.now(),
	});
}

/** One frontmatter value, where it is a non-empty string. Obsidian types the parsed block `any`, and it is: it is the user's YAML. */
function frontmatterString(frontmatter: Record<string, unknown> | undefined, key: string): string | null {
	const value = frontmatter?.[key];
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The library a note's `zotero-library` names (ticket 26): a group id, or the personal library when
 * the key is absent. YAML reads `zotero-library: 12345` as a number and a quoted one as a string;
 * the note wrote a group id either way, so both are read.
 */
export function libraryOfNote(frontmatter: Record<string, unknown> | undefined): ZoteroLibrary {
	const raw = frontmatter?.["zotero-library"];
	const group = typeof raw === "number" ? raw : Number(typeof raw === "string" && raw !== "" ? raw : NaN);
	return Number.isInteger(group) && group > 0 ? { group } : "user";
}

/** The dialogs' `libraryName`, given only where there is more than one library to tell apart (ticket 26). */
function libraryNamer(client: ZoteroClient): { libraryName?(library: ZoteroLibrary): string } {
	return client.libraries.length > 1 ? { libraryName: (library) => client.libraryName(library) } : {};
}

/**
 * The vault's own notes about papers, for the note's `literature note:` link (spec §4).
 *
 * Read off `metadataCache`, never by opening a file, and **our own notes are filtered out here**:
 * every note this plugin writes now carries `zotero-key` too, so without this a synced note would
 * happily point at its own twin -- the same document under a second mapped tag -- and call it the
 * user's literature note. `remarkable-note-id` is the one key that is ours alone.
 */
export function zoteroKeyedNotes(app: App): VaultNoteKeys[] {
	const notes: VaultNoteKeys[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		if (frontmatter === undefined || frontmatterString(frontmatter, "remarkable-note-id") !== null) continue;
		const zoteroKey = frontmatterString(frontmatter, "zotero-key");
		const citekey = frontmatterString(frontmatter, "citekey");
		if (zoteroKey === null && citekey === null) continue;
		notes.push({ path: file.path, link: app.metadataCache.fileToLinktext(file, ""), zoteroKey, citekey });
	}
	return notes;
}

/**
 * The Zotero entry points, registered once, for every vault.
 *
 * Not gated: Send, the tag command and *Link to Zotero item…* are the free half (spec §5). A vault
 * with nothing set up is told so by the command, in {@link zoteroUnavailable}'s words.
 */
export function registerZoteroCommands(host: ZoteroHost): void {
	host.addCommand({
		id: "zotero-send",
		name: SEND_COMMAND,
		callback: () => void sendZoteroPdf(host),
	});
	host.addCommand({
		id: "zotero-send-tagged",
		name: SEND_TAGGED_COMMAND,
		callback: () => void sendTaggedZoteroPapers(host),
	});
	host.addCommand({
		id: "zotero-link",
		name: "Link to Zotero item…",
		// Visible on any Markdown file, like `re-transcribe-note` and for the same reason: deciding
		// properly means an index lookup, and this runs on every keystroke in the palette. The note
		// that is not ours earns a sentence at run time instead.
		checkCallback: (checking) => {
			const file = host.app.workspace.getActiveFile();
			if (file === null || file.extension !== "md") return false;
			if (!checking) void linkNoteToZotero(host, file);
			return true;
		},
	});
	// The context action of §2.4: on a note that already names its paper, Send has nothing left to
	// ask about *which* paper, so it is one click from the note rather than a search.
	host.registerEvent(
		host.app.workspace.on("file-menu", (menu: Menu, file) => {
			if (!(file instanceof TFile)) return;
			const frontmatter = host.app.metadataCache.getFileCache(file)?.frontmatter;
			const key = frontmatterString(frontmatter, "zotero-key");
			if (key === null) return;
			menu.addItem((item) =>
				item
					.setTitle(SEND_COMMAND)
					.setIcon("send")
					.onClick(() => void sendZoteroPdf(host, { key, library: libraryOfNote(frontmatter) })),
			);
		}),
	);
}

/** The client, or the sentence saying why there is none. Every Zotero command starts here. */
function clientOrNotice(host: ZoteroHost): ZoteroClient | null {
	const client = host.zoteroClient();
	if (client === null) new Notice(zoteroUnavailable(host.data.zotero), LONG_NOTICE_MS);
	return client;
}

/**
 * *Send tagged Zotero papers to reMarkable* (spec §2.6): every paper carrying the send tag that is
 * not on the tablet yet, in one press, no questions. The sentences are `zotero-tag-send.ts`'s; this
 * only shows them, and closes the status line the sends opened.
 */
export async function sendTaggedZoteroPapers(host: ZoteroHost): Promise<void> {
	const client = clientOrNotice(host);
	if (client === null) return;
	const notices = await sendTaggedPapers(host, client);
	host.report("ok", `Tagged Sync: ${notices[0]}`);
	for (const notice of notices) new Notice(notice, LONG_NOTICE_MS);
}

/**
 * *Send Zotero PDF to reMarkable…* (spec §2.4, §2.5), from the palette or from a note.
 *
 * Everything it refuses, it refuses **before** opening anything: no route to a tablet. A dialog that
 * asks a reader to find their paper and then says it cannot deliver it has wasted the one thing this
 * command exists to save.
 *
 * The document goes up **without a sync tag** (decided 2026-09-13; see `SendDocument`). The reader
 * tags it on the tablet when they want it back, and the notice says so.
 */
export async function sendZoteroPdf(host: ZoteroHost, item?: { key: string; library: ZoteroLibrary }): Promise<void> {
	const client = clientOrNotice(host);
	if (client === null) return;
	const transport = sendTransport(host.sendRoutes());
	if (transport === null) {
		new Notice(SEND_NEEDS_TRANSPORT, LONG_NOTICE_MS);
		return;
	}

	try {
		const deps = { search: (query: string) => client.search(query), attachments: () => client.attachments(), ...libraryNamer(client) };
		const choice = item === undefined ? await askWhatToSend(host.app, deps) : await askWhichOfItem(host, client, item.key, item.library);
		if (choice === null) return;
		await putOnTablet(host, client, transport, choice);
	} catch (error) {
		console.warn("Tagged Sync: sending a Zotero PDF failed", error);
		new Notice(`Sending to your reMarkable failed: ${error instanceof Error ? error.message : String(error)}`, LONG_NOTICE_MS);
	}
}

/**
 * The context action's half of the question: this paper's PDF, where it has several. Usually no
 * dialog at all -- a window showing somebody a single answer they cannot change is not a question.
 */
async function askWhichOfItem(host: ZoteroHost, client: ZoteroClient, itemKey: string, library: ZoteroLibrary): Promise<SendChoice | null> {
	const item = await client.parentItem(itemKey, library);
	if (item === null) {
		new Notice(ITEM_GONE, LONG_NOTICE_MS);
		return null;
	}
	const pdf = pdfChoice(await client.attachments(), item);
	if (pdf.kind === "none") {
		new Notice(NO_PDF, LONG_NOTICE_MS);
		return null;
	}
	const attachment = pdf.kind === "use" ? pdf.attachment : await askWhichPdf(host.app, item, pdf.options);
	return attachment === null ? null : { item, attachment };
}

/**
 * The upload itself, and the one question §2.5 asks: this is already on your tablet -- again?
 *
 * Asked rather than refused, and asked rather than assumed. A second copy is a perfectly ordinary
 * thing to want -- the first has been read and filed away -- and it becomes a second document with
 * its own mapping, because nothing already on the tablet is ever touched (§1.2).
 */
async function putOnTablet(host: ZoteroHost, client: ZoteroClient, transport: SendTransport, choice: SendChoice): Promise<void> {
	const folder = host.data.zotero.folder.trim() === "" ? DEFAULT_SEND_FOLDER : host.data.zotero.folder;
	const links: StoredZoteroLinks = host.data.zoteroLinks;
	const state = sendState(links, choice.attachment, documentsOnTablet(links, host.now()));
	const name = tabletName(choice.item, choice.attachment);
	if (state.present.length > 0) {
		const again = await confirmDialog(
			host.app,
			"Already on your tablet",
			`"${name}" is already on your reMarkable, in ${folder}. Sending it again adds a second copy — nothing already there is changed.`,
			"Send another copy",
		);
		if (!again) return;
	}

	host.report("busy", `Tagged Sync: sending "${name}" to ${transport.label}…`);
	const result = await sendToTablet(
		{
			client,
			transport,
			readFile: readLocalFile,
			pickFile: () => {
				new Notice(PICK_THE_FILE, LONG_NOTICE_MS);
				return pickPdfFile();
			},
			now: () => host.now(),
		},
		{ attachment: choice.attachment, item: choice.item, folder, links, replacing: state.vanished },
	);
	// The user closed the file dialog, which is an answer and not a failure (§2.4).
	if (result === null) {
		host.report("stopped", "Tagged Sync: nothing sent");
		return;
	}
	host.data.zoteroLinks = result.links;
	await host.save();
	host.report("ok", `Tagged Sync: sent "${result.visibleName}"`);
	new Notice(`Sent "${result.visibleName}" to your reMarkable. It has no sync tag yet — add one on the tablet, annotate, then sync.`, LONG_NOTICE_MS);
}

/**
 * *Link to Zotero item…* (spec §2.3, last row): the user's answer where the plugin had none.
 *
 * It replaces whatever was there, a refusal remembered earlier included -- that is what the command
 * is for. The annotation map survives only a re-link to the *same* attachment: pointed at a
 * different file, those keys describe somebody else's pages.
 */
export async function linkNoteToZotero(host: ZoteroHost, file: TFile): Promise<void> {
	const client = clientOrNotice(host);
	if (client === null) return;
	const row = rowForNotePath(host.data.syncIndex.rows, file.path);
	if (row === undefined) {
		new Notice(NOTE_NOT_SYNCED_NOTICE);
		return;
	}
	const attachment = await askZoteroItem(host.app, { search: (query) => client.search(query), attachments: () => client.attachments(), ...libraryNamer(client) });
	if (attachment === null) return;

	const existing = linkFor(host.data.zoteroLinks, row.docId);
	const same = existing !== null && existing.attachmentKey === attachment.key && sameLibrary(existing.library, attachment.library);
	host.data.zoteroLinks = withLink(host.data.zoteroLinks, row.docId, {
		attachmentKey: attachment.key,
		library: attachment.library,
		annotations: same ? existing.annotations : {},
	});
	await host.save();
	new Notice(LINKED, LONG_NOTICE_MS);
}
