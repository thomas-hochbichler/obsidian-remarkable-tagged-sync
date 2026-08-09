import { describe, expect, it } from "vitest";
import {
	BACKGROUND_CONSENT_DESC,
	type CardCopy,
	cardCopy,
	deleteConfirmation,
	type LocalCardState,
	QUALITY_LINE,
	QUALITY_LINE_SHORT,
} from "./local-model-card";
import { ENOUGH_PAGES_TO_MEASURE, recordPageDuration } from "./local-model-settings";

const EVERY_STATE: LocalCardState[] = [
	{ kind: "absent" },
	{ kind: "downloading", receivedBytes: 2_000_000_000, totalBytes: 5_536_191_744 },
	{ kind: "verifying" },
	{ kind: "paused", onDiskBytes: 2_000_000_000 },
	{ kind: "out-of-disk", shortfallBytes: 2_100_000_000 },
	{ kind: "network-lost", message: "the connection timed out" },
	{ kind: "foreign-download", percent: 62 },
	{ kind: "ready" },
	{ kind: "update-available" },
	{ kind: "corrupt" },
	{ kind: "removed" },
	{ kind: "runtime-failed", message: "the engine exited with 1" },
];

function copyFor(state: LocalCardState, settings: Record<string, unknown> = {}): CardCopy {
	return cardCopy(state, "darwin", settings);
}

describe("every state", () => {
	it("says something, and never leaves a dead end with no explanation", () => {
		for (const state of EVERY_STATE) {
			const copy = copyFor(state);
			expect(copy.heading, state.kind).not.toBe("");
			expect(copy.paragraphs.length, state.kind).toBeGreaterThan(0);
			for (const paragraph of copy.paragraphs) expect(paragraph.trim(), state.kind).not.toBe("");
		}
	});

	// A state the user cannot act on has no buttons, and every other state has exactly one obvious
	// next step. Two CTAs on one card is a card that has not decided what it is asking.
	it("offers at most one call to action", () => {
		for (const state of EVERY_STATE) {
			const ctas = copyFor(state).actions.filter((action) => action.emphasis === "cta");
			expect(ctas.length, state.kind).toBeLessThanOrEqual(1);
		}
	});

	it("draws a bar exactly where there is progress to draw", () => {
		const withBar = EVERY_STATE.filter((state) => copyFor(state).percent !== null).map((state) => state.kind);

		expect(withBar).toEqual(["downloading", "foreign-download"]);
	});

	/**
	 * §4.2 forbids it outright: the only mitigation a plugin has for an antivirus deleting the engine
	 * is asking for an exclusion, which is both a user-visible installation step and a request to wave
	 * past a severe malware warning.
	 */
	it("never mentions an antivirus exclusion anywhere", () => {
		for (const state of EVERY_STATE) {
			const text = [copyFor(state).heading, ...copyFor(state).paragraphs].join(" ").toLowerCase();
			expect(text, state.kind).not.toContain("exclusion");
			expect(text, state.kind).not.toContain("exclude");
			expect(text, state.kind).not.toContain("allowlist");
		}
	});
});

describe("consent (§7.2)", () => {
	const copy = copyFor({ kind: "absent" });
	const text = copy.paragraphs.join(" ");

	it("names both downloads, the engine as its own cost", () => {
		expect(text).toContain("5.5 GB");
		// The binary is named rather than hidden inside "the model": §10 accepted a residual store risk
		// because the hygiene is visible.
		expect(text).toContain("12 MB");
	});

	it("says the download is checked before anything runs", () => {
		expect(text).toContain("SHA-256");
	});

	// The price of putting the model outside the vault, stated at the moment the user agrees to pay it.
	it("says the model outlives the plugin, and how to remove it", () => {
		expect(text).toContain("Uninstalling the plugin does not remove it");
		expect(text).toContain("Delete button");
	});

	it("states privacy, licence and memory", () => {
		expect(text).toContain("No account, no key, no network");
		expect(text).toContain("Apache-2.0");
		expect(text).toContain("32 GB of memory recommended");
	});

	it("asks for background consent here, where the estimate is already on screen", () => {
		expect(copy.showsBackgroundConsent).toBe(true);
		expect(BACKGROUND_CONSENT_DESC).toContain("Off by default");
		// Money is gone from the copy entirely: a local model costs none.
		expect(BACKGROUND_CONSENT_DESC.toLowerCase()).not.toContain("money");
		expect(BACKGROUND_CONSENT_DESC.toLowerCase()).not.toContain("api");
	});
});

