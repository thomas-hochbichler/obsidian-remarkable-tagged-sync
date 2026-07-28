import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// `obsidian` ships no resolvable entry point outside the app, so anything reachable from a test
		// gets the stub instead. See test-stubs/obsidian.ts for what it deliberately does not do.
		alias: { obsidian: new URL("./test-stubs/obsidian.ts", import.meta.url).pathname },
	},
});
