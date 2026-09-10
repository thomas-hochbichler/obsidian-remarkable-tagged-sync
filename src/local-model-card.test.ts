import { describe, expect, it } from "vitest";
import { MODEL_GENERATIONS } from "./local-model-artefacts";
import {
	backgroundConsentDesc,
	type CardCopy,
	cardCopy,
	deleteConfirmation,
	type LocalCardState,
	newerModelOffer,
	QUALITY_LINE,
	QUALITY_LINE_SHORT,
} from "./local-model-card";
import { ENOUGH_PAGES_TO_MEASURE, recordPageDuration } from "./local-model-settings";

/** A newer model on offer, as `local-register.ts` builds it from the generation records. */
const OFFER = { label: "Qwen3-VL-8B-Instruct", downloadBytes: 6_186_814_624, medianCer: 0.0179, currentMedianCer: 0.0432 };

const EVERY_STATE: LocalCardState[] = [
	{ kind: "absent" },
	{ kind: "downloading", receivedBytes: 2_000_000_000, totalBytes: 5_536_191_744 },
	{ kind: "verifying" },
	{ kind: "paused", onDiskBytes: 2_000_000_000 },
	{ kind: "out-of-disk", shortfallBytes: 2_100_000_000 },
	{ kind: "network-lost", message: "the connection timed out" },
	{ kind: "foreign-download", percent: 62 },
	{ kind: "ready", newer: null },
	{ kind: "ready", newer: OFFER },
	{ kind: "corrupt" },
	{ kind: "removed", modelBytes: 5_536_191_744 },
	{ kind: "runtime-failed", message: "the engine exited with 1" },
];

function copyFor(state: LocalCardState, settings: Record<string, unknown> = {}): CardCopy {
	return cardCopy(state, "darwin", settings, MODEL_GENERATIONS[0]);
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
		// The button a fresh install presses, so it quotes the model that install would get.
		expect(text).toContain("6.2 GB");
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

	// Every figure here is the chosen model's own. Three generations ship and they differ by a factor
	// of four in download and in working set, so a constant would describe somebody else's Mac.
	it("states privacy, licence and this model's own memory", () => {
		expect(text).toContain("No account, no key, no network");
		expect(text).toContain(`${MODEL_GENERATIONS[0].label} · Apache-2.0`);
		expect(text).toContain(`${MODEL_GENERATIONS[0].floorGb.darwin} GB of memory needed`);
	});

	it("quotes the smallest model's own figures when that is the one this machine would fetch", () => {
		const smallest = MODEL_GENERATIONS[MODEL_GENERATIONS.length - 1];
		const line = cardCopy({ kind: "absent" }, "darwin", {}, smallest).paragraphs.join(" ");

		expect(line).toContain(smallest.label);
		expect(line).toContain(`${smallest.floorGb.darwin} GB of memory needed`);
		expect(line).not.toContain(MODEL_GENERATIONS[0].label);
	});

	it("asks for background consent here, where the estimate is already on screen", () => {
		expect(copy.showsBackgroundConsent).toBe(true);
		expect(backgroundConsentDesc(MODEL_GENERATIONS[0])).toContain("Off by default");
		// Money is gone from the copy entirely: a local model costs none.
		expect(backgroundConsentDesc(MODEL_GENERATIONS[0]).toLowerCase()).not.toContain("money");
		expect(backgroundConsentDesc(MODEL_GENERATIONS[0]).toLowerCase()).not.toContain("api");
	});

	/**
	 * Reported as a setting nobody could picture. The old copy named the price and never the purchase:
	 * *"the model holds 8.6 GB and pushes the fans"*. And what off means is not mild -- the gate fires
	 * before a run starts, so the whole scheduled sync is skipped and nothing arrives on its own.
	 */
	it("says what the switch does before what it costs, and how much off actually costs", () => {
		const desc = backgroundConsentDesc(MODEL_GENERATIONS[0]);

		expect(desc).toContain("scheduled syncs are skipped altogether");
		expect(desc).toContain("sync by hand");
		// The price still has to be there; it is the reason to think before switching it on.
		// The card's own `gib()` counts in GB, not GiB -- the figure a disk and an activity monitor show.
		expect(desc).toContain(`${(MODEL_GENERATIONS[0].peakRssBytes / 1_000_000_000).toFixed(1)} GB`);
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
		expect(copyFor({ kind: "ready", newer: null }).paragraphs).toContain(QUALITY_LINE_SHORT);
		expect(QUALITY_LINE_SHORT).toContain("check anything that matters against the handwriting");
	});
});

