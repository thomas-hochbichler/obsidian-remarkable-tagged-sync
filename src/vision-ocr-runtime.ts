import { Platform } from "obsidian";
import { encodeGrayscalePng } from "./png-encoder";
import { DEFAULT_MAX_PARALLELISM, type VisionBatchResult, type VisionBatchRunner, VisionOcrBackend } from "./vision-ocr-backend";

/**
 * The Vision driver, piped to `osascript -l JavaScript` on stdin (spec §3.1). Nothing is ever
 * written to disk but the page PNGs -- this ~40-line readable string is the whole shipped artifact
 * (spec §3.2 / store-compliance §7). Verified end-to-end in research/01; two landmines are load-
 * bearing: pass `$()` (not `Ref()`) for the NSError out-param or osascript segfaults, and pre-check
 * the path with NSFileManager since the error message is then unavailable.
 */
const VISION_OCR_JXA = `
ObjC.import('Foundation');
ObjC.import('Vision');
function ocrOne(path) {
  var fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath($(path))) return { error: 'not_found' };
  var url = $.NSURL.fileURLWithPath($(path));
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;                 // 0 = accurate; .fast is visibly worse (research/01)
  req.usesLanguageCorrection = true;
  try { req.automaticallyDetectsLanguage = true; } catch (e) {}   // macOS 13+
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  var ok = handler.performRequestsError($.NSArray.arrayWithObject(req), $());
  if (!ok) return { error: 'unreadable_image' };
  var res = req.results;
  if (res.isNil()) return { error: 'no_results' };
  var lines = [];
  for (var i = 0; i < res.count; i++) {
    var cands = res.objectAtIndex(i).topCandidates(1);
    if (cands.isNil() || cands.count == 0) continue;
    lines.push(ObjC.unwrap(cands.objectAtIndex(0).string));
  }
  return { text: lines.join('\\n') };
}
function run(argv) {
  var pages = [];
  for (var j = 0; j < argv.length; j++) {
    var r;
    try { r = ocrOne(argv[j]); } catch (e) { r = { error: 'exception' }; }
    pages.push(r);
  }
  return JSON.stringify({ pages: pages });
}
`;

const OSASCRIPT = "/usr/bin/osascript";
const DARWIN_MAJOR_MACOS_13 = 22; // Darwin 22.x == macOS 13 (spec §3.5 / §4.1)
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 120_000;

/** Dynamic `require` behind the desktop guard -- never a static top-level node import (spec §7 #1). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeRequire(id: string): any {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: node modules are desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require(id);
}

/**
 * Why Vision can't run here, or `null` if it can (spec §4.1 stage 1): a cheap platform gate, no
 * subprocess. `"macos-only"` off macOS, `"needs-macos-13"` on an older Mac. Drives the settings
 * dropdown's disabled-option label (spec §4.2) and the LLM-vision no-key fallback.
 */
export function visionUnavailableReason(): "macos-only" | "needs-macos-13" | null {
	if (!Platform.isDesktop) return "macos-only";
	const os = nodeRequire("os");
	if (os.platform() !== "darwin") return "macos-only";
	const major = Number(os.release().split(".")[0]);
	return Number.isFinite(major) && major >= DARWIN_MAJOR_MACOS_13 ? null : "needs-macos-13";
}

/** Cheap platform gate: true when Apple Vision can run here (macOS 13+). */
export function visionPlatformSupported(): boolean {
	return visionUnavailableReason() === null;
}

/** Runs one osascript/Vision process over the given image paths, returning its raw stdout. */
function runOsascript(paths: string[]): Promise<string> {
	const { execFile } = nodeRequire("child_process");
	return new Promise((resolve, reject) => {
		const child = execFile(
			OSASCRIPT,
			["-l", "JavaScript", "-", ...paths],
			{ maxBuffer: EXEC_MAX_BUFFER, timeout: EXEC_TIMEOUT_MS },
			(err: Error | null, stdout: string, stderr: string) => {
				if (err) reject(new Error(`osascript failed: ${err.message} :: ${stderr}`));
				else resolve(stdout);
			},
		);
		child.stdin.end(VISION_OCR_JXA);
	});
}

/**
 * The real batch runner: writes each page PNG to a throwaway temp dir under `os.tmpdir()` (never a
 * TCC-protected location -- spec §3.3), runs one Vision process over them, and always cleans up.
 * Throws only on spawn/timeout failure; a bad or blank image comes back as a per-page result.
 */
const runBatch: VisionBatchRunner = async (images) => {
	const fs = nodeRequire("fs");
	const os = nodeRequire("os");
	const path = nodeRequire("path");

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagged-sync-ocr-"));
	try {
		const paths = images.map((png, i) => {
			const filePath = path.join(dir, `${i}.png`);
			fs.writeFileSync(filePath, png);
			return filePath;
		});
		const stdout = await runOsascript(paths);
		const parsed = JSON.parse(stdout) as { pages: Array<{ text?: string; error?: string }> };
		return parsed.pages.map((pg): VisionBatchResult => (pg.error ? { error: pg.error } : { text: pg.text ?? "" }));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

/** Two-stage availability (spec §4.1): cheap platform gate, then one real tiny-image invocation to catch sandboxing/TCC surprises. */
async function probe(): Promise<boolean> {
	if (!visionPlatformSupported()) return false;
	try {
		await runBatch([encodeGrayscalePng({ width: 1, height: 1, pixels: new Uint8Array([255]) })]);
		return true;
	} catch {
		return false;
	}
}

/** Wires the pure `VisionOcrBackend` to the real osascript runner, with parallelism capped near the perf-core count. */
export function createVisionOcrBackend(): VisionOcrBackend {
	const os = nodeRequire("os");
	const cores: number = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
	return new VisionOcrBackend({ runBatch, probe, maxParallelism: Math.max(1, Math.min(DEFAULT_MAX_PARALLELISM, cores)) });
}
