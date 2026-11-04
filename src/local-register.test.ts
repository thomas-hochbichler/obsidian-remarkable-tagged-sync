import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ButtonComponent, type DropdownComponent, FakeEl, Platform, type Setting, takeNotices, takeSettings } from "../tests/stubs/fake-obsidian";
import { MODEL_GENERATIONS } from "./local-model-artefacts";
import type { LocalModelPaths, LocalModelSnapshot } from "./local-model-store";
import { type BackendSettings, ocrBackendEntry } from "./ocr-registry";
import "./local-register";

// `local-register.ts` is the wiring between the machine gate, the disk state, the card's copy and the
// download, and each of those is tested on its own. What had nothing was that they are *joined up*:
// which model the card is drawn for, which directory a button writes into, and what a pick in the
// dropdown saves. A wrong wire here spends 6.2 GB of somebody's bandwidth on the wrong model, or
// offers Resume for a directory nothing is downloading into.
//
// Everything that touches the disk or the network is replaced and the machine is answered for, so
// this file runs identically on a Mac and on CI -- which the real functions, reading the real
// `os.platform()` and the real `os.totalmem()`, cannot do.

const [BEST, OLDER, SMALL] = MODEL_GENERATIONS;

const machine = vi.hoisted(() => ({
	platform: "darwin" as "darwin" | "win32",
	totalMemoryBytes: 64 * 1024 ** 3,
	directories: [] as { name: string; modelBytes: number | null; mmprojBytes: number | null; complete: boolean; hasPart: boolean }[],
	snapshot: {
		modelBytes: null,
		mmprojBytes: null,
		partPresent: false,
		verifiedPresent: false,
		runtimeExecutablePresent: false,
		lockHeldAtMs: null,
		corruptMarked: false,
	} as LocalModelSnapshot,
	removed: [] as string[],
}));

vi.mock("./local-model-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./local-model-runtime")>();
	const { chooseGeneration: choose } = await import("./local-model-artefacts");
	const pathsFor = (dir: string): LocalModelPaths => ({
		root: `/vault/${dir}`,
		runtimeDir: `/vault/${dir}/runtime`,
		runtimeExecutable: `/vault/${dir}/runtime/llama-mtmd-cli`,
		modelDir: `/vault/${dir}/model`,
		modelFile: `/vault/${dir}/model/model.gguf`,
		mmprojFile: `/vault/${dir}/model/mmproj.gguf`,
		verifiedMarker: `/vault/${dir}/verified`,
		corruptMarker: `/vault/${dir}/corrupt`,
		lockFile: `/vault/${dir}/lock`,
		modelPart: `/vault/${dir}/model/model.gguf.part`,
		mmprojPart: `/vault/${dir}/model/mmproj.gguf.part`,
	});
	return {
		...actual,
		localModelPlatform: () => machine.platform,
		machineFacts: () => ({ platform: machine.platform, arch: "arm64", totalMemoryBytes: machine.totalMemoryBytes }),
		// The rule itself is real -- it is `chooseGeneration`, tested in `local-model-download.test.ts`.
		// Only the two things it reads from the machine are answered for.
		resolveLocalModel: (_pluginId: string, preferred: string | null = null) => {
			const generation = choose(machine.directories, { platform: machine.platform, totalMemoryBytes: machine.totalMemoryBytes, preferred });
			return { paths: pathsFor(generation.dir), generation };
		},
		pathsForGeneration: (_pluginId: string, generation: { dir: string }) => pathsFor(generation.dir),
		readLocalModelSnapshot: () => machine.snapshot,
		readModelDirectories: () => machine.directories,
		removeModelDirectory: (_paths: LocalModelPaths, name: string) => machine.removed.push(name),
	};
});

const fetcher = vi.hoisted(() => ({
	started: [] as { root: string; dir: string }[],
	removedModel: null as string | null,
	discarded: null as string | null,
	progress: { phase: "downloading", receivedBytes: 1, totalBytes: 2 } as unknown,
}));

vi.mock("./local-model-fetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("./local-model-fetch")>()),
	startLocalModelDownload: (paths: LocalModelPaths, _platform: string, _onTick: () => void, generation: { dir: string }) => {
		fetcher.started.push({ root: paths.root, dir: generation.dir });
		return { progress: () => fetcher.progress, cancel: () => undefined, finished: Promise.resolve() };
	},
	removeLocalModel: (paths: LocalModelPaths) => {
		fetcher.removedModel = paths.root;
		return 5_536_191_744;
	},
	discardPartialDownload: (paths: LocalModelPaths) => {
		fetcher.discarded = paths.root;
	},
	foreignDownloadPercent: () => 0,
	partialBytes: () => 2_000_000_000,
	removeStaleParts: () => undefined,
}));

