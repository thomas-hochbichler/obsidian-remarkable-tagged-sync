// The four files the plugin downloads, pinned (managed-local-llm-ocr spec §5.2).
//
// Repo, **commit revision** -- never `main`, never `releases/latest` -- file names, byte sizes and
// SHA-256 hashes are constants in the shipped plugin, and nothing here is resolved at runtime.
//
// Why, stated once: a hash fetched from the host that serves the bytes proves only that the wire did
// not corrupt them; research 01 already tripped a `latest` whose assets were still uploading; and
// every quality and runtime figure the settings card quotes describes *these* files. **The plugin
// version is the model version** -- there is no model-update channel, so an update is a plugin
// release that ships new constants.

import { MMPROJ_FILE, MODEL_FILE, type LocalModelPlatform } from "./local-model-store";

/** One pinned file: where it comes from, what it is called here, and what it must weigh and hash. */
export interface PinnedArtefact {
	url: string;
	/** The name it is written under, which is not the name it is served under. */
	fileName: string;
	bytes: number;
	sha256: string;
	/**
	 * Leading path components to strip on extraction, for an archive.
	 *
	 * Pinned rather than sniffed, because the archives are: **the two platforms genuinely differ.**
	 * The macOS tarball wraps everything in a `llama-b10295/` directory and needs 1; the Windows zip
	 * puts its files at the root and needs 0, where a 1 would strip the file names themselves and
	 * extract nothing at all. Getting this wrong is silent -- the download verifies, the extraction
	 * reports success, and the executable is simply not there.
	 */
	stripComponents?: number;
}

function huggingFaceUrl(repo: string, revision: string, name: string): string {
	return `https://huggingface.co/${repo}/resolve/${revision}/${name}`;
}

/**
 * One model the plugin knows how to fetch and run, with everything that differs between models.
 *
 * There are two of these now, and the reason is a user decision (ticket 20, 2026-09-09): a better
 * model exists, and **nobody who already downloaded 5.5 GB is made to download 6.2 GB more to keep
 * what they have working**. Both generations sit side by side under `models/`, each in a directory
 * that names it, and {@link chooseGeneration} decides which one this install uses.
 *
 * That replaces the older rule, which was *"the plugin version is the model version"*. It held while
 * there was one model; with two it would mean a plugin update silently stops transcription until a
 * multi-gigabyte download finishes, which is the one outcome the decision rules out.
 */
export interface ModelGeneration {
	/** Directory under `models/`. It carries the version, so a new generation lands beside its predecessor. */
	dir: string;
	/** What the settings card calls it. */
	label: string;
	modelBytes: number;
	mmprojBytes: number;
	/**
	 * The two files, written as `model.gguf` / `mmproj.gguf` rather than under their upstream names:
	 * the directory already carries the version, so the file names carry no information, and the
	 * backend's spawn line stays the same across a model change.
	 */
	artefacts: readonly PinnedArtefact[];
	/**
	 * Median character error rate over the fifteen public reference pages, and the day it was measured.
	 * Quoted by the settings card, so it is a measurement of *these* files and never a published claim
	 * copied from a model card.
	 */
	measured: { medianCer: number; on: string };
	/** Peak resident set size observed across those pages; the floor below is derived from it. */
	peakRssBytes: number;
	/**
	 * The RAM this generation needs, per platform, as a nominal shipping configuration:
	 * **peak RSS + 4 GiB, rounded up to a size machines are sold in.** Per generation rather than a
	 * constant because the models differ by nearly a factor of two in working set, and a single floor
	 * would either shut a 16 GB Mac out of a model it runs comfortably or let a 16 GB Mac start one
	 * that swaps.
	 */
	floorGb: Readonly<Record<LocalModelPlatform, number>>;
	/**
	 * `-c` for `llama-mtmd-cli`, or null to let llama.cpp size the KV cache from the model's own
	 * declared context.
	 *
	 * Null was the only behaviour until 2026-09-09, and it is a trap on a modern model. Measured on
	 * this corpus: Qwen3-VL-8B declares a context large enough that the cache alone takes the peak to
	 * **42.82 GB**. Pinned at 8192 the same fifteen pages come back **byte-identical** at **7.99 GB**
	 * and 27 % faster -- one page never needs more, since the whole prompt is one image plus at most
	 * `MAX_TOKENS` of answer.
	 */
	contextTokens: number | null;
	/**
	 * Whether a page far taller than it is wide is cut at its blank bands before this model reads it
	 * (`splitTallInk`).
	 *
	 * Per model because it is not universally right, which was measured only after it shipped. On the
	 * reference set's scrolled page: Qwen2.5-VL-7B **4.32 % -> 1.00 %**, GPT-4o **39.53 % -> 3.99 %** --
	 * and Qwen3-VL-2B **1.00 % -> 10.63 %**, the other way and by a lot. Splitting helps a model that
	 * shrinks a tall image before reading it and hurts one that handles the shape natively.
	 */
	splitsTallPages: boolean;
}

