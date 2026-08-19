#!/usr/bin/env node
//
// The matrix link test. Loads test-matrix/*.yaml, enumerates the real suite with `vitest list`
// (collection only -- no test body ever runs), and fails on the four ways the matrix can lie:
//
//   1. a row that names a test which does not exist        -> the matrix claims coverage it has not got
//   2. a test that no row and no allowlist entry claims    -> a test was written without its row
//   3. a row with no scenario or no expected behaviour     -> a row that says nothing
//   4. an allowlist entry naming a test that is gone       -> the allowlist may only shrink
//
//   node scripts/matrix-link.mjs [--write-allowlist]
//
// `.mjs`, not `.ts`, and a script rather than a vitest test, for two separate reasons. It cannot be
// a vitest test because it has to enumerate the suite it would otherwise be inside. It is not
// TypeScript because `npm run build` runs tsc over scripts/, so a broken .ts gate script could
// block a release -- the same reasoning as release-checks.mjs, whose problem-reporting shape this
// copies.
//
// It lives in `test-matrix/` rather than `test/matrix/`: `test/` is the local Obsidian demo vault,
// which is gitignored AND a nested git repository, so nothing inside it can be committed.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { relative, join } from "node:path";

const MATRIX_DIR = "test-matrix";
const ALLOWLIST = "test-matrix/unclaimed-tests.txt";

// --- problems are grouped, because the output has to read as a to-do list ----------------------

const groups = new Map();
const fail = (group, line) => {
	if (!groups.has(group)) groups.set(group, []);
	groups.get(group).push(line);
};
const ok = (msg) => console.log(`  ok    ${msg}`);

// --- 1. load the matrix ------------------------------------------------------------------------

function loadMatrix() {
	const rows = [];
	const files = readdirSync(MATRIX_DIR)
		.filter((f) => f.endsWith(".yaml"))
		.sort();
	for (const f of files) {
		const path = join(MATRIX_DIR, f);
		const features = parseYaml(readFileSync(path, "utf8")) ?? [];
		for (const feature of features) {
			for (const s of feature.scenarios ?? []) {
				rows.push({ ...s, feature: feature.feature, name: feature.name, tier: s.tier ?? feature.tier, path });
			}
		}
	}
	return { rows, files };
}

// --- 2. enumerate the real suite, without running it --------------------------------------------
//
// ~1.6 s over 996 tests. Collection imports every test file, so listing costs nearly what running
// costs; there is nothing here worth optimising against a `verify` job that takes 44 s.

