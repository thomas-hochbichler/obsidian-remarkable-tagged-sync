import { describe, expect, it } from "vitest";
import type { RmPage } from "./rm-parser";
import {
	DEFAULT_VAULT_SEND_SETTINGS,
	migrateVaultSend,
	newerScreen,
	noteScreenSeen,
	screenDeclaredBy,
	tabletFor,
	type VaultSendSettings,
} from "./vault-send-settings";

const page = (paperSize?: RmPage["paperSize"]): RmPage => ({ formatVersion: 6, layers: [], paperSize });
const RM2_PAGE = page({ width: 1404, height: 1872 });
const PRO_PAGE = page({ width: 1620, height: 2160 });
/** A Paper Pro Move's screen: none `declaredCanvas` knows. */
const MOVE_PAGE = page({ width: 954, height: 1696 });

const settings = (overrides: Partial<VaultSendSettings> = {}): VaultSendSettings => ({ ...DEFAULT_VAULT_SEND_SETTINGS, ...overrides });

describe("the tablet a note is printed for", () => {
	it("is the user's pick, whatever the synced pages said", () => {
		expect(tabletFor(settings({ tablet: "rm12", tabletSeen: "paperPro", tabletSeenAt: "2026-11-01T00:00:00.000Z" }))).toBe("rm12");
		expect(tabletFor(settings({ tablet: "paperPro" }))).toBe("paperPro");
	});

	it("is the screen last seen until the user picks", () => {
		expect(tabletFor(settings({ tabletSeen: "paperPro", tabletSeenAt: "2026-11-01T00:00:00.000Z" }))).toBe("paperPro");
	});

	it("is the reMarkable 1, 2 or Paper Pure page while nothing has been seen", () => {
		expect(tabletFor(settings())).toBe("rm12");
	});
});

describe("the screen a synced document declares", () => {
	it("names the tablet its pages were written on, at the document's last change", () => {
		expect(screenDeclaredBy([PRO_PAGE], "1762992000000")).toEqual({ tablet: "paperPro", at: "2025-11-13T00:00:00.000Z" });
		expect(screenDeclaredBy([page(), RM2_PAGE], "2026-11-13T08:00:00.000Z")).toEqual({ tablet: "rm12", at: "2026-11-13T08:00:00.000Z" });
	});

	it("is nothing for pages that declare no screen, or one no known tablet has", () => {
		expect(screenDeclaredBy([page(), null], "1000")).toBeNull();
		expect(screenDeclaredBy([MOVE_PAGE], "1000")).toBeNull();
	});

	// A declaration that cannot be placed in time could not be told from an older one.
	it("is nothing when the document's time cannot be read", () => {
		expect(screenDeclaredBy([PRO_PAGE], undefined)).toBeNull();
		expect(screenDeclaredBy([PRO_PAGE], "yesterday")).toBeNull();
	});
});

describe("remembering the screen seen", () => {
	const older = { tablet: "rm12" as const, at: "2026-10-01T00:00:00.000Z" };
	const newer = { tablet: "paperPro" as const, at: "2026-11-01T00:00:00.000Z" };

	it("takes the first declaration", () => {
		expect(noteScreenSeen(settings(), newer)).toEqual(settings({ tabletSeen: "paperPro", tabletSeenAt: newer.at }));
	});

	it("replaces it with a newer document's", () => {
		const seenOld = settings({ tabletSeen: "rm12", tabletSeenAt: older.at });
		expect(noteScreenSeen(seenOld, newer)).toEqual(settings({ tabletSeen: "paperPro", tabletSeenAt: newer.at }));
	});

	// Two tablets on one account: listing order must not flip the guess.
	it("never lets an older document's declaration replace a newer one's", () => {
		const seenNew = settings({ tabletSeen: "paperPro", tabletSeenAt: newer.at });
		expect(noteScreenSeen(seenNew, older)).toBe(seenNew);
		expect(newerScreen(newer, older)).toBe(newer);
		expect(newerScreen(older, newer)).toBe(newer);
	});

	it("keeps the one held on a tie, and changes nothing when nothing was declared", () => {
		const held = { tablet: "rm12" as const, at: newer.at };
		expect(newerScreen(held, newer)).toBe(held);
		const seen = settings({ tabletSeen: "rm12", tabletSeenAt: older.at });
		expect(noteScreenSeen(seen, null)).toBe(seen);
	});
});

describe("reading the stored group", () => {
	it("gives a data.json without the group the defaults: folder Obsidian, tablet not chosen, Normal, toolbar left", () => {
		expect(migrateVaultSend(undefined)).toEqual({
			folder: "Obsidian",
			tablet: "auto",
			textSize: "normal",
			toolbarRight: false,
			tabletSeen: null,
			tabletSeenAt: null,
		});
	});

	it("keeps every value the group can hold", () => {
		const stored = { folder: "Inbox", tablet: "paperPro", textSize: "large", toolbarRight: true, tabletSeen: "rm12", tabletSeenAt: "2026-11-01T00:00:00.000Z" };
		expect(migrateVaultSend(stored)).toEqual(stored);
		expect(migrateVaultSend(migrateVaultSend(stored))).toEqual(stored);
	});

	// The declarative dropdown is handed the stored value as it is: one it does not offer shows nothing.
	it("reads a value no control offers, or no folder name, as the default", () => {
		expect(migrateVaultSend({ folder: "  ", tablet: "rm2", textSize: "huge", toolbarRight: "yes" })).toEqual(DEFAULT_VAULT_SEND_SETTINGS);
		expect(migrateVaultSend("nonsense")).toEqual(DEFAULT_VAULT_SEND_SETTINGS);
	});

	it("keeps the screen seen only together with its time", () => {
		expect(migrateVaultSend({ tabletSeen: "paperPro" })).toEqual(DEFAULT_VAULT_SEND_SETTINGS);
		expect(migrateVaultSend({ tabletSeen: "paperPro", tabletSeenAt: "not a time" })).toEqual(DEFAULT_VAULT_SEND_SETTINGS);
		expect(migrateVaultSend({ tabletSeenAt: "2026-11-01T00:00:00.000Z" })).toEqual(DEFAULT_VAULT_SEND_SETTINGS);
	});
});
