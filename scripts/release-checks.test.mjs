/**
 * The maintenance line, through the gate script as a release runs it: a real repository with a real
 * `origin`, and `release-checks.mjs` started in it.
 *
 * Nothing here can be asked of a smaller unit, because what these gates get wrong is the meeting of
 * three things no function holds together: the files in the tree, the branch HEAD is on, and what
 * `origin` says that branch is.
 */

import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./release-checks.mjs", import.meta.url));
const LICENSE = "SEE LICENSE IN LICENSING.md";
const MAINTENANCE = "release/1.10.x";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const verdict = (ageHours) =>
	JSON.stringify({
		schema: 1,
		commit: "abc1234",
		runId: "1",
		runUrl: "https://example.invalid/run/1",
		parts: Object.fromEntries(["ocr", "perf", "vision"].map((p) => [p, { status: "pass", measuredAt: hoursAgo(ageHours), detail: {} }])),
	});
const FRESH = verdict(9);
const STALE = verdict(24 * 30);

function write(dir, { version, minApp = "1.5.7", versions, frozen = "1.10.0", nightly = FRESH }) {
	const json = (name, value) => writeFileSync(join(dir, name), `${JSON.stringify(value, null, "\t")}\n`);
	json("manifest.json", { id: "fixture", version, minAppVersion: minApp });
	json("package.json", { name: "fixture", version, license: LICENSE });
	json("package-lock.json", { version, packages: { "": { version, license: LICENSE } } });
	json("versions.json", versions);
	mkdirSync(join(dir, "test-fixtures/legacy-state"), { recursive: true });
	json("test-fixtures/legacy-state/meta.json", { version: frozen });
	writeFileSync(join(dir, "CHANGELOG.md"), `## [Unreleased]\n\n## [${version}] - 2026-11-04\n\n### Fixed\n\n- A fix.\n`);
	writeFileSync(join(dir, ".nightly-verdict.json"), nightly);
}

