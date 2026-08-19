import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkPath,
	debounce,
	FakeApp,
	FakeVault,
	normalizePath,
	parseLinktext,
	Plugin,
	TFile,
	TFolder,
} from "./fake-obsidian";

// `rmapi-js` cannot be resolved under vitest at all -- its `dist/raw.js` imports `crc-32/crc32c`,
// which the package does not ship a resolvable entry for. That is a packaging fact, unrelated to
// any testing decision, and it is the second of the two things that stop `main.ts` being imported.
vi.mock("rmapi-js", () => ({ session: () => ({}) }));

describe("the plugin's module graph", () => {
	it("loads against this fake, which is the whole reason the fake exists", async () => {
		const main = await import("../src/main");
		expect(typeof main.default).toBe("function");
	});
});

describe("normalizePath", () => {
	it("collapses repeated and backslash separators into single forward ones", () => {
		expect(normalizePath("a\\\\b//c")).toBe("a/b/c");
	});

	it("strips leading and trailing separators", () => {
		expect(normalizePath("/notes/x.md/")).toBe("notes/x.md");
	});

	it("turns a path that was nothing but separators into the vault root", () => {
		expect(normalizePath("///")).toBe("/");
	});

	// The reMarkable side of this: a notebook titled by hand carries whatever space the pen put
	// there, and this is the rewrite that made such a note unfindable after it was written.
	it("rewrites a non-breaking space and a narrow one to an ordinary space", () => {
		expect(normalizePath("Meeting\u00A0notes.md")).toBe("Meeting notes.md");
		expect(normalizePath("Meeting\u202Fnotes.md")).toBe("Meeting notes.md");
	});

	it("composes to NFC, so a decomposed umlaut is the same path as a composed one", () => {
		expect(normalizePath("Bücher.md")).toBe("Bücher.md");
	});

	// Deliberately not an ordering assertion. Slashes have to come first, and that much this pins;
	// swapping the last two steps changes no path at all, so a test claiming to pin their order
	// would be a test that cannot fail. Measured, by making the swap.
	it("applies all three rewrites to one path, with the slash collapse first", () => {
		expect(normalizePath("//A\u00A0/B\u0308//")).toBe("A /B\u0308".normalize("NFC"));
	});
});

describe("parseLinktext", () => {
	it("splits a link at its first hash and keeps the hash on the subpath", () => {
		expect(parseLinktext("Note#Heading")).toEqual({ path: "Note", subpath: "#Heading" });
	});

	it("gives a link with no hash an empty subpath rather than a null one", () => {
		expect(parseLinktext("Note")).toEqual({ path: "Note", subpath: "" });
	});

	it("leaves the path empty when the link is nothing but a subpath", () => {
		expect(parseLinktext("#Heading")).toEqual({ path: "", subpath: "#Heading" });
	});
});

