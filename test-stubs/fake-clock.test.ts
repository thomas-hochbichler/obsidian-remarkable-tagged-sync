import { describe, expect, it } from "vitest";
import { FakeClock } from "./fake-clock";

// The clock is a test double, so it gets the same treatment as the rest of them: what the plugin's
// scheduling tests rely on is asserted here, once, rather than inside each of them.

describe("a clock a test moves by hand", () => {
	it("fires a timeout when its moment arrives, and not before", () => {
		const clock = new FakeClock();
		const fired: string[] = [];
		clock.setTimeout(() => fired.push("launch"), 4_000);

		clock.advance(3_999);
		expect(fired).toEqual([]);

		clock.advance(1);
		expect(fired).toEqual(["launch"]);
	});

	it("forgets a one-shot once it has fired", () => {
		// What "armed" counts is timers still to come, so a fired timeout must leave nothing behind.
		const clock = new FakeClock();
		clock.setTimeout(() => undefined, 10);

		expect(clock.armed).toBe(1);
		clock.advance(10);
		expect(clock.armed).toBe(0);
	});

	it("fires an interval once per period, however far time jumps", () => {
		const clock = new FakeClock();
		let ticks = 0;
		clock.setInterval(() => ticks++, 100);

		clock.advance(350);

		expect(ticks).toBe(3);
		expect(clock.armed).toBe(1);
	});

	it("fires timers in the order they fall due, not the order they were armed", () => {
		const clock = new FakeClock();
		const fired: string[] = [];
		clock.setTimeout(() => fired.push("late"), 200);
		clock.setTimeout(() => fired.push("early"), 100);

		clock.advance(200);

		expect(fired).toEqual(["early", "late"]);
	});

	it("lets a callback re-arm the timer it is running in", () => {
		// This is what rearmAutoSyncInterval does from inside a run: clear the interval and install a
		// fresh one. A clock that collected the due timers up front would fire the cleared one anyway.
		const clock = new FakeClock();
		const fired: string[] = [];
		let id = clock.setInterval(() => {
			fired.push("old");
			clock.clearInterval(id);
			id = clock.setInterval(() => fired.push("new"), 100);
		}, 100);

		clock.advance(250);

		expect(fired).toEqual(["old", "new"]);
		expect(clock.armed).toBe(1);
	});

	it("stops firing a timer that was cleared before its moment", () => {
		const clock = new FakeClock();
		let fired = false;
		const id = clock.setTimeout(() => (fired = true), 100);

		clock.clearTimeout(id);
		clock.advance(1_000);

		expect(fired).toBe(false);
		expect(clock.armed).toBe(0);
	});

	it("counts every timer nobody cleared -- which is what a leak looks like", () => {
		const clock = new FakeClock();
		for (let i = 0; i < 5; i++) clock.setInterval(() => undefined, 100);

		expect(clock.armed).toBe(5);
	});

	it("reads back the time it was moved to, so a due check can be asked the same question", () => {
		const clock = new FakeClock();
		expect(clock.now()).toBe(0);

		clock.advance(6 * 3_600_000);

		expect(clock.now()).toBe(6 * 3_600_000);
	});

	it("leaves time exactly where it was asked to stop, not on the last timer it fired", () => {
		const clock = new FakeClock();
		clock.setTimeout(() => undefined, 10);

		clock.advance(1_000);

		expect(clock.now()).toBe(1_000);
	});
});