/**
 * Qwen3-VL-8B-Instruct Q4_K_M, from **Qwen's own repository** rather than a community requantisation.
 * Two builds of this model exist at identical file sizes and different hashes; the publisher's own is
 * pinned because a third-party mirror can be deleted and this URL has to work for years.
 */
const QWEN3_VL_8B: ModelGeneration = {
	dir: "qwen3-vl-8b-instruct-q4_k_m",
	label: "Qwen3-VL-8B-Instruct",
	modelBytes: 5_027_784_800,
	mmprojBytes: 1_159_029_824,
	artefacts: [
		{
			url: huggingFaceUrl("Qwen/Qwen3-VL-8B-Instruct-GGUF", "f982a07559d4a2f6c8744d840bf6fccab30eea96", "Qwen3VL-8B-Instruct-Q4_K_M.gguf"),
			fileName: MODEL_FILE,
			bytes: 5_027_784_800,
			sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
		},
		{
			url: huggingFaceUrl("Qwen/Qwen3-VL-8B-Instruct-GGUF", "f982a07559d4a2f6c8744d840bf6fccab30eea96", "mmproj-Qwen3VL-8B-Instruct-F16.gguf"),
			fileName: MMPROJ_FILE,
			bytes: 1_159_029_824,
			sha256: "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38",
		},
	],
	measured: { medianCer: 0.0179, on: "2026-09-09" },
	peakRssBytes: 8_579_448_832,
	// **Only true with `contextTokens` pinned.** Unpinned this model peaks at 42.82 GB, and the floor
	// below would invite a 16 GB Mac to start it.
	// 7.99 GiB + 4 GiB -> 11.99, which rounds up to 16 GB. **This opens the backend to 16 GB Macs**,
	// which the 7B's own arithmetic shut out. Windows keeps 24 GB and is deliberately not derived: the
	// only Windows figure anyone has measured is the 7B's, on a CPU-only path, and scaling it by a
	// ratio would be inventing a measurement rather than making one.
	floorGb: { darwin: 16, win32: 24 },
	contextTokens: 8192,
	// **On, deliberately, although this is the one model measured to lose by it** -- 1.00 % whole
	// against 1.33 % cut on page 15, with the median unchanged. A third of a point on one page is a
	// known and bounded cost; reading a tall page whole is unbounded in the other direction, and the
	// tallest page anyone has measured is the 8.77x one in the reference set. Trading a measured
	// 0.33 pp for the behaviour of a page nobody has written yet is the wrong way round.
	splitsTallPages: true,
};

/**
 * Qwen2.5-VL-7B-Instruct Q4_K_M -- what every install before this shipped, kept **byte for byte**.
 * These hashes verified every existing download, and an install that has this model keeps using it.
 */
const QWEN25_VL_7B: ModelGeneration = {
	dir: "qwen2.5-vl-7b-instruct-q4_k_m",
	label: "Qwen2.5-VL-7B-Instruct",
	modelBytes: 4_683_072_032,
	mmprojBytes: 853_119_712,
	artefacts: [
		{
			url: huggingFaceUrl("ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", "508edd0afaa66bb9e9f40587acc2184f02daf1f6", "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf"),
			fileName: MODEL_FILE,
			bytes: 4_683_072_032,
			sha256: "9258bf05b12686d097ff3b6b18d968ab393649780aa2b3cd67fec43d50554392",
		},
		{
			url: huggingFaceUrl("ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", "508edd0afaa66bb9e9f40587acc2184f02daf1f6", "mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf"),
			fileName: MMPROJ_FILE,
			bytes: 853_119_712,
			sha256: "2ddb555391bae966e412deab9e07b58afa18bcc06930ba0f1c78a3695ab9e506",
		},
	],
	measured: { medianCer: 0.0432, on: "2026-09-09" },
	peakRssBytes: 16_200_204_288,
	// Left at the shipped 18 / 24, deliberately, although `peakRssBytes` above is the 15.09 GiB the
	// tall reference page reached rather than the 13.43 GiB these floors were derived from. Raising
	// macOS to 24 on that basis would newly exclude 18 GB Macs that are running this model today, and
	// whether the floor should move is an open question, not a side effect of adding a second model.
	floorGb: { darwin: 18, win32: 24 },
	// Deliberately unpinned, which is what every existing install has been running. Its 15.09 GB peak
	// would very likely fall with a `-c` too, but that changes the invocation of a model we are moving
	// away from -- and with it the 4.32 % it measured. See ticket 16.
	contextTokens: null,
	// The model splitting was built for: 4.32 % whole against 1.00 % cut, and its peak drops from
	// 15.09 GB to 13.22 GB with it, which is what keeps the 18 GB floor honest.
	splitsTallPages: true,
};