function listTests() {
	const out = execFileSync("npx", ["vitest", "list", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(out).map((t) => ({ name: t.name, file: relative(process.cwd(), t.file) }));
}

// --- 3. the checks -------------------------------------------------------------------------------

const { rows, files } = loadMatrix();
const tests = listTests();
console.log(`matrix link: ${rows.length} scenario rows in ${files.length} files, ${tests.length} tests collected\n`);

// -- row shape: a row must say what happens and what is expected, and be in exactly one state
const STATES = ["test", "gap", "waived"];
const seenIds = new Set();
for (const r of rows) {
	const where = `${r.path} ${r.id ?? "(row with no id)"}`;
	if (!r.id) fail("rows missing an id", `${r.path}: a scenario of ${r.feature} has no id`);
	else if (seenIds.has(r.id)) fail("duplicate row ids", `${where} is used twice`);
	else seenIds.add(r.id);

	if (!r.scenario || String(r.scenario).trim() === "")
		fail("rows with no scenario", `${where}  -- ${r.feature} ${r.name}: add \`scenario:\` (when does this happen?)`);
	if (!r.expect || String(r.expect).trim() === "")
		fail("rows with no expected behaviour", `${where}  -- ${r.feature} ${r.name}: add \`expect:\` (what must be true afterwards?)`);
	if (!r.layer) fail("rows with no layer", `${where}: add \`layer:\` (unit | engine | vault | e2e | nightly)`);

	const states = STATES.filter((k) => r[k]);
	if (states.length === 0)
		fail(
			"rows in no state",
			`${where}: add one of \`test:\` (it is covered), \`gap:\` (planned, cite the gap id) or \`waived:\` (never automated, say why)`,
		);
	if (states.length > 1) fail("rows in two states at once", `${where}: has ${states.join(" and ")} -- pick one`);
}

// -- the binding: file plus the exact `describe > it` name
//
// Not an id embedded in the test name. An id survives a rename, which sounds like the point and is
// the objection: it lets a row keep a claim about a test whose promise has changed underneath it,
// while the gate stays green. A name here is a sentence about a user-visible behaviour, so changing
// it SHOULD force a visit to the row.

const testKey = (t) => `${t.file} :: ${t.name}`;
const byKey = new Map(tests.map((t) => [testKey(t), t]));
const claimed = new Set();

for (const r of rows.filter((r) => r.test)) {
	if (!r.file) {
		fail("rows with no test file", `${r.path} ${r.id}: \`test:\` needs a \`file:\` beside it`);
		continue;
	}
	const key = `${r.file} :: ${r.test}`;
	if (byKey.has(key)) claimed.add(key);
	else
		fail(
			"rows naming a test that does not exist",
			`${r.id} ${r.feature} ${r.name}\n          wants: ${r.file} :: ${r.test}\n          -- write it, or fix the name in ${r.path} if the test was renamed`,
		);
}

// -- tests with no row, against the shrink-only allowlist
let allow = [];
try {
	allow = readFileSync(ALLOWLIST, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));
} catch {
	/* no allowlist yet */
}
const allowSet = new Set(allow);

if (process.argv.includes("--write-allowlist")) {
	const lines = tests
		.map(testKey)
		.filter((k) => !claimed.has(k))
		.sort();
	writeFileSync(
		ALLOWLIST,
		"# Tests that predate the matrix and have no row yet.\n" +
			"# This list may only ever shrink. A new test may not be added to it -- it needs a row.\n" +
			"# Regenerate deliberately with --write-allowlist; the diff must be reviewed as a ratchet reset.\n" +
			`${lines.join("\n")}\n`,
	);
	console.log(`wrote ${lines.length} entries to ${ALLOWLIST}`);
	process.exit(0);
}

for (const t of tests) {
	const key = testKey(t);
	if (claimed.has(key) || allowSet.has(key)) continue;
	fail(
		"tests with no matrix row",
		`${t.file} :: ${t.name}\n          -- add a scenario row under its feature in ${MATRIX_DIR}/, or say why it is not a feature`,
	);
}
for (const a of allow) {
	if (!byKey.has(a))
		fail(
			"allowlist entries whose test is gone",
			`${a}\n          -- the test was renamed or deleted; drop the line (the allowlist may only shrink)`,
		);
}

// --- 4. the report --------------------------------------------------------------------------------

const bound = rows.filter((r) => r.test).length;
const planned = rows.filter((r) => r.gap).length;
const waived = rows.filter((r) => r.waived).length;
const featureCount = new Set(rows.map((r) => r.feature)).size;

if (groups.size === 0) {
	ok(`${bound} rows bound to a test`);
	ok(`${planned} rows planned (gap ids: ${[...new Set(rows.filter((r) => r.gap).map((r) => r.gap))].sort().join(", ")})`);
	ok(`${waived} row${waived === 1 ? "" : "s"} waived`);
	ok(`${allow.length} tests on the shrink-only allowlist`);
	console.log(`\nmatrix link: PASS -- ${featureCount} features, ${rows.length} scenarios, nothing unaccounted for`);
	process.exit(0);
}

console.error("matrix link: FAIL\n");
let total = 0;
const CAP = 15;
for (const [group, lines] of groups) {
	console.error(`${lines.length} ${group}:`);
	for (const l of lines.slice(0, CAP)) console.error(`    [ ] ${l}`);
	if (lines.length > CAP) console.error(`    ... and ${lines.length - CAP} more of the same`);
	console.error("");
	total += lines.length;
}
console.error(`${total} thing${total === 1 ? "" : "s"} to fix. The matrix is the completeness truth; it is wrong until this passes.`);
process.exit(1);
