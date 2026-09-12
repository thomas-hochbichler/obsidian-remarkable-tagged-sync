/**
 * A tag in Zotero sends the paper to the tablet: spec §2.6.
 *
 * Send (§2.4) starts in Obsidian. The person deciding what to read next is sitting in Zotero, so
 * this is the same send started from there: at the end of a sync, every top-level item carrying
 * the send tag that is not already on the tablet goes through the pipeline of `zotero-send.ts` --
 * same folder, same name, same transport order, same link. Nothing here writes to Zotero, and the
 * tag is never taken off: items are the user's, and removing a tag would be the first write to an
 * item we only ever read.
 *
 * **No dialog, ever.** Send asks three things -- which PDF, which sync tag, pick the file -- and a
 * sync has nobody there to answer. Every one of those questions is a skip with a reason here, said
 * in the notice, and the manual command stays the place where questions get answered.
 *
 * **SSH only in a sync the user started.** The SSH route ends in a restart of the tablet's reading
 * app (see `ssh-send.ts`), which closes whatever is open. A background run that does that mid-page
 * is exactly the surprise the SSH setting's sentence promised would not happen unnoticed.
 */

import { readLocalFile } from "./desktop-files";
import type { SyncIndexRow } from "./sync-engine";
import type { ZoteroItem } from "./zotero-client";
import { SEND_COMMAND, type ZoteroHost } from "./zotero-plugin";
import {
	DEFAULT_SEND_FOLDER,
	documentsOnTablet,
	pdfChoice,
	SEND_NEEDS_A_TAG,
	SEND_NEEDS_TRANSPORT,
	sendState,
	sendToTablet,
	tabletName,
	tagChoice,
	type SendRoutes,
	type SendTransport,
} from "./zotero-send";
import { zoteroSkipReason } from "./zotero-sync";

/** Said when the vault maps several tags and has never said which one a tagged paper gets. */
export const SEND_NEEDS_A_CHOICE = "Choose the sync tag for Zotero sends under Settings → Zotero — this vault maps several.";

/** The per-item reasons, each the clause after `was not sent — `. Exported so a test can name them rather than match them. */
export const NO_PDF_IN_ZOTERO = "it has no PDF in Zotero";
export const NO_COPY_OF_PDF = "Zotero has no copy of the PDF";
export const WAITING_FOR_A_SYNC_YOU_START = "sending over SSH restarts the tablet's reading app, so it waits for a sync you start";
export const severalPdfs = (count: number): string => `it has ${count} PDFs — use ${SEND_COMMAND} to pick one`;

/** Which route a tag-driven send may take: the cloud in any run, the tablet only with a person at the keyboard. */
export type TagSendRoute = { readonly kind: "use"; readonly transport: SendTransport } | { readonly kind: "none" } | { readonly kind: "later" };

export function tagSendRoute(routes: SendRoutes, interactive: boolean): TagSendRoute {
	if (routes.cloud !== null) return { kind: "use", transport: routes.cloud };
	if (routes.ssh === null) return { kind: "none" };
	return interactive ? { kind: "use", transport: routes.ssh } : { kind: "later" };
}

/**
 * Which sync tag a tagged paper gets, with nobody to ask (§2.6).
 *
 * One mapped tag is the answer. Several are the setting's to decide, then the last manual send's;
 * a preference that has since been unmapped counts for nothing, like in {@link tagChoice}. With
 * neither the step does not guess: a document sent under the wrong tag lands in the wrong folder
 * for good, and the setting is one dropdown away.
 */
export type TagSendTag = { readonly kind: "use"; readonly tag: string } | { readonly kind: "none"; readonly reason: string };

export function tagSendTag(mapped: readonly string[], chosen: string | null, last: string | null): TagSendTag {
	const preferred = [chosen, last].find((tag): tag is string => tag !== null && mapped.includes(tag)) ?? null;
	const choice = tagChoice(mapped, preferred);
	if (choice.kind === "none") return { kind: "none", reason: SEND_NEEDS_A_TAG };
	if (choice.kind === "use") return { kind: "use", tag: choice.tag };
	return choice.preferred === null ? { kind: "none", reason: SEND_NEEDS_A_CHOICE } : { kind: "use", tag: choice.preferred };
}

/** The one sentence for what went up, or `null` when nothing did. */
export function tagSendNotice(names: readonly string[], tag: string): string | null {
	if (names.length === 0) return null;
	const quoted = names.map((name) => `"${name}"`).join(", ");
	return names.length === 1 ? `1 Zotero paper is on your reMarkable, tagged ${tag}: ${quoted}.` : `${names.length} Zotero papers are on your reMarkable, tagged ${tag}: ${quoted}.`;
}

