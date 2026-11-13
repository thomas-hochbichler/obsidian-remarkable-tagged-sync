/**
 * Where a person reaches a vault send (send spec §1): the palette command and the file menu's entry,
 * and the Obsidian half of what `vault-send.ts` is handed.
 *
 * Free and registered for every vault, like the Zotero send: over the cloud nothing about it is Pro,
 * and the SSH route is gated where it is today (`allowedTransports`, through `sendRoutes`).
 */

import { type Menu, Notice, TFile } from "obsidian";
import { confirmDialog } from "./confirm-modal";
import { obsidianRenderHost, printNote } from "./note-document";
import { LONG_NOTICE_MS } from "./sync-notices";
import { tabletFor } from "./vault-send-settings";
import { isSendable, SEND_THIS_FILE_COMMAND, SEND_TO_REMARKABLE_MENU, sendFromVault, type VaultSendDeps } from "./vault-send";
import type { ZoteroHost } from "./zotero-plugin";
import { sendTransport } from "./zotero-send";

/** The slice of the plugin a vault send reaches for: the Zotero host's, less Zotero. */
export type VaultSendHost = Pick<ZoteroHost, "app" | "data" | "save" | "now" | "sendRoutes" | "report" | "addCommand" | "registerEvent">;

/**
 * The palette command and the file-menu entry, on a single note or PDF and nothing else (§1): no
 * ribbon icon, no editor menu, no multi-selection, no folder.
 */
export function registerVaultSendCommands(host: VaultSendHost): void {
	host.addCommand({
		id: "vault-send",
		name: SEND_THIS_FILE_COMMAND,
		checkCallback: (checking) => {
			const file = host.app.workspace.getActiveFile();
			if (file === null || !isSendable(file)) return false;
			if (!checking) void sendVaultFile(host, file);
			return true;
		},
	});
	// The explorer, a tab's menu and its more-options all fire `file-menu`; a folder arrives here too.
	host.registerEvent(
		host.app.workspace.on("file-menu", (menu: Menu, file) => {
			if (!(file instanceof TFile) || !isSendable(file)) return;
			menu.addItem((item) =>
				item
					.setTitle(SEND_TO_REMARKABLE_MENU)
					.setIcon("send")
					.onClick(() => void sendVaultFile(host, file)),
			);
		}),
	);
}

/** What `sendFromVault` is handed in Obsidian. Read when the send starts, so the settings of that moment count. */
export function vaultSendDeps(host: VaultSendHost): VaultSendDeps<TFile> {
	const settings = host.data.vaultSend;
	const choice = { tablet: tabletFor(settings), textSize: settings.textSize, toolbarRight: settings.toolbarRight };
	return {
		transport: sendTransport(host.sendRoutes()),
		folder: settings.folder,
		sends: () => host.data.vaultSends,
		saveSends: async (sends) => {
			host.data.vaultSends = sends;
			await host.save();
		},
		readPdf: async (file) => new Uint8Array(await host.app.vault.readBinary(file)),
		readNote: (file) => host.app.vault.cachedRead(file),
		printNote: (file, markdown) => printNote(file, markdown, choice, obsidianRenderHost(host.app)),
		// The trash is the confirming button, drawn as destructive; *Keep it* is the other one, and what
		// Escape answers (§3): the safe answer is never the highlighted one.
		askAboutUsersCopies: (question) => confirmDialog(host.app, question.title, question.body, question.trashText, { cancelText: question.keepText, destructive: true }),
		mappedTags: Object.keys(host.data.tagFolderMap),
		report: (state, message) => host.report(state, message),
		now: () => host.now(),
	};
}

/** One send of `file`, its notice shown when it is done. */
export async function sendVaultFile(host: VaultSendHost, file: TFile): Promise<void> {
	new Notice(await sendFromVault(vaultSendDeps(host), file), LONG_NOTICE_MS);
}
