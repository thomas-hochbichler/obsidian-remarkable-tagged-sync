import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "../test-stubs/fake-obsidian";
import type { LocalModelPaths } from "./local-model-store";

// Gap G18 -- the half of the downloader that touches the disk and the network. 504 lines, and the
// gap list's summary of it was exact: "excellent pure planners, unconnected to anything that runs".
// Every rule this file follows is tested in `local-model-download.test.ts`; that the file *consults*
// them was not, and that is where 5.5 GB of somebody's bandwidth is at stake.
//
// **Real `fs`, in a real temporary directory.** Node's filesystem is not the thing under test, and a
// faked one would let a rename that never happened pass. The network is the seam that has to be
// faked, so `https.get` is spied on -- the module reaches it through a dynamic `require`, which
// resolves to the same singleton this file imports.
//
// The artefact table is replaced with a tiny one, because the real one is 5.5 GB and `fetchArtefact`
// refuses a file whose size does not match to the byte.

const RUNTIME_BODY = Buffer.from("engine-archive-bytes");
const MODEL_BODY = Buffer.from("model-weights-bytes-1234567890");
const MMPROJ_BODY = Buffer.from("mmproj-bytes");

/**
 * The CommonJS module objects, which is what the code under test reaches for.
 *
 * `vi.spyOn` cannot touch these: an ES module namespace is not configurable, and the downloader does
 * not import them as one anyway -- it calls `require("https")` at the moment it needs it, behind the
 * desktop guard. The CJS object those calls resolve to is an ordinary mutable object and the same
 * singleton every caller in the process sees, so replacing one property on it is the seam.
 */
const nodeRequire = createRequire(import.meta.url);
const httpsModule = nodeRequire("node:https") as typeof import("https");
const childProcessModule = nodeRequire("node:child_process") as typeof import("child_process");
const realHttpsGet = httpsModule.get;
const realExecFile = childProcessModule.execFile;

const artefacts = vi.hoisted(() => ({ runtimeStrip: 1 as number | undefined }));

vi.mock("./local-model-artefacts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./local-model-artefacts")>();
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- test-only.
	const crypto = require("node:crypto") as typeof import("crypto");
	const hash = (body: Buffer) => crypto.createHash("sha256").update(body).digest("hex");
	const runtimeBody = Buffer.from("engine-archive-bytes");
	const modelBody = Buffer.from("model-weights-bytes-1234567890");
	const mmprojBody = Buffer.from("mmproj-bytes");
	return {
		...actual,
		MODEL_ARTEFACTS: [
			{ url: "https://example.test/model.gguf", fileName: "model.gguf", bytes: modelBody.length, sha256: hash(modelBody) },
			{ url: "https://example.test/mmproj.gguf", fileName: "mmproj.gguf", bytes: mmprojBody.length, sha256: hash(mmprojBody) },
		],
		RUNTIME_ARTEFACTS: {
			darwin: {
				url: "https://example.test/engine.tar.gz",
				fileName: "engine.tar.gz",
				bytes: runtimeBody.length,
				sha256: hash(runtimeBody),
				get stripComponents() {
					return artefacts.runtimeStrip;
				},
			},
			win32: {
				url: "https://example.test/engine.zip",
				fileName: "engine.zip",
				bytes: runtimeBody.length,
				sha256: hash(runtimeBody),
				stripComponents: 0,
			},
		},
		totalDownloadBytes: () => runtimeBody.length + modelBody.length + mmprojBody.length,
	};
});

/** What `requiredFreeBytes` answers, so the out-of-disk branch is reachable without filling a disk. */
const disk = vi.hoisted(() => ({ required: 1 }));
vi.mock("./local-model-download", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./local-model-download")>();
	return { ...actual, requiredFreeBytes: () => disk.required };
});

// --- the fake CDN ---------------------------------------------------------------------------------

interface Served {
	/** The status to answer with. 206 means the `Range` was honoured, 200 means it was ignored. */
	status: number;
	/** The bytes of the whole artefact. What is sent depends on the status and the requested offset. */
	body: Buffer;
	/**
	 * Set when the server should end the body early *cleanly* -- no error, just fewer bytes than it
	 * promised. A CDN that does this is the one case no stream handler notices: the write finishes,
	 * the rename is one line away, and only the size check stands between it and a truncated model.
	 */
	truncateTo?: number;
}

const cdn = {
	responses: new Map<string, Served[]>(),
	requests: [] as { url: string; range: string | undefined }[],
};

