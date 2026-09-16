// The gate on `docs/ocr-local/`: every committed local figure describes the prompt, the raster, the
// runtime and the model files this build ships, and every generation the plugin can fetch has one.
//
// A test rather than a release check for the same reason the reference images are: a release check
// runs at release time, this runs on every commit, and a moved pin is found by the commit that moved
// it -- with the fix named: re-run `npm run measure:local -- <generation>` on a Mac and commit.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_GENERATIONS, RUNTIME_RELEASE } from "../../src/local-model-artefacts";
import { RENDER_VERSION } from "../../src/sync-engine";
import { checkFigure, type LocalFigure, missingFigures, promptSha } from "./figures";

const DIR = join(process.cwd(), "docs", "ocr-local");
const figures = (): LocalFigure[] =>
	readdirSync(DIR)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(readFileSync(join(DIR, name), "utf8")) as LocalFigure);
const current = { generations: MODEL_GENERATIONS, promptSha: promptSha(), renderVersion: RENDER_VERSION, runtime: RUNTIME_RELEASE };

describe("local figures", () => {
	it("were each measured against the prompt, raster, runtime and model files this build ships", () => {
		const problems = figures().flatMap((figure) => checkFigure(figure, current));
		expect(problems, "re-run `npm run measure:local -- <generation>` on a Mac and commit the file").toEqual([]);
	});

	it("exist for every model generation the plugin can fetch", () => {
		expect(missingFigures(figures(), MODEL_GENERATIONS)).toEqual([]);
	});
});
