import { defineConfig } from "vitest/config";

export default defineConfig({
	// Explicit, so a local run and a CI run cover the same files. `pro/` used to be excluded because
	// it existed only in the maintainer's working copy; it is published now, and leaving it out would
	// mean CI stopped testing the paid half of the product on the day it started being sold.
	test: {
		// `scripts/` is here for the release gates' own tests. They are not product code and are
		// deliberately outside the coverage numbers below, but the rules they check -- what happens
		// when a measurement did NOT arrive -- are exactly the paths that never run on a good day.
		// `test-stubs/` is here for the fake Obsidian's own tests. A test double with behaviour --
		// this one throws, folds case and normalises paths -- is code, and untested code in a test
		// double is the failure mode a fake exists to prevent.
		// `test-support/` is here for the nightly's measuring instrument (cer.ts): an unverified
		// measuring instrument is worse than none. Like `scripts/`, it is not product code and stays
		// outside the coverage numbers below.
		include: ["src/**/*.test.ts", "pro/**/*.test.ts", "scripts/**/*.test.mjs", "test-stubs/**/*.test.ts", "test-support/**/*.test.ts"],

		// Externalised dependencies bypass the alias above; rmapi-js has to go through Vite for the
		// `crc-32/crc32c` rewrite to reach its import.
		server: { deps: { inline: ["rmapi-js"] } },

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
		alias: {
			obsidian: new URL("./test-stubs/obsidian.ts", import.meta.url).pathname,
			// rmapi-js imports `crc-32/crc32c` without the `.js` that Node's ESM resolver insists on;
			// esbuild forgives that in the shipped bundle, Node does not in a test. Spelled out here so
			// a test can run the real library -- its parsing is what issue #156 is about.
			"crc-32/crc32c": "crc-32/crc32c.js",
		},
	},
});
