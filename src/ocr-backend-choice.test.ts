import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeApp, Platform, takeNotices } from "../test-stubs/fake-obsidian";
import { NO_LICENCE } from "./licence-state";
import { ocrBackendEntries } from "./ocr-registry";

// Driven through `src/entry.ts`, not `src/main.ts`, and the difference is the whole point: `entry.ts`
// is what Obsidian loads, and it side-effect-imports the four register modules. Importing `main.ts`
// alone gives a registry holding nothing but `vision` and `off`, so every assertion below about a
// paid backend would be an assertion about a backend that was not there.
//
// This is gap G03's `main.ts` half and the whole of gap G14 -- the "never an auto-spend" rule, which
// had no test anywhere in the repo. Both are money-safety rules: G03 protects the seller, G14 the
// buyer.
//
// It stays after the seam below it moves. What it asserts is that the shipped plugin, with the
// shipped registry, picks the backend the rules say it should -- which is the one thing a unit test
// of the decision function cannot say.

vi.mock("rmapi-js", () => ({ session: () => ({}) }));

// Whether Apple Vision can run is a property of the machine the test runs on, and every assertion
// below turns on it. Left real, this file passes on a Mac and fails on CI -- which it did, on the
// first push: `visionPlatformSupported()` reads `os.platform()`, so setting `Platform.isDesktop`
// alone moves nothing on Linux.
//
// The platform detection has its own tests. What these need is to be able to say "a machine where
// Vision runs" and "a machine where it does not" and have both mean the same thing everywhere.
const machine = vi.hoisted(() => ({ visionAvailable: true }));
vi.mock("./vision-ocr-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./vision-ocr-runtime")>();
	return { ...actual, visionPlatformSupported: () => machine.visionAvailable };
});

interface Chosen {
	id: string;
	constructor: { name: string };
}

async function chooseBackend(
	settings: { backend: string; licence?: Partial<typeof NO_LICENCE>; keys?: Record<string, unknown> },
	silent = false,
): Promise<Chosen> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown>)(
		new FakeApp(),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	plugin.data = {
		ocrBackend: settings.backend,
		llmProviders: settings.keys ?? {},
		licence: { ...NO_LICENCE, ...settings.licence },
	};
	return (plugin.resolveOcrBackend as (s: boolean) => Chosen).call(plugin, silent);
}

const PRO = { key: "test-key", activationId: "act-1", validatedAt: new Date().toISOString() };
/** A trial started long enough ago that it has certainly ended. */
const TRIAL_ENDED = { trialStartedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() };

function whereVisionRuns(): void {
	Platform.isDesktop = true;
	Platform.isMacOS = true;
	machine.visionAvailable = true;
}
function whereVisionCannotRun(): void {
	Platform.isDesktop = false;
	Platform.isMacOS = false;
	machine.visionAvailable = false;
}

/** Every paid backend this build actually ships, read from the registry rather than listed here. */
function meteredBackendIds(): string[] {
	return ocrBackendEntries()
		.filter((entry) => entry.metered)
		.map((entry) => entry.id);
}

describe("the backend a run gets", () => {
	beforeEach(() => {
		takeNotices();
		whereVisionRuns();
	});

	it("is the one the user selected, when this build has it and the licence permits it", async () => {
		expect((await chooseBackend({ backend: "off" })).id).toBe("off");
	});

	it("transcribes nothing, and says nothing, for an id this build no longer has", async () => {
		const chosen = await chooseBackend({ backend: "tesseract" });
		expect(chosen.constructor.name).toBe("UnavailableOcrBackend");
		expect(chosen.id).toBe("tesseract");
		expect(takeNotices()).toEqual([]);
	});
});

