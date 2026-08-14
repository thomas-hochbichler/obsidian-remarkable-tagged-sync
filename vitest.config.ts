import { defineConfig } from "vitest/config";

export default defineConfig({
	// Explicit, so a local run and a CI run cover the same files. `pro/` used to be excluded because
	// it existed only in the maintainer's working copy; it is published now, and leaving it out would
	// mean CI stopped testing the paid half of the product on the day it started being sold.
	test: {
		include: ["src/**/*.test.ts", "pro/**/*.test.ts"],
	},
	resolve: {
		// `obsidian` ships no resolvable entry point outside the app, so anything reachable from a test
		// gets the stub instead. See test-stubs/obsidian.ts for what it deliberately does not do.
		alias: { obsidian: new URL("./test-stubs/obsidian.ts", import.meta.url).pathname },
	},
});
