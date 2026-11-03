// A fake of the parts of Obsidian this plugin reaches. The `obsidian` module only exists inside the
// app, so without something here nothing that imports it can run under vitest at all -- `main.ts`
// least of all, and it is the largest untested file in the repo.
//
// Three rules govern what is in this file. They are what stops a test double from quietly becoming
// "whatever makes the suite green":
//
//   1. A member exists here only if a non-test file in `src/` or `pro/` calls it. The rule is
//      mechanical, so it can be checked instead of argued: a member with no caller is a member
//      somebody added to make a test pass. Everything else keeps throwing, the way this file's
//      predecessor threw for everything.
//   2. A *behaviour* is modelled only where it was read out of the shipped implementation. Every
//      such place cites it. The source is
//      `~/Library/Application Support/obsidian/obsidian-1.13.7.asar` -> `app.js`, de-minified by
//      hand. Reading it shows every branch rather than the one branch a test happened to hit; what
//      it cannot show is the day Obsidian changes it, which is what the E2E layer is for.
//   3. Where a behaviour was NOT read, the fake records the call and claims nothing about what
//      Obsidian would do with it. A recording is something a test can assert on without the fake
//      having to be right about Obsidian.
//
// Read from Obsidian 1.13.7. When that number moves, the cited behaviours are what to re-read.

export const READ_FROM_VERSION = "1.13.7";

// Type-only, so it is erased before anything runs and cannot alias back to this file. Under `tsc`
// it resolves to the REAL `obsidian.d.ts`, which is the point: production code keeps Obsidian's own
// types, and the two casts below are the single, named place where a fake is handed to it.
//
// What the casts give up is that the typechecker no longer proves the fake has the members the
// production code calls. That is deliberate -- a fake shaped by `implements App` would have to carry
// Obsidian's entire surface, which is the "asserts more than it can prove" failure this file exists
// to avoid. What catches a missing member instead is the test itself, at run time, loudly.
import type { App as ObsidianApp, Vault as ObsidianVault } from "obsidian";

/** Hands a fake app to production code that asks for Obsidian's `App`. */
export function asApp(app: FakeApp): ObsidianApp {
	return app as unknown as ObsidianApp;
}

/** Hands a fake vault to production code that asks for Obsidian's `Vault`. */
export function asVault(vault: FakeVault): ObsidianVault {
	return vault as unknown as ObsidianVault;
}

// --- the pure helpers ----------------------------------------------------------------------------
//
// These have no Obsidian state; they are functions, so they are reimplemented for real rather than
// faked. `normalizePath` is the one that forces the decision: it decides what counts as the same
// path, so a fake that normalises differently from Obsidian makes the collision model below --
// which is what the whole file is for -- worthless while looking correct.

/** app.js: `p.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "")`, empty becoming `"/"`. */
function collapseSlashes(path: string): string {
	const collapsed = path.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
	return collapsed === "" ? "/" : collapsed;
}

/**
 * U+00A0 and U+202F become an ordinary space. This one is not a guess anybody would have made, and
 * it is the reason a reMarkable notebook titled with a non-breaking space used to sync once and then
 * fail forever: the write normalised, the lookup did not.
 */
function stripNonBreakingSpaces(path: string): string {
	return path.replace(/[  ]/g, " ");
}

/**
 * app.js: `stripNbsp(collapseSlashes(p)).normalize("NFC")` -- slashes first, then spaces, then NFC.
 *
 * The order is written the way the implementation writes it, and it is worth saying that only the
 * first step's position is observable: swapping the last two changes no path, because NFC neither
 * produces nor consumes a non-breaking space. A test asserting that order would be asserting
 * something it cannot fail on, so there is not one.
 */
export function normalizePath(path: string): string {
	return stripNonBreakingSpaces(collapseSlashes(path)).normalize("NFC");
}

/** app.js: split on the first `#`; a leading `#` leaves `path` empty. */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
	const hash = linktext.indexOf("#");
	return {
		path: hash === -1 ? linktext : linktext.substring(0, hash),
		subpath: hash === -1 ? "" : linktext.substring(hash),
	};
}

export interface Debouncer<T extends unknown[], V> {
	(...args: [...T]): this;
	cancel(): this;
	run(): V | void;
}

/**
 * app.js, faithfully: trailing-edge only. The third argument is `resetTimer`, NOT "leading" -- with
 * it `true` every further call pushes the deadline out, with it `false` the first call's deadline
 * stands. Nothing here fires on the leading edge, which is worth knowing before asserting about a
 * settings field that persists through one.
 */
export function debounce<T extends unknown[], V>(
	cb: (...args: [...T]) => V,
	timeout = 0,
	resetTimer = false,
): Debouncer<T, V> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let self: unknown = null;
	let args: T | null = null;
	let deadline = 0;

	const invoke = (): V => {
		const boundArgs = args as T;
		args = null;
		return cb.apply(self, boundArgs) as V;
	};

	const fire = (): void => {
		if (deadline) {
			const now = Date.now();
			if (now < deadline) {
				timer = setTimeout(fire, deadline - now);
				deadline = 0;
				return;
			}
		}
		timer = null;
		invoke();
	};

	const debounced = function (this: unknown, ...called: T) {
		self = this;
		args = called;
		if (timer) {
			if (resetTimer) deadline = Date.now() + timeout;
		} else {
			timer = setTimeout(fire, timeout);
		}
		return debounced;
	} as Debouncer<T, V>;

	debounced.cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		return debounced;
	};
	debounced.run = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
		return invoke();
	};
	return debounced;
}

/**
 * Recording, not modelled. The real one swaps in an SVG element; what a test wants to know is which
 * icon was asked for, and asserting an attribute says that without the fake claiming anything about
 * how Obsidian draws it.
 */
export function setIcon(el: FakeEl, iconId: string): void {
	el.setAttribute("data-icon", iconId);
}

/** app.js: `el.setAttribute("aria-label", text)`. The placement argument only moves the popup. */
export function setTooltip(el: FakeEl, tooltip: string): void {
	el.setAttribute("aria-label", tooltip);
}

// --- Platform ------------------------------------------------------------------------------------

/**
 * State, not constants. Two of `main.ts`'s branches are only reachable by flipping these in a
 * `beforeEach`, and the previous stub's frozen-looking pair would not allow it.
 *
 * Both default to `false` -- the least capable environment -- so a test that forgot to say where it
 * runs gets the platform on which the Vision backend is closed and nothing spawns a subprocess.
 */
export const Platform = {
	isDesktop: false,
	isMacOS: false,
};

/** The version `main.ts` puts in its diagnostics block. */
export const apiVersion = READ_FROM_VERSION;

// --- elements ------------------------------------------------------------------------------------

/**
 * Recording, not a DOM. There is no `document` under vitest, and building one would mean asserting
 * against a second implementation of the browser rather than against the plugin.
 *
 * It carries exactly the members `src/` and `pro/` call on an element, and it keeps its children, so
 * a test reads the tree the plugin built instead of a rendered string.
 */
export class FakeEl {
	readonly children: FakeEl[] = [];
	readonly classes = new Set<string>();
	readonly attributes: Record<string, string> = {};
	readonly listeners: Record<string, ((event: unknown) => void)[]> = {};
	/**
	 * Not modelled, recorded. `pro/llm-register.ts` sets `el.style.color` to say whether a verdict is
	 * good news, and a bag of strings is enough to read that back -- claiming anything more would be a
	 * second implementation of CSS.
	 */
	readonly style: Record<string, string> = {};
	text = "";
	/** Read and written by a redraw that wants the reader to stay where they were. */
	scrollTop = 0;
	visible = true;
	removed = false;
	disabled = false;
	/** Set when this element is put into another. `remove()` uses it to detach, as the DOM does. */
	parentEl: FakeEl | null = null;

	constructor(readonly tag = "div") {}

