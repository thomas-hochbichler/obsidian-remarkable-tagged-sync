import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import { compatExtractionEntry, registerExtractionBackend } from "./extraction-registry";
import { type HostEnvironment, localDeviceId, prepareRun, REVIEW_LINK } from "./host";
import { emptyIntelligence, EMPTY_INTELLIGENCE_FINGERPRINT, setIntelligenceMode, type IntelligenceSettings } from "./settings";
import { parseExtraction } from "./extraction";
import type { IntelligenceState } from "./sync-pass";

registerExtractionBackend({
	id: "hostfake",
	label: "Host fake",
	metered: false,
	requiresLicence: false,
	measured: false,
	create: () => ({
		id: "hostfake",
		metered: false,
		extract: async (input) => ({ kind: "ok", result: parseExtraction({ tasks: [{ source: "call Bob", reason: "", id: "new", text: "Call Bob", due: null, done: false }], summary: "" }, input.slots, input.referenceDate)! }),
	}),
});
registerExtractionBackend(
	compatExtractionEntry({ id: "hostcloud", label: "Host cloud", kind: "cloud", resolve: (s) => ({ baseURL: "https://x/v1", model: "m", apiKey: (s.apiKey as string) ?? null }) }),
);

function env(files: Record<string, string> = {}): HostEnvironment & { files: HostEnvironment["files"] & { data: Record<string, string>; dirs: string[] } } {
	const data = { ...files };
	const dirs: string[] = [];
	let n = 0;
	const noteStore: NoteStore = { read: async () => null, exists: async () => false, write: async () => {}, ensureFolder: async () => {}, move: async () => {} };
	return {
		pluginDir: "plugin",
		files: {
			data,
			dirs,
			read: async (path) => data[path] ?? null,
			write: async (path, content) => void (data[path] = content),
			remove: async (path) => void delete data[path],
			mkdir: async (path) => void dirs.push(path),
		},
		noteStore,
		readVaultNote: async () => null,
		createNote: async () => {},
		formatDate: () => "D",
		formatTime: () => "T",
		randomId: () => `rand-${++n}-0123456789`,
		now: () => new Date("2026-09-28T10:00:00.000Z"),
	};
}

const ON = setIntelligenceMode(emptyIntelligence(), "work", true, new Date("2026-09-01T00:00:00.000Z"));
const MAP = { work: "Work" };
const onDevice = (settings: IntelligenceSettings, id = "device-a") => ({ ...settings, engineDeviceId: id });

describe("localDeviceId", () => {
	it("reads the id from the plugin folder, and mints one only when asked", async () => {
		const e = env();
		expect(await localDeviceId(e, false)).toBeNull();
		expect(await localDeviceId(e, true)).toBe("rand-1-0123456789");
		expect(e.files.data["plugin/device-id"]).toBe("rand-1-0123456789");
		expect(await localDeviceId(e, true)).toBe("rand-1-0123456789");
	});
});

describe("prepareRun", () => {
	it("gives every device the modes and the print, but no engine off the engine device", async () => {
		const run = await prepareRun(env({ "plugin/device-id": "device-b" }), { settings: onDevice(ON), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: {} });
		expect(run.modes("work")).toEqual({ transcript: true, intelligence: true });
		expect(run.fingerprint).not.toBe(EMPTY_INTELLIGENCE_FINGERPRINT);
		expect(run).toMatchObject({ hook: undefined, paused: null });
	});

	it("builds no engine when no tag asks for one", async () => {
		const run = await prepareRun(env({ "plugin/device-id": "device-a" }), { settings: onDevice(emptyIntelligence()), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: {} });
		expect(run).toMatchObject({ hook: undefined, paused: null, fingerprint: EMPTY_INTELLIGENCE_FINGERPRINT });
	});

	it("pauses with a reason when the backend is Pro and the vault is not, or when it lacks its key", async () => {
		const free = await prepareRun(env({ "plugin/device-id": "device-a" }), { settings: onDevice(ON), tagFolderMap: MAP, pro: false, transcriptionBackend: "hostcloud", providerSettings: {} });
		expect(free.paused).toContain("part of Tagged Sync Pro");
		const keyless = await prepareRun(env({ "plugin/device-id": "device-a" }), { settings: onDevice(ON), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: {} });
		expect(keyless.paused).toContain("Host cloud is not set up yet");
	});

	it("writes a page note through the environment: template, dates, ids, one base folder", async () => {
		const e = env({ "plugin/device-id": "device-a" });
		const created: Record<string, string> = {};
		e.readVaultNote = async (path) => (path === "T.md" ? "{{date}} {{time}}\n## Tasks\n{{ts.tasks}}\n" : null);
		e.createNote = async (path, content) => void (created[path] = content);
		const settings: IntelligenceSettings = { ...onDevice(ON), backend: "hostfake", profiles: [{ id: "p", name: "P", description: "", template: "T.md", slots: ["tasks"] }], mappings: { work: { ...ON.mappings.work, profiles: ["p"] } } };
		const run = await prepareRun(e, { settings, tagFolderMap: MAP, pro: true, transcriptionBackend: "vision", providerSettings: {} });
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: "2026-09-01T00:00:00.000Z" } };
		const page = { id: "p1", ordinal: 1, hash: "h", modified: Date.parse("2026-09-02T00:00:00.000Z") };
		await run.hook!.process({ docId: "d", name: "N", legacy: false, pages: [page], units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }], transcribe: async () => new Map([["p1", "call Bob"]]), writeRender: async () => "a.pdf" }, state);
		expect(created).toEqual({ "Work/N/2026-09-02 N p1.md": "D T\n## Tasks\n- [ ] Call Bob\n" });
		expect(state.rows["d:p1:work"]).toMatchObject({ noteId: "rand-1-0123456789", syncedAt: "2026-09-28T10:00:00.000Z" });
		expect(e.files.dirs).toEqual(["plugin/base"]);
		expect(Object.keys(e.files.data)).toContain("plugin/base/rand-1-0123456789.json");
		const base = JSON.parse(e.files.data["plugin/base/rand-1-0123456789.json"]) as { slots: { tasks: { list: { items: { id: string }[] } } } };
		expect(base.slots.tasks.list.items[0].id).toBe("rand-2-0");

		// The note is deleted by hand, then the page changes: the old base goes, a new note comes.
		await run.hook!.process({ docId: "d", name: "N", legacy: false, pages: [{ ...page, hash: "h2" }], units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }], transcribe: async () => new Map([["p1", "call Bob"]]), writeRender: async () => "a.pdf" }, state);
		expect(Object.keys(e.files.data)).not.toContain("plugin/base/rand-1-0123456789.json");
	});

	it("builds the engine hook on the engine device with a working backend", async () => {
		const e = env({ "plugin/device-id": "device-a" });
		const run = await prepareRun(e, { settings: onDevice(ON), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: { hostcloud: { apiKey: "k" } } });
		expect(run.paused).toBeNull();
		const hook = run.hook!;
		expect(hook.fingerprint).toBe(run.fingerprint);
		expect(hook.scansDue({})).toEqual(["work"]);
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: {} };
		hook.completeScans(state);
		expect(state.scans).toEqual({ work: "2026-09-01T00:00:00.000Z" });
		// A document with nothing new costs no call and writes no base.
		const report = await hook.process({ docId: "d", name: "N", legacy: false, pages: [], units: [], transcribe: async () => new Map(), writeRender: async () => "" }, state);
		expect(report.notesWritten).toBe(0);
		expect(e.files.dirs).toEqual([]);
		expect(REVIEW_LINK).toBe("obsidian://tagged-sync-review");
	});
});
