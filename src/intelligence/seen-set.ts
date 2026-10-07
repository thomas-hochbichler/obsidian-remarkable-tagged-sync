/**
 * The seen-set: which pages the Intelligence Engine has already decided about. It exists so that
 * switching Intelligence Mode on processes only pages written from then on -- a 200-page notebook
 * from last year tagged today must not turn into 200 extraction calls in one sync.
 */

/** One unit (`syncKey`) the engine has decided about, note or not. */
export interface SeenEntry {
	/** Whether the tag sat on the notebook or on the page; a `syncKey` alone cannot tell. */
	scope: "notebook" | "page";
	/** The page's `.rm` hash when decided; null for a page that had no `.rm` yet. */
	pageHash: string | null;
	/** The page's `modifed` the first time the engine saw it, frozen; null when absent. */
	firstSeen: number | null;
	/** Names the base file; minted at the first extraction attempt. */
	noteId?: string;
}

export type UnitClass = "new" | "changed" | "unchanged" | "old";

/**
 * A page's `cPages.pages[].modifed` as epoch ms. The device writes it as a string, stamps it on an
 * edit (never on creation), and leaves it out on a page not edited since it started stamping. The
 * rmapi-js `Content` type does not declare it, hence `unknown`.
 */
export function pageModified(page: unknown): number | null {
	if (page === null || typeof page !== "object") return null;
	const raw = (page as { modifed?: unknown }).modifed;
	if (typeof raw !== "string" && typeof raw !== "number") return null;
	if (raw === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

/**
 * The two questions, in this order. Seen → changed when the hash differs. Not seen → new only when
 * edited after `enabledAt`; absent `modifed` and legacy `pages[]` documents mean old.
 */
export function classifyUnit(input: {
	seen: SeenEntry | undefined;
	pageHash: string | null;
	modified: number | null;
	enabledAt: number;
	legacy: boolean;
}): UnitClass {
	const { seen, pageHash, modified, enabledAt, legacy } = input;
	if (seen) return seen.pageHash === pageHash ? "unchanged" : "changed";
	if (legacy || modified === null) return "old";
	return modified > enabledAt ? "new" : "old";
}

/**
 * Whether the switch-on scan writes a page into the seen-set with its current hash. A page edited
 * after the toggle is left to `classifyUnit` in the same run.
 */
export function switchOnStamp(modified: number | null, enabledAt: number): boolean {
	return modified === null || modified <= enabledAt;
}
