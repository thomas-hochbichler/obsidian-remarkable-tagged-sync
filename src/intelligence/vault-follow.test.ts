import { describe, expect, it } from "vitest";
import type { SyncIndex, SyncIndexRow } from "../sync-engine";
import { emptyIntelligence, type IntelligenceSettings } from "./settings";
import type { IntelligenceRow } from "./sync-pass";
import { followVaultRename } from "./vault-follow";

const transcriptRow = { syncKey: "d:work", docId: "d", pageId: null, tag: "work", entryHash: "h", pageHash: null, notePath: "Work/Log.md", status: "active", syncedAt: "" } as SyncIndexRow;
const pageRow = { syncKey: "d:p:work", notePath: "Work/Log/2026-09-28 Log p1.md", noteId: "n" } as IntelligenceRow;
const settings: IntelligenceSettings = {
	...emptyIntelligence(),
	profiles: [
		{ id: "a", name: "A", description: "", template: "Templates/Meeting.md", slots: [] },
		{ id: "b", name: "B", description: "", template: null, slots: [] },
	],
};
const index: SyncIndex = { rootHash: null, rows: { "d:work": transcriptRow }, intelligenceRows: { "d:p:work": pageRow } };

describe("followVaultRename", () => {
	it("follows a moved page note and leaves the rest as it was", () => {
		const out = followVaultRename({ syncIndex: index, intelligence: settings }, { kind: "file", from: pageRow.notePath, to: "Archive/p1.md" })!;
		expect(out.syncIndex.intelligenceRows!["d:p:work"].notePath).toBe("Archive/p1.md");
		expect(out.syncIndex.rows).toBe(index.rows);
		expect(out.intelligence).toBe(settings);
	});

	it("follows a renamed folder for transcript notes and page notes at once", () => {
		const out = followVaultRename({ syncIndex: index, intelligence: settings }, { kind: "folder", from: "Work", to: "Job" })!;
		expect(out.syncIndex.rows["d:work"].notePath).toBe("Job/Log.md");
		expect(out.syncIndex.intelligenceRows!["d:p:work"].notePath).toBe("Job/Log/2026-09-28 Log p1.md");
	});

	it("follows a renamed template, and keeps an index written before page notes existed as it was", () => {
		const legacy: SyncIndex = { rootHash: null, rows: {} };
		const out = followVaultRename({ syncIndex: legacy, intelligence: settings }, { kind: "file", from: "Templates/Meeting.md", to: "Templates/Meetings.md" })!;
		expect(out.intelligence.profiles.map((p) => p.template)).toEqual(["Templates/Meetings.md", null]);
		expect(out.syncIndex).toEqual(legacy);
	});

	it("is null when the rename touched nothing the plugin keeps", () => {
		expect(followVaultRename({ syncIndex: index, intelligence: settings }, { kind: "file", from: "Other.md", to: "Else.md" })).toBeNull();
	});
});