const busy = vi.hoisted(() => ({ transcribing: false }));
vi.mock("./local-ocr-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("./local-ocr-runtime")>()),
	isLocalModelBusy: () => busy.transcribing,
	createLocalOcrBackend: () => null,
}));

/** A directory holding a complete, full-length copy of one generation. */
function complete(generation: (typeof MODEL_GENERATIONS)[number]) {
	return { name: generation.dir, modelBytes: generation.modelBytes, mmprojBytes: generation.mmprojBytes, complete: true, hasPart: false };
}

/** The snapshot of a model that is downloaded, verified and runnable. */
function readySnapshot(generation: (typeof MODEL_GENERATIONS)[number]): LocalModelSnapshot {
	return {
		modelBytes: generation.modelBytes,
		mmprojBytes: generation.mmprojBytes,
		partPresent: false,
		verifiedPresent: true,
		runtimeExecutablePresent: true,
		lockHeldAtMs: null,
		corruptMarked: false,
	};
}

interface Rendered {
	/** The settings blob the card reads and writes -- the vault's `data.json` slice for this backend. */
	blob: BackendSettings;
	saves: number;
	defaultSelected: number;
	rows: Setting[];
	/** What the settings tab runs when it tears the card down. */
	tearDown: void | (() => void);
	/** The button whose label starts with this, from everything the render produced. */
	button(prefix: string): ButtonComponent | undefined;
	dropdown(): DropdownComponent | undefined;
	row(name: string): Setting | undefined;
	/** The card's heading. */
	heading(): string | undefined;
	/** The card's sentences. */
	paragraphs(): string[];
}

/** Every element with this tag, depth first. */
function allOf(el: FakeEl, tag: string): FakeEl[] {
	return [...(el.tag === tag ? [el] : []), ...el.children.flatMap((child) => allOf(child, tag))];
}

/** Renders the backend's settings into a fresh page, as the settings tab does. */
function render(blob: BackendSettings = {}): Rendered {
	const page = new FakeEl();
	const counts = { saves: 0, defaultSelected: 0 };
	takeSettings();
	const tearDown = ocrBackendEntry("local")?.renderSettings?.(page as never, {
		settings: blob,
		save: async () => {
			counts.saves++;
		},
		selectDefaultBackend: async () => {
			counts.defaultSelected++;
		},
	});
	const rows = takeSettings();
	return {
		blob,
		get saves() {
			return counts.saves;
		},
		get defaultSelected() {
			return counts.defaultSelected;
		},
		rows,
		tearDown,
		button: (prefix) => rows.flatMap((setting) => setting.buttons).find((candidate) => candidate.text.startsWith(prefix)),
		dropdown: () => rows.flatMap((setting) => setting.dropdowns)[0],
		row: (name) => rows.find((setting) => setting.name === name),
		heading: () => allOf(page, "h4")[0]?.text,
		paragraphs: () => allOf(page, "p").map((paragraph) => paragraph.text),
	};
}

/** What the local backend stored in the vault, as the card's own reader sees it. */
function preferred(blob: BackendSettings): unknown {
	return blob.preferredModelDir;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	Platform.isDesktop = true;
	Platform.isMacOS = true;
	machine.platform = "darwin";
	machine.totalMemoryBytes = 64 * 1024 ** 3;
	machine.directories = [];
	machine.snapshot = {
		modelBytes: null,
		mmprojBytes: null,
		partPresent: false,
		verifiedPresent: false,
		runtimeExecutablePresent: false,
		lockHeldAtMs: null,
		corruptMarked: false,
	};
	machine.removed = [];
	fetcher.started = [];
	fetcher.removedModel = null;
	fetcher.discarded = null;
	fetcher.progress = { phase: "downloading", receivedBytes: 1, totalBytes: 2 };
	busy.transcribing = false;
	// The download in flight is module state, deliberately: it outlives the page that started it. The
	// plugin's own unload is what clears it, and a test that skipped this would find the next card
	// still drawing a progress bar for the previous test's download.
	ocrBackendEntry("local")?.onPluginUnload?.();
	takeNotices();
	takeSettings();
});

