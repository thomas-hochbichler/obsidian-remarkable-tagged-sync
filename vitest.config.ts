import { defineConfig } from "vitest/config";

export default defineConfig({
	// Explicit, so a local run and a CI run cover the same files. Without it vitest also picks up
	// `pro/`'s premium tests, which exist only in the maintainer's working copy -- local was 277
	// tests and CI 211, and nobody chose that. `pro/` runs via `npm run test:pro`, an explicit
	// opt-in in the same shape as esbuild's TAGGED_SYNC_BUILD=pro. CI never sets it.
	test: {
		include: process.env.TAGGED_SYNC_TEST === "pro" ? ["pro/**/*.test.ts"] : ["src/**/*.test.ts"],
	},
	resolve: {
		// `obsidian` ships no resolvable entry point outside the app, so anything reachable from a test
		// gets the stub instead. See test-stubs/obsidian.ts for what it deliberately does not do.
		alias: { obsidian: new URL("./test-stubs/obsidian.ts", import.meta.url).pathname },
	},
});
