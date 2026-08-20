/**
 * A clock a test moves by hand.
 *
 * The plugin schedules two things -- a sync a few seconds after launch, and an interval backstop --
 * and the interesting questions about both are questions about time: does the launch sync wait, does
 * a re-arm clear the timer it replaces, does unloading leave anything running. None of that can be
 * asked of a real timer without the test sitting there for hours.
 *
 * `armed` is the one that catches leaks: a timer nobody cleared is not a wrong value anywhere, it is
 * a count that never comes down.
 */

interface Timer {
	/** When it next fires, on this clock's own scale. */
	at: number;
	/** Milliseconds between firings, or null for a one-shot. */
	readonly every: number | null;
	readonly fn: () => void;
}

export class FakeClock {
	private time = 0;
	private nextId = 1;
	private readonly timers = new Map<number, Timer>();

	now(): number {
		return this.time;
	}

	setTimeout(fn: () => void, ms: number): number {
		return this.arm({ at: this.time + ms, every: null, fn });
	}

	setInterval(fn: () => void, ms: number): number {
		return this.arm({ at: this.time + ms, every: ms, fn });
	}

	clearTimeout(id: number): void {
		this.timers.delete(id);
	}

	clearInterval(id: number): void {
		this.timers.delete(id);
	}

	/** Not a `Window` member. How many timers are still armed -- what a leak is counted in. */
	get armed(): number {
		return this.timers.size;
	}

	/**
	 * Not a `Window` member. Moves time forward, firing everything that falls due, in due order.
	 *
	 * A callback may arm or clear timers while this runs, which is exactly what a re-arm does, so the
	 * due timer is re-read from the map on every pass rather than collected up front.
	 */
	advance(ms: number): void {
		const until = this.time + ms;
		for (;;) {
			const next = this.nextDue(until);
			if (next === null) break;
			const [id, timer] = next;
			this.time = timer.at;
			if (timer.every === null) this.timers.delete(id);
			else timer.at += timer.every;
			timer.fn();
		}
		this.time = until;
	}

	private arm(timer: Timer): number {
		const id = this.nextId++;
		this.timers.set(id, timer);
		return id;
	}

	private nextDue(until: number): [number, Timer] | null {
		let due: [number, Timer] | null = null;
		for (const entry of this.timers) {
			if (entry[1].at > until) continue;
			if (due === null || entry[1].at < due[1].at) due = entry;
		}
		return due;
	}
}
