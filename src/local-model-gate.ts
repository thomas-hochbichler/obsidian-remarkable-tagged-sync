// Which machines the local model is offered on (managed-local-llm-ocr spec §4).
//
// This is the section that departs furthest from the map's destination -- "runs on macOS and Windows"
// became macOS on Apple Silicon with 18 GB and Windows on ARM with 24 GB -- and it does so on
// measurement rather than caution. The predicate is one formula, not two hand-picked numbers:
//
//     floor = measured peak RSS for that platform's build + 4 GiB,
//             rounded up to the next shipping memory configuration
//
// The uncomfortable consequence is stated rather than buried: **every 16 GB Mac is excluded.** Vision
// stays their default and they lose nothing they have today, and the alternative would be an
// "informed choice" ending in a swap storm. It is also the one unmeasured case on the shipping path
// -- nobody has run the 7B on a 16 GB Mac -- and if a page ever completes there, the macOS floor
// moves to 16 GB and *only that number* changes.

const GIB = 1024 ** 3;

/**
 * The RAM floors, as nominal shipping configurations.
 *
 * macOS: 13.43 GB peak RSS (Metal) + 4 GiB -> 18 GB. Windows: 16.64 GB (CPU-only) + 4 GiB -> 24 GB.
 * Windows pays more because it has no Metal path and does the whole thing on the CPU.
 */
export const MACOS_FLOOR_GB = 18;
export const WINDOWS_FLOOR_GB = 24;

/**
 * The thresholds sit one GiB under the nominal figure **on purpose**: a machine sold as 24 GB reports
 * roughly 23.6 GiB to `os.totalmem()`, and a floor written at the nominal number would exclude every
 * machine that exactly meets it.
 */
function thresholdBytes(floorGb: number): number {
	return (floorGb - 1) * GIB;
}

/** What one machine looks like to the gate. Injected so the whole rule is testable off both platforms. */
export interface MachineFacts {
	platform: string;
	arch: string;
	totalMemoryBytes: number;
}

/**
 * Why the backend cannot be offered here, or null when it can.
 *
 * The two reasons are kept apart because they need different sentences: an architecture is never
 * going to change, and a memory figure is the user's own number that they may recognise.
 */
export type LocalModelBlock = { kind: "architecture" } | { kind: "memory"; floorGb: number; actualGb: number };

/**
 * `offered ⟺ (macOS on arm64 ∨ Windows on arm64) ∧ os.totalmem() ≥ floor`
 *
 * **Linux is not registered at all** and so never reaches here: nothing on Linux is verified, and an
 * unverified 5.5 GB download is worse than no offer. **Intel Macs and Windows x64 do reach here** and
 * are blocked with a reason, because those users can see the backend exists -- the README and every
 * macOS screenshot promise it -- and silence would read as a bug. Windows x64's own reason is §4.2:
 * Defender quarantines the engine.
 */
export function localModelBlock(machine: MachineFacts): LocalModelBlock | null {
	const supportedPlatform = machine.platform === "darwin" || machine.platform === "win32";
	if (!supportedPlatform || machine.arch !== "arm64") return { kind: "architecture" };

	const floorGb = machine.platform === "darwin" ? MACOS_FLOOR_GB : WINDOWS_FLOOR_GB;
	if (machine.totalMemoryBytes >= thresholdBytes(floorGb)) return null;
	return { kind: "memory", floorGb, actualGb: Math.round(machine.totalMemoryBytes / GIB) };
}

/**
 * The dropdown's replacement text for a machine that can never run the model (§4.3).
 *
 * Each is rendered as the *entire* option text of a disabled dropdown entry, so each is the whole
 * explanation and neither has a card beneath it -- §4.1 attaches no `renderSetup` where the model
 * cannot run, which is what makes §6.2's listing rule produce show-but-disable here with no extra
 * mechanism.
 *
 * The memory string names the machine's own figure, because a bare requirement only sends the user
 * looking for what they have.
 */
export function localModelUnavailableLabel(block: LocalModelBlock, platform: string): string {
	if (block.kind === "architecture") {
		// One string for both excluded architectures -- Intel Macs and Windows x64 -- which keeps the
		// backend at one lifecycle string plus two hardware strings.
		return "Local model — needs Apple Silicon or Windows on ARM";
	}
	const machine = platform === "darwin" ? "Mac" : "PC";
	return `Local model — needs ${block.floorGb} GB RAM (this ${machine} has ${block.actualGb} GB)`;
}

/**
 * The one lifecycle string the dropdown needs (§6.2).
 *
 * Not-downloaded, downloading, corrupt, runtime-failed and removed all live in the card; this line's
 * only job is to point at it. It is reached only through §6.2's third clause -- the user selected the
 * backend while it worked and the model later disappeared -- because hiding a *selected* entry would
 * leave the dropdown showing nothing at all.
 */
export const NOT_READY_LABEL = "Local model — not ready, see below";