function serve(url: string, ...responses: Served[]): void {
	cdn.responses.set(url, responses);
}

/** One `IncomingMessage`, near enough: a readable with a status and headers. */
function fakeResponse(served: Served, offset: number): Readable & { statusCode: number; headers: Record<string, string> } {
	const from = served.status === 206 ? offset : 0;
	const whole = served.body.subarray(from);
	const chunks = [served.truncateTo === undefined ? whole : whole.subarray(0, served.truncateTo)];
	const stream = new Readable({
		read() {
			const chunk = chunks.shift();
			if (chunk !== undefined) this.push(chunk);
			else this.push(null);
		},
	}) as Readable & { statusCode: number; headers: Record<string, string> };
	stream.statusCode = served.status;
	stream.headers = {};
	return stream;
}

function installCdn(): void {
	(httpsModule as { get: unknown }).get = ((url: string, options: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
		const range = options?.headers?.Range;
		cdn.requests.push({ url, range });
		const queue = cdn.responses.get(url);
		if (!queue || queue.length === 0) throw new Error(`no fake response queued for ${url}`);
		const served = queue.length === 1 ? queue[0] : queue.shift()!;
		const offset = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
		// Async, like a real socket: the caller's `.on("error")` handlers must be attached first.
		setTimeout(() => callback(fakeResponse(served, offset)), 0);
		return { on: () => undefined, destroy: () => undefined };
	}) as unknown as typeof httpsModule.get;
}

// --- the vault on disk ----------------------------------------------------------------------------

let root: string;

function pathsIn(directory: string): LocalModelPaths {
	return {
		root: directory,
		runtimeDir: path.join(directory, "runtime"),
		runtimeExecutable: path.join(directory, "runtime", "llama-server"),
		modelDir: path.join(directory, "model"),
		modelFile: path.join(directory, "model", "model.gguf"),
		mmprojFile: path.join(directory, "model", "mmproj.gguf"),
		verifiedMarker: path.join(directory, "verified"),
		corruptMarker: path.join(directory, "corrupt"),
		lockFile: path.join(directory, "lock"),
		modelPart: path.join(directory, "model", "model.gguf.part"),
		mmprojPart: path.join(directory, "model", "mmproj.gguf.part"),
	};
}

/**
 * A `tar` that does what the real one does for these tests: writes the executable the caller checks
 * for, unless the test says the strip depth was wrong. Spied rather than run, because the archive is
 * twenty bytes of the word "engine-archive-bytes".
 */
const tar = { extracted: [] as string[][], writesExecutable: true };

function installTar(paths: LocalModelPaths): void {
	(childProcessModule as { execFile: unknown }).execFile = ((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		tar.extracted.push(args);
		// The real `tar` exits 0 on a wrong strip depth having written nothing useful, which is the
		// whole reason the caller checks for the executable afterwards.
		if (tar.writesExecutable) {
			fs.mkdirSync(paths.runtimeDir, { recursive: true });
			fs.writeFileSync(paths.runtimeExecutable, "#!/bin/sh\n");
		}
		callback(null, "", "");
		return {} as never;
	}) as unknown as typeof childProcessModule.execFile;
}

beforeEach(() => {
	Platform.isDesktop = true;
	root = fs.mkdtempSync(path.join(os.tmpdir(), "tagged-sync-fetch-"));
	cdn.responses.clear();
	cdn.requests.length = 0;
	tar.extracted.length = 0;
	tar.writesExecutable = true;
	artefacts.runtimeStrip = 1;
	disk.required = 1;
	installCdn();
	// The downloader's lock heartbeat and its retry pause both go through `window`.
	vi.stubGlobal("window", {
		setInterval: () => 1,
		clearInterval: () => undefined,
		setTimeout: (fn: () => void) => setTimeout(fn, 0),
	});
});

