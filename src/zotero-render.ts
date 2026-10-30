/**
 * The render as a Zotero attachment: when the sync uploads it (Zotero spec §4, #180).
 *
 * {@link planRender} is arithmetic over the switch, the unit and what we recorded; the pass in
 * `zotero-sync.ts` does the talking through `client.renders`. One attachment per paper, replaced in
 * place: the render's MD5 against the one we uploaded last decides whether anything is sent, so a
 * document synced under two document tags, or synced again unchanged, uploads once.
 *
 * Before anything is replaced, {@link judgeRender} reads what the user did to the attachment in
 * Zotero. The file is theirs from the moment they change it, annotate it, move it or trash it, and
 * Tagged Sync never touches it again -- nor trashes it, ever (§4.3).
 */

import type { RenderState, ZoteroLibrary } from "./zotero-client";
import type { LinkedRender, RenderTheirs } from "./zotero-links";

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
	/**
	 * The vault note was deleted by hand: the user's "start over". A render they made theirs is read
	 * once more, and one no longer under the paper (trashed, moved) is added anew (04 #5, §4.3).
	 */
	readonly noteWasDeleted?: boolean;
}

export type RenderPlan =
	/** Nothing to do, and nothing to say beyond what the record already says. */
	| { readonly kind: "none" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "not-added"; readonly reason: string }
	/** No record: look under the paper for one of ours first (spec §4.2), and create one only if there is none. */
	| { readonly kind: "find"; readonly parentKey: string }
	/** The render changed, or the user deleted the vault note after making it theirs: read the attachment, then {@link judgeRender}. */
	| { readonly kind: "check"; readonly render: LinkedRender };

export function planRender(input: RenderInput): RenderPlan {
	if (!input.switchedOn) return { kind: "none" };
	const { recorded } = input;
	// A page note of a document whose document tag already added the render: that one is the line's.
	if (input.md5 === null) return recorded === undefined ? { kind: "not-added", reason: NOT_WHOLE_DOCUMENT } : { kind: "none" };
	// Theirs stays theirs -- until the vault note is deleted, when what they did is read once more.
	if (recorded?.theirs !== undefined && input.noteWasDeleted !== true) return { kind: "none" };
	if (input.library !== "user") return { kind: "not-added", reason: GROUP_LIBRARY };
	if (!input.web) return { kind: "not-added", reason: NEEDS_WEB };
	if (recorded !== undefined) return recorded.theirs === undefined && recorded.md5 === input.md5 ? { kind: "unchanged" } : { kind: "check", render: recorded };
	if (input.paperKey === null) return { kind: "not-added", reason: NO_PARENT_ITEM };
	return { kind: "find", parentKey: input.paperKey };
}

export type RenderJudgement =
	| { readonly kind: "theirs"; readonly theirs: RenderTheirs }
	/** Zotero already holds this render: record it, send nothing. */
	| { readonly kind: "unchanged" }
	/** Replace the file Zotero holds, keeping the filename it has: an upload sets the item's filename (ticket 16 live check). */
	| { readonly kind: "upload"; readonly holds: string | null; readonly filename: string | null };

/**
 * What to do with an attachment of ours whose render changed (Zotero spec §4.3), from its state now.
 * `render` is the record, or a re-found attachment with no MD5 of ours: then the file in it is
 * replaced once, the accepted loss of spec §4.2.
 */
export function judgeRender(md5: string, render: LinkedRender, state: RenderState | null): RenderJudgement {
	if (state === null || state.trashed) return { kind: "theirs", theirs: "trashed" };
	if (state.parentKey !== render.parentKey) return { kind: "theirs", theirs: "moved" };
	if (state.annotated) return { kind: "theirs", theirs: "annotated" };
	if (state.md5 === md5) return { kind: "unchanged" };
	// Neither this render nor the last one we uploaded: pages rotated or deleted in Zotero's reader.
	// Two devices syncing the same tablet state agree on both, so neither takes the other's for the user's.
	if (render.md5 !== undefined && state.md5 !== render.md5) return { kind: "theirs", theirs: "changed" };
	return { kind: "upload", holds: state.md5, filename: state.filename };
}