describe("the quality line (§7.4)", () => {
	/**
	 * A comparison, not a warning. A warning attached only to the LLM would tell the user the accurate
	 * option is the risky one, since Vision gets three times as many characters wrong.
	 */
	it("compares the two backends rather than warning about one", () => {
		expect(QUALITY_LINE).toContain("Apple Vision gets more of them wrong");
		expect(QUALITY_LINE).toContain("Check anything that matters against the handwriting");
	});

	it("is in full on the consent card, where the comparison decides the answer", () => {
		expect(copyFor({ kind: "absent" }).paragraphs).toContain(QUALITY_LINE);
	});

	/**
	 * A downloaded, selected model is not a choice any more, and the comparison it was written for has
	 * nothing left to compare. What must survive is the part a user still acts on: the misreads are
	 * fluent, so check them.
	 */
	it("keeps only the check-it sentence once the model is ready", () => {
		expect(copyFor({ kind: "ready" }).paragraphs).toContain(QUALITY_LINE_SHORT);
		expect(QUALITY_LINE_SHORT).toContain("check anything that matters against the handwriting");
	});
});

describe("the speed line (§7.3)", () => {
	it("quotes the derived figure before this machine has run a page", () => {
		expect(copyFor({ kind: "ready" }).paragraphs[0]).toContain("15 seconds a page on a fast Mac");
	});

	it("quotes this machine's own once it has", () => {
		const settings = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE; i++) recordPageDuration(settings, 11_000);

		expect(copyFor({ kind: "ready" }, settings).paragraphs[0]).toContain("11 seconds a page on this machine");
	});

	it("never claims a Windows figure was measured", () => {
		const line = cardCopy({ kind: "absent" }, "win32", {}).paragraphs.join(" ");

		expect(line).toContain("Estimated, never measured on Windows hardware");
	});
});

describe("the states that carry a decided sentence", () => {
	it("says nothing was run when verification failed", () => {
		const copy = copyFor({ kind: "corrupt" });

		expect(copy.paragraphs[0]).toBe("The download did not match the checksum this plugin was published with. Nothing has been run.");
		// Terminal: no further automatic attempt, so the only way on is a button.
		expect(copy.actions.map((a) => a.id)).toEqual(["delete"]);
	});

	/**
	 * The 12 MB / 5.5 GB line is load-bearing: Defender never touched the model, so the honest
	 * reassurance is that the expensive half is safe.
	 */
	it("tells a user whose engine was deleted that the model survived", () => {
		const copy = copyFor({ kind: "removed" });
		const text = copy.paragraphs.join(" ");

		expect(text).toContain("antivirus");
		expect(text).toContain("12 MB engine is affected");
		expect(text).toContain("5.5 GB model on disk is untouched");
		// Manual, never automatic: an automatic retry loops the malware alert once per cycle.
		expect(copy.actions.map((a) => a.id)).toEqual(["retry-runtime"]);
	});

	it("warns that an update does not redo existing transcripts", () => {
		expect(copyFor({ kind: "update-available" }).paragraphs.join(" ")).toContain("are not redone");
	});

	// The number is the fact the answer turns on, so the button carries it rather than the prose.
	it("names what discarding a paused download throws away, on the button", () => {
		const copy = copyFor({ kind: "paused", onDiskBytes: 2_000_000_000 });

		expect(copy.actions.find((a) => a.id === "discard")?.label).toBe("Discard 2.0 GB");
		expect(copy.actions.find((a) => a.id === "discard")?.emphasis).toBe("warning");
	});

	it("names the shortfall when the disk is full", () => {
		expect(copyFor({ kind: "out-of-disk", shortfallBytes: 2_100_000_000 }).paragraphs[0]).toBe("Free 2.1 GB and press Resume.");
	});

	// A download lasts hours; refusing to sync for hours would cost renders, notes and highlights,
	// which are the plugin's actual job.
	it("says syncing keeps working during the download", () => {
		expect(copyFor({ kind: "downloading", receivedBytes: 1, totalBytes: 2 }).paragraphs.join(" ")).toContain("Syncing still works");
	});

	it("shows the other vault's progress rather than a spinner", () => {
		expect(copyFor({ kind: "foreign-download", percent: 62 }).heading).toContain("62 %");
	});
});

describe("deleteConfirmation", () => {
	it("names the bytes freed, the fallback and what survives", () => {
		const text = deleteConfirmation(5_536_191_744, "Apple Vision");

		expect(text).toContain("5.5 GB");
		expect(text).toContain("Apple Vision");
		expect(text).toContain("Transcripts already in your notes are not touched");
	});
});