/**
 * Qwen3-VL-2B-Instruct Q4_K_M, from Qwen's own repository. **The only model here an 8 GB Mac can run**,
 * and the answer to a machine that until now had nothing but Apple Vision: 6.55 % against Vision's
 * 15.65 % on the fifteen public reference pages.
 */
const QWEN3_VL_2B: ModelGeneration = {
	dir: "qwen3-vl-2b-instruct-q4_k_m",
	label: "Qwen3-VL-2B-Instruct",
	modelBytes: 1_107_409_952,
	mmprojBytes: 445_053_216,
	artefacts: [
		{
			url: huggingFaceUrl("Qwen/Qwen3-VL-2B-Instruct-GGUF", "52d6c8ffea26cc873ac5ad116f8631268d7eb503", "Qwen3VL-2B-Instruct-Q4_K_M.gguf"),
			fileName: MODEL_FILE,
			bytes: 1_107_409_952,
			sha256: "089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae",
		},
		{
			url: huggingFaceUrl("Qwen/Qwen3-VL-2B-Instruct-GGUF", "52d6c8ffea26cc873ac5ad116f8631268d7eb503", "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf"),
			fileName: MMPROJ_FILE,
			bytes: 445_053_216,
			sha256: "f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82",
		},
	],
	measured: { medianCer: 0.0655, on: "2026-09-10" },
	peakRssBytes: 3_107_241_984,
	// 2.89 GiB + 4 GiB = 6.89 GiB, against the 7 GiB an 8 GB Mac reports: **114 MB of margin**, the
	// thinnest of any tier and set by one page. Windows is 16 GB and is **derived, never measured** --
	// the only Windows figure anyone has is the 7B's CPU-only 16.64 GB against its 13.43 GB on Metal,
	// and that ratio puts this model at 7.58 GiB, past an 8 GB machine's 7 GiB. A derived number that
	// close to a threshold is not one to gate on, so Windows keeps the larger floor.
	floorGb: { darwin: 8, win32: 16 },
	// 6144 rather than 8192, and the difference is the whole tier: 2.89 GB against 3.11 GB, which is
	// 8 GB against 16 GB. It is the smallest context that reads **all fifteen** pages -- at 4096 the
	// scrolled page does not fit and fails -- so the number comes from the pages rather than from the
	// floor it lands on. A page taller than any measured here fails visibly rather than swapping,
	// because the cache is capped and cannot grow with the page.
	contextTokens: 6144,
	// **Off, and this is the one model where that matters.** Cut, it reads the scrolled page at
	// 10.63 %; whole, at 1.00 %. Splitting would buy 599 MB of margin and cost that page nine and a
	// half points -- the wrong way round for the tier whose whole argument is that it beats Apple
	// Vision by enough to be worth a download.
	splitsTallPages: false,
};

/** Newest first. The order is the preference, and `chooseGeneration` is the only thing that reads it. */
export const MODEL_GENERATIONS: readonly ModelGeneration[] = [QWEN3_VL_8B, QWEN25_VL_7B, QWEN3_VL_2B];

/** What one directory under `models/` holds, as facts rather than a conclusion. */
export interface ModelDirectoryFacts {
	name: string;
	modelBytes: number | null;
	mmprojBytes: number | null;
}

/** True when this directory holds a complete, full-length copy of that generation. */
export function holdsGeneration(entry: ModelDirectoryFacts, generation: ModelGeneration): boolean {
	return entry.name === generation.dir && entry.modelBytes === generation.modelBytes && entry.mmprojBytes === generation.mmprojBytes;
}

/** What the choice needs to know about the machine and about the user, beyond what is on disk. */
export interface ChoiceContext {
	platform: LocalModelPlatform;
	totalMemoryBytes: number;
	/** The directory the user picked in settings, if they picked one. A preference, never a fact. */
	preferred?: string | null;
}

/** The thresholds sit one GiB under nominal: a machine sold as 16 GB reports roughly 15.6 GiB. */
function fits(generation: ModelGeneration, context: ChoiceContext): boolean {
	return context.totalMemoryBytes >= (generation.floorGb[context.platform] - 1) * 1024 ** 3;
}

