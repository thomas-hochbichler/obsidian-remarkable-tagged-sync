/**
 * One vault send, end to end: a note or a PDF from the vault onto the tablet (send spec §1, §2, §3,
 * §8).
 *
 * Everything that touches Obsidian or the network is handed in ({@link VaultSendDeps}), so the eight
 * steps of §2 and every sentence of §8 are testable with a fake transport, a fake printer and a fake
 * dialog. The plugin's half -- the command, the menu entry, the real dialog -- is
 * `vault-send-plugin.ts`.
 *
 * **Upload first, clear second** (ADR 0001). The earlier copies are looked at before the upload,
 * because the look must not see the new document; but nothing is cleared, and nobody is asked, until
 * the new one is on the tablet and in the record. A failure anywhere therefore never leaves the user
 * without the document, and a failed look never stops a send (§11 P17).
 */

import { isEmptyNote } from "./note-document";
import { PrintFailure, RESTART_SENTENCE } from "./print-surface";
import { copiesOf, sendFor, type SentKind, type StoredVaultSends, tagNames, type VaultSend, withSend } from "./vault-sends";
import { type CopyRef, type EarlierCopyLook, safeTabletName, SEND_NEEDS_TRANSPORT, type SendTransport } from "./zotero-send";

/** The file being sent, as much of a `TFile` as a send reads. */
export interface VaultFile {
	readonly path: string;
	readonly basename: string;
	readonly extension: string;
}

/** What a dialog about the user's own earlier copies says, and its two answers (§3). */
export interface CopiesQuestion {
	readonly title: string;
	readonly body: string;
	/** The default, and what closing the dialog answers. */
	readonly keepText: string;
	readonly trashText: string;
}

/** `F` is the file type the reads take: a `TFile` in Obsidian, a plain {@link VaultFile} in a test. */
export interface VaultSendDeps<F extends VaultFile = VaultFile> {
	/** The route this send takes, or `null` when there is none (§1, `sendTransport`). */
	readonly transport: SendTransport | null;
	/** The tablet folder, already trimmed and defaulted (`vaultSend.folder`). */
	readonly folder: string;
	/** The record as it stands now -- read live, never a copy taken at the start, so a sync's own write is not undone. */
	sends(): StoredVaultSends;
	/** Sets the record and saves `data.json`. */
	saveSends(sends: StoredVaultSends): Promise<void>;
	readPdf(file: F): Promise<Uint8Array>;
	readNote(file: F): Promise<string>;
	/** The note printed on the tablet's page (`printNote`); any failure a {@link PrintFailure}. */
	printNote(file: F, markdown: string): Promise<Uint8Array>;
	/** `true` for the trash. Every other way out of the dialog keeps the copies. */
	askAboutUsersCopies(question: CopiesQuestion): Promise<boolean>;
	/** The tags mapped for sync, in the settings' order, for the tag hint (§8.1). */
	readonly mappedTags: readonly string[];
	report(state: "busy" | "ok" | "stopped", message: string): void;
	now(): Date;
}

export const SEND_THIS_FILE_COMMAND = "Send this file to reMarkable";
export const SEND_TO_REMARKABLE_MENU = "Send to reMarkable";
export const ANOTHER_SEND_RUNNING = "Another send is still running.";
const NOTHING_SENT = "Tagged Sync: nothing sent";

/** Only `.md` and `.pdf` are offered a send (§1): a note is printed, a PDF goes as it is. */
export function isSendable(file: Pick<VaultFile, "extension">): boolean {
	return file.extension === "md" || file.extension === "pdf";
}

/** How to bring the marks back, said after every send (§8.1). */
export function tagHint(tags: readonly string[]): string {
	if (tags.length === 0) return "No tag is mapped for sync yet. Map one in the settings, then tag the document or any page of it to bring your marks back as one note.";
	if (tags.length === 1) return `Tag it, or any page of it, with ${tagNames(tags)} on the tablet to bring your marks back as one note.`;
	return `Tag it, or any page of it, with one of your sync tags (${tagNames(tags)}) on the tablet to bring your marks back as one note.`;
}

/** `The earlier copy` / `The 2 earlier copies`, and the verb that goes with it. */
function copies(count: number): { the: string; is: string } {
	return count === 1 ? { the: "The earlier copy", is: "is" } : { the: `The ${count} earlier copies`, is: "are" };
}

