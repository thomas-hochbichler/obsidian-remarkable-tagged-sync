#!/usr/bin/env node
//
// Scans the BUILT bundle, not `src/`. This is the check that would have caught the store
// rejection of 1.0.5 before the reviewer did -- both problems it looks for live in bundled
// dependency code, where no lint of our own source could ever see them.
//
//   node scripts/check-bundle.mjs [path]     # default: main.js
//
// Two groups:
//
// 1. Obfuscation. The store returns a blocking Error for dynamic <script> creation and
//    `new Function`. Ours came from jszip's pre-built `dist/jszip.min.js`, which has the
//    `setimmediate` and `immediate` polyfills baked in: 4 + 1 sites, an exact count match.
//    esbuild.config.mjs now aliases them away, so the expected count is 0. If this ever goes
//    non-zero again, a dependency bump has reintroduced a polyfill -- look at the aliases first.
//
// 2. Premium. `main.js` is the release asset, and a pro build used to overwrite it. That is fixed
//    at the root (the pro build writes `main.pro.js` now), but this stays as the second layer:
//    it reads the actual bytes about to be published.
//
//    Measured against a real pro build, not just against `pro/` source: 6 of the 7 needles fire
//    (2-7 hits each) and 0 fire on the free bundle.
//
//    The 7th, "premium", is live too, and it is worth knowing why: the build does not minify, so
//    first-party COMMENTS are copied into `main.js` verbatim. This gate failed during the 1.0.6
//    work on a comment in `src/main.ts` that merely used the word. So a hit here does not
//    necessarily mean a pro build leaked -- check your own comments first.

import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "main.js";

// Both quote styles: esbuild's output quoting is not something to depend on.
const OBFUSCATION = [
	{ label: 'createElement("script")', needles: ['createElement("script")', "createElement('script')"] },
	{ label: "new Function", needles: ["new Function"] },
];

const PREMIUM = [
	"api.anthropic.com",
	"openrouter",
	"lmstudio",
	"x-api-key",
	"chat/completions",
	"Transcribe the handwritten",
	"premium",
];

let bundle;
try {
	bundle = readFileSync(file, "utf8");
} catch {
	console.error(`bundle scan: cannot read ${file} -- run \`npm run build\` first`);
	process.exit(1);
}

const countOf = (needle) => bundle.split(needle).length - 1;
// Premium needles are brand and marker strings, so case must not matter: the only hit for
// "premium" inside `pro/` is spelled `Premium`, and a case-sensitive scan silently misses it.
// Verified to still give 0 false positives against the real free bundle. The obfuscation needles
// stay case-sensitive -- they are exact JS syntax, and `new function` lowercase is a different
// (legal) construct.
const countInsensitive = (needle) => bundleLower.split(needle.toLowerCase()).length - 1;

const bundleLower = bundle.toLowerCase();

// Byte length, not string length -- they differ (1 244 016 chars vs 1 244 046 bytes) and the
// byte figure is the one that matches `ls` and the published asset.
console.log(`bundle scan: ${file}, ${Buffer.byteLength(bundle, "utf8").toLocaleString("en-US")} bytes\n`);

let failed = false;
const report = (label, hits) => {
	if (hits === 0) {
		console.log(`  ok    ${label}: 0`);
	} else {
		console.error(`  FAIL  ${label}: ${hits}`);
		failed = true;
	}
};

console.log("obfuscation patterns (the store rejects these)");
for (const { label, needles } of OBFUSCATION) {
	report(label, needles.reduce((n, needle) => n + countOf(needle), 0));
}

console.log("\npremium needles (must never reach the free bundle)");
for (const needle of PREMIUM) report(needle, countInsensitive(needle));

if (failed) {
	console.error("\nbundle scan: FAIL");
	console.error("If a premium needle hit: `main.js` holds a pro build. Run `npm run build` and never publish by hand.");
	console.error("If an obfuscation pattern hit: a dependency reintroduced a polyfill. See the aliases in esbuild.config.mjs.");
	process.exit(1);
}
console.log("\nbundle scan: PASS");
