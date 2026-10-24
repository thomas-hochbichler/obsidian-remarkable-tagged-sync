import { describe, expect, it, vi } from "vitest";
import { FakeApp, type Scope } from "../tests/stubs/fake-obsidian";
import { registerEmbeddedPdfSearch } from "./embedded-pdf-keys";

// What the focus can land on, as far as `closest` and `isConnected` tell: no DOM under vitest, so each
// element answers the selectors the plugin asks with what Obsidian's markup would give.
function element(answers: Record<string, unknown> = {}, connected = true) {
	const el: Record<string, unknown> = {
		isConnected: connected,
		closest: (selector: string) => answers[selector] ?? null,
		getAttribute: (name: string) => (name === "src" ? "attachments/doc.pdf" : null),
	};
	return el;
}

/** A PDF embed inside a note: `.pdf-embed` in `.internal-embed` in a markdown leaf. */
function noteEmbed(connected = true) {
	const leaf = element();
	const internalEmbed = element();
	const embed = element({ ".workspace-leaf-content[data-type='markdown']": leaf, ".internal-embed": internalEmbed }, connected);
	const inside = element({ ".pdf-embed": embed });
	return { embed, inside };
}

function registered() {
	const app = new FakeApp();
	const cleanups: (() => void)[] = [];
	const plugin = {
		app,
		registerDomEvent: (el: { addEventListener(type: string, handler: (event: unknown) => void): void }, type: string, handler: (event: unknown) => void) =>
			el.addEventListener(type, handler),
		register: (cleanup: () => void) => cleanups.push(cleanup),
	};
	registerEmbeddedPdfSearch(plugin as never);
	const click = (target: unknown) => app.workspace.containerEl.dispatch("pointerdown", { target });
	const pressCmdF = () => (app.keymap.pushed.at(-1) as Scope).keys.find((k) => k.key === "F")!.func();
	return { app, click, pressCmdF, unload: () => cleanups.forEach((cleanup) => cleanup()) };
}

describe("Cmd+F in an embedded PDF: the focus", () => {
	it("takes Cmd+F while an embed in a note has the focus, under the view's own scope", () => {
		const { app, click } = registered();
		const viewScope = {};
		app.workspace.activeView = { scope: viewScope };

		click(noteEmbed().inside);
		expect(app.keymap.pushed).toHaveLength(1);
		const scope = app.keymap.pushed[0] as Scope;
		expect(scope.keys).toEqual([expect.objectContaining({ modifiers: ["Mod"], key: "F" })]);
		expect(scope.parent).toBe(viewScope);
	});

	it("takes Cmd+F when the keyboard moves the focus into an embed, under Obsidian's root scope without a note view", () => {
		const { app } = registered();
		app.workspace.containerEl.dispatch("focusin", { target: noteEmbed().inside });
		expect(app.keymap.pushed).toHaveLength(1);
		expect((app.keymap.pushed[0] as Scope).parent).toBe(app.scope);
	});

	it("gives Cmd+F back when the focus moves out of the embed", () => {
		const { app, click } = registered();
		click(noteEmbed().inside);
		click(element());
		expect(app.keymap.pushed).toEqual([]);
	});

	it("leaves Cmd+F alone in a PDF embedded outside a note, such as a canvas", () => {
		const { app, click } = registered();
		click(element({ ".pdf-embed": element() }));
		expect(app.keymap.pushed).toEqual([]);
	});

	it("gives Cmd+F back when the plugin unloads", () => {
		const { app, click, unload } = registered();
		click(noteEmbed().inside);
		unload();
		expect(app.keymap.pushed).toEqual([]);
	});

	it("opens the PDF in a tab, by the note's own link, when the embed has no find bar to reach", () => {
		const { app, click, pressCmdF } = registered();
		const openLinkText = vi.fn(async () => undefined);
		Object.assign(app.workspace, { openLinkText });
		app.workspace.activeView = { currentMode: {}, file: { path: "Work/Note.md" } };

		click(noteEmbed().inside);
		expect(pressCmdF()).toBe(false);
		expect(openLinkText).toHaveBeenCalledWith("attachments/doc.pdf", "Work/Note.md", "tab");
	});

	it("opens nothing when the embed carries no link to open in a tab", () => {
		const { app, click, pressCmdF } = registered();
		const openLinkText = vi.fn(async () => undefined);
		Object.assign(app.workspace, { openLinkText });
		const embed = element({ ".workspace-leaf-content[data-type='markdown']": element() });

		click(element({ ".pdf-embed": embed }));
		expect(pressCmdF()).toBe(false);
		expect(openLinkText).not.toHaveBeenCalled();
	});

	it("searches the note when the embed was redrawn away under the focus", () => {
		const { app, click, pressCmdF } = registered();
		const view = { currentMode: {}, showSearch: vi.fn() };
		app.workspace.activeView = view;
		const stale = noteEmbed(false);

		click(stale.inside);
		pressCmdF();
		expect(view.showSearch).toHaveBeenCalled();
		expect(app.keymap.pushed).toEqual([]);
	});
});
