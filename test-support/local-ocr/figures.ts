// The local figures: one committed measurement per model generation the plugin can fetch, taken on
// a Mac through the shipped runtime (local-ocr-accuracy spec §3.3, "local dated figure").
//
// Nobody hosts the models a laptop can run, so these rows cannot come from the nightly. They come
// from `npm run measure:local -- <generation>` instead, and what makes them publishable beside the
// nightly's rows is the discipline here rather than the cadence: a figure carries the prompt hash,
// the render version, the runtime release and the model file hashes it was measured with, and the
// test in `local-figures.test.ts` refuses a build whose pins have moved past it. A local run is
// deterministic (`--temp 0 --seed 42`, byte-identical across builds of the same weights), so
// re-measuring on an unchanged pin would only reproduce the file -- the pin moving is the event.
//
// No transcript text, ever. Rates, structure verdicts, timings and provenance only.

import { createHash } from "node:crypto";
import type { ModelGeneration } from "../../src/local-model-artefacts";
import { TRANSCRIPTION_PROMPT } from "../../src/llm-transcript";
import type { BackendStatus, PageMeasurement } from "../nightly/ocr";

export interface LocalFigure {
	schema: 1;
	measuredAt: string;
	/** `ModelGeneration.dir` -- the key the settings card and the download share. */
	generation: string;
	label: string;
	modelSha256: string;
	mmprojSha256: string;
	/** llama.cpp release tag, `RUNTIME_RELEASE`. */
	runtime: string;
	/**
	 * No hostname: the CPU, the memory and the OS are what move a number; a name moves nothing.
	 * `osBuild` is optional because the measurements taken before it existed do not carry it.
	 */
	machine: { cpu: string; memoryGb: number; os: string; osBuild?: string };
	promptSha: string;
	renderVersion: number;
	contextTokens: number | null;
	splitsTallPages: boolean;
	status: BackendStatus;
	medianCer: number | null;
	pages: Record<string, PageMeasurement & { ms: number; peakRssBytes: number | null }>;
	note?: string;
}

/** The same sixteen hex characters the nightly writes as `promptSha`. */
export function promptSha(): string {
	return createHash("sha256").update(TRANSCRIPTION_PROMPT).digest("hex").slice(0, 16);
}

export interface CurrentPins {
	generations: readonly ModelGeneration[];
	promptSha: string;
	renderVersion: number;
	runtime: string;
}

/**
 * Everything that would make a committed figure describe something other than what this build
 * ships, each named. Empty means the figure may stand.
 *
 * The last two lines bind the figure to the settings card: `ModelGeneration.measured` is quoted to
 * the user as a measurement of these files, and a card that says 1.79 % beside a file that measured
 * 2.10 % is the drift this exists to catch.
 */
export function checkFigure(figure: LocalFigure, current: CurrentPins): string[] {
	const problems: string[] = [];
	const generation = current.generations.find((g) => g.dir === figure.generation);
	if (!generation) return [`${figure.generation}: no such model generation in this build`];
	if (figure.promptSha !== current.promptSha) problems.push(`${figure.generation}: prompt changed (${figure.promptSha} -> ${current.promptSha})`);
	if (figure.renderVersion !== current.renderVersion) problems.push(`${figure.generation}: render version changed (${figure.renderVersion} -> ${current.renderVersion})`);
	if (figure.runtime !== current.runtime) problems.push(`${figure.generation}: runtime changed (${figure.runtime} -> ${current.runtime})`);
	const pinned = (fileName: string) => generation.artefacts.find((a) => a.fileName === fileName)?.sha256;
	if (figure.modelSha256 !== pinned("model.gguf")) problems.push(`${figure.generation}: model file is not the pinned one`);
	if (figure.mmprojSha256 !== pinned("mmproj.gguf")) problems.push(`${figure.generation}: projector file is not the pinned one`);
	if (figure.contextTokens !== generation.contextTokens) problems.push(`${figure.generation}: context pin changed (${figure.contextTokens} -> ${generation.contextTokens})`);
	if (figure.splitsTallPages !== generation.splitsTallPages) problems.push(`${figure.generation}: tall-page splitting changed`);
	if (figure.medianCer === null || Math.abs(figure.medianCer - generation.measured.medianCer) >= 0.00005) {
		problems.push(`${figure.generation}: the settings card says ${generation.measured.medianCer}, the figure measured ${figure.medianCer}`);
	}
	if (figure.measuredAt.slice(0, 10) !== generation.measured.on) {
		problems.push(`${figure.generation}: the settings card dates it ${generation.measured.on}, the figure is from ${figure.measuredAt.slice(0, 10)}`);
	}
	return problems;
}

/** Generations this build can fetch that have no figure. A model offered without a number is a claim. */
export function missingFigures(figures: LocalFigure[], generations: readonly ModelGeneration[]): string[] {
	const have = new Set(figures.map((f) => f.generation));
	return generations.filter((g) => !have.has(g.dir)).map((g) => g.dir);
}
