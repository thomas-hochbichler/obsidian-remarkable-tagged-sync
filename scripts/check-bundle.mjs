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
// 2. The licence gate. This group was inverted on the day `pro/` was published.
//
//    It used to assert that four cloud hostnames were ABSENT from `main.js` -- the free bundle was
//    the only bundle allowed out, and a pro build overwriting it was the failure to catch. There is
//    one bundle now, the cloud backends are in it on purpose, and those needles would fail on every
//    release forever. The script's own rule applied: a needle that cannot tell two bundles apart is
//    worse than one fewer, because a gate nobody can keep green gets waved past.
//
//    So it asks the opposite question, and it is the more dangerous one: is the LICENCE CHECK still
//    in the bytes about to be published? A build that ships the paid backends with the gate stripped
//    out -- by a bad merge, a tree-shake, a stray edit -- would look completely normal and give the
//    product away. Both needles must be PRESENT; zero is the failure.
//
//    They are the Polar API host and the public organization id: two strings that only exist in
//    `src/licence-client.ts` and cannot be produced by a comment, which is what the old group's
//    seventh needle kept tripping over.

import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "main.js";

// Both quote styles: esbuild's output quoting is not something to depend on.
const OBFUSCATION = [
	{ label: 'createElement("script")', needles: ['createElement("script")', "createElement('script')"] },
	{ label: "new Function", needles: ["new Function"] },
];

const GATE = ["api.polar.sh", "e1f4bd71-6fb3-4f0f-a602-f42985a89e15"];

let bundle;
try {
	bundle = readFileSync(file, "utf8");
} catch {
	console.error(`bundle scan: cannot read ${file} -- run \`npm run build\` first`);
	process.exit(1);
}

const countOf = (needle) => bundle.split(needle).length - 1;
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

// The mirror image: here zero is the failure. Kept as its own function rather than a flag on
// `report`, so that reading the loop below tells you which way round the test runs.
const reportPresent = (label, hits) => {
	if (hits > 0) {
		console.log(`  ok    ${label}: ${hits}`);
	} else {
		console.error(`  FAIL  ${label}: 0 -- the licence gate is not in this bundle`);
		failed = true;
	}
};

console.log("obfuscation patterns (the store rejects these)");
for (const { label, needles } of OBFUSCATION) {
	report(label, needles.reduce((n, needle) => n + countOf(needle), 0));
}

console.log("\nlicence gate (must be in every published bundle)");
for (const needle of GATE) reportPresent(needle, countOf(needle));

if (failed) {
	console.error("\nbundle scan: FAIL");
	console.error("If a licence-gate needle is missing: this bundle would give the paid backends away. Do not publish it.");
	console.error("If an obfuscation pattern hit: a dependency reintroduced a polyfill. See the aliases in esbuild.config.mjs.");
	process.exit(1);
}
console.log("\nbundle scan: PASS");
