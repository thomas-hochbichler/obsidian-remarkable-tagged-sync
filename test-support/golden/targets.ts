// The golden set: every shipped `.rm` fixture plus the five synthetic scenes. An explicit list,
// never a glob -- a golden contains whatever its fixture contains, so nothing outside
// `test-fixtures/` may ever feed one (the measurement corpus lives outside the repo on purpose).

import { readFileSync } from "node:fs";
import { parseRmV6 } from "../../src/rm-parser";
import type { GoldenTarget } from "./extract";
import { syntheticScenes } from "./scenes";

const FIXTURES = [
	"normal-a-stroke-2-layers",
	"color-and-tool-v3.14.4",
	"notebook-with-image",
	"weather-station-page1",
	"cape-marrow-typed-highlights",
];

export const GOLDENS_DIR = "test-fixtures/rmv6/goldens";

export function goldenTargets(): GoldenTarget[] {
	return [
		...FIXTURES.map((name) => {
			const source = `test-fixtures/rmv6/${name}.rm`;
			return { name, page: parseRmV6(new Uint8Array(readFileSync(source))), source };
		}),
		// The annotated-PDF path (ticket 20): the real seven-highlight page composited onto the PDF it
		// was written on -- the one render entry point the notebook goldens above never exercise.
		{
			name: "weather-station-page1-annotated",
			page: parseRmV6(new Uint8Array(readFileSync("test-fixtures/rmv6/weather-station-page1.rm"))),
			source: "test-fixtures/rmv6/weather-station.pdf + weather-station-page1.rm",
			sourcePdf: new Uint8Array(readFileSync("test-fixtures/rmv6/weather-station.pdf")),
		},
		...syntheticScenes().map(({ name, page }) => ({ name, page, source: "synthetic (test-support/golden/scenes.ts)" })),
	];
}
