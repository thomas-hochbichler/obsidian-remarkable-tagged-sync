/**
 * The clock the plugin schedules its unattended work against.
 *
 * A parameter rather than `window` for one reason: the two things scheduled here are "a few seconds
 * after launch" and "every six hours", and neither can be asked of a real timer without a test
 * sitting there for six hours. The questions that matter are all about time -- does the launch sync
 * wait, does a re-arm replace the timer it succeeds, does unloading leave anything running.
 *
 * `now` belongs here with the timers because the interval's tick asks it whether the interval has
 * actually elapsed. Split across two clocks, a test can move one and not the other and get an answer
 * the running plugin would never give.
 *
 * Deliberately not Obsidian's `registerInterval`: that clears only on unload, so re-arming -- which
 * every finished run does -- would leave the old one behind, every time.
 */
export interface Scheduler {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(id: number): void;
	setInterval(fn: () => void, ms: number): number;
	clearInterval(id: number): void;
	/** Milliseconds since the epoch, on the same clock the timers run on. */
	now(): number;
}

/** What the plugin runs on inside Obsidian. */
export const windowScheduler: Scheduler = {
	setTimeout: (fn, ms) => window.setTimeout(fn, ms),
	clearTimeout: (id) => window.clearTimeout(id),
	setInterval: (fn, ms) => window.setInterval(fn, ms),
	clearInterval: (id) => window.clearInterval(id),
	now: () => Date.now(),
};