describe("the model the first download fetches", () => {
	it("fetches what the rule picked when the reader picked nothing", () => {
		const page = render();

		page.button("Download the model")?.click();

		expect(fetcher.started).toEqual([{ root: `/vault/${BEST.dir}`, dir: BEST.dir }]);
	});

	// Before this the dropdown decided nothing until both models were on disk: a reader who wanted the
	// small one got the large one, and could only switch after downloading 6.2 GB they did not want.
	it("fetches the model the reader picked instead", () => {
		const page = render({ preferredModelDir: SMALL.dir });

		page.button("Download the model")?.click();

		expect(fetcher.started).toEqual([{ root: `/vault/${SMALL.dir}`, dir: SMALL.dir }]);
	});
});

describe("a download in flight", () => {
	// A download lasts a long time and the card said only "Downloading the model · 2.5 GB of 6.2 GB":
	// which model, and where 6.2 GB of the reader's disk was going, took a look into the file system.
	it("names the model and the directory it lands in", () => {
		render().button("Download the model")?.click();

		const during = render();

		expect(during.heading()).toBe(`Downloading ${BEST.label}`);
		expect(during.row("Model files")?.desc).toBe(`/vault/${BEST.dir}/model`);
		expect(during.button("Pause")).toBeDefined();
	});

	// The rule keeps answering with the working model until the new one is complete, so reading the
	// name from the rule would announce the wrong model and point at a directory nothing writes into.
	it("names the model being fetched, not the one still in use", () => {
		machine.directories = [complete(OLDER)];
		machine.snapshot = readySnapshot(OLDER);
		render({ preferredModelDir: OLDER.dir }).button(`Get ${BEST.label}`)?.click();

		const during = render({ preferredModelDir: OLDER.dir });

		expect(during.heading()).toBe(`Downloading ${BEST.label}`);
		expect(during.row("Model files")?.desc).toBe(`/vault/${BEST.dir}/model`);
	});

	it("still says where the files are once it is paused", () => {
		machine.snapshot = { ...machine.snapshot, partPresent: true };

		const paused = render();

		expect(paused.heading()).toBe("Download paused");
		expect(paused.row("Model files")?.desc).toBe(`/vault/${BEST.dir}/model`);
	});

	it("says the working model keeps transcribing while a newer one arrives", () => {
		machine.directories = [complete(OLDER)];
		machine.snapshot = readySnapshot(OLDER);
		render({ preferredModelDir: OLDER.dir }).button(`Get ${BEST.label}`)?.click();

		const words = render({ preferredModelDir: OLDER.dir }).paragraphs().join(" ");

		expect(words).toContain(`Transcription keeps using ${OLDER.label}`);
		expect(words).not.toContain("without a transcript");
	});

	it("says notes arrive without a transcript while there is no model yet", () => {
		render().button("Download the model")?.click();

		expect(render().paragraphs().join(" ")).toContain("notes just arrive without a transcript");
	});
});

/**
 * A newer model's download that failed, with the older model still working. The rule keeps answering
 * with the older one, so a button wired to the rule's answer acts on the model that works.
 */
describe("a newer model's download that failed", () => {
	beforeEach(() => {
		machine.directories = [complete(OLDER)];
		machine.snapshot = readySnapshot(OLDER);
	});

	function failWith(failure: unknown): Rendered {
		fetcher.progress = { phase: "failed", failure };
		render({ preferredModelDir: OLDER.dir }).button(`Get ${BEST.label}`)?.click();
		return render({ preferredModelDir: OLDER.dir });
	}

	it.each([
		["paused by the reader", { phase: "failed", failure: { kind: "cancelled" } }],
		["refused because another run was busy", { phase: "failed", failure: { kind: "busy" } }],
		["finished", { phase: "done" }],
	])("draws what is on disk once the download was %s", (_name, progress) => {
		render({ preferredModelDir: OLDER.dir }).button(`Get ${BEST.label}`)?.click();
		fetcher.progress = progress;

		const page = render({ preferredModelDir: OLDER.dir });

		expect(page.heading()).toBe("Local model — ready");
		expect(page.row("Model files")?.desc).toBe(`/vault/${OLDER.dir}/model`);
	});

	it("resumes the newer model, not the one in use", () => {
		const page = failWith({ kind: "network", message: "offline" });
		expect(page.heading()).toBe("Download interrupted");
		fetcher.started = [];

		page.button("Resume")?.click();

		expect(fetcher.started).toEqual([{ root: `/vault/${BEST.dir}`, dir: BEST.dir }]);
	});

	// `removeLocalModel` takes the engine with it, which the working model needs as well, and the
	// backend selection would fall back to Vision with a good model still on disk.
	it("deletes only what it fetched, and leaves the working model, its engine and the backend alone", async () => {
		const page = failWith({ kind: "corrupt" });
		expect(page.heading()).toBe("The download could not be verified");

		await page.button("Delete and start over")?.click();

		expect(machine.removed).toEqual([BEST.dir]);
		expect(fetcher.removedModel).toBeNull();
		expect(page.defaultSelected).toBe(0);
		expect(preferred(page.blob)).toBe(OLDER.dir);
	});
});

