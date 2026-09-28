import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import { compatExtractionEntry, registerExtractionBackend } from "./extraction-registry";
import { TFile } from "obsidian";
import { adapterFiles, coreTemplateFormats, type HostEnvironment, hostEnvironmentFor, intelligenceNotices, localDeviceId, noteCreator, prepareRun, REVIEW_LINK, reviewStoresFor, templaterOf } from "./host";
import { emptyReport } from "./sync-pass";
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
let rests = 0;
registerExtractionBackend({
	id: "hostresting",
	label: "Host resting",
	metered: false,
	requiresLicence: false,
	measured: false,
	create: () => ({ id: "hostresting", metered: false, extract: async () => ({ kind: "failed", reason: "x" }), rest: () => void rests++ }),
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
		configDir: ".obsidian",
		formatNow: (format) => `<${format}>`,
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
		const run = await prepareRun(env({ "plugin/device-id": "device-b" }), { settings: onDevice(ON), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: {}, background: false });
		expect(run.modes("work")).toEqual({ transcript: true, intelligence: true });
		expect(run.fingerprint).not.toBe(EMPTY_INTELLIGENCE_FINGERPRINT);
		expect(run).toMatchObject({ hook: undefined, paused: null });
	});

	it("builds no engine when no tag asks for one", async () => {
		const run = await prepareRun(env({ "plugin/device-id": "device-a" }), { settings: onDevice(emptyIntelligence()), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: {}, background: false });
		expect(run).toMatchObject({ hook: undefined, paused: null, fingerprint: EMPTY_INTELLIGENCE_FINGERPRINT });
	});

	it("pauses with a reason when the backend is Pro and the vault is not, or when it lacks its key", async () => {
		const free = await prepareRun(env({ "plugin/device-id": "device-a" }), { settings: onDevice(ON), tagFolderMap: MAP, pro: false, transcriptionBackend: "hostcloud", providerSettings: {}, background: false });
		expect(free.paused).toContain("part of Tagged Sync Pro");
		const keyless = await prepareRun(env({ "plugin/device-id": "device-a" }), { settings: onDevice(ON), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: {}, background: false });
		expect(keyless.paused).toContain("Host cloud is not set up yet");
	});

	it("writes a page note through the environment: template, dates, ids, one base folder", async () => {
		const e = env({ "plugin/device-id": "device-a", ".obsidian/templates.json": JSON.stringify({ dateFormat: "DD.MM.YYYY" }) });
		const created: Record<string, string> = {};
		e.readVaultNote = async (path) => (path === "T.md" ? "{{date}} {{time}} {{time:ss}}\n## Tasks\n{{ts.tasks}}\n" : null);
		e.createNote = async (path, content) => void (created[path] = content);
		const settings: IntelligenceSettings = { ...onDevice(ON), backend: "hostfake", profiles: [{ id: "p", name: "P", description: "", template: "T.md", slots: ["tasks"] }], mappings: { work: { ...ON.mappings.work, profiles: ["p"] } } };
		const run = await prepareRun(e, { settings, tagFolderMap: MAP, pro: true, transcriptionBackend: "vision", providerSettings: {}, background: false });
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: "2026-09-01T00:00:00.000Z" } };
		const page = { id: "p1", ordinal: 1, hash: "h", modified: Date.parse("2026-09-02T00:00:00.000Z") };
		await run.hook!.process({ docId: "d", name: "N", legacy: false, pages: [page], units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }], transcribe: async () => new Map([["p1", "call Bob"]]), writeRender: async () => "a.pdf" }, state);
		expect(created).toEqual({ "Work/N/2026-09-02 N p1.md": "<DD.MM.YYYY> <HH:mm> <ss>\n## Tasks\n- [ ] Call Bob\n" });
		expect(state.rows["d:p1:work"]).toMatchObject({ noteId: "rand-1-0123456789", syncedAt: "2026-09-28T10:00:00.000Z" });
		expect(e.files.dirs).toEqual(["plugin/base"]);
		expect(Object.keys(e.files.data)).toContain("plugin/base/rand-1-0123456789.json");
		const base = JSON.parse(e.files.data["plugin/base/rand-1-0123456789.json"]) as { slots: { tasks: { list: { items: { id: string }[] } } } };
		expect(base.slots.tasks.list.items[0].id).toBe("rand-2-0");

		// The note is deleted by hand, then the page changes: the old base goes, a new note comes.
		await run.hook!.process({ docId: "d", name: "N", legacy: false, pages: [{ ...page, hash: "h2" }], units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }], transcribe: async () => new Map([["p1", "call Bob"]]), writeRender: async () => "a.pdf" }, state);
		expect(Object.keys(e.files.data)).not.toContain("plugin/base/rand-1-0123456789.json");
	});

	it("leaves extraction out of a background sync without consent to spend, and in with it", async () => {
		const input = { tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: { hostcloud: { apiKey: "k" } }, background: true };
		const refused = await prepareRun(env({ "plugin/device-id": "device-a" }), { ...input, settings: onDevice(ON) });
		expect(refused).toMatchObject({ hook: undefined, paused: null });
		const allowed = await prepareRun(env({ "plugin/device-id": "device-a" }), { ...input, settings: { ...onDevice(ON), autoExtractMetered: true } });
		expect(allowed.hook).toBeDefined();
	});

	it("runs only the free tag's pages without Pro, though the others stay switched on in the settings", async () => {
		const e = env({ "plugin/device-id": "device-a" });
		const both = setIntelligenceMode(onDevice({ ...ON, backend: "hostfake" }), "home", true, new Date("2026-09-05T00:00:00.000Z"));
		const run = await prepareRun(e, { settings: both, tagFolderMap: { work: "Work", home: "Home" }, pro: false, transcriptionBackend: "vision", providerSettings: {}, background: false });
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: "2026-09-01T00:00:00.000Z", home: "2026-09-05T00:00:00.000Z" } };
		const page = { id: "p1", ordinal: 1, hash: "h", modified: Date.parse("2026-09-10T00:00:00.000Z") };
		await run.hook!.process({ docId: "d", name: "N", legacy: false, pages: [page], units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }, { tag: "home", scope: "notebook", pageIds: ["p1"] }], transcribe: async () => new Map([["p1", "call Bob"]]), writeRender: async () => "a.pdf" }, state);
		expect(Object.keys(state.rows)).toEqual(["d:p1:work"]);
		expect(both.mappings.home.intelligence).toBe(true);
	});

	it("builds the engine hook on the engine device with a working backend", async () => {
		const e = env({ "plugin/device-id": "device-a" });
		const run = await prepareRun(e, { settings: onDevice(ON), tagFolderMap: MAP, pro: true, transcriptionBackend: "hostcloud", providerSettings: { hostcloud: { apiKey: "k" } }, background: false });
		expect(run.paused).toBeNull();
		const hook = run.hook!;
		expect(hook.fingerprint).toBe(run.fingerprint);
		expect(hook.scansDue({})).toEqual(["work"]);
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: {} };
		// A cloud backend holds nothing for a run; releasing it is a no-op.
		run.dispose();
		await hook.beforeRun(state);
		hook.completeScans(state);
		expect(state.scans).toEqual({ work: "2026-09-01T00:00:00.000Z" });
		// A document with nothing new costs no call and writes no base.
		const report = await hook.process({ docId: "d", name: "N", legacy: false, pages: [], units: [], transcribe: async () => new Map(), writeRender: async () => "" }, state);
		expect(report.notesWritten).toBe(0);
		expect(e.files.dirs).toEqual([]);
		expect(REVIEW_LINK).toBe("obsidian://tagged-sync-review");
	});

	it("lets the extraction backend rest after each document only when the local model also transcribes", async () => {
		const e = env({ "plugin/device-id": "device-a" });
		const doc = { docId: "d", name: "N", legacy: false, pages: [], units: [], transcribe: async () => new Map<string, string>(), writeRender: async () => "" };
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: {} };
		rests = 0;
		const local = await prepareRun(e, { settings: { ...onDevice(ON), backend: "hostresting" }, tagFolderMap: MAP, pro: true, transcriptionBackend: "local", providerSettings: {}, background: false });
		await local.hook!.process(doc, state);
		await local.hook!.process(doc, state);
		expect(rests).toBe(2);
		const cloud = await prepareRun(e, { settings: { ...onDevice(ON), backend: "hostresting" }, tagFolderMap: MAP, pro: true, transcriptionBackend: "vision", providerSettings: {}, background: false });
		await cloud.hook!.process(doc, state);
		expect(rests).toBe(2);
	});
});