/** Every generation this machine has the memory for, most accurate first. */
export function runnableGenerations(context: ChoiceContext): ModelGeneration[] {
	return MODEL_GENERATIONS.filter((generation) => fits(generation, context)).sort((a, b) => a.measured.medianCer - b.measured.medianCer);
}

/**
 * Which model this install uses, in three steps.
 *
 * 1. **What the user picked**, if they picked one and it is installed and this machine can run it. A
 *    reader who chose the small model on a large Mac had a reason, and a plugin update must not
 *    quietly move them back.
 * 2. **The most accurate model already on disk.** Preferring what is installed is what keeps a plugin
 *    update from stopping transcription: an install holding the 7B goes on reading pages with it, and
 *    a better model is offered rather than required.
 * 3. **The most accurate this machine can run**, for a fresh install -- which is not the same as the
 *    newest. The list is a size ladder, not a timeline: an 8 GB Mac cannot run the largest model at
 *    all, and handing it one whose own memory gate then refuses it is how "newest wins" fails.
 *
 * Accuracy is the sort key throughout because that is what the choice is *about*. Memory and download
 * size are its costs, and a cost belongs beside the thing it buys rather than in the ordering.
 *
 * A download in flight is not considered here -- the settings card shows it from the download itself --
 * so a half-fetched model never displaces a working one.
 */
export function chooseGeneration(present: readonly ModelDirectoryFacts[], context: ChoiceContext): ModelGeneration {
	const installed = (generation: ModelGeneration) => present.some((entry) => holdsGeneration(entry, generation));
	const runnable = runnableGenerations(context);

	const picked = runnable.find((generation) => generation.dir === context.preferred && installed(generation));
	// Nothing here may return a generation this machine cannot run, so every arm reads from `runnable`
	// and the last resort is the least demanding model rather than the best one.
	return picked ?? runnable.find(installed) ?? runnable[0] ?? MODEL_GENERATIONS[MODEL_GENERATIONS.length - 1];
}

/**
 * A model worth offering beside the one in use: more accurate, and one this machine can actually run.
 *
 * Not "the newest". On a machine that cannot run the most accurate model there may still be a better
 * one than the reader has, and on one that already runs the best there is nothing to say.
 */
export function betterGeneration(inUse: ModelGeneration, context: ChoiceContext): ModelGeneration | null {
	const best = runnableGenerations(context)[0];
	return best !== undefined && best.measured.medianCer < inUse.measured.medianCer ? best : null;
}

/** llama.cpp release b10295 (2026-08-06T12:56:29Z). */
const RUNTIME_RELEASE = "b10295";

function llamaReleaseUrl(asset: string): string {
	return `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_RELEASE}/${asset}`;
}

/**
 * The runtime archive per platform.
 *
 * **There is no x64 entry and there is no Vulkan entry**, and neither is an oversight: Defender
 * quarantines `llama-mtmd-cli.exe` from both x64 assets as `Trojan:Win32/Wacatac.B!ml` (§4.2), and
 * upstream publishes no Vulkan build for Windows arm64 at all. §4.1 refuses to offer the backend on
 * any machine not covered here, so a missing entry is unreachable rather than a fallback.
 */
export const RUNTIME_ARTEFACTS: Readonly<Record<LocalModelPlatform, PinnedArtefact>> = {
	darwin: {
		url: llamaReleaseUrl("llama-b10295-bin-macos-arm64.tar.gz"),
		fileName: "llama-b10295-bin-macos-arm64.tar.gz",
		bytes: 10_975_480,
		sha256: "eee879ac4b0c9abd4afd1b646e90b59c54dab7e08cea0d8d40b8e6bf9ce43aa1",
		// Everything sits under `llama-b10295/`, including the version symlinks the dylibs load through.
		stripComponents: 1,
	},
	win32: {
		url: llamaReleaseUrl("llama-b10295-bin-win-cpu-arm64.zip"),
		fileName: "llama-b10295-bin-win-cpu-arm64.zip",
		bytes: 12_191_028,
		sha256: "55a3098ea95462803f2f65498511fc3e57fafe721c1acba2507381e55fb93afe",
		// The zip has no wrapping directory: its `.exe` and `.dll` files are at the root.
		stripComponents: 0,
	},
};

/** Every byte this machine has to fetch for one generation: its two model files plus the runtime archive. */
export function totalDownloadBytes(platform: LocalModelPlatform, generation: ModelGeneration = MODEL_GENERATIONS[0]): number {
	return generation.artefacts.reduce((sum, artefact) => sum + artefact.bytes, 0) + RUNTIME_ARTEFACTS[platform].bytes;
}