	/** `href` lands among the attributes, as `DomElementInfo.href` sets the attribute. */
	private child(tag: string, options?: { cls?: string; text?: string; href?: string; attr?: Record<string, string> }): FakeEl {
		const el = new FakeEl(tag);
		if (options?.cls) for (const c of options.cls.split(/\s+/)) el.classes.add(c);
		if (options?.text) el.text = options.text;
		if (options?.href) el.attributes.href = options.href;
		if (options?.attr) Object.assign(el.attributes, options.attr);
		el.parentEl = this;
		this.children.push(el);
		return el;
	}

	createEl(tag: string, options?: { cls?: string; text?: string; href?: string; attr?: Record<string, string> }): FakeEl {
		return this.child(tag, options);
	}
	createDiv(options?: { cls?: string; text?: string }): FakeEl {
		return this.child("div", options);
	}
	createSpan(options?: { cls?: string; text?: string }): FakeEl {
		return this.child("span", options);
	}
	appendChild(el: FakeEl): FakeEl {
		el.parentEl = this;
		this.children.push(el);
		return el;
	}
	setText(text: string): void {
		this.text = text;
		this.children.length = 0;
	}
	appendText(text: string): void {
		this.text += text;
	}
	empty(): void {
		this.children.length = 0;
		this.text = "";
		// Faithful to the DOM, and the reason it is modelled at all: emptying an element collapses its
		// content, so the browser clamps the scroll offset to zero. A stub that kept the offset would
		// let a redraw that reads it *after* emptying look correct here and still jump on a real page.
		this.scrollTop = 0;
	}
	addClass(...classes: string[]): void {
		for (const c of classes) this.classes.add(c);
	}
	removeClass(...classes: string[]): void {
		for (const c of classes) this.classes.delete(c);
	}
	toggleClass(classes: string | string[], on: boolean): void {
		for (const c of Array.isArray(classes) ? classes : [classes]) {
			if (on) this.classes.add(c);
			else this.classes.delete(c);
		}
	}
	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
	}
	addEventListener(type: string, handler: (event: unknown) => void): void {
		(this.listeners[type] ??= []).push(handler);
	}
	removeEventListener(type: string, handler: (event: unknown) => void): void {
		this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
	}
	/**
	 * Fires every handler registered for `type`. Not an Obsidian member -- the way a test clicks.
	 *
	 * The event carries `stopPropagation` and `preventDefault`, and records that they were called.
	 * A bare `{}` is not an event: a handler that reaches for either would throw, which turns a
	 * question about behaviour into a question about the double. Recording them is also what lets a
	 * test ask whether a click was held back from the editor, which has no other visible effect.
	 */
	dispatch(type: string, event: Record<string, unknown> = {}): { stopped: boolean; defaultPrevented: boolean } {
		const record = { stopped: false, defaultPrevented: false };
		const full = {
			type,
			stopPropagation: () => {
				record.stopped = true;
			},
			preventDefault: () => {
				record.defaultPrevented = true;
			},
			...event,
		};
		for (const handler of this.listeners[type] ?? []) handler(full);
		return record;
	}
	hide(): void {
		this.visible = false;
	}
	show(): void {
		this.visible = true;
	}
	/** `enhance.js`, in full: `toggle(t) { t ? this.show() : this.hide() }`. */
	toggle(visible: boolean): void {
		if (visible) this.show();
		else this.hide();
	}
	/** `Element.remove()`: detached from its parent, not merely flagged. */
	remove(): void {
		this.removed = true;
		const siblings = this.parentEl?.children;
		if (siblings) {
			const at = siblings.indexOf(this);
			if (at >= 0) siblings.splice(at, 1);
		}
		this.parentEl = null;
	}
	/**
	 * `Node.isConnected`: whether the element is still in the document.
	 *
	 * There is no document here, so this models the one transition the product code asks about --
	 * `region-view.ts` checks it to find out whether the note is still open after an await. An element
	 * is connected until something removes it.
	 */
	get isConnected(): boolean {
		return !this.removed;
	}
	/** `Element.querySelector`, for a single class only (`.name`): the first match below this one, depth first. */
	querySelector(selector: string): FakeEl | null {
		if (!/^\.[\w-]+$/.test(selector)) throw new Error(`tests/stubs: querySelector("${selector}") is not modelled; only ".class" is.`);
		for (const child of this.children) {
			if (child.classes.has(selector.slice(1))) return child;
			const inner = child.querySelector(selector);
			if (inner !== null) return inner;
		}
		return null;
	}
	/** `Element.closest`, for a single class only: this element or the nearest one above it that has it. */
	closest(selector: string): FakeEl | null {
		if (!/^\.[\w-]+$/.test(selector)) throw new Error(`tests/stubs: closest("${selector}") is not modelled; only ".class" is.`);
		let el: FakeEl | null = this;
		while (el !== null && !el.classes.has(selector.slice(1))) el = el.parentEl;
		return el;
	}
	/** Recording, not modelled: how many times the plugin asked for this element to be scrolled to. */
	scrolledIntoView = 0;
	scrollIntoView(): void {
		this.scrolledIntoView += 1;
	}
	/** Every string in this element and below it, in document order. The usual thing to assert. */
	allText(): string[] {
		const out = this.text === "" ? [] : [this.text];
		for (const c of this.children) out.push(...c.allText());
		return out;
	}
}

/**
 * A global, not an import -- which is why `src/main.ts` calls it without importing anything, and why
 * it does not exist under vitest at all. A test that renders a settings section reaches it and dies
 * with `createFragment is not defined`, six sections away from what it was testing.
 *
 * Obsidian 1.13.7, `enhance.js`:
 *
 *     window.createFragment = function (t) {
 *         var e = document.createDocumentFragment();
 *         return t && t(e), e;
 *     };
 *
 * Three facts, all modelled: the callback is optional, it is called with the fragment, and the
 * fragment -- not the callback's return -- is what comes back.
 */
export function createFragment(build?: (fragment: FakeEl) => unknown): FakeEl {
	const fragment = new FakeEl("#document-fragment");
	build?.(fragment);
	return fragment;
}

/**
 * A `<canvas>`, recorded rather than drawn.
 *
 * `region-view.ts` allocates one, sizes it, asks for a 2d context and hands both to pdf.js. What a
 * test wants to know is the size it chose -- that is where the scale ceiling and the band arithmetic
 * end up -- and modelling a rasteriser to find out would be asserting against a second browser.
 *
 * `getContext` answers `null` for anything but `"2d"`, which is what a browser does for a context it
 * cannot give, and the product code has a branch for exactly that.
 */
export class FakeCanvasEl extends FakeEl {
	width = 0;
	height = 0;
	/** Set to true to model a platform that refuses a 2d context. */
	refuseContext = false;
	constructor() {
		super("canvas");
	}
	getContext(kind: string): object | null {
		if (this.refuseContext || kind !== "2d") return null;
		return { canvas: this };
	}
}

/**
 * A global, like {@link createFragment} -- `enhance.js` puts `createEl` on `window`, so `src/` calls
 * it without importing anything and it does not exist under vitest at all.
 */
export function createEl(tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl {
	const el = tag === "canvas" ? new FakeCanvasEl() : new FakeEl(tag);
	if (options?.cls) for (const c of options.cls.split(/\s+/)) el.classes.add(c);
	if (options?.text) el.text = options.text;
	if (options?.attr) Object.assign(el.attributes, options.attr);
	return el;
}

// --- the file tree -------------------------------------------------------------------------------

export class TAbstractFile {
	path = "";
	name = "";
	parent: TFolder | null = null;
	constructor(public vault: FakeVault) {}
}

export class TFile extends TAbstractFile {
	basename = "";
	extension = "";
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "/";
	}
}

function basename(path: string): string {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? path : path.slice(cut + 1);
}

// --- what checkPath refuses ----------------------------------------------------------------------
//
// app.js, read in full. This was written off as unprovable before the implementation was read, and
// it matters for this plugin specifically: a reMarkable notebook is titled by hand, and
// `Meeting 14:30` is a legal notebook title and an illegal macOS filename.

