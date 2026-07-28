import { OffOcrBackend } from "./off-ocr-backend";
import { registerOcrBackend } from "./ocr-registry";
import { createVisionOcrBackend, visionUnavailableReason } from "./vision-ocr-runtime";
import type { VisionOcrBackend } from "./vision-ocr-backend";

/** Created lazily (the constructor reads node modules) and cached for the session. */
let cached: VisionOcrBackend | null = null;

export function visionBackend(): VisionOcrBackend {
	return (cached ??= createVisionOcrBackend());
}

registerOcrBackend({
	id: "vision",
	label: "Apple Vision (local, default)",
	metered: false,
	// Shown everywhere, disabled where it can't run, so the gap explains itself in place (spec §4.2).
	unavailableLabel() {
		const reason = visionUnavailableReason();
		if (!reason) return null;
		return reason === "needs-macos-13" ? "Apple Vision — needs macOS 13 or later" : "Apple Vision — macOS only";
	},
	create: () => visionBackend(),
});

// Registered after Vision so it sits below it in the dropdown, and so that a build with neither
// additional backends nor a usable Vision still has something selectable.
registerOcrBackend({
	id: "off",
	label: "Off — no transcription",
	metered: false,
	create: () => new OffOcrBackend(),
});
