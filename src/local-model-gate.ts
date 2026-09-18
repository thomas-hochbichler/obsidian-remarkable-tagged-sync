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
 * The floors of the model that shipped first, kept as the default so every existing caller and every
 * existing test keeps the numbers it was written against.
 *
 * macOS: 13.43 GB peak RSS (Metal) + 4 GiB -> 18 GB. Windows: 16.64 GB (CPU-only) + 4 GiB -> 24 GB.
 * Windows pays more because it has no Metal path and does the whole thing on the CPU.
 *
 * They are no longer *the* floors: each model generation carries its own, because the two that ship
 * differ by nearly a factor of two in working set (`local-model-artefacts.ts`).
 */
export const MACOS_FLOOR_GB = 18;
export const WINDOWS_FLOOR_GB = 24;

/** One generation's RAM floors, as nominal shipping configurations. */
export interface MemoryFloors {
	darwin: number;
	win32: number;
}

const DEFAULT_FLOORS: MemoryFloors = { darwin: MACOS_FLOOR_GB, win32: WINDOWS_FLOOR_GB };

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
export function localModelBlock(machine: MachineFacts, floors: MemoryFloors = DEFAULT_FLOORS): LocalModelBlock | null {
	const supportedPlatform = machine.platform === "darwin" || machine.platform === "win32";
	if (!supportedPlatform || machine.arch !== "arm64") return { kind: "architecture" };

	const floorGb = machine.platform === "darwin" ? floors.darwin : floors.win32;
	if (machine.totalMemoryBytes >= thresholdBytes(floorGb)) return null;
	return { kind: "memory", floorGb, actualGb: Math.round(machine.totalMemoryBytes / GIB) };
}

/**
 * The dropdown's replacement text for a machine the model is not offered on (§4.3).
 *
 * Each is rendered as the *entire* option text of a disabled dropdown entry, so each is the whole
 * explanation and none has a card beneath it -- §4.1 attaches no card where the model cannot run.
 *
 * The memory string names the machine's own figure, because a bare requirement only sends the user
 * looking for what they have.
 */
export function localModelUnavailableLabel(block: LocalModelBlock, platform: string): string {
	if (block.kind === "architecture") {
		// Windows x64 is the one excluded architecture that *can* run the model -- what it cannot do is
		// get the engine past Defender (§4.2), and the free build's localhost backend reaches the same
		// models through a host the user installs themselves. Sending that user to "needs Apple Silicon
		// or Windows on ARM" would read as "buy another machine" when the way through is a setting away.
		// Nothing here says "coming": the measurement that would open the managed route can still say no.
		if (platform === "win32") return "Local model — not yet on Windows x64; use a localhost backend (Ollama, LM Studio)";
		// An Intel Mac has no such way through, so it keeps the plain hardware line.
		return "Local model — needs Apple Silicon or Windows on ARM";
	}
	const machine = platform === "darwin" ? "Mac" : "PC";
	return `Local model — needs ${block.floorGb} GB RAM (this ${machine} has ${block.actualGb} GB)`;
}