export type VaultPlatform = "macos" | "linux" | "windows" | "mobile";

/** app.js: `win ? '*"\\/<>:|?' : "\\/:" + (mobile ? '*?<>"' : "")`. */
function forbiddenCharacters(platform: VaultPlatform): string {
	if (platform === "windows") return '*"\\/<>:|?';
	return "\\/:" + (platform === "mobile" ? '*?<>"' : "");
}

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/** app.js, `checkPath`. The Windows half really is Windows-only -- the character half is not. */
export function checkPath(path: string, platform: VaultPlatform): void {
	if (platform === "windows") {
		const last = path.charAt(path.length - 1);
		if (last === "." || last === " ") throw new Error("File names cannot end with a dot or a space.");
		const base = basename(path).replace(/\.[^.]+$/, "");
		if (WINDOWS_RESERVED.test(base)) throw new Error("File name is forbidden: " + base);
	}
	const forbidden = forbiddenCharacters(platform);
	const segmentForbidden = new RegExp(`[${forbidden.replace(/[\\^\]-]/g, "\\$&")}]`);
	if (path.split("/").some((segment) => segmentForbidden.test(segment))) {
		throw new Error("File name cannot contain any of the following characters: " + forbidden.split("").join(" "));
	}
}

// --- the Vault -----------------------------------------------------------------------------------

export type VaultEvent = "rename" | "create" | "modify" | "delete";
/** The workspace's events, which is one: the file explorer's context menu. */
export type WorkspaceEvent = "file-menu";
export interface EventRef {
	event: VaultEvent | WorkspaceEvent;
	handler: (...args: never[]) => void;
}

export interface FakeVaultOptions {
	name?: string;
	/**
	 * Which `checkPath` rules apply, and whether the *filesystem* folds case. Deliberately separate
	 * from `Platform` above, because in Obsidian they are separate too: the Vault reads constants
	 * derived from `process.platform`, not the `Platform` object the plugin reads.
	 */
	platform?: VaultPlatform;
}

/**
 * Models the file *index*, which is the only thing this plugin ever touches -- `vault.adapter`
 * appears nowhere in `src/` or `pro/`. Plus the one place the index and the filesystem are known to
 * disagree, because that disagreement is the highest-ranked gap in the repo.
 */
export class FakeVault {
	/** app.js calls it `fileMap`, and it is an exact-string map. That is the whole of rule 2. */
	private readonly fileMap = new Map<string, TAbstractFile>();
	private readonly contents = new Map<string, string>();
	/**
	 * Every path this vault actually wrote, in order, with repeats. Not an Obsidian member -- it is
	 * here because without it `process()` skipping an unchanged write is unobservable, and a
	 * modelled behaviour no test can see is one that rots silently. A deliberate mutation removing
	 * the skip survived the whole suite until this existed.
	 */
	readonly writeLog: string[] = [];
	private readonly binaries = new Map<string, ArrayBuffer>();
	private readonly refs: EventRef[] = [];
	private readonly name: string;
	private readonly platform: VaultPlatform;

	constructor(options: FakeVaultOptions = {}) {
		this.name = options.name ?? "Test Vault";
		this.platform = options.platform ?? "macos";
	}

	getName(): string {
		return this.name;
	}

	/**
	 * The filesystem, not the index -- the only member of `vault.adapter` this plugin reaches, and
	 * the one `Vault.create` itself calls before it throws.
	 *
	 * app.js: `fsPromises.access(fullPath)`, false on any error. So the *filesystem* decides, which
	 * means it folds case wherever the platform does. The real signature takes a second `sensitive`
	 * argument that adds an exact-case confirmation on top; nothing in this plugin passes it, so
	 * nothing here models it.
	 */
	readonly adapter = {
		exists: async (path: string): Promise<boolean> => this.existsOnDisk(path) !== null,
	};

	// app.js: `fileMap.hasOwnProperty(p)` and an instance check. Exact string, no folding. The
	// insensitive lookup exists in Obsidian as a separate method and this plugin never calls it.
	getAbstractFileByPath(path: string): TAbstractFile | null {
		return this.fileMap.get(path) ?? null;
	}
	getFileByPath(path: string): TFile | null {
		const found = this.fileMap.get(path);
		return found instanceof TFile ? found : null;
	}
	getFolderByPath(path: string): TFolder | null {
		const found = this.fileMap.get(path);
		return found instanceof TFolder ? found : null;
	}
	/** Every Markdown file in the vault, which is how the plugin sweeps for frontmatter keys. */
	getMarkdownFiles(): TFile[] {
		return this.getAllLoadedFiles().filter((file): file is TFile => file instanceof TFile && file.extension === "md");
	}

	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.fileMap.values()];
	}

	/**
	 * Rule 2. `create` checks `adapter.exists()` -- the filesystem -- while every lookup above goes
	 * through the index. macOS and Windows fold case and the index does not, so `create` can throw
	 * on a path `getFileByPath` says is free. That is not a hypothesis: it is the mechanism behind
	 * the collision the plugin ships with today.
	 */
	private existsOnDisk(path: string): string | null {
		const folds = this.platform !== "linux";
		if (this.fileMap.has(path)) return path;
		if (!folds) return null;
		const lower = path.toLowerCase();
		for (const key of this.fileMap.keys()) if (key.toLowerCase() === lower) return key;
		return null;
	}

	async read(file: TFile): Promise<string> {
		return this.contents.get(file.path) ?? "";
	}
	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	/** app.js: read, apply, write only if it changed, return the new content. */
	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const before = this.contents.get(file.path) ?? "";
		const after = fn(before);
		if (after !== before) {
			this.contents.set(file.path, after);
			this.writeLog.push(file.path);
		}
		return after;
	}

	/** Rule 1. app.js throws this exact sentence, from `create` and from `createBinary` alike. */
	async create(path: string, data: string): Promise<TFile | null> {
		const p = normalizePath(path);
		checkPath(p, this.platform);
		if (this.existsOnDisk(p)) throw new Error("File already exists.");
		this.contents.set(p, data);
		this.writeLog.push(p);
		return this.index(p, "file") as TFile;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile | null> {
		const p = normalizePath(path);
		checkPath(p, this.platform);
		if (this.existsOnDisk(p)) throw new Error("File already exists.");
		this.binaries.set(p, data);
		this.writeLog.push(p);
		return this.index(p, "file") as TFile;
	}

	/** The bytes of a binary file, as `region-view.ts` reads the embedded PDF back out of the vault. */
	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const bytes = this.binaries.get(file.path);
		if (bytes === undefined) throw new Error(`FakeVault: no binary at ${file.path}`);
		// A copy, because Obsidian hands back a fresh buffer and a caller that transfers it -- pdf.js
		// does -- must not detach the vault's own copy.
		return bytes.slice(0);
	}

	async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
		this.binaries.set(file.path, data);
		this.writeLog.push(file.path);
	}

	/** app.js: the same shape as `create`, with its own sentence. */
	async createFolder(path: string): Promise<TFolder | null> {
		const p = normalizePath(path);
		checkPath(p, this.platform);
		if (this.existsOnDisk(p)) throw new Error("Folder already exists.");
		return this.index(p, "folder") as TFolder;
	}

	on(event: VaultEvent, handler: (...args: never[]) => void): EventRef {
		const ref = { event, handler };
		this.refs.push(ref);
		return ref;
	}

	/** Not an Obsidian member. How a test says "the user renamed this in the file explorer". */
	trigger(event: VaultEvent, ...args: unknown[]): void {
		for (const ref of this.refs) {
			if (ref.event === event) (ref.handler as (...a: unknown[]) => void)(...args);
		}
	}

	/** Not an Obsidian member. Puts a file in the vault without going through `create`'s rules. */
	seed(path: string, content = ""): TFile {
		this.contents.set(path, content);
		return this.index(path, "file") as TFile;
	}

	/**
	 * Not an Obsidian member. What `fileManager.renameFile` does to the index.
	 *
	 * A folder fans out. app.js, the desktop adapter, after renaming a folder: it fires
	 * `trigger("renamed", t, e)` for the folder, then `for (s in this.files)` every path
	 * `s.startsWith(e + "/")` gets moved to `t + s.slice(e.length)` and fires one more. The Vault
	 * turns each into its own `rename` event, because renaming a folder does *not* move its
	 * children -- `TFolder` never overrides `setPath`, so only the folder's own path changed and
	 * every child is still indexed under the old prefix.
	 *
	 * So one folder move reaches a subscriber as **1 + one per descendant**, folder first. Modelled
	 * because a listener that handles only the folder event and one that handles only the child
	 * events both look correct against a fake that fires once.
	 */
	rename(file: TAbstractFile, toPath: string): void {
		const from = file.path;
		this.move(file, toPath);
		if (!(file instanceof TFolder)) return;
		const prefix = `${from}/`;
		for (const [path, entry] of [...this.fileMap]) {
			if (path.startsWith(prefix)) this.move(entry, toPath + path.slice(from.length));
		}
	}

	/** One entry, and the single `rename` event it fires. */
	private move(entry: TAbstractFile, toPath: string): void {
		const from = entry.path;
		this.fileMap.delete(from);
		const content = this.contents.get(from);
		if (content !== undefined) {
			this.contents.delete(from);
			this.contents.set(toPath, content);
		}
		const binary = this.binaries.get(from);
		if (binary !== undefined) {
			this.binaries.delete(from);
			this.binaries.set(toPath, binary);
		}
		this.setPath(entry, toPath);
		this.fileMap.set(toPath, entry);
		this.trigger("rename", entry, from);
	}

	/** Not an Obsidian member. What a test asserts a write landed as. */
	fileContents(): Record<string, string> {
		return Object.fromEntries(this.contents);
	}

	private setPath(entry: TAbstractFile, path: string): void {
		entry.path = path;
		entry.name = basename(path);
		if (entry instanceof TFile) {
			const dot = entry.name.lastIndexOf(".");
			entry.basename = dot <= 0 ? entry.name : entry.name.slice(0, dot);
			entry.extension = dot <= 0 ? "" : entry.name.slice(dot + 1);
		}
	}

	private index(path: string, kind: "file" | "folder"): TAbstractFile {
		const existing = this.fileMap.get(path);
		if (existing) return existing;
		const entry = kind === "file" ? new TFile(this) : new TFolder(this);
		this.setPath(entry, path);
		this.fileMap.set(path, entry);
		return entry;
	}
}

