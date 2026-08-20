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
	text = "";
	visible = true;
	removed = false;
	disabled = false;

	constructor(readonly tag = "div") {}

	private child(tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl {
		const el = new FakeEl(tag);
		if (options?.cls) for (const c of options.cls.split(/\s+/)) el.classes.add(c);
		if (options?.text) el.text = options.text;
		if (options?.attr) Object.assign(el.attributes, options.attr);
		this.children.push(el);
		return el;
	}

	createEl(tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeEl {
		return this.child(tag, options);
	}
	createDiv(options?: { cls?: string; text?: string }): FakeEl {
		return this.child("div", options);
	}
	createSpan(options?: { cls?: string; text?: string }): FakeEl {
		return this.child("span", options);
	}
	appendChild(el: FakeEl): FakeEl {
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
	/** Fires every handler registered for `type`. Not an Obsidian member -- the way a test clicks. */
	dispatch(type: string, event: unknown = {}): void {
		for (const handler of this.listeners[type] ?? []) handler(event);
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
	remove(): void {
		this.removed = true;
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
export interface EventRef {
	event: VaultEvent;
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

	/** Not an Obsidian member. What `fileManager.renameFile` does to the index. */
	rename(file: TAbstractFile, toPath: string): void {
		const from = file.path;
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
		this.setPath(file, toPath);
		this.fileMap.set(toPath, file);
		this.trigger("rename", file, from);
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
		onLayoutReady: (cb: () => void): void => {
			if (this.workspace.layoutReady) cb();
			else this.workspace.pending.push(cb);
		},
		/** Not an Obsidian member. What Obsidian does when the workspace has finished loading. */
		markLayoutReady: (): void => {
			this.workspace.layoutReady = true;
			for (const cb of this.workspace.pending.splice(0, this.workspace.pending.length)) cb();
		},
	};
	readonly fileManager = {
		renameFile: async (file: TAbstractFile, newPath: string): Promise<void> => {
			this.vault.rename(file, newPath);
		},
	};
	readonly metadataCache = {
		/** The plugin resolves an embed to a file. Exact path first, then the vault's own lookup. */
		getFirstLinkpathDest: (linkpath: string, _sourcePath: string): TFile | null =>
			this.vault.getFileByPath(linkpath) ?? this.vault.getFileByPath(normalizePath(linkpath)),
	};

	constructor(vault: FakeVault = new FakeVault()) {
		this.vault = vault;
	}
}

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

export class Modal {
	readonly contentEl = new FakeEl();
	readonly titleEl = new FakeEl();
	opened = false;
	constructor(readonly app: FakeApp) {}
	open(): void {
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

export class Setting {
	name = "";
	desc = "";
	heading = false;
	disabled = false;
	readonly settingEl = new FakeEl();
	readonly nameEl = new FakeEl();
	readonly descEl = new FakeEl();
	readonly controlEl = new FakeEl();
	readonly texts: TextComponent[] = [];
	readonly toggles: ToggleComponent[] = [];
	readonly dropdowns: DropdownComponent[] = [];
	readonly buttons: ButtonComponent[] = [];

	constructor(readonly containerEl: FakeEl) {
		settingLog.push(this);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string | FakeEl): this {
		this.name = typeof name === "string" ? name : name.allText().join("");
		return this;
	}
	setDesc(desc: string | FakeEl): this {
		this.desc = typeof desc === "string" ? desc : desc.allText().join(" ");
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
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
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
	addExtraButton(cb: (button: ButtonComponent) => unknown): this {
		return this.addButton(cb);
	}
	then(cb: (setting: this) => unknown): this {
		cb(this);
		return this;
	}
	clear(): this {
		this.controlEl.empty();
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
	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
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
	onload(): void | Promise<void> {}
	onunload(): void {}
}

export class PluginSettingTab {
	readonly containerEl = new FakeEl();
	constructor(
		readonly app: FakeApp,
		readonly plugin: Plugin,
	) {}
	display(): void {}
	hide(): void {}
}

// --- deliberately not implemented ----------------------------------------------------------------

/**
 * Reachable from `src/obsidian-fetch.ts`, so it has to exist or the module graph breaks. It must
 * never do anything: a unit test that reaches the network is a test whose result depends on somebody
 * else's server being up.
 */
export function requestUrl(): never {
	throw new Error("test-stubs: requestUrl is not implemented. A test tried to make a real network request.");
}
