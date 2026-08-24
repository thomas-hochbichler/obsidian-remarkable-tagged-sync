import { describe, expect, it } from "vitest";
import { outcomeStatus, progressStatus, type StatusRequest, statusView } from "./status-model";
import type { SyncProgress } from "./sync-engine";

// The decisions, without an element. `status-and-notices.test.ts` is the other half: that the shipped
// item is actually built from these answers.

const busy: StatusRequest = { state: "busy", text: "Tagged Sync: scanning…" };

describe("statusView", () => {
	it("gives each state its own icon, and spins only while busy", () => {
		// A literal map, which is exactly the kind of thing that gets edited by hand. `stopped` having
		// its own icon is the one that carries meaning: a check would claim a run that finished and a
		// cross would claim one that broke.
		const iconOf = (state: StatusRequest["state"]) => statusView({ state, text: "" }, false);

		expect(iconOf("busy")).toMatchObject({ icon: "refresh-cw", spinning: true });
		expect(iconOf("ok")).toMatchObject({ icon: "check", spinning: false });
		expect(iconOf("failed")).toMatchObject({ icon: "x", spinning: false });
		expect(iconOf("stopped")).toMatchObject({ icon: "square", spinning: false });
		// Same argument as `stopped`, one step further: a background run skipped because the tablet was
		// in a drawer is neither a finished run nor a broken one, and a cross every night is how a
		// status bar stops being read at all.
		expect(iconOf("asleep")).toMatchObject({ icon: "moon", spinning: false });
	});

	it("shows no bar unless one was given", () => {
		// Absent means no bar, not an empty one. An empty bar is still a bar and claims a run that has
		// done nothing yet.
		expect(statusView({ state: "ok", text: "done" }, false).bar).toBeNull();
		expect(statusView({ state: "busy", text: "", bar: 0 }, false).bar).toBe(0);
		expect(statusView({ state: "busy", text: "", bar: 40 }, false).bar).toBe(40);
	});

	it("withdraws the offer to stop once a stop is pending", () => {
		// The run keeps going for a while after the ask, so "busy" is still true. A second click has
		// nothing left to request.
		expect(statusView(busy, false)).toMatchObject({ stoppable: true, tooltip: "Click to stop the sync" });
		expect(statusView(busy, true)).toMatchObject({ stoppable: false, tooltip: "" });
	});

	it("only ever offers to stop a run that is happening", () => {
		for (const state of ["ok", "failed", "stopped", "asleep"] as const) {
			expect(statusView({ state, text: "" }, false).stoppable).toBe(false);
		}
	});

	it("joins the tooltip without leaving an empty line where a part is missing", () => {
		expect(statusView({ ...busy, detail: "Reading List" }, false).tooltip).toBe(
			"Reading List\nClick to stop the sync",
		);
		expect(statusView({ ...busy, detail: "Reading List" }, true).tooltip).toBe("Reading List");
		expect(statusView(busy, false).tooltip).toBe("Click to stop the sync");
	});

	it("leaves the tooltip empty when there is nothing to put in it", () => {
		expect(statusView({ state: "ok", text: "done" }, false).tooltip).toBe("");
	});

	it("passes the two texts through separately, because they are cut differently", () => {
		// A document name is of unbounded length and gets truncated; `text` is a sentence with nowhere
		// else to be read.
		expect(statusView({ ...busy, document: "Reading List" }, false)).toMatchObject({
			text: "Tagged Sync: scanning…",
			document: "Reading List",
		});
		expect(statusView(busy, false).document).toBe("");
	});
});

describe("progressStatus", () => {
	const scanning = (checked: number, candidates: number, document?: string): SyncProgress => ({
		phase: "scanning",
		checked,
		candidates,
		document,
	});
	const working = (done: number, total: number): SyncProgress => ({
		phase: "working",
		done,
		total,
		document: "Reading List",
		tag: "sync",
		step: "rendering",
		unitDone: 1,
		unitTotal: 4,
	});

	it("turns a scan tick into a count, a name and no bar", () => {
		expect(progressStatus(scanning(3, 12, "Reading List"), false, null)).toEqual({
			state: "busy",
			text: "checking 3 of 12 ·",
			bar: null,
			document: "Reading List",
			detail: "Reading List",
		});
	});

	it("drops the separator when nothing follows it", () => {
		// The separator belongs to whichever side is followed by the other, or it dangles.
		expect(progressStatus(scanning(3, 12), false, null).text).toBe("checking 3 of 12");
	});

	it("says it is scanning until there is something to count", () => {
		// "checking 0 of 0" reads as a finished run that found nothing.
		expect(progressStatus(scanning(0, 0), false, null).text).toBe("Tagged Sync: scanning…");
	});

	it("turns a working tick into a percentage and a name", () => {
		// No text: the icon says whose item this is, and the prefix would cost the width the name needs.
		expect(progressStatus(working(3, 12), false, null)).toEqual({
			state: "busy",
			text: "",
			bar: 25,
			document: "Reading List",
			detail: "Reading List\ntag: sync · page 1 of 4 · rendering",
		});
	});

	it("stops the bar at full when the pre-scan under-counted", () => {
		// Past full, the plugin looks broken at exactly the moment it is nearly done.
		expect(progressStatus(working(20, 12), false, null).bar).toBe(100);
	});

	it("answers a pending stop instead of the tick, and carries the bar forward", () => {
		// The ticks would otherwise go on announcing work the user has already ended. The bar freezes
		// rather than emptying: the work already done is not undone by stopping.
		expect(progressStatus(working(9, 12), true, 50)).toEqual({
			state: "busy",
			text: "Tagged Sync: stopping…",
			bar: 50,
		});
	});

	it("still says stopping when there was no bar to carry", () => {
		expect(progressStatus(scanning(3, 12, "Reading List"), true, null)).toMatchObject({
			text: "Tagged Sync: stopping…",
			bar: null,
		});
	});
});

describe("outcomeStatus", () => {
	it("names the state and the sentence together, since they have to agree", () => {
		expect(outcomeStatus({ stopped: true, notesWritten: 2 })).toEqual({
			state: "stopped",
			text: "Tagged Sync: stopped · 2 note(s)",
		});
		expect(outcomeStatus({ stopped: false, notesWritten: 3 })).toEqual({
			state: "ok",
			text: "Tagged Sync: 3 note(s)",
		});
		// A count of zero would read as a failure.
		expect(outcomeStatus({ stopped: false, notesWritten: 0 })).toEqual({
			state: "ok",
			text: "Tagged Sync: up to date",
		});
	});

	it("leaves no bar behind in any of the three", () => {
		// One left sitting at full claims the run is still happening, and it would sit there until the
		// next sync.
		for (const outcome of [
			{ stopped: true, notesWritten: 0 },
			{ stopped: false, notesWritten: 3 },
			{ stopped: false, notesWritten: 0 },
		]) {
			expect(statusView(outcomeStatus(outcome), false).bar).toBeNull();
		}
	});
});