// --- the App's three one-off reaches ---------------------------------------------------------------
//
// `workspace`, `fileManager` and `metadataCache` are one method each in the whole plugin. Three
// stubs of one method, not three subsystems.

export class FakeApp {
	readonly vault: FakeVault;
	readonly workspace = {
		/**
		 * False until a test says otherwise, which is what a plugin loaded during Obsidian's own
		 * startup sees. `onLayoutReady` runs its callback at once only once this is true.
		 */
		layoutReady: false,
		/** Callbacks handed over before the workspace was ready, still waiting. */
		pending: [] as (() => void)[],
		/**
		 * The note on screen. Obsidian answers this from the active leaf; here a test opens a note by
		 * setting it, and the plugin reads it through `getActiveFile()` exactly as it does in Obsidian.
		 */
		activeFile: null as TFile | null,
		getActiveFile: (): TFile | null => this.workspace.activeFile,
		/** Where `embedded-pdf-keys.ts` listens for the focus moving into an embedded PDF. Recording. */
		containerEl: new FakeEl(),
		/**
		 * The view on screen, whatever type is asked for: only `embedded-pdf-keys.ts` asks, and only for
		 * a `MarkdownView`. A test sets it, as it sets `activeFile`.
		 */
		activeView: null as unknown,
		getActiveViewOfType: (_type: unknown): unknown => this.workspace.activeView,
		/** Recording: every file opened in a leaf, as its path plus the `eState.subpath` it was opened at. */
		openedFiles: [] as string[],
		getLeaf: (_newLeaf?: unknown) => ({
			openFile: async (file: TFile, state?: { eState?: { subpath?: string } }): Promise<void> => {
				this.workspace.openedFiles.push(`${file.path}${state?.eState?.subpath ?? ""}`);
			},
		}),
		onLayoutReady: (cb: () => void): void => {
			if (this.workspace.layoutReady) cb();
			else this.workspace.pending.push(cb);
		},
		/** Not an Obsidian member. What Obsidian does when the workspace has finished loading. */
		markLayoutReady: (): void => {
			this.workspace.layoutReady = true;
			for (const cb of this.workspace.pending.splice(0, this.workspace.pending.length)) cb();
		},
		on: (event: WorkspaceEvent, handler: (...args: never[]) => void): EventRef => {
			const ref = { event, handler };
			this.workspaceRefs.push(ref);
			return ref;
		},
		/** Not an Obsidian member. How a test says "the user right-clicked this file". */
		trigger: (event: WorkspaceEvent, ...args: unknown[]): void => {
			for (const ref of this.workspaceRefs) {
				if (ref.event === event) (ref.handler as (...a: unknown[]) => void)(...args);
			}
		},
	};
	/** The workspace's own events. Same shape as the vault's, for the same reason: one `trigger`. */
	private readonly workspaceRefs: EventRef[] = [];
	/**
	 * Obsidian's Keychain (since 1.11.4), as far as `main.ts` reads it: `getSecret`. Not read from
	 * `app.js`; `obsidian.d.ts` says "the secret value or null if not found", and that is all this
	 * claims. `secrets` is not an Obsidian member: a test puts a token in it, as the user would through
	 * the settings.
	 */
	readonly secretStorage = {
		secrets: new Map<string, string>(),
		getSecret: (id: string): string | null => this.secretStorage.secrets.get(id) ?? null,
	};
	readonly fileManager = {
		renameFile: async (file: TAbstractFile, newPath: string): Promise<void> => {
			this.vault.rename(file, newPath);
		},
	};
	readonly metadataCache = {
		/**
		 * What Obsidian parsed out of each note's `---` block, by path.
		 *
		 * Not an Obsidian member: there, the cache fills itself from the files. Here a test writes the
		 * frontmatter it wants the plugin to see, because parsing YAML in a stub would be modelling
		 * `js-yaml` rather than Obsidian.
		 */
		frontmatter: new Map<string, Record<string, unknown>>(),
		/** The `^block` ids of each note, by path. Not an Obsidian member, written by a test like `frontmatter`. */
		blocks: new Map<string, string[]>(),
		/** The plugin resolves an embed to a file. Exact path first, then the vault's own lookup. */
		getFirstLinkpathDest: (linkpath: string, _sourcePath: string): TFile | null =>
			this.vault.getFileByPath(linkpath) ?? this.vault.getFileByPath(normalizePath(linkpath)),
		getFileCache: (file: TFile): { frontmatter?: Record<string, unknown>; blocks?: Record<string, unknown> } | null => {
			const frontmatter = this.metadataCache.frontmatter.get(file.path);
			const blocks = this.metadataCache.blocks.get(file.path);
			if (frontmatter === undefined && blocks === undefined) return null;
			return {
				...(frontmatter === undefined ? {} : { frontmatter }),
				...(blocks === undefined ? {} : { blocks: Object.fromEntries(blocks.map((id) => [id, { id }])) }),
			};
		},
		/** Obsidian answers the shortest unambiguous form; the basename is that wherever it is unique. */
		fileToLinktext: (file: TFile, _sourcePath: string): string => file.basename,
	};

