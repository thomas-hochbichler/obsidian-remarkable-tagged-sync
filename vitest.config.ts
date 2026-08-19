import { defineConfig } from "vitest/config";

export default defineConfig({
	// Explicit, so a local run and a CI run cover the same files. `pro/` used to be excluded because
	// it existed only in the maintainer's working copy; it is published now, and leaving it out would
	// mean CI stopped testing the paid half of the product on the day it started being sold.
	test: {
		// `scripts/` is here for the release gates' own tests. They are not product code and are
		// deliberately outside the coverage numbers below, but the rules they check -- what happens
		// when a measurement did NOT arrive -- are exactly the paths that never run on a good day.
		include: ["src/**/*.test.ts", "pro/**/*.test.ts", "scripts/**/*.test.mjs"],

		coverage: {
			provider: "v8",

			// Spelled out, and that is the whole point. Vitest counts only the files a run actually
			// loaded unless `include` says otherwise -- so without these two lines `main.ts`, the
			// single largest untested file in the repo, would simply not appear, and every number
			// below would be flattering for exactly the reason the ratchet exists to prevent.
			include: ["src/**/*.ts", "pro/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.d.ts"],

			// `json-summary` feeds the ratchet and the badges; `json` is what the pull-request
			// comment reads to say which lines THIS change left uncovered. One run, three readers --
			// a second run could disagree with the first, and a badge that contradicts the gate is
			// worse than no badge.
			reporter: ["text-summary", "json-summary", "json"],
			reportsDirectory: "coverage",
		},
	},
	resolve: {
		// `obsidian` ships no resolvable entry point outside the app, so anything reachable from a test
		// gets the stub instead. See test-stubs/obsidian.ts for what it deliberately does not do.
		alias: { obsidian: new URL("./test-stubs/obsidian.ts", import.meta.url).pathname },
	},
});