describe("the Obsidian glue", () => {
	it("reads an absent file as null, and removes or makes a folder only when that changes something", async () => {
		const files = new Map<string, string>([["a", "1"]]);
		const calls: string[] = [];
		const adapter = {
			exists: async (p: string) => files.has(p),
			read: async (p: string) => files.get(p)!,
			write: async (p: string, d: string) => void files.set(p, d),
			remove: async (p: string) => void (calls.push(`rm ${p}`), files.delete(p)),
			mkdir: async (p: string) => void (calls.push(`mkdir ${p}`), files.set(p, "")),
		};
		const f = adapterFiles(adapter);
		expect([await f.read("a"), await f.read("b")]).toEqual(["1", null]);
		await f.write("b", "2");
		await f.remove("b");
		await f.remove("b");
		await f.mkdir("dir");
		await f.mkdir("dir");
		expect(calls).toEqual(["rm b", "mkdir dir"]);
	});

	it("finds Templater only when its API is there", () => {
		const api = { create_new_note_from_template: async () => null };
		expect(templaterOf({ plugins: { plugins: { "templater-obsidian": { templater: api } } } })).toBe(api);
		expect(templaterOf({ plugins: { plugins: { "templater-obsidian": { templater: {} } } } })).toBeNull();
		expect(templaterOf({})).toBeNull();
	});

	it("creates a note through Templater with folder and name, falls back when it throws or returns no file, and uses create without it", async () => {
		const created: string[] = [];
		const create = async (path: string, content: string) => void created.push(`${path}=${content}`);
		const seen: unknown[][] = [];
		const templater = {
			create_new_note_from_template: async (...args: unknown[]) => {
				seen.push(args);
				return { path: "made" };
			},
		};
		await noteCreator(templater, create)("Work/N/p1.md", "body");
		await noteCreator(templater, create)("root.md", "top");
		expect(seen).toEqual([
			["body", "Work/N", "p1", false],
			["top", "", "root", false],
		]);
		await noteCreator({ create_new_note_from_template: () => Promise.reject(new Error("syntax")) }, create)("a.md", "x");
		// Templater's own parse error: a notice, the file it began deleted, and nothing returned.
		await noteCreator({ create_new_note_from_template: async () => undefined }, create)("c.md", "z");
		await noteCreator(null, create)("b.md", "y");
		expect(created).toEqual(["a.md=x", "c.md=z", "b.md=y"]);
	});

	it("reads core Templates' date and time formats, ignoring blanks and a broken file", async () => {
		const read = (text: string | null) => ({ read: async () => text });
		expect(await coreTemplateFormats(read(JSON.stringify({ dateFormat: "DD.MM.YYYY", timeFormat: "HH:mm" })), ".obsidian")).toEqual({ date: "DD.MM.YYYY", time: "HH:mm" });
		expect(await coreTemplateFormats(read(JSON.stringify({ dateFormat: "", timeFormat: 3 })), ".obsidian")).toEqual({ date: null, time: null });
		expect(await coreTemplateFormats(read(null), ".obsidian")).toEqual({ date: null, time: null });
		expect(await coreTemplateFormats(read("{broken"), ".obsidian")).toEqual({ date: null, time: null });
	});
});