	/** The root scope, which `embedded-pdf-keys.ts` hangs its own scope under. */
	readonly scope = new Scope();
	/** Recording: the scopes pushed and not yet popped, last on top. Claims nothing about key routing. */
	readonly keymap = {
		pushed: [] as Scope[],
		pushScope: (scope: Scope): void => void this.keymap.pushed.push(scope),
		popScope: (scope: Scope): void => {
			this.keymap.pushed = this.keymap.pushed.filter((pushed) => pushed !== scope);
		},
	};

	constructor(vault: FakeVault = new FakeVault()) {
		this.vault = vault;
	}
}

/** Recording. The keys registered on it; nothing routes a key here -- a test calls `func` itself. */
export class Scope {
	readonly keys: { modifiers: string[] | null; key: string | null; func: () => unknown }[] = [];
	constructor(readonly parent?: unknown) {}
	register(modifiers: string[] | null, key: string | null, func: () => unknown): object {
		this.keys.push({ modifiers, key, func });
		return {};
	}
}

/** Only ever a type tag handed to `getActiveViewOfType`; a test sets the view it answers with. */
export class MarkdownView {}

// --- the constructible classes ---------------------------------------------------------------------

/** Recording. Every notice the plugin raised, in order, which is what its tests assert. */
export const noticeLog: { message: string; timeout?: number }[] = [];

export class Notice {
	readonly noticeEl = new FakeEl();
	constructor(
		readonly message: string,
		readonly timeout?: number,
	) {
		noticeLog.push({ message, timeout });
		this.noticeEl.setText(message);
	}
	setMessage(message: string): this {
		this.noticeEl.setText(message);
		return this;
	}
	hide(): void {
		this.noticeEl.remove();
	}
}

/** Not an Obsidian member. Reads the notices and clears them, so tests do not leak into each other. */
export function takeNotices(): string[] {
	return noticeLog.splice(0, noticeLog.length).map((n) => n.message);
}

/**
 * Recording. Every modal opened, in order -- a dialog nobody can see is a dialog no test can find,
 * and "no dialog was opened" is half of what the confirmations are asserted on.
 */
export const modalLog: Modal[] = [];

/** Not an Obsidian member. Reads the modals and clears them. */
export function takeModals(): Modal[] {
	return modalLog.splice(0, modalLog.length);
}

