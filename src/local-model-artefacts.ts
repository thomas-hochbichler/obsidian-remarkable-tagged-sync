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

import { MMPROJ_BYTES, MMPROJ_FILE, MODEL_BYTES, MODEL_FILE, type LocalModelPlatform } from "./local-model-store";

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

/** The model repo, pinned to a commit rather than a branch. */
const MODEL_REPO = "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF";
const MODEL_REVISION = "508edd0afaa66bb9e9f40587acc2184f02daf1f6";

function huggingFaceUrl(name: string): string {
	return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${name}`;
}

/**
 * The two model files.
 *
 * They are written as `model.gguf` / `mmproj.gguf` rather than under their upstream names: the
 * directory already carries the version (§5.1), so the file names carry no information, and the
 * backend's spawn line stays the same across a model change.
 */
export const MODEL_ARTEFACTS: readonly PinnedArtefact[] = [
	{
		url: huggingFaceUrl("Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf"),
		fileName: MODEL_FILE,
		bytes: MODEL_BYTES,
		sha256: "9258bf05b12686d097ff3b6b18d968ab393649780aa2b3cd67fec43d50554392",
	},
	{
		url: huggingFaceUrl("mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf"),
		fileName: MMPROJ_FILE,
		bytes: MMPROJ_BYTES,
		sha256: "2ddb555391bae966e412deab9e07b58afa18bcc06930ba0f1c78a3695ab9e506",
	},
];

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

/** Every byte this machine has to fetch: both model files plus its own runtime archive. */
export function totalDownloadBytes(platform: LocalModelPlatform): number {
	return MODEL_ARTEFACTS.reduce((sum, artefact) => sum + artefact.bytes, 0) + RUNTIME_ARTEFACTS[platform].bytes;
}
