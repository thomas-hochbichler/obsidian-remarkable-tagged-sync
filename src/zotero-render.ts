/**
 * The render as a Zotero attachment: when the sync uploads it (Zotero spec §4, #180).
 *
 * {@link planRender} is arithmetic over the switch, the unit and what we recorded; the pass in
 * `zotero-sync.ts` does the talking through `client.renders`. One attachment per paper, replaced in
 * place: the render's MD5 against the one we uploaded last decides whether anything is sent, so a
 * document synced under two document tags, or synced again unchanged, uploads once.
 */

import type { ZoteroLibrary } from "./zotero-client";
import type { LinkedRender } from "./zotero-links";

/** Shared with the added-page clause: Zotero hangs a note and a render alike under a paper only. */
export const NO_PARENT_ITEM = "this PDF has no parent item in Zotero";

/** The clauses after `render not added: ` (Zotero spec §4.3, §10 P6). */
export const NOT_WHOLE_DOCUMENT = "tag the whole document";
export const GROUP_LIBRARY = "group library";
export const NEEDS_WEB = "needs a zotero.org connection";
export const STORAGE_FULL = "your Zotero Storage is full";

export interface RenderInput {
	/** *Add the render to Zotero* on, in a Pro vault. */
	readonly switchedOn: boolean;
	/** MD5 of the unit's final render, `null` for a page-scoped unit: only a whole-document render goes up (04 #4). */
	readonly md5: string | null;
	/** The library the linked PDF is in. */
	readonly library: ZoteroLibrary;
	/** The paper the PDF hangs under, `null` for a standalone PDF. */
	readonly paperKey: string | null;
	/** A zotero.org connection is configured: the desktop cannot upload a file (ticket 08 #5). */
	readonly web: boolean;
	readonly recorded: LinkedRender | undefined;
}

export type RenderPlan =
	/** Nothing to do, and nothing to say beyond the link to a render already there. */
	| { readonly kind: "none" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "not-added"; readonly reason: string }
	| { readonly kind: "create"; readonly parentKey: string }
	| { readonly kind: "replace"; readonly render: LinkedRender };

export function planRender(input: RenderInput): RenderPlan {
	if (!input.switchedOn) return { kind: "none" };
	// A page note of a document whose document tag already added the render: that one is the line's.
	if (input.md5 === null) return input.recorded === undefined ? { kind: "not-added", reason: NOT_WHOLE_DOCUMENT } : { kind: "none" };
	if (input.library !== "user") return { kind: "not-added", reason: GROUP_LIBRARY };
	if (!input.web) return { kind: "not-added", reason: NEEDS_WEB };
	if (input.recorded !== undefined) return input.recorded.md5 === input.md5 ? { kind: "unchanged" } : { kind: "replace", render: input.recorded };
	if (input.paperKey === null) return { kind: "not-added", reason: NO_PARENT_ITEM };
	return { kind: "create", parentKey: input.paperKey };
}