export class Modal {
	readonly contentEl = new FakeEl();
	readonly titleEl = new FakeEl();
	opened = false;
	constructor(readonly app: FakeApp) {}
	/**
	 * Escape, a click on the background and `close()` are one path in Obsidian too: both handlers call
	 * `close()`, which unloads the component and runs `onClose`. So a modal cannot tell a test which
	 * of the three happened -- and neither can the plugin, which is why a confirmation has to default
	 * to "no" rather than be set by whichever handler ran.
	 */
	open(): void {
		modalLog.push(this);
		this.opened = true;
		this.onOpen();
	}
	close(): void {
		this.opened = false;
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

/** `obsidian.d.ts`: a modal with a text field over a list of suggestions. Only the placeholder is read here. */
export abstract class SuggestModal extends Modal {
	placeholder = "";
	setPlaceholder(placeholder: string): void {
		this.placeholder = placeholder;
	}
}

/**
 * `obsidian.d.ts`: lists `getItems()` by `getItemText(item)`, and calls `onChooseItem` with the item
 * chosen. The fuzzy matching itself is Obsidian's and not modelled: a test chooses by the text shown.
 */
export abstract class FuzzySuggestModal<T> extends SuggestModal {
	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt: unknown): void;
	/** Not an Obsidian member. The list before anything is typed: each item's text, in `getItems` order. */
	get itemTexts(): string[] {
		return this.getItems().map((item) => this.getItemText(item));
	}
	/** Not an Obsidian member. The user picks the item showing `text`; the modal closes, then hears of it. */
	choose(text: string): void {
		const item = this.getItems().find((candidate) => this.getItemText(candidate) === text);
		if (item === undefined) throw new Error(`tests/stubs: the picker lists no "${text}" among ${this.itemTexts.join(", ")}`);
		this.close();
		this.onChooseItem(item, {});
	}
}

export class ProgressBarComponent {
	value = 0;
	constructor(readonly containerEl: FakeEl) {}
	setValue(value: number): this {
		this.value = value;
		return this;
	}
}

export class MarkdownRenderChild {
	private readonly cleanups: (() => void)[] = [];
	constructor(readonly containerEl: FakeEl) {}
	onload(): void {}
	onunload(): void {}
	register(cb: () => void): void {
		this.cleanups.push(cb);
	}
	/** Not an Obsidian member. Runs what `register` collected, the way unloading would. */
	unload(): void {
		for (const cb of this.cleanups.splice(0, this.cleanups.length)) cb();
		this.onunload();
	}
}

// --- Setting, recording ------------------------------------------------------------------------
//
// Recording rather than modelled: what a test about the settings surface wants to know is which rows
// were drawn, in what order, with which text and which control -- none of which is a claim about how
// Obsidian paints them.

export class TextComponent {
	value = "";
	placeholder = "";
	disabled = false;
	readonly inputEl = new FakeEl("input");
	private changed: ((value: string) => unknown) | null = null;
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	getValue(): string {
		return this.value;
	}
	setPlaceholder(placeholder: string): this {
		this.placeholder = placeholder;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onChange(cb: (value: string) => unknown): this {
		this.changed = cb;
		return this;
	}
	/** Not an Obsidian member. How a test types into the field. */
	type(value: string): void {
		this.value = value;
		this.changed?.(value);
	}
}

export class ToggleComponent {
	value = false;
	disabled = false;
	private changed: ((value: boolean) => unknown) | null = null;
	setValue(value: boolean): this {
		this.value = value;
		return this;
	}
	getValue(): boolean {
		return this.value;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
	tooltip = "";
	onChange(cb: (value: boolean) => unknown): this {
		this.changed = cb;
		return this;
	}
	/** Not an Obsidian member. How a test flips the switch. */
	toggle(value: boolean): void {
		this.value = value;
		this.changed?.(value);
	}
}

/**
 * An `<option>`, because `src/main.ts:1215` reaches past the component and mutates one:
 * `dropdown.selectEl.options[last].disabled = true` and then rewrites its `text`. That is how a
 * backend that cannot run here is shown greyed out with the reason in place of its name -- so the
 * option elements, not just the value map, are what a test has to be able to read.
 */
export class FakeOptionEl extends FakeEl {
	value = "";
	constructor() {
		super("option");
	}
}

/** A `<select>`. `options` is the live collection the DOM gives it. */
export class FakeSelectEl extends FakeEl {
	readonly options: FakeOptionEl[] = [];
	constructor() {
		super("select");
	}
}

export class DropdownComponent {
	value = "";
	disabled = false;
	readonly selectEl = new FakeSelectEl();
	private changed: ((value: string) => unknown) | null = null;
	/**
	 * app.js: `addOption(value, display)` is `this.selectEl.createEl("option", {value, text: display})`
	 * and nothing else -- there is no separate list. Modelled that way rather than as a map, so an
	 * option the plugin relabels afterwards reads back relabelled.
	 */
	addOption(value: string, display: string): this {
		const option = new FakeOptionEl();
		option.value = value;
		option.text = display;
		this.selectEl.options.push(option);
		this.selectEl.appendChild(option);
		return this;
	}
	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) this.addOption(value, display);
		return this;
	}
	/** Not an Obsidian member. The option list as a test wants to read it: value -> label, in order. */
	get options(): Record<string, string> {
		return Object.fromEntries(this.selectEl.options.map((option) => [option.value, option.text]));
	}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	getValue(): string {
		return this.value;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onChange(cb: (value: string) => unknown): this {
		this.changed = cb;
		return this;
	}
	/** Not an Obsidian member. How a test picks an entry. */
	pick(value: string): void {
		this.value = value;
		this.changed?.(value);
	}
}

export class ButtonComponent {
	text = "";
	icon = "";
	tooltip = "";
	cta = false;
	warning = false;
	disabled = false;
	readonly buttonEl = new FakeEl("button");
	private clicked: ((event: unknown) => unknown) | null = null;
	setButtonText(text: string): this {
		this.text = text;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
	setCta(): this {
		this.cta = true;
		return this;
	}
	setWarning(): this {
		this.warning = true;
		return this;
	}
	/** Recording, like {@link setCta}: which buttons asked to be drawn as destructive. */
	destructive = false;
	setDestructive(): this {
		this.destructive = true;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(cb: (event: unknown) => unknown): this {
		this.clicked = cb;
		return this;
	}
	/** Not an Obsidian member. How a test presses it. */
	click(): unknown {
		return this.clicked?.({});
	}
}

/** `obsidian.d.ts`: an icon button for secondary actions -- icon and tooltip, no label. */
export class ExtraButtonComponent {
	icon = "";
	tooltip = "";
	disabled = false;
	readonly extraSettingsEl = new FakeEl("div");
	private clicked: (() => unknown) | null = null;
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(cb: () => unknown): this {
		this.clicked = cb;
		return this;
	}
	/** Not an Obsidian member. How a test presses it. */
	click(): unknown {
		return this.clicked?.();
	}
}

/**
 * Obsidian's Keychain picker (since 1.11.4): the user picks or creates an entry, and the component
 * hands back the entry's **name**, never the secret. Not read from `app.js`; `obsidian.d.ts` gives
 * `setValue(name)` and `onChange(name | null)`, and that is all this claims.
 */
export class SecretComponent {
	value = "";
	private changed: ((value: string | null) => unknown) | null = null;
	constructor(
		readonly app: FakeApp,
		readonly containerEl: FakeEl,
	) {}
	setValue(value: string): this {
		this.value = value;
		return this;
	}
	onChange(cb: (value: string | null) => unknown): this {
		this.changed = cb;
		return this;
	}
	/** Not an Obsidian member. How a test picks a Keychain entry, or clears the choice with `null`. */
	pick(name: string | null): unknown {
		this.value = name ?? "";
		return this.changed?.(name);
	}
}

export class Setting {
	name = "";
	desc = "";
	heading = false;
	disabled = false;
	readonly settingEl = new FakeEl();
	/** Where the name and description sit. Detached here, like the three below: nothing reads the tree. */
	readonly infoEl = new FakeEl();
	readonly nameEl = new FakeEl();
	readonly descEl = new FakeEl();
	readonly controlEl = new FakeEl();
	readonly texts: TextComponent[] = [];
	readonly toggles: ToggleComponent[] = [];
	readonly dropdowns: DropdownComponent[] = [];
	readonly buttons: ButtonComponent[] = [];
	readonly extraButtons: ExtraButtonComponent[] = [];
	/** What `addComponent` built, in order. */
	readonly components: unknown[] = [];

	constructor(readonly containerEl: FakeEl) {
		settingLog.push(this);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string | FakeEl): this {
		this.name = typeof name === "string" ? name : name.allText().join("");
		return this;
	}
	/**
	 * Replaces what `descEl` held. A fragment's elements land in it, as the DOM moves a fragment's
	 * nodes: a fold in a description is there to read.
	 */
	setDesc(desc: string | FakeEl): this {
		this.desc = typeof desc === "string" ? desc : desc.allText().join(" ");
		this.descEl.empty();
		if (typeof desc !== "string") for (const child of [...desc.children]) this.descEl.appendChild(child);
		return this;
	}
	setHeading(): this {
		this.heading = true;
		return this;
	}
	setClass(cls: string): this {
		this.settingEl.addClass(cls);
		return this;
	}
	/** 1.15.0's app.js: the row's class, then `setDisabled` on each of its components. */
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		for (const list of [this.texts, this.toggles, this.dropdowns, this.buttons, this.extraButtons]) for (const component of list) component.setDisabled(disabled);
		return this;
	}
	setTooltip(tooltip: string): this {
		this.settingEl.setAttribute("aria-label", tooltip);
		return this;
	}
	addText(cb: (text: TextComponent) => unknown): this {
		const text = new TextComponent();
		this.texts.push(text);
		cb(text);
		return this;
	}
	addTextArea(cb: (text: TextComponent) => unknown): this {
		return this.addText(cb);
	}
	addToggle(cb: (toggle: ToggleComponent) => unknown): this {
		const toggle = new ToggleComponent();
		this.toggles.push(toggle);
		cb(toggle);
		return this;
	}
	addDropdown(cb: (dropdown: DropdownComponent) => unknown): this {
		const dropdown = new DropdownComponent();
		this.dropdowns.push(dropdown);
		cb(dropdown);
		return this;
	}
	addButton(cb: (button: ButtonComponent) => unknown): this {
		const button = new ButtonComponent();
		this.buttons.push(button);
		cb(button);
		return this;
	}
	addExtraButton(cb: (button: ExtraButtonComponent) => unknown): this {
		const button = new ExtraButtonComponent();
		this.extraButtons.push(button);
		cb(button);
		return this;
	}
	addComponent(cb: (el: FakeEl) => unknown): this {
		this.components.push(cb(this.controlEl));
		return this;
	}
	then(cb: (setting: this) => unknown): this {
		cb(this);
		return this;
	}
	/** The controls go, from the element and from the record: a redrawn row starts without them. */
	clear(): this {
		this.controlEl.empty();
		for (const list of [this.texts, this.toggles, this.dropdowns, this.buttons, this.extraButtons, this.components]) list.length = 0;
		return this;
	}
}

/** Recording. Every row constructed, in draw order -- order is a decision this plugin makes. */
export const settingLog: Setting[] = [];

/** Not an Obsidian member. Reads the rows and clears them. */
export function takeSettings(): Setting[] {
	return settingLog.splice(0, settingLog.length);
}

// --- Plugin --------------------------------------------------------------------------------------

export interface Command {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
}

export class Plugin {
	readonly commands: Command[] = [];
	readonly settingTabs: PluginSettingTab[] = [];
	readonly eventRefs: EventRef[] = [];
	readonly domEvents: { el: FakeEl; type: string }[] = [];
	readonly codeBlockProcessors = new Map<string, (source: string, el: FakeEl, ctx: unknown) => unknown>();
	readonly protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
	readonly statusBarItems: FakeEl[] = [];
	readonly cleanups: (() => void)[] = [];
	/** What `loadData()` returns. A test sets it to the `data.json` it wants to arrive with. */
	saved: unknown = null;
	/** Every `saveData()` argument, in order. What proves the plugin persisted, and when. */
	readonly saves: unknown[] = [];

	constructor(
		readonly app: FakeApp,
		readonly manifest: { id: string; name: string; version: string } = {
			id: "tagged-sync",
			name: "Tagged Sync",
			version: "0.0.0-test",
		},
	) {}

	async loadData(): Promise<unknown> {
		return this.saved;
	}
	async saveData(data: unknown): Promise<void> {
		this.saved = data;
		this.saves.push(structuredClone(data));
	}
	addCommand(command: Command): Command {
		this.commands.push(command);
		return command;
	}
	addStatusBarItem(): FakeEl {
		const el = new FakeEl();
		this.statusBarItems.push(el);
		return el;
	}
	/** `obsidian.d.ts`: `update()` "Called by addSettingTab()" -- so a tab's definitions run inside `onload`. */
	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
		tab.update();
	}
	registerEvent(ref: EventRef): void {
		this.eventRefs.push(ref);
	}
	registerDomEvent(el: FakeEl, type: string, handler: (event: unknown) => void): void {
		this.domEvents.push({ el, type });
		el.addEventListener(type, handler);
	}
	register(cb: () => void): void {
		this.cleanups.push(cb);
	}
	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: (source: string, el: FakeEl, ctx: unknown) => unknown,
	): void {
		this.codeBlockProcessors.set(language, handler);
	}
	registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
		this.protocolHandlers.set(action, handler);
	}
	onload(): void | Promise<void> {}
	onunload(): void {}
}