/** What happened to the earlier copies in one send, counted for the notice. */
interface Outcome {
	swapped: number;
	kept: number;
	cleared: number;
	clearFailed: number;
	unchecked: number;
	stranger: boolean;
	/** Over SSH: the copies the record still takes to be there. */
	overSsh: number;
}

/** The additions of §8, in the table's order. */
function additions(outcome: Outcome): string {
	const parts: string[] = [];
	if (outcome.swapped > 0) {
		const { the, is } = copies(outcome.swapped);
		parts.push(`${the}, which nobody had written on, ${is} in the tablet's trash.`);
	}
	if (outcome.kept > 0) {
		const { the, is } = copies(outcome.kept);
		parts.push(`${the} with your marks ${is} still there.`);
	}
	if (outcome.cleared > 0) {
		const { the, is } = copies(outcome.cleared);
		parts.push(`${the} ${is} in the tablet's trash.`);
	}
	if (outcome.clearFailed > 0) {
		const { the, is } = copies(outcome.clearFailed);
		parts.push(`${the} could not be moved to the trash and ${is} still there.`);
	}
	if (outcome.unchecked > 0) {
		const { the, is } = copies(outcome.unchecked);
		parts.push(`${the} could not be checked and ${is} still there.`);
	}
	if (outcome.stranger) parts.push("A document of that name was already there. This one was added beside it.");
	if (outcome.overSsh > 0) {
		const { the, is } = copies(outcome.overSsh);
		parts.push(`Over SSH nothing is replaced. ${the} ${is} still there.`);
	}
	return parts.map((part) => ` ${part}`).join("");
}

/** The dialog of §3, for one or several copies of the user's. */
export function usersCopiesQuestion(name: string, count: number): CopiesQuestion {
	if (count === 1) {
		return {
			title: `"${name}" has an earlier copy with your marks`,
			body: "The new version is on your tablet. The earlier copy has your writing or a tag on it, or you moved it. Marks you have not synced yet go with it if you clear it; the tablet's trash keeps it until you empty it.",
			keepText: "Keep it",
			trashText: "Move it to the trash",
		};
	}
	return {
		title: `"${name}" has ${count} earlier copies with your marks`,
		body: "The new version is on your tablet. The earlier copies have your writing or a tag on them, or you moved them. Marks you have not synced yet go with them if you clear them; the tablet's trash keeps them until you empty it.",
		keepText: "Keep them",
		trashText: "Move them to the trash",
	};
}

/** `"Login-Spec" could not be printed, so nothing was sent: <reason>.` -- with the restart sentence where a print below Electron 40 was refused (§4.5). */
export function printFailedNotice(name: string, failure: PrintFailure): string {
	if (failure.kind === "busy") return ANOTHER_SEND_RUNNING;
	const reason = failure.reason.replace(/[\s.]+$/, "");
	return `"${name}" could not be printed, so nothing was sent: ${reason}.${failure.restartFirst ? ` ${RESTART_SENTENCE}` : ""}`;
}

/** Tries to move one copy to the trash; `false` for "still there", whatever the reason (§3, *Clearing failed*). */
async function trash(transport: SendTransport, ref: CopyRef): Promise<boolean> {
	try {
		return (await transport.moveToTrash?.(ref)) === true;
	} catch (error) {
		console.warn("Tagged Sync: moving an earlier copy to the trash failed", error);
		return false;
	}
}

let sending = false;

/**
 * Sends one file and answers the notice to show (§8). One send at a time: a second one while this
 * runs is answered {@link ANOTHER_SEND_RUNNING} and touches nothing -- not even the status line,
 * which belongs to the send that is running.
 *
 * A sync running meanwhile is no reason to wait (§1): the Zotero send does not look at it either,
 * and the record is read and written live, so neither undoes the other.
 */
export async function sendFromVault<F extends VaultFile>(deps: VaultSendDeps<F>, file: F): Promise<string> {
	if (sending) return ANOTHER_SEND_RUNNING;
	sending = true;
	try {
		return await send(deps, file);
	} finally {
		sending = false;
	}
}