/** One sentence per paper that stayed behind, in the shape of §3.4.2's skip notice. */
export function tagSendSkipNotice(title: string, reason: string): string {
	return `Zotero: "${title}" was not sent — ${reason}.`;
}

/** The whole step refused at once: the tag, the route, or Zotero itself. */
function stepSkipped(count: number, sendTag: string, reason: string): string {
	return `Zotero: ${count} ${count === 1 ? "paper" : "papers"} tagged ${sendTag} not sent. ${reason}`;
}

/**
 * The step, at the end of a sync. Never throws: it answers the sentences the run should say.
 *
 * After the reMarkable half and not before it, because what this decides on is the sync index, and
 * the index is only as fresh as the listing that just ran: a document the user deleted from the
 * tablet is an orphaned row *after* the run and still an active one before it. Before the run, a
 * paper deleted on purpose would come back one sync late.
 *
 * Zotero is asked first and the vault's own state only if there is something tagged -- a vault
 * with the tag on nothing gets no notice about routes or tags it has not set up. Items already on
 * the tablet are skipped in silence: idempotence comes from the link store (§2.5), not from Zotero,
 * and the tag staying on a paper that was sent last week is the normal state, not a complaint.
 */
export async function sendTaggedPapers(host: ZoteroHost, interactive: boolean): Promise<string[]> {
	const sendTag = host.data.zotero.sendTag.trim();
	if (sendTag === "") return [];
	const client = host.zoteroClient();
	if (client === null) return [];

	let items: ZoteroItem[];
	try {
		items = await client.itemsWithTag(sendTag);
	} catch (error) {
		return [`Zotero: papers tagged ${sendTag} were not sent — ${zoteroSkipReason(error)}. The next sync tries again.`];
	}
	if (items.length === 0) return [];

	const tag = tagSendTag(Object.keys(host.data.tagFolderMap), host.data.zotero.sendSyncTag, host.data.zotero.lastTag);
	if (tag.kind === "none") return [stepSkipped(items.length, sendTag, tag.reason)];
	const route = tagSendRoute(host.sendRoutes(), interactive);
	if (route.kind === "none") return [stepSkipped(items.length, sendTag, SEND_NEEDS_TRANSPORT)];

	const sent: string[] = [];
	const skipped: string[] = [];
	try {
		const attachments = await client.attachments();
		const rows: SyncIndexRow[] = Object.values(host.data.syncIndex.rows);
		const onTablet = documentsOnTablet(rows, host.data.zoteroLinks, host.now());
		const folder = host.data.zotero.folder.trim() === "" ? DEFAULT_SEND_FOLDER : host.data.zotero.folder;

		for (const item of items) {
			const title = item.title.trim() === "" ? item.key : item.title;
			const pdf = pdfChoice(attachments, item.key);
			if (pdf.kind === "none") {
				skipped.push(tagSendSkipNotice(title, NO_PDF_IN_ZOTERO));
				continue;
			}
			if (pdf.kind === "ask") {
				skipped.push(tagSendSkipNotice(title, severalPdfs(pdf.options.length)));
				continue;
			}
			// Re-read per item: every successful send below writes it.
			const links = host.data.zoteroLinks;
			const state = sendState(links, pdf.attachment.key, onTablet);
			if (state.present.length > 0) continue;
			if (route.kind === "later") {
				skipped.push(tagSendSkipNotice(title, WAITING_FOR_A_SYNC_YOU_START));
				continue;
			}

			const name = tabletName(item, pdf.attachment);
			host.report("busy", `Tagged Sync: sending "${name}" to ${route.transport.label}…`);
			try {
				const result = await sendToTablet(
					// `pickFile` answers "no" without asking: the one dialog Send may open is the one this
					// step may not (file header), so a PDF Zotero cannot hand over stays behind, named.
					{ client, transport: route.transport, readFile: readLocalFile, pickFile: async () => null, now: () => host.now() },
					{ attachment: pdf.attachment, item, folder, tag: tag.tag, links, replacing: state.vanished },
				);
				if (result === null) {
					skipped.push(tagSendSkipNotice(title, NO_COPY_OF_PDF));
					continue;
				}
				host.data.zoteroLinks = result.links;
				await host.save();
				sent.push(result.visibleName);
			} catch (error) {
				console.warn("Tagged Sync: sending a tagged Zotero paper failed", error);
				skipped.push(tagSendSkipNotice(title, error instanceof Error ? error.message : String(error)));
			}
		}
	} catch (error) {
		// The listing, or the link store: whatever it was, what went up before it stays sent and said.
		skipped.push(`Zotero: papers tagged ${sendTag} were not all sent — ${zoteroSkipReason(error)}. The next sync tries again.`);
	}

	const notice = tagSendNotice(sent, tag.tag);
	return notice === null ? skipped : [notice, ...skipped];
}