describe("debounce", () => {
	beforeEach(() => vi.useFakeTimers());

	it("calls through once after the wait, with the last arguments it was given", () => {
		const spy = vi.fn();
		const d = debounce(spy, 500);
		d("first");
		d("second");
		vi.advanceTimersByTime(500);
		expect(spy.mock.calls).toEqual([["second"]]);
	});

	// The third argument is `resetTimer`, not "leading". Nothing here fires on the leading edge --
	// worth pinning, because a settings field that persists through one is asserted against it.
	it("does not fire on the leading edge, whatever the third argument says", () => {
		const spy = vi.fn();
		debounce(spy, 500, true)("x");
		expect(spy).not.toHaveBeenCalled();
	});

	it("keeps the first call's deadline when resetTimer is off", () => {
		const spy = vi.fn();
		const d = debounce(spy, 500, false);
		d("a");
		vi.advanceTimersByTime(400);
		d("b");
		vi.advanceTimersByTime(100);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("pushes the deadline out on every further call when resetTimer is on", () => {
		const spy = vi.fn();
		const d = debounce(spy, 500, true);
		d("a");
		vi.advanceTimersByTime(400);
		d("b");
		vi.advanceTimersByTime(100);
		expect(spy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(400);
		expect(spy.mock.calls).toEqual([["b"]]);
	});

	it("run() fires the pending call immediately and cancel() drops it", () => {
		const ran = vi.fn();
		debounce(ran, 500)("x").run();
		expect(ran).toHaveBeenCalledTimes(1);

		const dropped = vi.fn();
		debounce(dropped, 500)("x").cancel();
		vi.advanceTimersByTime(5000);
		expect(dropped).not.toHaveBeenCalled();
	});
});

describe("checkPath", () => {
	it("refuses a colon on macOS, which is where a handwritten 'Meeting 14:30' lands", () => {
		expect(() => checkPath("Notes/Meeting 14:30.md", "macos")).toThrow(/cannot contain/);
	});

	it("allows on macOS the characters only Windows forbids", () => {
		expect(() => checkPath("Notes/What? <draft>.md", "macos")).not.toThrow();
		expect(() => checkPath("Notes/What? <draft>.md", "windows")).toThrow(/cannot contain/);
	});

	it("forbids on mobile a set wider than the desktop one it otherwise shares", () => {
		expect(() => checkPath("Notes/What?.md", "linux")).not.toThrow();
		expect(() => checkPath("Notes/What?.md", "mobile")).toThrow(/cannot contain/);
	});

	it("refuses a trailing dot or space only on Windows", () => {
		expect(() => checkPath("Notes/draft.", "windows")).toThrow(/cannot end with a dot or a space/);
		expect(() => checkPath("Notes/draft ", "windows")).toThrow(/cannot end with a dot or a space/);
		expect(() => checkPath("Notes/draft.", "macos")).not.toThrow();
	});

	it("refuses a reserved device name only on Windows, extension or not", () => {
		expect(() => checkPath("Notes/CON.md", "windows")).toThrow("File name is forbidden: CON");
		expect(() => checkPath("Notes/lpt1.md", "windows")).toThrow(/forbidden/);
		expect(() => checkPath("Notes/CON.md", "macos")).not.toThrow();
	});

	it("checks every segment, not only the last one", () => {
		expect(() => checkPath("Note:s/x.md", "macos")).toThrow(/cannot contain/);
	});
});

describe("the vault's file index", () => {
	it("looks a path up exactly, without folding case", () => {
		const vault = new FakeVault();
		vault.seed("Notes/X.md", "hello");
		expect(vault.getFileByPath("Notes/X.md")?.path).toBe("Notes/X.md");
		expect(vault.getFileByPath("notes/x.md")).toBeNull();
	});

	it("keeps files and folders apart, so a folder is not returned as a file", async () => {
		const vault = new FakeVault();
		await vault.createFolder("Notes");
		expect(vault.getFolderByPath("Notes")).toBeInstanceOf(TFolder);
		expect(vault.getFileByPath("Notes")).toBeNull();
	});

	it("splits a name into basename and extension the way a TFile carries them", () => {
		const file = new FakeVault().seed("Notes/Meeting.md");
		expect(file).toBeInstanceOf(TFile);
		expect([file.name, file.basename, file.extension]).toEqual(["Meeting.md", "Meeting", "md"]);
	});
});

// The two rules this fake models. Both were read out of Obsidian 1.13.7's shipped `app.js`, and
// together they are the highest-ranked gap in the repo: `create` decides a path is taken through the
// filesystem, while every lookup the plugin makes goes through the index.
describe("what the vault refuses to write over", () => {
	it("throws Obsidian's own sentence when creating over a file that is there", async () => {
		const vault = new FakeVault();
		await vault.create("Notes/X.md", "one");
		await expect(vault.create("Notes/X.md", "two")).rejects.toThrow("File already exists.");
	});

	it("throws it for a binary write too, from the same shape", async () => {
		const vault = new FakeVault();
		await vault.createBinary("Files/a.png", new ArrayBuffer(1));
		await expect(vault.createBinary("Files/a.png", new ArrayBuffer(1))).rejects.toThrow("File already exists.");
	});

	it("has its own sentence for a folder", async () => {
		const vault = new FakeVault();
		await vault.createFolder("Notes");
		await expect(vault.createFolder("Notes")).rejects.toThrow("Folder already exists.");
	});

	// This is the disagreement itself, and it is what makes a "free" path not free.
	it("refuses a path the index says is free, when only its case differs", async () => {
		const vault = new FakeVault({ platform: "macos" });
		await vault.create("Notes/X.md", "one");
		expect(vault.getFileByPath("Notes/x.md")).toBeNull();
		await expect(vault.create("Notes/x.md", "two")).rejects.toThrow("File already exists.");
	});

	it("accepts that same path on Linux, where the filesystem does not fold case", async () => {
		const vault = new FakeVault({ platform: "linux" });
		await vault.create("Notes/X.md", "one");
		await expect(vault.create("Notes/x.md", "two")).resolves.toBeInstanceOf(TFile);
	});

	// The write normalises and the lookup does not. That asymmetry is the whole bug behind the fix
	// in `note-builder.ts`, and the fake has to reproduce it or a test cannot see it.
	it("normalises the path it writes to, while the lookup keeps whatever it was given", async () => {
		const vault = new FakeVault();
		await vault.create("Notes/Meeting\u00A0notes.md", "x");
		expect(vault.getFileByPath("Notes/Meeting\u00A0notes.md")).toBeNull();
		expect(vault.getFileByPath("Notes/Meeting notes.md")?.path).toBe("Notes/Meeting notes.md");
	});

	it("applies checkPath before the existence check, so an illegal name never lands", async () => {
		const vault = new FakeVault({ platform: "macos" });
		await expect(vault.create("Notes/Meeting 14:30.md", "x")).rejects.toThrow(/cannot contain/);
		expect(vault.getAllLoadedFiles()).toEqual([]);
	});
});

describe("writing through the vault", () => {
	it("process() writes only when the callback changed something, and returns the new text", async () => {
		const vault = new FakeVault();
		const file = vault.seed("Notes/X.md", "before");

		await expect(vault.process(file, () => "before")).resolves.toBe("before");
		expect(vault.writeLog).toEqual([]);

		await expect(vault.process(file, (data) => data + "!")).resolves.toBe("before!");
		expect(vault.writeLog).toEqual(["Notes/X.md"]);
		expect(vault.fileContents()["Notes/X.md"]).toBe("before!");
	});

	it("a rename moves the content with the file and tells whoever subscribed", async () => {
		const vault = new FakeVault();
		const file = vault.seed("Notes/Old.md", "body");
		const seen: [string, string][] = [];
		vault.on("rename", ((f: TFile, oldPath: string) => seen.push([f.path, oldPath])) as never);

		const app = new FakeApp(vault);
		await app.fileManager.renameFile(file, "Notes/New.md");

		expect(vault.getFileByPath("Notes/Old.md")).toBeNull();
		expect(vault.getFileByPath("Notes/New.md")?.path).toBe("Notes/New.md");
		expect(vault.fileContents()).toEqual({ "Notes/New.md": "body" });
		expect(seen).toEqual([["Notes/New.md", "Notes/Old.md"]]);
	});
});

describe("the plugin host", () => {
	it("hands loadData whatever the test says data.json holds, and records every save", async () => {
		const plugin = new Plugin(new FakeApp());
		plugin.saved = { deviceToken: "abc" };
		await expect(plugin.loadData()).resolves.toEqual({ deviceToken: "abc" });

		const data = { deviceToken: "abc" };
		await plugin.saveData(data);
		data.deviceToken = "changed-after-the-save";
		expect(plugin.saves).toEqual([{ deviceToken: "abc" }]);
	});
});