async function send<F extends VaultFile>(deps: VaultSendDeps<F>, file: F): Promise<string> {
	// 1. Route.
	const transport = deps.transport;
	if (transport === null) {
		deps.report("stopped", NOTHING_SENT);
		return SEND_NEEDS_TRANSPORT;
	}
	// A file called `.md` has no name before its extension; the tablet still needs one.
	const name = safeTabletName(file.basename) || "Untitled";
	const kind: SentKind = file.extension === "pdf" ? "pdf" : "note";

	try {
		// 2. Bytes. Nothing has touched the tablet before this is done.
		let bytes: Uint8Array;
		if (kind === "pdf") {
			bytes = await deps.readPdf(file);
		} else {
			const markdown = await deps.readNote(file);
			if (isEmptyNote(markdown)) {
				deps.report("stopped", NOTHING_SENT);
				return `"${name}" is empty. There is nothing to send.`;
			}
			try {
				bytes = await deps.printNote(file, markdown);
			} catch (error) {
				deps.report("stopped", NOTHING_SENT);
				const failure = error instanceof PrintFailure ? error : new PrintFailure("failed", error instanceof Error ? error.message : String(error));
				return printFailedNotice(name, failure);
			}
		}

		// 3. Status line.
		deps.report("busy", `Tagged Sync: sending "${name}" to ${transport.label}…`);

		// 4. The look, over the cloud only. A copy the user chose to keep is never asked about again (P15),
		// so the transport -- which knows nothing of `kept` -- is never shown one.
		const before = copiesOf(deps.sends(), file.path);
		const known = before.filter((copy) => copy.send.goneAt === undefined);
		const looked = before.filter((copy) => copy.send.kept !== true);
		// `null` after a look that failed (P17): the send goes on and clears nothing.
		let look: EarlierCopyLook | null = null;
		if (transport.earlierCopies !== undefined) {
			try {
				look = await transport.earlierCopies(
					looked.map(({ docId, send }) => ({ docId, ...(send.name === undefined ? {} : { name: send.name }), ...(send.folderId === undefined ? {} : { folderId: send.folderId }) })),
					deps.folder,
					name,
				);
			} catch (error) {
				console.warn("Tagged Sync: looking at the earlier copies failed", error);
			}
		}

		// 5. Upload, into the folder the look just found where it found one -- one account listing per
		// send instead of two. A failure here leaves no document to record and no reason to clear anything.
		const found = look?.folderId === undefined ? {} : { folderId: look.folderId };
		const { docId, folderId } = await transport.putPdf({ visibleName: name, bytes, folder: deps.folder, ...found });

		// 6. Record, into the map as it is now.
		const sent: VaultSend = { origin: file.path, kind, sentAt: deps.now().toISOString(), name, folderId };
		await deps.saveSends(withSend(deps.sends(), docId, sent));

		// 7. Clear.
		const outcome: Outcome = { swapped: 0, kept: 0, cleared: 0, clearFailed: 0, unchecked: 0, stranger: false, overSsh: 0 };
		const keptBefore = known.filter((copy) => copy.send.kept === true).length;
		if (transport.earlierCopies === undefined) {
			outcome.overSsh = known.length;
		} else if (look === null) {
			outcome.kept = keptBefore;
			outcome.unchecked = known.length - keptBefore;
		} else {
			outcome.kept = keptBefore;
			outcome.stranger = look.strangerNamed;
			const users: CopyRef[] = [];
			const usersIds: string[] = [];
			for (const copy of look.copies) {
				if (copy.state === "gone") continue;
				if (copy.state === "users") {
					users.push(copy.ref);
					usersIds.push(copy.docId);
				} else if (await trash(transport, copy.ref)) outcome.swapped++;
				else outcome.clearFailed++;
			}
			if (users.length > 0) {
				if (await deps.askAboutUsersCopies(usersCopiesQuestion(name, users.length))) {
					for (const ref of users) {
						if (await trash(transport, ref)) outcome.cleared++;
						else outcome.clearFailed++;
					}
				} else {
					let sends = deps.sends();
					for (const id of usersIds) {
						const copy = sendFor(sends, id);
						if (copy !== null) sends = withSend(sends, id, { ...copy, kept: true });
					}
					await deps.saveSends(sends);
					outcome.kept += users.length;
				}
			}
		}

		// 8. Notice.
		deps.report("ok", `Tagged Sync: sent "${name}"`);
		return `Sent "${name}" to your reMarkable, into "${deps.folder}". ${tagHint(deps.mappedTags)}${additions(outcome)}`;
	} catch (error) {
		console.warn("Tagged Sync: sending a file from the vault failed", error);
		deps.report("stopped", NOTHING_SENT);
		return `Sending to your reMarkable failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}
