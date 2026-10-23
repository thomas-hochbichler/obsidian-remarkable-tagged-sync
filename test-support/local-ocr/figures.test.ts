import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelGeneration } from "../../src/local-model-artefacts";
import { evaluateBackend, loadReferencePages } from "../nightly/ocr";
import { checkFigure, figureBaseline, type LocalFigure, missingFigures } from "./figures";

const generation: ModelGeneration = {
	dir: "qwen3-vl-8b-instruct-q4_k_m",
	label: "Qwen3-VL-8B-Instruct",
	modelBytes: 1,
	mmprojBytes: 1,
	artefacts: [
		{ url: "", fileName: "model.gguf", bytes: 1, sha256: "aa" },
		{ url: "", fileName: "mmproj.gguf", bytes: 1, sha256: "bb" },
	],
	measured: { medianCer: 0.0179, on: "2026-09-16" },
	peakRssBytes: 1,
	floorGb: { darwin: 16, win32: 24 },
	contextTokens: 8192,
	splitsTallPages: true,
	encoderOnCpu: false,
};
const current = { generations: [generation], promptSha: "635b0b92a4432be2", renderVersion: 31, runtime: "b10295" };
const figure = (over: Partial<LocalFigure> = {}): LocalFigure => ({
	schema: 1,
	measuredAt: "2026-09-16T10:00:00.000Z",
	generation: generation.dir,
	label: generation.label,
	modelSha256: "aa",
	mmprojSha256: "bb",
	runtime: "b10295",
	machine: { cpu: "Apple M2 Max", memoryGb: 64, os: "macOS 26.5.2" },
	promptSha: "635b0b92a4432be2",
	renderVersion: 31,
	contextTokens: 8192,
	splitsTallPages: true,
	encoderOnCpu: false,
	status: "pass",
	medianCer: 0.01786,
	pages: {},
	...over,
});

describe("a local figure", () => {
	it("stands when every pin it was measured with is the one this build ships", () => {
		expect(checkFigure(figure(), current)).toEqual([]);
	});

	it("names each pin that moved past it -- prompt, raster, runtime, model files, context, splitting, encoder", () => {
		const problems = checkFigure(
			figure({ promptSha: "0000000000000000", renderVersion: 30, runtime: "b10000", modelSha256: "cc", mmprojSha256: "dd", contextTokens: null, splitsTallPages: false, encoderOnCpu: true }),
			current,
		);
		expect(problems).toHaveLength(8);
		expect(problems.join("\n")).toMatch(/prompt changed .*render version changed .*runtime changed .*model file .*projector file .*context pin .*splitting .*encoder/s);
	});

	it("is refused when the settings card quotes a different number or day than it measured", () => {
		expect(checkFigure(figure({ medianCer: 0.021 }), current)).toEqual([`${generation.dir}: the settings card says 0.0179, the figure measured 0.021`]);
		expect(checkFigure(figure({ measuredAt: "2026-09-10T10:00:00.000Z" }), current)).toEqual([`${generation.dir}: the settings card dates it 2026-09-16, the figure is from 2026-09-10`]);
	});

	it("is refused for a generation this build does not know, and is missed for one it does", () => {
		expect(checkFigure(figure({ generation: "qwen9-vl-1b" }), current)).toEqual(["qwen9-vl-1b: no such model generation in this build"]);
		expect(missingFigures([], [generation])).toEqual([generation.dir]);
		expect(missingFigures([figure()], [generation])).toEqual([]);
	});
});

describe("a re-measurement", () => {
	it("takes each page the committed figure measured as its baseline, and leaves out the pages it could not", () => {
		const pages = { "01": { cer: 0.04, structure: {}, ms: 1, peakRssBytes: null }, "02": { cer: null, structure: {}, problem: "empty-output" as const, ms: 1, peakRssBytes: null } };
		expect(figureBaseline(figure({ pages }))).toEqual({ "01": { cer: 0.04 } });
		expect(figureBaseline(undefined)).toEqual({});
	});

	// #218: Qwen2.5-VL on Metal (M5 Max, macOS 27) read every page as "@@@@", 328 % median, and the
	// measurement had called it a pass -- it was judged against no baseline at all.
	it("is a catastrophe when every page comes back as a run of '@' against the committed Qwen2.5-VL figure", () => {
		const committed = JSON.parse(readFileSync(join(process.cwd(), "docs", "ocr-local", "qwen2.5-vl-7b-instruct-q4_k_m.json"), "utf8")) as LocalFigure;
		const pages = loadReferencePages(join(process.cwd(), "test-fixtures", "ocr-reference", "pages"));
		const outcomes = new Map(pages.map((page) => [page.id, { text: "@".repeat(2 * page.body.length) }]));

		expect(evaluateBackend(pages, outcomes, figureBaseline(committed)).status).toBe("catastrophe");
	});
});
