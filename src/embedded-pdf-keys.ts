// The key half of `Cmd+F` in a PDF embedded in a note (ticket 26): which embed has the focus, and a
// scope that takes `Mod+F` while one does. What `Mod+F` then opens is decided in
// `embedded-pdf-search.ts`.
//
// A scope and not a `keydown` listener: Obsidian's keymap listens on `window` in the capture phase and
// hands the key to the top scope first, so a listener on the embed hears `Cmd+F` only after the note's
// search has opened (research/25 §2). The scope is pushed only while an embed in a note has the focus,
// and every key but `Mod+F` falls through to the scope that was on top before it.

import { MarkdownView, type Plugin, Scope } from "obsidian";
import { searchEmbeddedPdf } from "./embedded-pdf-search";

/** The PDF embed `target` sits in, when that embed is in a note -- not in a canvas or a PDF tab. */
function noteEmbedAt(target: EventTarget | null): HTMLElement | null {
	const el = (target as Element | null)?.closest?.<HTMLElement>(".pdf-embed") ?? null;
	return el?.closest(".workspace-leaf-content[data-type='markdown']") ? el : null;
}

export function registerEmbeddedPdfSearch(plugin: Plugin): void {
	const { app } = plugin;
	let embedEl: HTMLElement | null = null;
	let scope: Scope | null = null;

	const pressFind = () => {
		const view = app.workspace.getActiveViewOfType(MarkdownView);
		// Gone from the page -- a sync or Re-transcribe redrew the note under the focus, and no event
		// said so. The key was meant for the note, then.
		if (embedEl === null || !embedEl.isConnected) {
			trackFocus(null);
			view?.showSearch();
			return false;
		}
		// The embed's link as the note wrote it, from Obsidian's documented `.internal-embed[src]`: the
		// way back to the PDF that needs none of the internals.
		const link = embedEl.closest(".internal-embed")?.getAttribute("src");
		searchEmbeddedPdf(view?.currentMode, embedEl, () => {
			if (link) void app.workspace.openLinkText(link, view?.file?.path ?? "", "tab");
		});
		return false;
	};

	// A click into the page, or the keyboard moving into it, gives the embed the focus; anything else in
	// the workspace takes it away. Capture, so a viewer that stops the event still tells us.
	const trackFocus = (target: EventTarget | null) => {
		const el = noteEmbedAt(target);
		if (el !== null && scope === null) {
			scope = new Scope(app.workspace.getActiveViewOfType(MarkdownView)?.scope ?? app.scope);
			scope.register(["Mod"], "F", pressFind);
			app.keymap.pushScope(scope);
		}
		if (el === null && scope !== null) {
			app.keymap.popScope(scope);
			scope = null;
		}
		embedEl = el;
	};
	const workspaceEl = app.workspace.containerEl;
	plugin.registerDomEvent(workspaceEl, "pointerdown", (event) => trackFocus(event.target), { capture: true });
	plugin.registerDomEvent(workspaceEl, "focusin", (event) => trackFocus(event.target));
	plugin.register(() => trackFocus(null));
}