/**
 * Two complete models, with the less accurate one picked. Found in the 1.11.0 smoke test: the card
 * offered a 6.2 GB download of a model already on disk, and Delete took the engine and the backend
 * selection from the one that stays.
 */
describe("two complete models, the smaller one picked", () => {
	beforeEach(() => {
		machine.directories = [complete(BEST), complete(SMALL)];
		machine.snapshot = readySnapshot(SMALL);
	});

	it("offers no download of the model already on disk", () => {
		const page = render({ preferredModelDir: SMALL.dir });

		expect(page.button(`Get ${BEST.label}`)).toBeUndefined();
		expect(page.paragraphs().join(" ")).not.toContain(BEST.label);
	});

	it("deletes only the one on the card, and goes back to the other", async () => {
		const page = render({ preferredModelDir: SMALL.dir });

		await page.button("Delete the model")?.click();
		await settle();

		expect(machine.removed).toEqual([SMALL.dir]);
		expect(fetcher.removedModel).toBeNull();
		expect(page.defaultSelected).toBe(0);
		expect(preferred(page.blob)).toBeUndefined();
	});
});

describe("the speed figure, across a change of model", () => {
	beforeEach(() => {
		machine.directories = [complete(OLDER)];
		machine.snapshot = readySnapshot(OLDER);
	});

	// Quoted as this machine's it would be false, and looking at another model must not cost the figure:
	// going back to the first one would have to measure ten pages again.
	it("does not quote timings measured on another model, and keeps them", () => {
		const blob: BackendSettings = { preferredModelDir: OLDER.dir, recentPageModel: BEST.dir, recentPageMs: Array.from({ length: 10 }, () => 1_000) };

		expect(render(blob).paragraphs().join(" ")).not.toContain("on this machine");

		expect(blob.recentPageMs).toHaveLength(10);
		expect(blob.recentPageModel).toBe(BEST.dir);
	});

	it("keeps timings measured on this model", () => {
		const blob: BackendSettings = { preferredModelDir: OLDER.dir, recentPageModel: OLDER.dir, recentPageMs: Array.from({ length: 10 }, () => 9_000) };

		expect(render(blob).paragraphs().join(" ")).toContain("9 seconds a page on this machine");
	});

	it("does not trust timings from before they named a model", () => {
		const blob: BackendSettings = { preferredModelDir: OLDER.dir, recentPageMs: Array.from({ length: 10 }, () => 1_000) };

		expect(render(blob).paragraphs().join(" ")).not.toContain("on this machine");
	});
});

describe("the choice of model", () => {
	it("lists every model this machine can run, marking the one the rule would pick", () => {
		const page = render();

		const options = page.dropdown()?.options ?? {};
		expect(Object.keys(options).sort()).toEqual(MODEL_GENERATIONS.map((generation) => generation.dir).sort());
		expect(options[BEST.dir]).toContain("(default)");
		// The error rate and the memory, in the card's own unit -- the two numbers the choice turns on.
		expect(options[SMALL.dir]).toContain("6.6 % error");
		expect(options[SMALL.dir]).toContain("memory");
		expect(options[OLDER.dir]).not.toContain("(default)");
	});

	it("leaves out a model this machine is too small for, and says why underneath", () => {
		machine.totalMemoryBytes = 16 * 1024 ** 3;
		const page = render();

		expect(Object.keys(page.dropdown()?.options ?? {}).sort()).toEqual([BEST.dir, SMALL.dir].sort());
		expect(page.row("Model")?.desc).toContain(`${OLDER.label} needs 18 GB and is not offered here.`);
	});

	it("asks nothing where there is only one model to run", () => {
		machine.totalMemoryBytes = 9 * 1024 ** 3;
		const page = render();

		expect(page.row("Model")).toBeUndefined();
	});

	it("stores a pick, and stores nothing at all for the rule's own answer", async () => {
		const page = render();

		page.dropdown()?.pick(SMALL.dir);
		await settle();
		expect(preferred(page.blob)).toBe(SMALL.dir);

		// Back to the default: a cleared preference, not a stored one. The rule stays in charge, which
		// matters on the next machine -- where its answer may be a different model.
		render(page.blob).dropdown()?.pick(BEST.dir);
		await settle();
		expect(preferred(page.blob)).toBeUndefined();
	});
});

