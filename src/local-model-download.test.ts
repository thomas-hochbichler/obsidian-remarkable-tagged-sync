import { describe, expect, it } from "vitest";
import { MODEL_ARTEFACTS, RUNTIME_ARTEFACTS, totalDownloadBytes } from "./local-model-artefacts";
import {
	formatBytes,
	freeSpaceShortfall,
	planCleanup,
	planRangeResponse,
	planResume,
	requiredFreeBytes,
	shortfallMessage,
	verificationOutcome,
} from "./local-model-download";
import { MMPROJ_BYTES, MODEL_BYTES } from "./local-model-store";

describe("planResume", () => {
	it("starts from zero when nothing is on disk", () => {
		expect(planResume(0, 1000)).toEqual({ kind: "fresh" });
	});

	it("resumes from the byte after the last one written", () => {
		expect(planResume(400, 1000)).toEqual({ kind: "resume", offset: 400 });
	});

	it("reports a part that already holds the whole file as complete", () => {
		expect(planResume(1000, 1000)).toEqual({ kind: "complete" });
	});

	// A part longer than the pinned size is not a resume point, it is a file that cannot be what we
	// asked for. Appending to it would produce a hash mismatch after 5.5 GB instead of after nothing.
	it("throws away a part that is longer than the pinned size", () => {
		expect(planResume(1001, 1000)).toEqual({ kind: "fresh" });
	});
});

describe("planRangeResponse", () => {
	it("appends when the server honoured the range", () => {
		expect(planRangeResponse(206, 400)).toEqual({ kind: "append", from: 400 });
	});

	/**
	 * A 200 means the range was ignored and the body starts at byte zero. HuggingFace redirects to a
	 * signed CDN URL, which is exactly where that happens. Appending it to the part would splice two
	 * beginnings together, and only the final hash would find out -- after 5.5 GB.
	 */
	it("restarts at zero when the server ignored the range", () => {
		expect(planRangeResponse(200, 400)).toEqual({ kind: "restart" });
	});

	it("treats a plain 200 on a fresh download as the normal case", () => {
		expect(planRangeResponse(200, 0)).toEqual({ kind: "restart" });
	});

	it("refuses any other status", () => {
		for (const status of [204, 301, 403, 416, 500]) {
			expect(planRangeResponse(status, 400)).toEqual({ kind: "error", status });
		}
	});
});

describe("free space", () => {
	it("asks for every pinned byte plus room to unpack the runtime", () => {
		const required = requiredFreeBytes("darwin");

		expect(required).toBeGreaterThan(totalDownloadBytes("darwin"));
		// The archive is still on disk while `tar` writes what is inside it.
		expect(required).toBe(totalDownloadBytes("darwin") + RUNTIME_ARTEFACTS.darwin.bytes);
	});

	/**
	 * An update lands beside its predecessor (§5.1), so the old model is still occupying its bytes
	 * while the new one arrives. Nothing is subtracted for it -- the free figure the OS reports already
	 * accounts for it as used, and assuming we may delete it first is exactly the assumption §5.3
	 * forbids.
	 */
	it("never discounts an already-installed model", () => {
		expect(requiredFreeBytes("win32")).toBe(requiredFreeBytes("win32"));
		expect(requiredFreeBytes("win32")).toBeGreaterThan(MODEL_BYTES + MMPROJ_BYTES);
	});

	it("reports no shortfall when there is room", () => {
		expect(freeSpaceShortfall(1000, 1000)).toBe(0);
		expect(freeSpaceShortfall(1000, 2000)).toBe(0);
	});

	it("reports exactly how much is missing", () => {
		expect(freeSpaceShortfall(1000, 400)).toBe(600);
	});

	// "Not enough space" sends the user looking for a number nobody gave them.
	it("names the shortfall in the message", () => {
		expect(shortfallMessage(2_100_000_000)).toContain("2.1 GB");
		expect(shortfallMessage(2_100_000_000)).toContain("Resume");
	});
});

describe("formatBytes", () => {
	it("reads the way the consent copy quotes it", () => {
		expect(formatBytes(5_536_191_744)).toBe("5.5 GB");
		expect(formatBytes(12_191_028)).toBe("12 MB");
		expect(formatBytes(0)).toBe("0 MB");
	});

	// A megabyte figure with a decimal point reads as false precision on a number nobody acts on.
	it("keeps one decimal for gigabytes and none for megabytes", () => {
		expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
		expect(formatBytes(999_000_000)).toBe("999 MB");
	});
});

