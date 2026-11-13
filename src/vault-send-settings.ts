/**
 * The *Send from the vault* group's settings (send spec §7), and the guess for *Tablet*.
 *
 * *Tablet* is the one setting with a default nobody can know: a note is printed on a page the size of
 * the tablet's screen, and the plugin is never told which tablet that is. Until the user picks, it is
 * read off the synced pages -- a page's scene names the screen it was written on (`declaredCanvas`) --
 * and **the newest document that declared one wins** (§11 P6): someone who moved from a reMarkable 2
 * to a Paper Pro has old pages of the one and new pages of the other, and the newest is the device in
 * use. Not the last page a sync rendered: a sync walks documents in listing order, so two tablets on
 * one account would flip the guess back and forth by order alone.
 */

import type { SendTablet, SendTextSize } from "./note-print";
import { declaredCanvas, PAPER_PRO, RM_1_2 } from "./pdf-renderer";
import type { RmPage } from "./rm-parser";

/** Where a vault send lands on the tablet: a top-level folder, looked up by name (05 #3). */
export const DEFAULT_VAULT_SEND_FOLDER = "Obsidian";

export interface VaultSendSettings {
	/** The tablet folder: looked up by name, created when missing, never renamed. May equal Zotero's. */
	folder: string;
	/** The user's pick, or `"auto"` until they make one -- then the guess counts ({@link tabletFor}). */
	tablet: SendTablet | "auto";
	textSize: SendTextSize;
	/** The tablet is in left-handed mode, so the wide margin goes to the right. */
	toolbarRight: boolean;
	/** The screen the newest synced document declared, or `null` before one has. */
	tabletSeen: SendTablet | null;
	/** That document's `lastModified`, as an ISO time; set together with `tabletSeen`. */
	tabletSeenAt: string | null;
}

export const DEFAULT_VAULT_SEND_SETTINGS: VaultSendSettings = {
	folder: DEFAULT_VAULT_SEND_FOLDER,
	tablet: "auto",
	textSize: "normal",
	toolbarRight: false,
	tabletSeen: null,
	tabletSeenAt: null,
};

const isTablet = (value: unknown): value is SendTablet => value === "rm12" || value === "paperPro";

/**
 * Reads the stored group field by field. Every value a dropdown shows is checked against what it
 * offers, because the declarative tab hands a stored value straight to the control: a hand-edited
 * `"rm2"` would be a dropdown showing nothing. What does not read is the default.
 */
export function migrateVaultSend(stored: unknown): VaultSendSettings {
	const saved = (typeof stored === "object" && stored !== null ? stored : {}) as Partial<Record<keyof VaultSendSettings, unknown>>;
	// The pair or neither: a screen without its time could never be replaced by a newer one, and a
	// time without a screen guesses nothing.
	const seenAt = typeof saved.tabletSeenAt === "string" && Number.isFinite(Date.parse(saved.tabletSeenAt)) ? saved.tabletSeenAt : null;
	const seen = isTablet(saved.tabletSeen) && seenAt !== null;
	return {
		folder: typeof saved.folder === "string" && saved.folder.trim() !== "" ? saved.folder.trim() : DEFAULT_VAULT_SEND_FOLDER,
		tablet: isTablet(saved.tablet) ? saved.tablet : "auto",
		textSize: saved.textSize === "large" ? "large" : "normal",
		toolbarRight: saved.toolbarRight === true,
		tabletSeen: seen ? (saved.tabletSeen as SendTablet) : null,
		tabletSeenAt: seen ? seenAt : null,
	};
}

/**
 * The tablet a note is printed for: the pick, else the screen last seen, else the reMarkable 1/2 page.
 * A Paper Pro Move declares no screen `declaredCanvas` knows, so it stays at 1/2 -- the entry 06 #1
 * advises for it.
 */
export function tabletFor(settings: VaultSendSettings): SendTablet {
	if (settings.tablet !== "auto") return settings.tablet;
	return settings.tabletSeen ?? "rm12";
}

/** A screen a synced document declared, and when that document last changed. */
export interface ScreenSeen {
	tablet: SendTablet;
	/** The document's `lastModified`, as an ISO time. */
	at: string;
}

/**
 * The screen one rendered document declares, or `null` when its pages say nothing (pre-`scene_info`
 * firmware, a PDF-backed page's annotations without the block, a Move) or its time cannot be read --
 * a declaration that cannot be placed in time could not be told from an older one.
 *
 * `lastModified` is the device's own field: milliseconds as a string from both routes, ISO from some
 * older listings (`deviceModified` reads it the same way).
 */
export function screenDeclaredBy(scenes: readonly (RmPage | null)[], lastModified: string | undefined): ScreenSeen | null {
	const canvas = declaredCanvas(scenes.filter((scene): scene is RmPage => scene !== null));
	const tablet: SendTablet | null = canvas === PAPER_PRO ? "paperPro" : canvas === RM_1_2 ? "rm12" : null;
	if (tablet === null || lastModified === undefined) return null;
	const ms = /^\d+$/.test(lastModified) ? Number(lastModified) : Date.parse(lastModified);
	return Number.isFinite(ms) ? { tablet, at: new Date(ms).toISOString() } : null;
}

/** The newer of two declarations; on a tie the one already held stays, so nothing flips by order. */
export function newerScreen(held: ScreenSeen | null, next: ScreenSeen | null): ScreenSeen | null {
	if (next === null) return held;
	if (held === null) return next;
	return Date.parse(next.at) > Date.parse(held.at) ? next : held;
}

/**
 * The group after a sync declared `seen`: replaced only by a newer declaration, and the same object
 * when nothing changes. Kept after a pick too: the pick decides what a send uses, the record only
 * what was seen.
 */
export function noteScreenSeen(settings: VaultSendSettings, seen: ScreenSeen | null): VaultSendSettings {
	const held = settings.tabletSeen === null || settings.tabletSeenAt === null ? null : { tablet: settings.tabletSeen, at: settings.tabletSeenAt };
	const newest = newerScreen(held, seen);
	if (newest === null || newest === held) return settings;
	return { ...settings, tabletSeen: newest.tablet, tabletSeenAt: newest.at };
}
