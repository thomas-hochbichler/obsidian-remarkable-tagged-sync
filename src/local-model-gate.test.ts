import { describe, expect, it } from "vitest";
import { localModelBlock, localModelUnavailableLabel, MACOS_FLOOR_GB, WINDOWS_FLOOR_GB } from "./local-model-gate";

const GIB = 1024 ** 3;

/** What a machine sold as `nominal` GB actually reports: a few per cent under the label. */
function reported(nominalGb: number): number {
	return Math.round(nominalGb * 0.983 * GIB);
}

const mac = (gb: number, arch = "arm64") => ({ platform: "darwin", arch, totalMemoryBytes: reported(gb) });
const pc = (gb: number, arch = "arm64") => ({ platform: "win32", arch, totalMemoryBytes: reported(gb) });

describe("the registration predicate (§4.1)", () => {
	it("offers the backend on Apple Silicon at or above 18 GB", () => {
		expect(localModelBlock(mac(MACOS_FLOOR_GB))).toBeNull();
		expect(localModelBlock(mac(24))).toBeNull();
		expect(localModelBlock(mac(64))).toBeNull();
	});

	it("offers it on Windows on ARM at or above 24 GB", () => {
		expect(localModelBlock(pc(WINDOWS_FLOOR_GB))).toBeNull();
		expect(localModelBlock(pc(32))).toBeNull();
	});

	/**
	 * The threshold sits a GiB under the nominal figure on purpose: a machine sold as 24 GB reports
	 * roughly 23.6 GiB, and a floor written at the nominal number excludes every machine that exactly
	 * meets it.
	 */
	it("passes a machine that reports slightly under its advertised size", () => {
		expect(localModelBlock({ platform: "win32", arch: "arm64", totalMemoryBytes: 23.6 * GIB })).toBeNull();
		expect(localModelBlock({ platform: "darwin", arch: "arm64", totalMemoryBytes: 17.7 * GIB })).toBeNull();
	});

	/**
	 * Every 16 GB Mac is excluded, and that is the map's most uncomfortable consequence rather than an
	 * oversight. Vision stays their default and they lose nothing they have today; the alternative is
	 * an "informed choice" ending in a swap storm.
	 */
	it("excludes a 16 GB Mac", () => {
		expect(localModelBlock(mac(16))).toEqual({ kind: "memory", floorGb: MACOS_FLOOR_GB, actualGb: 16 });
	});

	it("excludes a 16 GB Windows ARM PC, which needs more rather than less", () => {
		expect(localModelBlock(pc(16))).toEqual({ kind: "memory", floorGb: WINDOWS_FLOOR_GB, actualGb: 16 });
		// Windows pays more because it has no Metal path: 16.64 GB peak RSS against macOS's 13.43.
		expect(WINDOWS_FLOOR_GB).toBeGreaterThan(MACOS_FLOOR_GB);
	});

	/** Defender quarantines the engine from both x64 assets as `Trojan:Win32/Wacatac.B!ml` (§4.2). */
	it("excludes Windows x64 however much memory it has", () => {
		expect(localModelBlock(pc(128, "x64"))).toEqual({ kind: "architecture" });
	});

	// Unmeasured in every respect, and excluded rather than guessed at.
	it("excludes Intel Macs", () => {
		expect(localModelBlock(mac(128, "x64"))).toEqual({ kind: "architecture" });
	});

	// Nothing on Linux is verified, and an unverified 5.5 GB download is worse than no offer. The
	// entry is not registered there at all; this is the belt to that braces.
	it("excludes every other platform", () => {
		expect(localModelBlock({ platform: "linux", arch: "arm64", totalMemoryBytes: 128 * GIB })).toEqual({ kind: "architecture" });
	});

	// Architecture is checked before memory: a 128 GB Intel Mac is not a memory problem, and telling
	// it to buy RAM would be a lie.
	it("reports architecture rather than memory when both would fail", () => {
		expect(localModelBlock(mac(8, "x64"))).toEqual({ kind: "architecture" });
	});
});

describe("the strings a machine without the offer sees (§4.3, §6.2)", () => {
	/** An Intel Mac has no way to the model at all, so it gets the plain hardware line. */
	it("tells an Intel Mac it needs other hardware", () => {
		expect(localModelUnavailableLabel({ kind: "architecture" }, "darwin")).toBe("Local model — needs Apple Silicon or Windows on ARM");
	});

	// Windows x64 runs the model fine; only the engine download is blocked (§4.2, amended 2026-09-11),
	// and the localhost backend reaches the same models through a host the user installs. "Buy another
	// machine" would be the wrong sentence. Nothing promises the managed route -- it may still fail.
	it("sends a Windows x64 user to the localhost backend rather than to other hardware", () => {
		expect(localModelUnavailableLabel({ kind: "architecture" }, "win32")).toBe(
			"Local model — not yet on Windows x64; use a localhost backend (Ollama, LM Studio)",
		);
	});

	// A bare requirement only sends the user looking for what they have.
	it("names the machine's own figure beside the requirement", () => {
		expect(localModelUnavailableLabel({ kind: "memory", floorGb: 18, actualGb: 16 }, "darwin")).toBe(
			"Local model — needs 18 GB RAM (this Mac has 16 GB)",
		);
		expect(localModelUnavailableLabel({ kind: "memory", floorGb: 24, actualGb: 16 }, "win32")).toBe(
			"Local model — needs 24 GB RAM (this PC has 16 GB)",
		);
	});

	it("is four strings and no more", () => {
		const strings = new Set([
			localModelUnavailableLabel({ kind: "architecture" }, "darwin"),
			localModelUnavailableLabel({ kind: "architecture" }, "win32"),
			localModelUnavailableLabel({ kind: "memory", floorGb: 18, actualGb: 16 }, "darwin"),
			localModelUnavailableLabel({ kind: "memory", floorGb: 24, actualGb: 8 }, "win32"),
		]);
		// Three hardware shapes since the two excluded architectures parted ways; the memory ones differ
		// only by their numbers. A model that is merely not downloaded gets no string at all -- it is
		// listed, and its card says what to do.
		expect(strings.size).toBe(4);
		for (const value of strings) expect(value.startsWith("Local model — ")).toBe(true);
	});
});

/**
 * The floors move with the model (ticket 20). Two generations ship and their working sets differ by
 * nearly a factor of two, so one constant would either shut a 16 GB Mac out of a model it runs
 * comfortably or let one start a model that swaps.
 */
describe("the floor follows the generation", () => {
	const mac = (gb: number) => ({ platform: "darwin", arch: "arm64", totalMemoryBytes: gb * 1024 ** 3 });

	it("offers a 16 GB Mac the newer model, which the older model's floor shut out", () => {
		expect(localModelBlock(mac(16), { darwin: 16, win32: 24 })).toBeNull();
		expect(localModelBlock(mac(16), { darwin: 18, win32: 24 })).toEqual({ kind: "memory", floorGb: 18, actualGb: 16 });
	});

	// Unchanged behaviour for anyone already running the model that shipped first.
	it("keeps the shipped floors when no generation is named", () => {
		expect(localModelBlock(mac(18))).toBeNull();
		expect(localModelBlock(mac(16))).toEqual({ kind: "memory", floorGb: 18, actualGb: 16 });
	});
});
