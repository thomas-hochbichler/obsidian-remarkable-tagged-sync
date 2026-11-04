#!/usr/bin/env node
//
// Runs any TypeScript file against the plugin's own code -- a live check, a one-off measurement, a
// research script under .scratch -- with the flags every bundled script in package.json uses:
//
//   npm run ts -- <file.ts> [args...]
//
// Bundled, not loaded: `obsidian` has no entry point outside the app, so it is aliased to the test
// stub, and iconv-lite stays external as everywhere else. ESM, so a script may `await` at the top;
// the banner gives the CommonJS dependencies inside the bundle the `require` they call.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
	console.error("usage: npm run ts -- <file.ts> [args...]");
	process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "tagged-sync-ts-"));
const outfile = join(dir, "run.mjs");
try {
	await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
		outfile,
		logLevel: "warning",
		alias: { obsidian: resolve("tests/stubs/obsidian.ts") },
		external: ["iconv-lite"],
	});
	process.exitCode = spawnSync(process.execPath, [outfile, ...args], { stdio: "inherit" }).status ?? 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
