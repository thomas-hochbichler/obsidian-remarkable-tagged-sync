/**
 * Every `npm run` script that bundles still bundles.
 *
 * These entry points are not covered by anything else. `tsc` does not see them as a bundle, the test
 * suite never imports them, and the only thing that runs them is a nightly at 03:50 or a maintainer
 * reaching for a tool -- so a broken one is discovered by its own silence.
 *
 * That is not hypothetical. `nightly:ocr` started importing `RENDER_VERSION` from `sync-engine`,
 * which reaches `digest-pipeline` and from there `pdf-text`, which imports `obsidian`. Its esbuild
 * command was the one without `--alias:obsidian`, so the bundle stopped resolving and the night came
 * back `unknown`. Nothing was red until a scheduled run reported nothing at all, and the five nights
 * a baseline needs went back to counting from further away.
 *
 * The check is the honest one: run each command as written, into a throwaway file, and require it to
 * succeed. Asserting flags instead would be asserting today's import graph, which is the thing that
 * moves.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = mkdtempSync(join(tmpdir(), "tagged-sync-bundle-"));

afterAll(() => rmSync(out, { recursive: true, force: true }));

/**
 * The bundling half of each script, with its output redirected.
 *
 * Everything here is `esbuild … --outfile=X && node X`: the `&&` is the seam, and only the left of
 * it is this file's business. Running the right-hand side would mean talking to an OCR provider.
 */
const bundlers = Object.entries(scripts)
	.map(([name, command]) => [name, String(command).split("&&")[0].trim()])
	.filter(([, command]) => command.startsWith("esbuild "))
	.map(([name, command]) => [name, command.replace(/--outfile=\S+/, `--outfile=${join(out, `${name.replace(/\W/g, "-")}.cjs`)}`)]);

describe("the scripts that bundle", () => {
	it("is looking at all of them, so a new one cannot be added without being checked", () => {
		// A guard on the guard: if this list ever comes back empty -- a renamed field, a changed shape
		// -- every assertion below would pass by having nothing to say.
		expect(bundlers.length).toBeGreaterThanOrEqual(6);
		expect(bundlers.map(([name]) => name)).toContain("nightly:ocr");
	});

	for (const [name, command] of bundlers) {
		it(`resolves every import of ${name}`, () => {
			const [, ...args] = command.split(/\s+/);
			// esbuild writes the unresolved import and its file to stderr, which is the useful half.
			expect(() => execFileSync("npx", ["esbuild", ...args], { stdio: "pipe" })).not.toThrow();
		});
	}
});