describe("intelligenceNotices", () => {
	it("says a pause, the engine's own notices, and the pending proposals with where to review them", () => {
		expect(intelligenceNotices(null, emptyReport())).toEqual([]);
		expect(intelligenceNotices("Paused.", { ...emptyReport(), notices: ["Page 3 failed 3 times."], proposals: 1, proposalNotes: 1 })).toEqual([
			"Paused.",
			"Page 3 failed 3 times.",
			'1 proposal in 1 note waiting for review — run "Review proposals" or click the callout in a note.',
		]);
		expect(intelligenceNotices(null, { ...emptyReport(), proposals: 4, proposalNotes: 2 })).toEqual(['4 proposals in 2 notes waiting for review — run "Review proposals" or click the callout in a note.']);
	});
});

describe("hostEnvironmentFor", () => {
	it("reaches the app through the vault: plugin folder, templates, note creation and the clock", async () => {
		const template = Object.assign(Object.create(TFile.prototype) as TFile, { path: "T.md" });
		const created: string[] = [];
		const app = {
			vault: {
				configDir: ".obsidian",
				adapter: { exists: async () => false, read: async () => "", write: async () => {}, remove: async () => {}, mkdir: async () => {} },
				getAbstractFileByPath: (path: string) => (path === "T.md" ? template : path === "Folder" ? {} : null),
				read: async () => "template text",
				create: async (path: string, content: string) => void created.push(`${path}=${content}`),
			},
		};
		const store = env().noteStore;
		const e = hostEnvironmentFor(app, { id: "remarkable-tagged-sync" }, store, () => ({ format: (f) => `now(${f})` }));
		expect(e.pluginDir).toBe(".obsidian/plugins/remarkable-tagged-sync");
		expect(hostEnvironmentFor(app, { id: "x", dir: "custom/dir" }, store, () => ({ format: () => "" })).pluginDir).toBe("custom/dir");
		expect([await e.readVaultNote("T.md"), await e.readVaultNote("Folder"), await e.readVaultNote("gone.md")]).toEqual(["template text", null, null]);
		await e.createNote("Work/p1.md", "body");
		expect(created).toEqual(["Work/p1.md=body"]);
		expect(e.formatNow("YYYY")).toBe("now(YYYY)");
		expect(e.randomId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(e.now()).toBeInstanceOf(Date);
		expect(e.noteStore).toBe(store);
		expect(e.configDir).toBe(".obsidian");
		expect(await e.files.read("x")).toBeNull();
	});
});

describe("reviewStoresFor", () => {
	it("reads bases from the plugin folder and notes through the vault, with short item ids", async () => {
		const e = env({ "plugin/base/n1.json": "{}" });
		const stores = reviewStoresFor(e, {});
		expect(await stores.baseStore.load("n1")).toBeNull();
		expect(stores.noteStore).toBe(e.noteStore);
		expect(stores.newId()).toBe("rand-1-0");
		expect(stores.rows).toEqual({});
	});
});