// G03. The gate that decides whether the paid backends are paid.
describe("a paid backend chosen without a licence", () => {
	beforeEach(() => {
		takeNotices();
		whereVisionRuns();
	});

	it("does not run, and falls back to free local Apple Vision", async () => {
		for (const id of meteredBackendIds()) {
			expect((await chooseBackend({ backend: id })).id, id).toBe("vision");
		}
	});

	// The configured case, and it is the one that matters. Without a key the gate is invisible: an
	// unlicensed run and an unconfigured one both end at Apple Vision, so removing the gate entirely
	// changes nothing observable. With a key it is the difference between the paid backend running
	// and not running -- which is the whole product.
	//
	// Deleting the gate block from main.ts, and flipping requiresLicence to false in the registry,
	// both passed all 996 tests this repo had, and both passed the first draft of this file too.
	it("does not run even when its API key is set -- which is the only way the gate is visible at all", async () => {
		for (const id of meteredBackendIds()) {
			const chosen = await chooseBackend({ backend: id, keys: { [id]: { apiKey: "sk-test", model: "m" } } });
			expect(chosen.id, id).toBe("vision");
		}
	});

	it("says it needs Pro, in those words, and not that a key is missing", async () => {
		const id = meteredBackendIds()[0];
		await chooseBackend({ backend: id, keys: { [id]: { apiKey: "sk-test", model: "m" } } });
		const notices = takeNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("needs Tagged Sync Pro");
		expect(notices[0]).not.toContain("No API key");
	});

	it("says so honestly where there is no local transcription to fall back to", async () => {
		whereVisionCannotRun();
		const id = meteredBackendIds()[0];
		await chooseBackend({ backend: id, keys: { [id]: { apiKey: "sk-test", model: "m" } } });
		expect(takeNotices()[0]).toContain("Nothing will be transcribed");
	});

	it("says nothing on a background run, and still refuses", async () => {
		const chosen = await chooseBackend({ backend: meteredBackendIds()[0] }, true);
		expect(chosen.id).toBe("vision");
		expect(takeNotices()).toEqual([]);
	});

	it("transcribes nothing where Apple Vision cannot run -- it never reaches for another paid one", async () => {
		whereVisionCannotRun();
		for (const id of meteredBackendIds()) {
			const chosen = await chooseBackend({ backend: id });
			expect(chosen.constructor.name, id).toBe("UnavailableOcrBackend");
		}
	});

	it("treats an ended trial exactly as never having bought", async () => {
		const id = meteredBackendIds()[0];
		expect((await chooseBackend({ backend: id, licence: TRIAL_ENDED })).id).toBe("vision");
	});

	it("lets it run once the licence is there", async () => {
		const id = meteredBackendIds()[0];
		const chosen = await chooseBackend({ backend: id, licence: PRO, keys: { [id]: { apiKey: "sk-test", model: "m" } } });
		expect(chosen.id).toBe(id);
	});
});

// G14, the "never an auto-spend" rule. It had no test anywhere in the repo, and the failure it
// guards against is the expensive direction: a backend the user is paying per page for, started
// because another one was not configured.
describe("a backend that is permitted but not configured", () => {
	beforeEach(() => {
		takeNotices();
		whereVisionRuns();
	});

	it("falls back to free local Apple Vision, never to another metered provider", async () => {
		for (const id of meteredBackendIds()) {
			const chosen = await chooseBackend({ backend: id, licence: PRO });
			expect(chosen.id, id).toBe("vision");
		}
	});

	// The two fallbacks land on the same backend, so the sentence is the only thing that tells a
	// user which of the two happened -- and only one of them is fixable by typing a key.
	it("says which backend has no key, and not that the user needs to buy anything", async () => {
		const id = meteredBackendIds()[0];
		await chooseBackend({ backend: id, licence: PRO });
		const notices = takeNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("No API key set for");
		expect(notices[0]).toContain("Apple Vision (local)");
		expect(notices[0]).not.toContain("Tagged Sync Pro");
	});

	it("says nothing on a background run, because an unattended sync must not raise a popup", async () => {
		const id = meteredBackendIds()[0];
		expect((await chooseBackend({ backend: id, licence: PRO }, true)).id).toBe("vision");
		expect(takeNotices()).toEqual([]);
	});

	it("transcribes nothing where Apple Vision cannot run, rather than spending money elsewhere", async () => {
		whereVisionCannotRun();
		for (const id of meteredBackendIds()) {
			const chosen = await chooseBackend({ backend: id, licence: PRO });
			expect(chosen.constructor.name, id).toBe("UnavailableOcrBackend");
		}
	});

	// The rule stated as a rule, over whatever the registry holds, so a provider added later is
	// covered by this the day it registers rather than the day somebody remembers to add a case.
	it("never hands a run a metered backend the user did not select", async () => {
		const metered = new Set(meteredBackendIds());
		for (const id of metered) {
			for (const licence of [{}, PRO]) {
				const chosen = await chooseBackend({ backend: id, licence });
				if (chosen.id !== id) expect(metered.has(chosen.id), `${id} fell back to ${chosen.id}`).toBe(false);
			}
		}
	});
});