/**
 * The declarative settings API (Obsidian 1.13): the tab answers `getSettingDefinitions()` and Obsidian
 * draws what comes back. Read from `obsidian-1.15.0.asar` -> `app.js`, not 1.13.7 (the API is newer
 * than this file's other readings): `update()` is `this.settingItems = this.getSettingDefinitions()`
 * followed by `refreshCurrentPage(this)`, so it draws again whatever is open; a render row's `Setting`
 * gets `setName(def.name)` and `setDesc(def.desc)` before `def.render(setting, group)` runs, and the
 * cleanup it returns is kept on the row. From `obsidian.d.ts` only: `addSettingTab()` calls `update()`,
 * and the cleanup runs "before the row is torn down".
 *
 * Also from 1.15.0's `app.js`: a control row's change is `await this.setControlValue(key, value)`
 * followed by `this.refreshDomState()` (`getControlBinding`), and `refreshDomState()` re-evaluates
 * each drawn row's `visible` into `settingEl.toggle(…)` and its `disabled` into `setting.setDisabled(…)`
 * -- nothing is drawn again, so a row hidden by `visible` stays in the page. The value a control starts
 * with is `getControlValue(key)`, or the control's `defaultValue` when that answers nothing.
 *
 * And a redraw **reuses** a row whose key it drew before (`due`/`nue`): the key is the control's key,
 * else the row's name, else its index, within its group. The reused row's cleanup runs, `setting.clear()`
 * empties its controls, and the definition is drawn again into the same `Setting` -- so whatever a
 * render put into `settingEl` itself is still there. A row whose key is gone has its cleanup run after
 * the redraw. Not modelled: Obsidian skips redrawing a control row that holds the focused element.
 *
 * A group is an element with `setting-group` and its `cls`, holding its heading and its rows (app.js
 * `HDe`); the heading is drawn here as a heading {@link Setting} carrying the `extraButtons` (Obsidian
 * draws a header of its own). As in app.js `rue`, a redraw keeps a group with the same path: its
 * heading is set again and its rows drawn again, but its class, extra buttons and search box -- with
 * the `match` it was first given -- stay as its first draw made them. The group a render callback
 * gets is an empty object: app.js passes its own internal record there, not the `SettingGroup` the
 * d.ts names, so nothing in the plugin may read it. A group's `search` box is typed into with
 * {@link PluginSettingTab.groupSearch}; `match` runs for each searchable row then and after every
 * redraw once something was typed (obsidian.d.ts; ticket 17's F6 saw it per keystroke, `""` included).
 * A control is drawn as the component its type names; `folder` as a text field (its suggester is
 * Obsidian's); `secret` as a {@link SecretComponent}, whose change hands `setControlValue` the picked
 * entry's name or `null`.
 *
 * Kinds and fields no definition of this plugin uses yet throw, rather than being drawn as though they
 * were understood: a group's `visible` (Obsidian hides a group whose rows are all hidden) is one.
 */
export interface FakeDefinition {
	type?: "group" | "list" | "page";
	name?: string;
	desc?: string | FakeEl;
	heading?: string;
	cls?: string;
	searchable?: boolean;
	aliases?: string[];
	visible?: boolean | (() => boolean);
	control?: FakeControl;
	items?: FakeDefinition[];
	render?: (setting: Setting, group: object) => void | (() => void);
	displayValue?: string | (() => string);
	status?: "warning" | null | (() => "warning" | null);
	extraButtons?: ((button: ExtraButtonComponent) => unknown)[];
	search?: { placeholder?: string; match: (def: FakeDefinition, query: string) => boolean };
}

/** The control types this plugin's definitions use. */
export interface FakeControl {
	type: "toggle" | "dropdown" | "text" | "folder" | "secret";
	key: string;
	defaultValue?: unknown;
	disabled?: boolean | (() => boolean);
	options?: Record<string, string>;
	placeholder?: string;
	includeRoot?: boolean;
}

const NOT_MODELLED = ["action", "disabled"];

/** `app.js`'s `el(value, fallback)`: a predicate is a value or a function answering one. */
function evaluate<T>(value: T | (() => T) | undefined, fallback: T): T {
	return value === undefined ? fallback : typeof value === "function" ? (value as () => T)() : value;
}

/** obsidian.d.ts 1.13.1: the value label and status a page's entry shows. Read back, not drawn. */
export class DisplayValueComponent {
	value: string | null = null;
	status: "warning" | null = null;
	constructor(readonly containerEl: FakeEl) {}
	setValue(value: string | null): this {
		this.value = value;
		return this;
	}
	setStatus(status: "warning" | null): this {
		this.status = status;
		return this;
	}
}

/** A row on screen: what drew it, its `Setting`, and the cleanup its render returned. */
interface DrawnRow {
	def: FakeDefinition;
	setting: Setting;
	cleanup?: () => void;
	/** What its group's `search.match` last answered; a row outside a filtered group always matches. */
	matches?: boolean;
}

/** A group as its first draw built it: the element, the heading row, and the search box, if any. */
interface DrawnGroup {
	groupEl: FakeEl;
	heading: Setting | null;
	search?: NonNullable<FakeDefinition["search"]>;
}

/** A group with a search box, as last drawn: its rows are what `match` is asked about. */
interface DrawnSearch {
	path: string;
	search: NonNullable<FakeDefinition["search"]>;
	rows: DrawnRow[];
}

/** How {@link renderSettingTab} was last asked to draw, so `update()` draws the same view again. */
export interface RenderOptions {
	/** A page by name, at any depth. Absent: the root, with each page as one entry row. */
	page?: string;
	/**
	 * Not Obsidian: each page drawn right under its entry, as a heading with the page's name and its
	 * rows -- the one long tab the plugin had before it had pages, which is what its older tests read.
	 */
	openPages?: boolean;
}

