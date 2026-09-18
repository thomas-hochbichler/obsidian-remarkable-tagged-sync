/**
 * A tag in Zotero sends the paper to the tablet: spec §2.6, the command *Send tagged Zotero papers
 * to reMarkable*.
 *
 * Send (§2.4) starts in Obsidian. The person deciding what to read next is sitting in Zotero, so
 * this is the same send started from there: every top-level item carrying the send tag that is not
 * already on the tablet goes through the pipeline of `zotero-send.ts` -- same folder, same name,
 * same transport order, same link. Nothing here writes to Zotero, and the tag is never taken off:
 * items are the user's, and removing a tag would be the first write to an item we only ever read.
 *
 * **A command, not a step of the sync** (decided 2026-09-18). *Sync now* reads the tablet and writes
 * the vault; the one thing that puts a file on the tablet is a command the user runs, so "Sync
 * never writes to your tablet" stays a sentence with no footnote. The price is one press; the
 * scheduler never sends.
 *
 * **No sync tag on the tablet**, like Send (decided 2026-09-13, after the live test: a tag the user
 * never chose turned up on the tablet with no setting to explain it). The paper is on the tablet;
 * whether and when it syncs back is the reader's to say, by tagging it there.
 *
 * **No dialog, ever.** Send asks two things -- which PDF, pick the file -- and a batch has no room
 * for either. Every one of those questions is a skip with a reason here, said in the notice, and
 * the single-paper command stays the place where questions get answered.
 */

import { readLocalFile } from "./desktop-files";
import type { ZoteroClient, ZoteroItem } from "./zotero-client";
import type { ZoteroHost } from "./zotero-plugin";
import {
	DEFAULT_SEND_FOLDER,
	documentsOnTablet,
	pdfChoice,
	SEND_COMMAND,
	SEND_NEEDS_TRANSPORT,
	sendState,
	sendToTablet,
	tabletName,
	type SendRoutes,
	type SendTransport,
} from "./zotero-send";
import { zoteroSkipReason } from "./zotero-sync";

/** The per-item reasons, each the clause after `was not sent — `. Exported so a test can name them rather than match them. */
export const NO_PDF_IN_ZOTERO = "it has no PDF in Zotero";
export const NO_COPY_OF_PDF = "Zotero has no copy of the PDF";
export const severalPdfs = (count: number): string => `it has ${count} PDFs — use ${SEND_COMMAND} to pick one`;
/** The command pressed with the setting emptied: nothing to look for, and where to name it. */
export const NO_SEND_TAG = "No send tag named. Name one under Settings → Zotero → Send tag in Zotero.";

/** Which route the papers take: the cloud when it is connected, else the tablet over SSH, else none. Same order as Send. */
export function tagSendRoute(routes: SendRoutes): SendTransport | null {
	return routes.cloud ?? routes.ssh;
}

/** The one sentence for what went up, or `null` when nothing did. It says that the document is untagged and where the tag goes -- "there" alone would read as Zotero after a command about Zotero tags. */
export function tagSendNotice(names: readonly string[]): string | null {
	if (names.length === 0) return null;
	const quoted = names.map((name) => `"${name}"`).join(", ");
	return names.length === 1
		? `Sent 1 Zotero paper to your reMarkable: ${quoted}. It has no sync tag yet — add one on the tablet when you want it back.`
		: `Sent ${names.length} Zotero papers to your reMarkable: ${quoted}. They have no sync tag yet — add one on the tablet when you want them back.`;
}

/** One sentence per paper that stayed behind, in the shape of §3.4.2's skip notice. */
export function tagSendSkipNotice(title: string, reason: string): string {
	return `Zotero: "${title}" was not sent — ${reason}.`;
}

/** Nothing tagged, or everything tagged already there: the command was pressed, so it answers. */
export function nothingToSend(count: number, sendTag: string): string {
	return count === 0
		? `Zotero: no paper carries the tag ${sendTag}.`
		: `Zotero: ${count === 1 ? "the paper" : `all ${count} papers`} tagged ${sendTag} ${count === 1 ? "is" : "are"} on your reMarkable already.`;
}

/** The whole command refused at once: the route, or Zotero itself. */
function stepSkipped(count: number, sendTag: string, reason: string): string {
	return `Zotero: ${count} ${count === 1 ? "paper" : "papers"} tagged ${sendTag} not sent. ${reason}`;
}

/**
 * The command's work. Never throws: it answers the sentences the command should say, always at
 * least one -- somebody pressed it.
 *
 * "Is it still on the tablet?" is judged on what the last sync's listing recorded on the links
 * (`markListed`): a document deleted on the tablet after the last sync counts as present until the
 * next sync lists without it. A paper deleted on purpose therefore waits one sync before the
 * command sends it again, which is the safe side of the two.
 *
 * Items already on the tablet are skipped in silence, and counted: idempotence comes from the link
 * store (§2.5), not from Zotero, and the tag staying on a paper that was sent last week is the
 * normal state, not a complaint.
 */
export async function sendTaggedPapers(host: ZoteroHost, client: ZoteroClient): Promise<string[]> {
	const sendTag = host.data.zotero.sendTag.trim();
	if (sendTag === "") return [NO_SEND_TAG];

	let items: ZoteroItem[];
	try {
		items = await client.itemsWithTag(sendTag);
	} catch (error) {
		return [`Zotero: papers tagged ${sendTag} were not sent — ${zoteroSkipReason(error)}.`];
	}
	if (items.length === 0) return [nothingToSend(0, sendTag)];

	const transport = tagSendRoute(host.sendRoutes());
	if (transport === null) return [stepSkipped(items.length, sendTag, SEND_NEEDS_TRANSPORT)];

	const sent: string[] = [];
	const skipped: string[] = [];
	let present = 0;
	try {
		const attachments = await client.attachments();
		const onTablet = documentsOnTablet(host.data.zoteroLinks, host.now());
		const folder = host.data.zotero.folder.trim() === "" ? DEFAULT_SEND_FOLDER : host.data.zotero.folder;

		for (const item of items) {
			const title = item.title.trim() === "" ? item.key : item.title;
			const pdf = pdfChoice(attachments, item);
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
			const state = sendState(links, pdf.attachment, onTablet);
			if (state.present.length > 0) {
				present += 1;
				continue;
			}

			const name = tabletName(item, pdf.attachment);
			host.report("busy", `Tagged Sync: sending "${name}" to ${transport.label}…`);
			try {
				const result = await sendToTablet(
					// `pickFile` answers "no" without asking: the one dialog Send may open is the one this
					// command may not (file header), so a PDF Zotero cannot hand over stays behind, named.
					{ client, transport, readFile: readLocalFile, pickFile: async () => null, now: () => host.now() },
					{ attachment: pdf.attachment, item, folder, links, replacing: state.vanished },
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
		skipped.push(`Zotero: papers tagged ${sendTag} were not all sent — ${zoteroSkipReason(error)}.`);
	}

	const notice = tagSendNotice(sent);
	if (notice === null && skipped.length === 0) return [nothingToSend(present, sendTag)];
	return notice === null ? skipped : [notice, ...skipped];
}