function run(dir, ...args) {
	const r = spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * A clone of a bare `origin`, whose `main` holds `main` and whose maintenance branch, when asked for,
 * holds `branch`. HEAD is left on `head`.
 */
function repository({ main, branch, head = "main" }) {
	const root = mkdtempSync(join(tmpdir(), "tagged-sync-release-checks-"));
	roots.push(root);
	const origin = join(root, "origin.git");
	const dir = join(root, "clone");
	execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
	execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
	const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	git("remote", "add", "origin", origin);

	write(dir, main);
	git("add", "-A");
	git("commit", "--quiet", "-m", "Main");
	git("push", "--quiet", "origin", "main");

	if (branch) {
		git("switch", "--quiet", "-c", MAINTENANCE);
		write(dir, branch);
		git("add", "-A");
		git("commit", "--quiet", "--allow-empty", "-m", "Release");
		git("push", "--quiet", "origin", MAINTENANCE);
	}
	git("switch", "--quiet", head);
	return { dir, git, origin, root };
}

const MAIN_1_11 = { version: "1.11.0", minApp: "1.13.4", versions: { "1.10.0": "1.5.7", "1.11.0": "1.13.4" }, frozen: "1.11.0" };
const BRANCH_1_10_1 = { version: "1.10.1", versions: { "1.9.2": "1.5.7", "1.10.0": "1.5.7", "1.10.1": "1.5.7" }, frozen: "1.9.2" };

describe("version gate: a 1.10.x key on main", () => {
	it("does not push the frozen state out of the 1.11.0 release PR", () => {
		const { dir } = repository({
			main: {
				version: "1.11.0",
				minApp: "1.13.4",
				versions: { "1.10.0": "1.5.7", "1.10.1": "1.5.7", "1.11.0": "1.13.4" },
				frozen: "1.10.0",
			},
		});
		const { status, out } = run(dir, "version");
		expect(out).toContain("legacy-state produced by 1.10.0");
		expect(status).toBe(0);
	});

	it("does not push the 1.11.0 freeze out when two keys land after 1.11.0", () => {
		const { dir } = repository({
			main: {
				version: "1.11.0",
				minApp: "1.13.4",
				versions: { "1.10.0": "1.5.7", "1.11.0": "1.13.4", "1.10.1": "1.5.7", "1.10.2": "1.5.7" },
				frozen: "1.11.0",
			},
		});
		expect(run(dir, "version").status).toBe(0);
	});

	it("does not buy a state two main releases old any extra time", () => {
		const { dir } = repository({
			main: {
				version: "1.12.0",
				minApp: "1.13.4",
				versions: { "1.10.0": "1.5.7", "1.11.0": "1.13.4", "1.10.1": "1.5.7", "1.12.0": "1.13.4" },
				frozen: "1.10.0",
			},
		});
		const { status, out } = run(dir, "version");
		expect(out).toContain("expected 1.11.0 or 1.12.0");
		expect(status).toBe(1);
	});

	it("passes on the maintenance branch, whose state stays where main froze it", () => {
		const { dir } = repository({ main: MAIN_1_11, branch: BRANCH_1_10_1, head: MAINTENANCE });
		expect(run(dir, "version").status).toBe(0);
	});
});

describe("tag pre-check: where a version may be tagged", () => {
	it("lets 1.10.1 through on the tip of release/1.10.x", () => {
		const { dir } = repository({ main: MAIN_1_11, branch: BRANCH_1_10_1, head: MAINTENANCE });
		const { status, out } = run(dir, "tag", "1.10.1");
		expect(out).toContain("HEAD is origin/release/1.10.x");
		expect(status).toBe(0);
	});

	it("refuses 1.10.1 on main, because it ships from its own branch", () => {
		const { dir } = repository({ main: BRANCH_1_10_1, branch: BRANCH_1_10_1 });
		const { status, out } = run(dir, "tag", "1.10.1");
		expect(out).toContain("is not origin/release/1.10.x");
		expect(status).toBe(1);
	});

	it("says what is wrong when release/1.10.x does not exist yet", () => {
		const { dir } = repository({ main: BRANCH_1_10_1 });
		const { status, out } = run(dir, "tag", "1.10.1");
		expect(out).toContain("could not fetch origin/release/1.10.x");
		expect(status).toBe(1);
	});

	it("refuses 1.10.1 on a commit release/1.10.x does not have yet", () => {
		const { dir, git } = repository({ main: MAIN_1_11, branch: BRANCH_1_10_1, head: MAINTENANCE });
		git("commit", "--quiet", "--allow-empty", "-m", "Not pushed");
		const { status, out } = run(dir, "tag", "1.10.1");
		expect(out).toContain("is not origin/release/1.10.x");
		expect(status).toBe(1);
	});

	it("refuses 1.11.0 on the maintenance branch, because anything else still ships from main", () => {
		const { dir } = repository({ main: MAIN_1_11, branch: MAIN_1_11, head: MAINTENANCE });
		const { status, out } = run(dir, "tag", "1.11.0");
		expect(out).toContain("is not origin/main");
		expect(status).toBe(1);
	});

	it("still lets 1.11.0 through on the tip of main", () => {
		const { dir } = repository({ main: MAIN_1_11 });
		const { status, out } = run(dir, "tag", "1.11.0");
		expect(out).toContain("HEAD is origin/main");
		expect(status).toBe(0);
	});

	it("still ships 1.10.0 itself from main: the line starts after it", () => {
		const { dir } = repository({ main: { version: "1.10.0", versions: { "1.9.2": "1.5.7", "1.10.0": "1.5.7" }, frozen: "1.9.2" } });
		expect(run(dir, "tag", "1.10.0").status).toBe(0);
	});
});

describe("nightly gate: a maintenance release reads main's verdict", () => {
	const stale = { ...BRANCH_1_10_1, nightly: STALE };

	it("passes on main's fresh verdict although the branch's own file is old", () => {
		const { dir } = repository({ main: MAIN_1_11, branch: stale, head: MAINTENANCE });
		expect(run(dir, "nightly").status).toBe(0);
	});

	it("fails on main's stale verdict although the branch's own file is fresh", () => {
		const { dir } = repository({ main: { ...MAIN_1_11, nightly: STALE }, branch: BRANCH_1_10_1, head: MAINTENANCE });
		const { status, out } = run(dir, "nightly");
		expect(out).toContain("older than 72 h");
		expect(status).toBe(1);
	});

	it("fails when main has no verdict at all: the default is still fail", () => {
		const { dir, git } = repository({ main: MAIN_1_11, branch: BRANCH_1_10_1 });
		git("rm", "--quiet", ".nightly-verdict.json");
		git("commit", "--quiet", "-m", "No verdict");
		git("push", "--quiet", "origin", "main");
		git("switch", "--quiet", MAINTENANCE);
		const { status, out } = run(dir, "nightly");
		expect(out).toContain("missing");
		expect(status).toBe(1);
	});

	it("runs on the branch's release commit in CI, against main's verdict", () => {
		const { dir } = repository({ main: { ...MAIN_1_11, nightly: STALE }, branch: BRANCH_1_10_1, head: MAINTENANCE });
		const { status, out } = run(dir, "nightly", "--if-release");
		expect(out).toContain("release commit");
		expect(status).toBe(1);
	});

	it("reads main's verdict from release.yml's one-commit checkout of the tag, and leaves it shallow", () => {
		const { git, origin, root } = repository({ main: MAIN_1_11, branch: stale, head: MAINTENANCE });
		git("tag", "1.10.1");
		git("push", "--quiet", "origin", "1.10.1");
		git("switch", "--quiet", "main");
		git("commit", "--quiet", "--allow-empty", "-m", "More of main's history");
		git("push", "--quiet", "origin", "main");
		const checkout = join(root, "checkout");
		execFileSync("git", ["clone", "--quiet", "--depth=1", "--branch=1.10.1", `file://${origin}`, checkout], { stdio: "ignore" });
		expect(run(checkout, "nightly").status).toBe(0);
		const fetched = execFileSync("git", ["rev-list", "--count", "FETCH_HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
		expect(fetched).toBe("1");
	});

	it("says it could not read main's verdict when origin is out of reach", () => {
		const { dir, git } = repository({ main: MAIN_1_11, branch: BRANCH_1_10_1, head: MAINTENANCE });
		git("remote", "remove", "origin");
		const { status, out } = run(dir, "nightly");
		expect(out).toContain("could not be read or will not parse");
		expect(status).toBe(1);
	});

	it("keeps reading the tree's own verdict for a release from main", () => {
		const { dir } = repository({ main: MAIN_1_11, branch: { ...MAIN_1_11, nightly: STALE }, head: MAINTENANCE });
		const { status, out } = run(dir, "nightly");
		expect(out).toContain("older than 72 h");
		expect(status).toBe(1);
	});
});

describe("latest: whether GitHub's Latest moves to this release", () => {
	const latest = (...args) => {
		const dir = mkdtempSync(join(tmpdir(), "tagged-sync-latest-"));
		roots.push(dir);
		return run(dir, "latest", ...args).out.trim();
	};

	it.each([
		["1.10.2", "1.11.0", "false"],
		["1.10.1", "1.10.0", "true"],
		["1.11.0", "1.10.2", "true"],
		["1.10.10", "1.10.9", "true"],
		["1.10.9", "1.10.10", "false"],
		["2.0.0", "1.99.99", "true"],
	])("%s over a Latest of %s is %s", (version, current, expected) => {
		expect(latest(version, current)).toBe(expected);
	});

	it("refuses to guess when it is not told the current Latest", () => {
		const dir = mkdtempSync(join(tmpdir(), "tagged-sync-latest-"));
		roots.push(dir);
		expect(run(dir, "latest", "1.10.1", "").status).toBe(2);
	});
});