describe("the speed line (§7.3)", () => {
	it("quotes the derived figure before this machine has run a page", () => {
		expect(copyFor({ kind: "ready", newer: null }).paragraphs[0]).toContain("15 seconds a page on a fast Mac");
	});

	it("quotes this machine's own once it has", () => {
		const settings = {};
		for (let i = 0; i < ENOUGH_PAGES_TO_MEASURE; i++) recordPageDuration(settings, 11_000);

		expect(copyFor({ kind: "ready", newer: null }, settings).paragraphs[0]).toContain("11 seconds a page on this machine");
	});

	it("never claims a Windows figure was measured", () => {
		const line = cardCopy({ kind: "absent" }, "win32", {}, MODEL_GENERATIONS[0]).paragraphs.join(" ");

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
		const copy = copyFor({ kind: "removed", modelBytes: 5_536_191_744 });
		const text = copy.paragraphs.join(" ");

		expect(text).toContain("antivirus");
		expect(text).toContain("12 MB engine is affected");
		expect(text).toContain("5.5 GB model on disk is untouched");
		// Manual, never automatic: an automatic retry loops the malware alert once per cycle.
		expect(copy.actions.map((a) => a.id)).toEqual(["retry-runtime"]);
	});

	it("warns that an update does not redo existing transcripts", () => {
		expect(copyFor({ kind: "ready", newer: OFFER }).paragraphs.join(" ")).toContain("are not redone");
	});

	/**
	 * The whole of ticket 20 in one assertion: a working model keeps working and the better one is an
	 * offer. A card that reached for the download itself would be the plugin deciding to spend two
	 * hours and 6.2 GB of someone's disk on a plugin update they did not ask for.
	 */
	it("offers a newer model beside a ready one, with both error rates and no push", () => {
		const copy = copyFor({ kind: "ready", newer: OFFER });
		const text = copy.paragraphs.join(" ");

		expect(copy.heading).toBe("Local model — ready");
		expect(text).toContain("1.8 % character error against your 4.3 %");
		expect(text).toContain("6.2 GB");
		expect(text).toContain("keeps working");
		expect(copy.actions.map((a) => a.id)).toEqual(["update", "delete"]);
		expect(copy.actions[0].label).toContain("Qwen3-VL-8B-Instruct");
	});

	it("says nothing about a newer model when there is not one", () => {
		const copy = copyFor({ kind: "ready", newer: null });

		expect(copy.actions.map((a) => a.id)).toEqual(["delete"]);
		expect(copy.paragraphs.join(" ")).not.toContain("character error against");
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

	it("shows the download's progress rather than a spinner", () => {
		expect(copyFor({ kind: "foreign-download", percent: 62 }).heading).toContain("62 %");
	});

	/**
	 * The lock carries a timestamp and nothing else (§5.4), so this card cannot see a second vault --
	 * and a download left running by a previous plugin instance reaches it looking exactly the same. It
	 * claimed one anyway, and a user with one vault open was told about a vault that did not exist.
	 */
	it("claims no second vault in the heading, because it cannot see one", () => {
		const copy = copyFor({ kind: "foreign-download", percent: 62 });

		expect(copy.heading).not.toContain("another vault");
		// The paragraph may still name it -- there it is one of two possibilities offered, not a fact.
		expect(copy.paragraphs.join(" ")).toContain("before the plugin last reloaded");
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

/**
 * The offer a ready model carries when a better one exists (ticket 20). Pure, so the whole rule is
 * testable without a filesystem -- which is what the rest of the local-model set is built on and what
 * the settings registry had briefly broken by deciding this inside itself.
 */
describe("newerModelOffer", () => {
	const [newest, older] = MODEL_GENERATIONS;

	it("quotes both error rates and the real download size", () => {
		const offer = newerModelOffer(older, { platform: "darwin", totalMemoryBytes: 64 * 1024 ** 3 });

		expect(offer).toMatchObject({ label: newest.label, medianCer: newest.measured.medianCer, currentMedianCer: older.measured.medianCer });
		// The runtime archive rides along, so the figure is what the user actually waits for.
		expect(offer?.downloadBytes).toBeGreaterThan(newest.modelBytes + newest.mmprojBytes);
	});

	it("offers nothing to an install already on the newest model", () => {
		expect(newerModelOffer(newest, { platform: "darwin", totalMemoryBytes: 64 * 1024 ** 3 })).toBeNull();
	});

	// Windows fetches a different runtime archive, so the size it is promised has to be its own.
	it("sizes the download per platform", () => {
		expect(newerModelOffer(older, { platform: "win32", totalMemoryBytes: 64 * 1024 ** 3 })?.downloadBytes).not.toBe(newerModelOffer(older, { platform: "darwin", totalMemoryBytes: 64 * 1024 ** 3 })?.downloadBytes);
	});
});
