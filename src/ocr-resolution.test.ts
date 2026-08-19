import { describe, expect, it } from "vitest";
import {
	defaultOcrBackend,
	hasAlternativeBackends,
	hasCloudBackends,
	hasOnDeviceBackends,
	isGated,
	planGatedFallback,
	planUnconfiguredFallback,
} from "./ocr-resolution";

const VISION = { id: "vision", metered: false };
const OFF = { id: "off", metered: false };
const CLOUD = { id: "anthropic", metered: true };
const LOCAL_MODEL = { id: "local-model", metered: false };

describe("defaultOcrBackend", () => {
	it("is Apple Vision where Apple Vision runs", () => {
		expect(defaultOcrBackend(true)).toBe("vision");
	});

	// Not "vision, disabled". Defaulting to an option the user cannot use and cannot change away
	// from without first understanding why is worse than defaulting to nothing.
	it("is off where it does not, rather than a backend that is there but cannot run", () => {
		expect(defaultOcrBackend(false)).toBe("off");
	});
});

describe("what a build has to offer", () => {
	it("counts no alternative when all it has is the two every build has", () => {
		expect(hasAlternativeBackends([VISION, OFF])).toBe(false);
	});

	it("counts one as soon as anything else registers", () => {
		expect(hasAlternativeBackends([VISION, OFF, LOCAL_MODEL])).toBe(true);
	});

	it("says there are cloud backends only when something actually costs money per page", () => {
		expect(hasCloudBackends([VISION, OFF, LOCAL_MODEL])).toBe(false);
		expect(hasCloudBackends([VISION, OFF, CLOUD])).toBe(true);
	});

	// This is the 1.1.0 regression, as a test. A free user on a supported Mac, with Apple Vision and
	// an offline model and nothing else, was told their pages go to a provider with their own key --
	// because the description asked "are there alternatives" and used the answer to claim a network.
	it("tells an on-device alternative apart from a cloud one, which is what the wrong string could not", () => {
		const freeLocalBuild = [VISION, OFF, LOCAL_MODEL];
		expect(hasAlternativeBackends(freeLocalBuild)).toBe(true);
		expect(hasOnDeviceBackends(freeLocalBuild)).toBe(true);
		expect(hasCloudBackends(freeLocalBuild)).toBe(false);
	});

	it("does not count the two built-in ones as on-device alternatives, though neither is metered", () => {
		expect(hasOnDeviceBackends([VISION, OFF])).toBe(false);
	});

	it("answers all four questions with no for a build that registered nothing at all", () => {
		expect([hasAlternativeBackends([]), hasCloudBackends([]), hasOnDeviceBackends([])]).toEqual([
			false,
			false,
			false,
		]);
	});
});

// The line the whole paid tier rests on. It is one boolean, and removing it left all 996 tests this
// repo had green -- which is the argument for it being a named function with its own tests rather
// than an expression inside a method nothing can construct.
describe("isGated", () => {
	const paid = { label: "Anthropic", requiresLicence: true };
	const free = { label: "Ollama", requiresLicence: false };

	it("stops a paid backend for someone who has not bought", () => {
		expect(isGated(paid, "free")).toBe(true);
	});

	it("lets it through for a licence and for a trial alike", () => {
		expect(isGated(paid, "pro")).toBe(false);
		expect(isGated(paid, "trial")).toBe(false);
	});

	it("never stops a backend that does not ask for a licence", () => {
		expect(isGated(free, "free")).toBe(false);
		expect(isGated(free, "pro")).toBe(false);
	});
});

describe("the fallback for a backend that needs a licence", () => {
	const input = { label: "Anthropic", visionAvailable: true, silent: false };

	it("uses free local Apple Vision and says which backend needed Pro", () => {
		expect(planGatedFallback(input)).toEqual({
			use: "vision",
			notice: "Anthropic needs Tagged Sync Pro. Using Apple Vision instead.",
		});
	});

	it("is honest where there is no local transcription at all, instead of naming a fallback there is none of", () => {
		const plan = planGatedFallback({ ...input, visionAvailable: false });
		expect(plan.use).toBe("unavailable");
		expect(plan.notice).toContain("Nothing will be transcribed");
	});

	it("says nothing on a background run, and refuses just the same", () => {
		expect(planGatedFallback({ ...input, silent: true })).toEqual({ use: "vision", notice: null });
	});
});

describe("the fallback for a backend that has no key", () => {
	const input = { label: "Anthropic", visionAvailable: true, silent: false };

	it("uses free local Apple Vision and says which key is missing", () => {
		expect(planUnconfiguredFallback(input)).toEqual({
			use: "vision",
			notice: "No API key set for Anthropic — using Apple Vision (local) for this sync.",
		});
	});

	it("says nothing on a background run, and falls back just the same", () => {
		expect(planUnconfiguredFallback({ ...input, silent: true })).toEqual({ use: "vision", notice: null });
	});

	// The asymmetry is the shipped behaviour and is pinned rather than smoothed over: the gated
	// fallback speaks on a machine with no Vision and this one does not. Nothing here is silent to
	// the user in the end -- an unavailable backend is reported by the run's own summary -- but the
	// two paths differ, and a test that hid that would be describing a plugin nobody ships.
	it("says nothing where Apple Vision cannot run, unlike the licence fallback", () => {
		expect(planUnconfiguredFallback({ ...input, visionAvailable: false })).toEqual({
			use: "unavailable",
			notice: null,
		});
	});

	// The rule G14 exists for, stated once: there is no third option, so there is nothing for a
	// future edit to point at that would start spending the user's money.
	it("never has a third option to fall back to", () => {
		const uses = [true, false].flatMap((visionAvailable) =>
			[true, false].map((silent) => planUnconfiguredFallback({ ...input, visionAvailable, silent }).use),
		);
		expect(new Set(uses)).toEqual(new Set(["vision", "unavailable"]));
	});
});
