import { describe, expect, it } from "vitest";
import {
	ALREADY_RUNNING_NOTICE,
	NOT_CONNECTED_NOTICE,
	preflightRun,
	reTranscribableUnits,
	type RunConditions,
} from "./sync-guards";

// Imports neither `obsidian` nor the plugin: these are the decisions, and they are decidable without
// a vault. `sync-preflight.test.ts` is the other half -- that the shipped commands ask this, and act
// on the answer.

const READY: RunConditions = { connected: true, running: false, backendRequiresLicence: false };

describe("preflightRun", () => {
	it("lets a run start when nothing is in the way", () => {
		expect(preflightRun(READY)).toEqual({ start: true, refreshLicence: false });
	});

	it("refuses a run with no device token, naming the connection", () => {
		expect(preflightRun({ ...READY, connected: false })).toEqual({
			start: false,
			notice: NOT_CONNECTED_NOTICE,
		});
	});

	it("refuses a run while another one holds the lock", () => {
		expect(preflightRun({ ...READY, running: true })).toEqual({
			start: false,
			notice: ALREADY_RUNNING_NOTICE,
		});
	});

	it("names the connection first when both are wrong", () => {
		// The order is the decision. "A sync is already running" would send someone who has just been
		// unpaired looking for a run they cannot see, while the thing stopping them is the token.
		expect(preflightRun({ connected: false, running: true, backendRequiresLicence: true })).toEqual({
			start: false,
			notice: NOT_CONNECTED_NOTICE,
		});
	});

	it("asks for a licence re-read on a backend that needs one", () => {
		expect(preflightRun({ ...READY, backendRequiresLicence: true })).toEqual({
			start: true,
			refreshLicence: true,
		});
	});

	it("asks for no licence re-read on a backend that needs none", () => {
		// The promise a free user is owed: their sync causes no call to Polar at all.
		expect(preflightRun({ ...READY, backendRequiresLicence: false })).toEqual({
			start: true,
			refreshLicence: false,
		});
	});

	it("never turns a licence into a refusal", () => {
		// A lapsed licence falls back to a free backend inside `resolveOcrBackend`, with a message.
		// Refusing the run instead would strand a buyer whose card expired mid-notebook.
		for (const backendRequiresLicence of [true, false]) {
			expect(preflightRun({ ...READY, backendRequiresLicence }).start).toBe(true);
		}
	});

	it("refuses on the state it was handed and nothing else", () => {
		// Two calls with the same conditions answer the same thing -- it holds no state of its own, so
		// the lock it reads is never a lock it keeps.
		const conditions = { ...READY, running: true };
		expect(preflightRun(conditions)).toEqual(preflightRun(conditions));
	});
});

describe("reTranscribableUnits", () => {
	it("counts nothing before anything has been synced", () => {
		expect(reTranscribableUnits({})).toBe(0);
	});

	it("counts the rows a note still stands behind", () => {
		expect(
			reTranscribableUnits({
				a: { status: "active" },
				b: { status: "orphaned" },
				c: { status: "active" },
			}),
		).toBe(2);
	});

	it("counts an index of nothing but orphaned rows as nothing to do", () => {
		// A row goes orphaned when its note is gone from the vault -- the user deleted it. Re-transcribing
		// one would write the note straight back.
		expect(reTranscribableUnits({ a: { status: "orphaned" }, b: { status: "orphaned" } })).toBe(0);
	});

	it("counts rows, not documents -- a notebook split into pages is several", () => {
		// The number reaches the user twice: as "no synced notes yet", and as the count the
		// confirmation dialog quotes. One function, so the two can never disagree.
		const rows = Object.fromEntries([1, 2, 3].map((page) => [`doc-1/${page}`, { status: "active" }]));
		expect(reTranscribableUnits(rows)).toBe(3);
	});
});