// The card redraws itself on every download tick. Once the settings tab has torn it down, a tick
// must draw nothing -- and must still redraw a newer card that took its place.
describe("a card the settings tab tore down", () => {
	it("draws nothing more, while a newer card keeps redrawing", async () => {
		const old = render();
		const newer = render();
		if (typeof old.tearDown !== "function") throw new Error("the card returned no cleanup");

		old.tearDown();
		newer.dropdown()?.pick(SMALL.dir);
		await settle();
		expect(takeSettings().map((setting) => setting.name)).toContain("Model");

		if (typeof newer.tearDown === "function") newer.tearDown();
		newer.dropdown()?.pick(BEST.dir);
		await settle();
		expect(takeSettings()).toEqual([]);
	});
});

describe("a model that is ready, beside a better one", () => {
	beforeEach(() => {
		machine.directories = [complete(OLDER)];
		machine.snapshot = readySnapshot(OLDER);
	});

	/**
	 * Ticket 20 in one assertion: the newer model installs *beside* the one that works, so the offer
	 * costs nothing if it disappoints. Writing into the running model's directory is what would make
	 * it a replacement -- and an interrupted one would leave the reader with neither.
	 */
	it("installs the newer model beside the working one, not over it", () => {
		const page = render({ preferredModelDir: OLDER.dir });

		page.button(`Get ${BEST.label}`)?.click();

		expect(fetcher.started).toEqual([{ root: `/vault/${BEST.dir}`, dir: BEST.dir }]);
	});

	// The guard reads the directory that is *locked*, which is the model in use -- asking about the
	// empty directory the download is about to create would answer no every time.
	it("refuses to start while another vault is transcribing, and says so", () => {
		busy.transcribing = true;
		const page = render({ preferredModelDir: OLDER.dir });

		page.button(`Get ${BEST.label}`)?.click();

		expect(fetcher.started).toEqual([]);
		expect(takeNotices().join(" ")).toContain("Another vault is transcribing right now");
	});

	it("names the directory beside the delete button, so nothing is removed on trust", () => {
		const page = render({ preferredModelDir: OLDER.dir });

		expect(page.row("Model files")?.desc).toBe(`/vault/${OLDER.dir}/model`);
	});

	/**
	 * The pick goes with the model. A name in `data.json` for a directory that is gone is silently
	 * ignored -- and then honoured again the day a download recreates it, which is a choice the reader
	 * made about a model they deleted.
	 */
	it("gives the selection back when the model is deleted", async () => {
		const page = render({ preferredModelDir: OLDER.dir });

		await page.button("Delete the model")?.click();

		expect(fetcher.removedModel).toBe(`/vault/${OLDER.dir}`);
		expect(preferred(page.blob)).toBeUndefined();
		// Without this the reader is left selecting a backend that transcribes nothing at all.
		expect(page.defaultSelected).toBe(1);
		expect(takeNotices().join(" ")).toContain("5.5 GB");
	});
});

/**
 * A model this build no longer pins -- downloaded by an earlier release and left where it was. It
 * still transcribes, so it is named, sized and offered, never removed underneath the user; the
 * button is there because 5.5 GB of disk is the whole reason to press it.
 */
describe("a model an earlier release left behind", () => {
	const LEGACY = { name: "qwen2-vl-7b-instruct-q4_k_m", modelBytes: 4_000_000_000, mmprojBytes: 1_400_000_000, complete: true, hasPart: false };

	beforeEach(() => {
		machine.directories = [complete(BEST), LEGACY];
		machine.snapshot = readySnapshot(BEST);
	});

	it("offers it by name, and removes only the directory its own button names", () => {
		const page = render();

		expect(page.rows.flatMap((row) => row.buttons).map((candidate) => candidate.text)).toContain(`Remove ${LEGACY.name}`);
		page.button(`Remove ${LEGACY.name}`)?.click();

		expect(machine.removed).toEqual([LEGACY.name]);
	});

	// Provably useless is the other half of the same rule: no URL in this build could finish a partial
	// of a model it does not pin, so that one goes without asking.
	it("removes an unfinishable partial without asking", () => {
		machine.directories = [complete(BEST), { ...LEGACY, complete: false, hasPart: true }];

		render();

		expect(machine.removed).toEqual([LEGACY.name]);
	});
});