describe("verificationOutcome", () => {
	it("accepts a file whose hash matches", () => {
		expect(verificationOutcome(true, false)).toBe("verified");
	});

	// The likeliest cause of a first mismatch is a resume the server mishandled, which a clean
	// download from zero fixes.
	it("re-downloads once after the first mismatch", () => {
		expect(verificationOutcome(false, false)).toBe("retry");
	});

	/**
	 * A second mismatch is terminal with no further automatic attempt. Without the marker on disk a
	 * restart resets the count and the plugin fetches 5.5 GB it has already been told twice is wrong.
	 */
	it("gives up permanently after the second", () => {
		expect(verificationOutcome(false, true)).toBe("corrupt");
	});

	it("still accepts a match after a previous mismatch", () => {
		expect(verificationOutcome(true, true)).toBe("verified");
	});
});

describe("planCleanup", () => {
	const pinned = "qwen2.5-vl-7b-instruct-q4_k_m";

	it("leaves the pinned directory alone whatever state it is in", () => {
		const plan = planCleanup([{ name: pinned, hasPart: true, complete: false }], pinned);

		expect(plan).toEqual({ deleteSilently: [], offerToDelete: [] });
	});

	// Provably useless: an incomplete download of a version this build can no longer finish.
	it("silently deletes a partial of a version that is no longer pinned", () => {
		const plan = planCleanup([{ name: "qwen2.5-vl-7b-instruct-q3_k_m", hasPart: true, complete: false }], pinned);

		expect(plan.deleteSilently).toEqual(["qwen2.5-vl-7b-instruct-q3_k_m"]);
		expect(plan.offerToDelete).toEqual([]);
	});

	/**
	 * A complete model of a superseded version works, and it is the fallback if the new download
	 * fails. The rule underneath: silent deletion is only for what is provably useless -- anything
	 * that ever worked costs a button press.
	 */
	it("never silently deletes a complete model of a superseded version", () => {
		const plan = planCleanup([{ name: "qwen2.5-vl-7b-instruct-q3_k_m", hasPart: false, complete: true }], pinned);

		expect(plan.deleteSilently).toEqual([]);
		expect(plan.offerToDelete).toEqual(["qwen2.5-vl-7b-instruct-q3_k_m"]);
	});

	// Half-downloaded on top of a complete set is still something that once worked.
	it("offers rather than deletes when a superseded directory is both complete and resuming", () => {
		const plan = planCleanup([{ name: "old", hasPart: true, complete: true }], pinned);

		expect(plan.deleteSilently).toEqual([]);
		expect(plan.offerToDelete).toEqual(["old"]);
	});

	it("leaves a superseded directory that is neither alone", () => {
		const plan = planCleanup([{ name: "old", hasPart: false, complete: false }], pinned);

		expect(plan).toEqual({ deleteSilently: [], offerToDelete: [] });
	});
});

describe("the pinned table", () => {
	// Every figure the card quotes describes these files; a typo here is a download that can never
	// verify, discovered after 5.5 GB.
	it("pins a full-length SHA-256 and an absolute URL for every artefact", () => {
		for (const artefact of [...MODEL_ARTEFACTS, RUNTIME_ARTEFACTS.darwin, RUNTIME_ARTEFACTS.win32]) {
			expect(artefact.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(artefact.url).toMatch(/^https:\/\//);
			expect(artefact.bytes).toBeGreaterThan(0);
		}
	});

	// Never `main`, never `releases/latest`: research 01 tripped a `latest` whose assets were still
	// uploading.
	it("resolves the model at a commit revision rather than a branch", () => {
		for (const artefact of MODEL_ARTEFACTS) {
			expect(artefact.url).toContain("/resolve/508edd0afaa66bb9e9f40587acc2184f02daf1f6/");
			expect(artefact.url).not.toContain("/resolve/main/");
		}
	});

	it("totals the 5.5 GB the consent copy quotes", () => {
		expect(MODEL_ARTEFACTS.reduce((sum, a) => sum + a.bytes, 0)).toBe(5_536_191_744);
		expect(formatBytes(totalDownloadBytes("darwin"))).toBe("5.5 GB");
	});

	/**
	 * Windows arm64 only, and CPU only. Both x64 assets are quarantined by Defender as
	 * `Trojan:Win32/Wacatac.B!ml` and there is no Vulkan build for arm64 at all.
	 */
	it("ships one Windows artefact, arm64 and CPU", () => {
		expect(RUNTIME_ARTEFACTS.win32.fileName).toContain("win-cpu-arm64");
		expect(RUNTIME_ARTEFACTS.win32.fileName).not.toContain("x64");
	});
});
