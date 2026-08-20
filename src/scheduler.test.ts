import { afterEach, describe, expect, it, vi } from "vitest";
import { windowScheduler } from "./scheduler";

// The adapter every shipped run actually uses, and the one no other test touches -- they all inject a
// clock instead. Five one-line delegations, and a `clearTimeout` wired to `clearInterval` would leak
// one timer per re-arm in the released plugin while every scheduling test stayed green.

const calls: [string, unknown][] = [];

function stubWindow(): void {
	vi.stubGlobal("window", {
		setTimeout: (fn: () => void, ms: number) => {
			calls.push(["setTimeout", ms]);
			void fn;
			return 11;
		},
		clearTimeout: (id: number) => calls.push(["clearTimeout", id]),
		setInterval: (fn: () => void, ms: number) => {
			calls.push(["setInterval", ms]);
			void fn;
			return 22;
		},
		clearInterval: (id: number) => calls.push(["clearInterval", id]),
	});
}

afterEach(() => {
	calls.length = 0;
	vi.unstubAllGlobals();
});

describe("windowScheduler", () => {
	it("arms a one-shot through the platform and hands its id back", () => {
		stubWindow();

		expect(windowScheduler.setTimeout(() => undefined, 4_000)).toBe(11);
		expect(calls).toEqual([["setTimeout", 4_000]]);
	});

	it("arms a repeat through the platform and hands its id back", () => {
		stubWindow();

		expect(windowScheduler.setInterval(() => undefined, 6 * 3_600_000)).toBe(22);
		expect(calls).toEqual([["setInterval", 6 * 3_600_000]]);
	});

	it("cancels each kind with its own canceller", () => {
		// The one that matters. Clearing an interval with clearTimeout leaves it running, and the
		// plugin re-arms after every sync -- so the leak would be one timer per run, forever.
		stubWindow();

		windowScheduler.clearTimeout(11);
		windowScheduler.clearInterval(22);

		expect(calls).toEqual([
			["clearTimeout", 11],
			["clearInterval", 22],
		]);
	});

	it("reads the wall clock, which is the one lastSyncAt is written on", () => {
		const before = Date.now();

		const now = windowScheduler.now();

		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
	});
});