export class PluginSettingTab {
	readonly containerEl = new FakeEl();
	settingItems: FakeDefinition[] = [];
	/** Not an Obsidian member. What is on screen, or `null` while the tab is closed. */
	shown: RenderOptions | null = null;
	/** The view the rows below were drawn for; another view starts from nothing. */
	private drawnFor = "";
	/** Every row drawn, by its key, with its definition and cleanup: what a redraw reuses and `refreshDomState()` walks. */
	private rendered = new Map<string, DrawnRow>();
	/** Every group drawn, by its path: what a redraw keeps the header of. */
	private groups = new Map<string, DrawnGroup>();
	/** The groups with a search box on screen, by heading. */
	private searches = new Map<string, DrawnSearch>();
	/** What was typed into each search box, by the group's path: kept across redraws. */
	private readonly queries = new Map<string, string>();
	constructor(
		readonly app: FakeApp,
		readonly plugin: Plugin,
	) {}
	getSettingDefinitions(): FakeDefinition[] {
		return [];
	}
	/** `app.js`: `PluginSettingTab` reads `this.plugin.settings[key]`. The plugin overrides both. */
	getControlValue(key: string): unknown {
		return (this.plugin as unknown as { settings?: Record<string, unknown> }).settings?.[key];
	}
	setControlValue(key: string, value: unknown): void | Promise<void> {
		const settings = (this.plugin as unknown as { settings?: Record<string, unknown> }).settings;
		if (!settings) return;
		settings[key] = value;
		return this.plugin.saveData(settings);
	}
	/** Re-evaluates `visible` and `disabled` on what is drawn, and draws nothing again. */
	refreshDomState(): void {
		for (const { def, setting, matches } of this.rendered.values()) {
			setting.settingEl.toggle(evaluate(def.visible, true) && matches !== false);
			if (def.control?.disabled !== undefined) setting.setDisabled(evaluate(def.control.disabled, false));
		}
	}
	/**
	 * Asks for the definitions again, and draws them again if the tab is open -- at the same scroll
	 * offset: measured on Obsidian 1.15.0, `update()` left the root at 4540 of 5277 and a sub-page at
	 * 2510 (settings-redesign ticket 17, F1, `.scratch/settings-redesign/research/settings-probe/`).
	 */
	update(): void {
		this.settingItems = this.getSettingDefinitions();
		if (this.shown === null) return;
		const offset = this.containerEl.scrollTop;
		this.draw(this.shown);
		this.containerEl.scrollTop = offset;
	}
	/** Closing the tab tears its rows down, so their cleanups run. */
	hide(): void {
		this.shown = null;
		this.tearDown();
	}
	private tearDown(): void {
		for (const row of this.rendered.values()) row.cleanup?.();
		this.rendered.clear();
		this.groups.clear();
	}
	private draw(options: RenderOptions): void {
		const view = JSON.stringify(options);
		if (view !== this.drawnFor) this.tearDown();
		this.drawnFor = view;
		const previous = this.rendered;
		this.rendered = new Map();
		const previousGroups = this.groups;
		this.groups = new Map();
		this.searches = new Map();
		this.containerEl.empty();
		const page = options.page === undefined ? null : findPage(this.settingItems, options.page);
		if (options.page !== undefined && page === null) throw new Error(`tests/stubs: no settings page named "${options.page}"`);
		const items = page === null ? this.settingItems : (page.items ?? []);
		this.drawItems(this.containerEl, items, options.openPages === true, "", previous, previousGroups);
		for (const [key, row] of previous) if (!this.rendered.has(key)) row.cleanup?.();
		for (const entry of this.searches.values()) {
			const query = this.queries.get(entry.path);
			if (query !== undefined) this.match(entry, query);
		}
		this.refreshDomState();
	}
	/** Not an Obsidian member. The search box in the header of the group headed `heading`, to type into. */
	groupSearch(heading: string): { placeholder: string; type(query: string): void } {
		const entry = this.searches.get(heading);
		if (!entry) throw new Error(`tests/stubs: no group "${heading}" with a search box on screen`);
		return {
			placeholder: entry.search.placeholder ?? "",
			type: (query) => {
				const current = this.searches.get(heading) ?? entry;
				this.queries.set(current.path, query);
				this.match(current, query);
				this.refreshDomState();
			},
		};
	}
	private match(entry: DrawnSearch, query: string): void {
		for (const row of entry.rows) row.matches = row.def.searchable === false || entry.search.match(row.def, query);
	}
	/** Draws `items` into `el` and answers the rows drawn at this level, not inside a group under it. */
	private drawItems(
		el: FakeEl,
		items: FakeDefinition[],
		openPages: boolean,
		path: string,
		previous: Map<string, DrawnRow>,
		previousGroups: Map<string, DrawnGroup>,
	): DrawnRow[] {
		const group = {};
		const rows: DrawnRow[] = [];
		items.forEach((item, index) => {
			const unmodelled = NOT_MODELLED.find((field) => (item as Record<string, unknown>)[field] !== undefined);
			if (unmodelled !== undefined || item.type === "list" || (item.type !== undefined && item.visible !== undefined)) {
				throw new Error(`tests/stubs: a definition's "${unmodelled ?? (item.type === "list" ? "list" : "visible")}" is not modelled yet. Model it from obsidian.d.ts first.`);
			}
			if (item.type === "group") {
				if (item.heading === undefined && (item.extraButtons !== undefined || item.search !== undefined)) {
					throw new Error("tests/stubs: a header without a heading is not modelled yet. Model it from obsidian.d.ts first.");
				}
				const groupPath = `${path}group:${item.heading ?? item.cls ?? index}/`;
				const kept = previousGroups.get(groupPath);
				const drawn = kept ?? this.newGroup(item);
				if (kept) {
					kept.groupEl.empty();
					if (kept.heading) {
						kept.groupEl.appendChild(kept.heading.settingEl);
						settingLog.push(kept.heading.setName(item.heading ?? ""));
					}
				}
				this.groups.set(groupPath, drawn);
				el.appendChild(drawn.groupEl);
				const children = this.drawItems(drawn.groupEl, item.items ?? [], openPages, groupPath, previous, previousGroups);
				if (drawn.search !== undefined && item.heading !== undefined) this.searches.set(item.heading, { path: groupPath, search: drawn.search, rows: children });
			} else if (item.type === "page") {
				const entry = new Setting(el).setName(item.name ?? "");
				if (item.displayValue !== undefined || item.status !== undefined) {
					entry.addComponent((controlEl) =>
						new DisplayValueComponent(controlEl).setValue(evaluate(item.displayValue, "")).setStatus(evaluate(item.status, null)),
					);
				}
				if (!openPages) return;
				new Setting(el).setName(item.name ?? "").setHeading();
				this.drawItems(el, item.items ?? [], openPages, `${path}page:${item.name}/`, previous, previousGroups);
			} else {
				const key = path + (item.control ? `ctrl:${item.control.key}` : item.name ? `name:${item.name}` : `item#${index}`);
				const reused = previous.get(key);
				let setting: Setting;
				if (reused) {
					reused.cleanup?.();
					setting = reused.setting.clear();
					el.appendChild(setting.settingEl);
					settingLog.push(setting);
				} else {
					setting = new Setting(el);
				}
				setting.setName(item.name ?? "").setDesc(item.desc ?? "");
				const row: DrawnRow = { def: item, setting };
				this.rendered.set(key, row);
				rows.push(row);
				if (item.control !== undefined) this.drawControl(setting, item.control);
				const cleanup = item.render?.(setting, group);
				if (cleanup) row.cleanup = cleanup;
			}
		});
		return rows;
	}
	/** A group's element and header, as app.js `HDe` builds them once: the search box only if it starts with rows. */
	private newGroup(item: FakeDefinition): DrawnGroup {
		const groupEl = new FakeEl();
		groupEl.addClass("setting-group", ...(item.cls ?? "").split(/\s+/).filter(Boolean));
		const heading = item.heading === undefined ? null : new Setting(groupEl).setName(item.heading).setHeading();
		for (const button of item.extraButtons ?? []) heading?.addExtraButton(button);
		return { groupEl, heading, search: item.search !== undefined && (item.items ?? []).length > 0 ? item.search : undefined };
	}
	private drawControl(setting: Setting, control: FakeControl): void {
		const value = this.getControlValue(control.key) ?? control.defaultValue;
		const onChange = async (next: unknown): Promise<void> => {
			await this.setControlValue(control.key, next);
			this.refreshDomState();
		};
		if (control.type === "toggle") setting.addToggle((toggle) => toggle.setValue(value as boolean).onChange(onChange));
		else if (control.type === "dropdown") setting.addDropdown((dropdown) => dropdown.addOptions(control.options ?? {}).setValue(value as string).onChange(onChange));
		// app.js: `addComponent(el => new SecretComponent(app, el).setValue(value || "").onChange(change))` -- the entry's name, as picked.
		else if (control.type === "secret") setting.addComponent((el) => new SecretComponent(this.app, el).setValue((value as string | null) || "").onChange(onChange));
		else setting.addText((text) => text.setPlaceholder(control.placeholder ?? "").setValue((value as string | undefined) ?? "").onChange(onChange));
	}
}

function findPage(items: FakeDefinition[], name: string): FakeDefinition | null {
	for (const item of items) {
		if (item.type === "page" && item.name === name) return item;
		const inner = findPage(item.items ?? [], name);
		if (inner !== null) return inner;
	}
	return null;
}

/** Not an Obsidian member. The user opening the tab -- on its root, or on one page. */
export function renderSettingTab(tab: PluginSettingTab, options: RenderOptions = {}): void {
	tab.shown = options;
	tab.update();
}

// --- deliberately not implemented ----------------------------------------------------------------

/**
 * Reachable from `src/obsidian-fetch.ts`, so it has to exist or the module graph breaks. It must
 * never do anything: a unit test that reaches the network is a test whose result depends on somebody
 * else's server being up.
 */
export function requestUrl(): never {
	throw new Error("tests/stubs: requestUrl is not implemented. A test tried to make a real network request.");
}