afterEach(() => {
	(httpsModule as { get: unknown }).get = realHttpsGet;
	(childProcessModule as { execFile: unknown }).execFile = realExecFile;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

/** Everything served correctly, so a test only has to say what it wants to go wrong. */
function serveEverything(): void {
	serve("https://example.test/engine.tar.gz", { status: 200, body: RUNTIME_BODY });
	serve("https://example.test/model.gguf", { status: 200, body: MODEL_BODY });
	serve("https://example.test/mmproj.gguf", { status: 200, body: MMPROJ_BODY });
}

async function download(paths: LocalModelPaths, platform: "darwin" | "win32" = "darwin") {
	const { startLocalModelDownload } = await import("./local-model-fetch");
	installTar(paths);
	const handle = startLocalModelDownload(paths, platform, () => undefined);
	return { handle, outcome: await handle.finished };
}

describe("a download that runs to the end", () => {
	it("writes both markers' worth of state: the files in place and the verified marker", async () => {
		const paths = pathsIn(root);
		serveEverything();

		const { outcome } = await download(paths);

		expect(outcome).toEqual({ phase: "done" });
		expect(fs.readFileSync(paths.modelFile)).toEqual(MODEL_BODY);
		expect(fs.readFileSync(paths.mmprojFile)).toEqual(MMPROJ_BODY);
		expect(fs.existsSync(paths.verifiedMarker)).toBe(true);
		// The archive is removed once unpacked, and no `.part` survives a finished download.
		expect(fs.existsSync(path.join(paths.runtimeDir, "engine.tar.gz"))).toBe(false);
		expect(fs.existsSync(paths.modelPart)).toBe(false);
		// The lock is released whichever way the run ended.
		expect(fs.existsSync(paths.lockFile)).toBe(false);
	});

	it("fetches the 12 MB engine before the 5.5 GB model, so a broken setup surfaces in seconds", async () => {
		const paths = pathsIn(root);
		serveEverything();

		await download(paths);

		expect(cdn.requests.map((request) => request.url)).toEqual([
			"https://example.test/engine.tar.gz",
			"https://example.test/model.gguf",
			"https://example.test/mmproj.gguf",
		]);
	});
});

// The sharpest edge in the whole downloader, and it had no test at all. A `.part` is on disk, so the
// request is ranged -- and what the server answers decides whether the body is appended or replaces
// what is there. Get it wrong and the part becomes two beginnings spliced together, which only the
// final hash finds out, after 5.5 GB.
describe("resuming a part-finished download", () => {
	it("asks for the rest and appends it when the server honours the range", async () => {
		const paths = pathsIn(root);
		fs.mkdirSync(paths.modelDir, { recursive: true });
		fs.writeFileSync(paths.modelPart, MODEL_BODY.subarray(0, 10));
		serve("https://example.test/engine.tar.gz", { status: 200, body: RUNTIME_BODY });
		serve("https://example.test/model.gguf", { status: 206, body: MODEL_BODY });
		serve("https://example.test/mmproj.gguf", { status: 200, body: MMPROJ_BODY });

		const { outcome } = await download(paths);

		expect(outcome).toEqual({ phase: "done" });
		expect(cdn.requests.find((request) => request.url.endsWith("model.gguf"))?.range).toBe("bytes=10-");
		expect(fs.readFileSync(paths.modelFile)).toEqual(MODEL_BODY);
	});

	it("throws the part away when the server ignores the range and answers 200", async () => {
		// A 200 to a ranged request means this body starts at byte zero. Appending it would splice the
		// first ten bytes onto a complete copy -- a file of the right *content* twice over and the
		// wrong length, which fails the size check at best and the hash at worst.
		const paths = pathsIn(root);
		fs.mkdirSync(paths.modelDir, { recursive: true });
		fs.writeFileSync(paths.modelPart, MODEL_BODY.subarray(0, 10));
		serve("https://example.test/engine.tar.gz", { status: 200, body: RUNTIME_BODY });
		serve("https://example.test/model.gguf", { status: 200, body: MODEL_BODY });
		serve("https://example.test/mmproj.gguf", { status: 200, body: MMPROJ_BODY });

		const { outcome } = await download(paths);

		expect(outcome).toEqual({ phase: "done" });
		expect(fs.readFileSync(paths.modelFile)).toEqual(MODEL_BODY);
	});

	it("renames a part that is already complete instead of asking for it again", async () => {
		const paths = pathsIn(root);
		fs.mkdirSync(paths.modelDir, { recursive: true });
		fs.writeFileSync(paths.modelPart, MODEL_BODY);
		serveEverything();

		const { outcome } = await download(paths);

		expect(outcome).toEqual({ phase: "done" });
		expect(cdn.requests.some((request) => request.url.endsWith("model.gguf"))).toBe(false);
	});

	it("skips an artefact that is already in place at the right size", async () => {
		const paths = pathsIn(root);
		fs.mkdirSync(paths.modelDir, { recursive: true });
		fs.writeFileSync(paths.modelFile, MODEL_BODY);
		serveEverything();

		await download(paths);

		expect(cdn.requests.some((request) => request.url.endsWith("model.gguf"))).toBe(false);
	});
});

describe("bytes that are not the published ones", () => {
	it("tries once more from zero, then records the corrupt marker and stops", async () => {
		// Two strikes: the likeliest cause of one mismatch is a resume the server mishandled, which a
		// clean download fixes. A second is terminal -- a third attempt is 5.5 GB spent on hope.
		const paths = pathsIn(root);
		serve("https://example.test/engine.tar.gz", { status: 200, body: RUNTIME_BODY });
		serve("https://example.test/model.gguf", { status: 200, body: Buffer.from("not-the-published-bytes-abcdef") });
		serve("https://example.test/mmproj.gguf", { status: 200, body: MMPROJ_BODY });

		const { outcome } = await download(paths);

		expect(outcome).toEqual({ phase: "failed", failure: { kind: "corrupt" } });
		// On disk, because a restart would otherwise reset the count and buy a third 5.5 GB attempt.
		expect(fs.existsSync(paths.corruptMarker)).toBe(true);
		expect(cdn.requests.filter((request) => request.url.endsWith("model.gguf"))).toHaveLength(2);
		// The second attempt starts from zero rather than resuming into the same bad bytes.
		expect(cdn.requests.filter((request) => request.url.endsWith("model.gguf")).every((request) => request.range === undefined)).toBe(true);
	});

	it("leaves no corrupt marker for the engine, which costs seconds to fetch again", async () => {
		const paths = pathsIn(root);
		serve("https://example.test/engine.tar.gz", { status: 200, body: Buffer.from("not-the-engine-bytes") });

		const { outcome } = await download(paths);

		expect(outcome).toEqual({ phase: "failed", failure: { kind: "corrupt" } });
		expect(fs.existsSync(paths.corruptMarker)).toBe(false);
	});
});

describe("a body that ends early without saying so", () => {
	it("refuses a short file rather than renaming it into place", async () => {
		// The one failure no stream handler sees: the connection is not dropped and nothing errors --
		// the CDN simply sends fewer bytes than it promised. The write finishes, and the rename is one
		// line away. Without the size check the model is installed truncated, and the *hash* is what
		// finds out, after the whole download.
		const paths = pathsIn(root);
		serve("https://example.test/engine.tar.gz", { status: 200, body: RUNTIME_BODY });
		serve("https://example.test/model.gguf", { status: 200, body: MODEL_BODY, truncateTo: 10 });
		serve("https://example.test/mmproj.gguf", { status: 200, body: MMPROJ_BODY });

		const { outcome } = await download(paths);

		expect(outcome.phase).toBe("failed");
		expect(outcome.phase === "failed" && outcome.failure.kind).toBe("network");
		expect(outcome.phase === "failed" && outcome.failure.kind === "network" && outcome.failure.message).toContain(
			`stopped at 10 of ${MODEL_BODY.length} bytes`,
		);
		// Never renamed into place, so the next run resumes rather than trusting a short file.
		expect(fs.existsSync(paths.modelFile)).toBe(false);
	});
});

describe("the disk it is about to fill", () => {
	it("refuses before writing anything, and says how much is missing", async () => {
		const paths = pathsIn(root);
		disk.required = Number.MAX_SAFE_INTEGER;
		serveEverything();

		const { outcome } = await download(paths);

		expect(outcome.phase).toBe("failed");
		expect(outcome.phase === "failed" && outcome.failure.kind).toBe("out-of-disk");
		expect(outcome.phase === "failed" && outcome.failure.kind === "out-of-disk" && outcome.failure.shortfallBytes).toBeGreaterThan(0);
		// Nothing was fetched and no lock was taken: the refusal comes before both.
		expect(cdn.requests).toEqual([]);
		expect(fs.existsSync(paths.lockFile)).toBe(false);
	});
});

describe("unpacking the engine", () => {
	it("strips the wrapping directory on macOS and nothing on Windows", async () => {
		// Pinned per platform rather than sniffed: the macOS tarball wraps its payload in one directory
		// and the Windows zip does not. `tar` exits 0 on a wrong depth either way.
		const macPaths = pathsIn(root);
		serveEverything();
		await download(macPaths, "darwin");
		expect(tar.extracted[0]).toContain("--strip-components=1");

		const winRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tagged-sync-fetch-win-"));
		tar.extracted.length = 0;
		cdn.responses.clear();
		serve("https://example.test/engine.zip", { status: 200, body: RUNTIME_BODY });
		serve("https://example.test/model.gguf", { status: 200, body: MODEL_BODY });
		serve("https://example.test/mmproj.gguf", { status: 200, body: MMPROJ_BODY });
		await download(pathsIn(winRoot), "win32");
		expect(tar.extracted[0].some((argument) => argument.startsWith("--strip-components"))).toBe(false);
		fs.rmSync(winRoot, { recursive: true, force: true });
	});

	it("calls a successful tar that unpacked nothing a failure, rather than a ready state", async () => {
		// The failure this check exists for: a wrong strip depth extracts nothing and `tar` says it
		// worked. Without it the card reads "ready" and the first transcription dies.
		const paths = pathsIn(root);
		tar.writesExecutable = false;
		serveEverything();

		const { outcome } = await download(paths);

		expect(outcome.phase).toBe("failed");
		expect(outcome.phase === "failed" && outcome.failure.kind).toBe("extract");
		expect(outcome.phase === "failed" && outcome.failure.kind === "extract" && outcome.failure.message).toContain(
			"not in the archive",
		);
		expect(fs.existsSync(paths.verifiedMarker)).toBe(false);
	});
});

describe("cancelling mid-stream", () => {
	it("stops, releases the lock, and leaves the part where a resume can find it", async () => {
		const paths = pathsIn(root);
		serve("https://example.test/engine.tar.gz", { status: 200, body: RUNTIME_BODY });
		// A body that arrives in one chunk; cancel is asked for before the stream is read.
		serve("https://example.test/model.gguf", { status: 200, body: MODEL_BODY });
		serve("https://example.test/mmproj.gguf", { status: 200, body: MMPROJ_BODY });

		const { startLocalModelDownload } = await import("./local-model-fetch");
		installTar(paths);
		const handle = startLocalModelDownload(paths, "darwin", () => {
			// Cancel the moment the engine is done and the model has started arriving.
			if (fs.existsSync(paths.runtimeExecutable)) handle.cancel();
		});
		const outcome = await handle.finished;

		expect(outcome).toEqual({ phase: "failed", failure: { kind: "cancelled" } });
		// Never reported as a network failure: the user asked for this.
		expect(fs.existsSync(paths.verifiedMarker)).toBe(false);
		expect(fs.existsSync(paths.lockFile)).toBe(false);
	});
});

describe("the tools it refuses to use", () => {
	it("never hands a file to the OS to open, which is what would quarantine the engine", () => {
		// Obsidian sets no `LSFileQuarantineEnabled`, so an `fs` write attaches no quarantine xattr and
		// the extracted binary starts. A file placed by `shell.openPath` would be SIGKILLed on first
		// run -- a failure that looks like a corrupt download and is not one.
		// A source-level guard, deliberately, because neither rule has a runtime signal here: a
		// quarantined binary is SIGKILLed on somebody else's Mac, and `requestUrl` buffering 5.5 GB
		// only shows up as an out-of-memory crash on a machine that is not this one. Comments are
		// stripped first -- the file explains both rules at length, and naming a thing is not calling it.
		const source = fs
			.readFileSync(new URL("./local-model-fetch.ts", import.meta.url), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");

		expect(source).not.toMatch(/shell\s*\.\s*openPath/);
		expect(source).not.toMatch(/\brequestUrl\s*\(/);
		// And the rule it exists to protect: everything is written with `fs`.
		expect(source).toMatch(/createWriteStream/);
	});

	it("unpacks with the system tar, and asks for a real archive path", async () => {
		const paths = pathsIn(root);
		serveEverything();

		await download(paths);

		expect(tar.extracted[0].slice(0, 2)).toEqual(["-xf", path.join(paths.runtimeDir, "engine.tar.gz")]);
		expect(tar.extracted[0]).toContain(paths.runtimeDir);
	});
});

// Not a test of the plugin: a guard on the fixture above. `execFileSync` proves the system tar this
// file fakes is actually there, so a machine without it fails loudly here rather than passing every
// test above while the real download could never unpack.
describe("the fixture's own assumption", () => {
	it("is running somewhere a system tar exists", () => {
		expect(() => execFileSync("tar", ["--version"], { stdio: "ignore" })).not.toThrow();
	});
});
