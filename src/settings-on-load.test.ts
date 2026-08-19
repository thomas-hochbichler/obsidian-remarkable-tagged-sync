import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeApp } from "../test-stubs/fake-obsidian";
import { NO_LICENCE } from "./licence-state";

// Gap G20 -- what the plugin arrives with. Every field of `data.json` is read raw, with no schema
// version, by 26 lines inside `onload()`; a wrong default or a dropped migration is silent, and it is
// silent on somebody's existing install rather than on a fresh one.
//
// This is the characterisation, written against the unmodified `main.ts` and kept afterwards. It
// asserts what the shipped plugin's `onload()` puts in `this.data` for a given stored blob -- which
// is the one thing a unit test of the migration cannot say, because the migration does not know
// which registry or which platform it will be handed.
//
// Driven through `src/entry.ts` for the reason `ocr-backend-choice.test.ts` gives: `entry.ts` is what
// Obsidian loads, and it is what fills the backend registry the coercion below consults.

vi.mock("rmapi-js", () => ({ session: () => ({}) }));

// Obsidian's timers. `onload()` schedules the on-launch auto-sync through them, so without this it
// throws in `onLayoutReady` before returning. Step 6 of the cut replaces them with an injected
// scheduler and this goes away with it.
vi.stubGlobal("window", {
	setTimeout: () => 0,
	clearTimeout: () => undefined,
	setInterval: () => 0,
	clearInterval: () => undefined,
});

// Whether Apple Vision can run is a property of the machine, and the default backend turns on it.
// Left real, this file would pass on a Mac and fail on CI -- which is exactly what happened to
// `ocr-backend-choice.test.ts` on its first push.
const machine = vi.hoisted(() => ({ visionAvailable: true }));
vi.mock("./vision-ocr-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./vision-ocr-runtime")>();
	return { ...actual, visionPlatformSupported: () => machine.visionAvailable };
});

interface Loaded {
	data: Record<string, unknown>;
	saves: unknown[];
}

/** Runs the real `onload()` against a `data.json` and hands back what the plugin decided it holds. */
async function loadWith(saved: unknown): Promise<Loaded> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Loaded & { saved: unknown })(
		new FakeApp(),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	plugin.saved = saved;
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	return plugin;
}

describe("what the plugin arrives with", () => {
	beforeEach(() => {
		machine.visionAvailable = true;
	});

	it("gives a first install every default", async () => {
		const { data } = await loadWith(null);

		expect(data).toMatchObject({
			deviceToken: null,
			tagFolderMap: {},
			ocrBackend: "vision",
			llmProviders: {},
			ocrUnavailableNoticeShown: false,
			autoSync: { enabled: false, intervalHours: 6, autoTranscribeMetered: false },
			lastSyncAt: null,
			attachmentsFolder: "tagged-sync/attachments",
			marginNotes: false,
			licence: NO_LICENCE,
		});
	});

	it("writes nothing while loading -- an upgrade that syncs nothing must leave data.json alone", async () => {
		const { saves } = await loadWith({ deviceToken: "token", ocrBackendChoice: "tesseract" });
		expect(saves).toEqual([]);
	});

	it("still honours the pre-1.1 key name for the backend choice", async () => {
		const { data } = await loadWith({ ocrBackendChoice: "off" });
		expect(data.ocrBackend).toBe("off");
	});

	it("prefers the current key name when a data.json carries both", async () => {
		const { data } = await loadWith({ ocrBackend: "off", ocrBackendChoice: "vision" });
		expect(data.ocrBackend).toBe("off");
	});

	it("resets a backend this build no longer has to the platform default", async () => {
		// "tesseract" and "llm-vision" shipped and were retired. Left alone they would select a backend
		// that cannot be built, which fails at transcription time rather than here.
		for (const retired of ["tesseract", "llm-vision", "", "not-a-backend"]) {
			const { data } = await loadWith({ ocrBackend: retired });
			expect(data.ocrBackend).toBe("vision");
		}
	});

	it("keeps a backend this build does have", async () => {
		const { data } = await loadWith({ ocrBackend: "off" });
		expect(data.ocrBackend).toBe("off");
	});

	it("defaults to off where Apple Vision cannot run", async () => {
		// Vision is still offered there, but disabled -- so defaulting to it would select an option the
		// user cannot use and cannot understand. Nothing pretends text is coming.
		machine.visionAvailable = false;
		const { data } = await loadWith(null);
		expect(data.ocrBackend).toBe("off");
	});

	it("drops the single API key the pre-multi-provider version stored", async () => {
		const { data } = await loadWith({ llmVisionApiKey: "sk-old-secret" });

		expect(data.llmProviders).toEqual({});
		expect(data).not.toHaveProperty("llmVisionApiKey");
	});

	it("fills a half-written autoSync block from the defaults rather than rejecting it", async () => {
		const { data } = await loadWith({ autoSync: { enabled: true } });
		expect(data.autoSync).toEqual({ enabled: true, intervalHours: 6, autoTranscribeMetered: false });
	});

	it("fills a half-written licence block the same way", async () => {
		// data.json travels between machines through Obsidian Sync, so it can be written by a version
		// that did not have all of these fields.
		const { data } = await loadWith({ licence: { key: "abc" } });
		expect(data.licence).toEqual({ ...NO_LICENCE, key: "abc" });
	});

	it("keeps what a working install has stored", async () => {
		const stored = {
			deviceToken: "device-token",
			tagFolderMap: { "#work": "Work" },
			syncIndex: { version: 4, rows: { "doc/1": { note: "Work/One.md" } } },
			ocrBackend: "off",
			llmProviders: { anthropic: { apiKey: "sk-1" } },
			ocrUnavailableNoticeShown: true,
			autoSync: { enabled: true, intervalHours: null, autoTranscribeMetered: true },
			lastSyncAt: "2026-08-01T00:00:00.000Z",
			attachmentsFolder: "Attachments",
			marginNotes: true,
			licence: { ...NO_LICENCE, key: "k", activationId: "a", validatedAt: "2026-08-01T00:00:00.000Z" },
		};

		const { data } = await loadWith(structuredClone(stored));
		expect(data).toMatchObject(stored);
	});

	it("honours a marginNotes: true written by a 1.1.0 beta", async () => {
		// Someone switched that on themselves. The feature they said yes to now draws the handwriting
		// out of the embedded PDF instead of storing a picture of it, and the setting is on screen again
		// to say no with.
		const { data } = await loadWith({ marginNotes: true });
		expect(data.marginNotes).toBe(true);
	});

	it("survives a data.json that is not an object at all", async () => {
		for (const junk of ["", 0, "a string", [], true]) {
			const { data } = await loadWith(junk);
			expect(data.tagFolderMap).toEqual({});
			expect(data.licence).toEqual(NO_LICENCE);
		}
	});
});
