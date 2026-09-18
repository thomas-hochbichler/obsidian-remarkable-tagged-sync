/**
 * The two reaches into the machine that Send needs and Obsidian has no API for: reading a file by
 * its absolute path, and asking the user for one.
 *
 * Both exist because of where a Zotero PDF lives. Zotero's storage is outside the vault, so
 * `Vault.adapter` cannot see it; the desktop connection answers an absolute path, and that path is
 * the cheapest way to the bytes by a wide margin -- no download, and it works for a *linked* file
 * that was never in Zotero's storage at all (spec §2.4). When neither connection can hand the file
 * over, the user is asked, and a file input is the one picker a renderer has that needs no Electron
 * internals: `@electron/remote` is deprecated, gated, and not something a plugin should be reaching
 * through for one dialog.
 *
 * `document` is a parameter with a default rather than a global reference, so the picker's logic is
 * testable without a DOM. The default is evaluated only when a caller leaves it out.
 */

import { Platform } from "obsidian";

function nodeFs(): typeof import("fs") {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: reading a file by path is desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: see the file header.
	const loaded: unknown = require("fs");
	return loaded as typeof import("fs");
}

/**
 * A file off this machine, or `null` when it is not there.
 *
 * Missing is an answer and not a failure: Zotero's database can name a file the user has since
 * moved, renamed or deleted, and §2.4's next step -- the download -- is exactly what that should
 * fall through to. Every other reason it cannot be read (a permission, a disk) throws, because
 * falling through would turn it into a needless download of a file that is right there.
 */
export async function readLocalFile(path: string): Promise<Uint8Array | null> {
	try {
		return new Uint8Array(await nodeFs().promises.readFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** As much of a file input as this needs. Narrow on purpose, so a test can be a plain object. */
export interface FilePicker {
	createElement(tag: "input"): {
		type: string;
		accept: string;
		onchange: ((this: unknown, event: Event) => unknown) | null;
		oncancel: ((this: unknown, event: Event) => unknown) | null;
		files: { arrayBuffer(): Promise<ArrayBuffer> }[] | null;
		click(): void;
	};
}

/**
 * The one file dialog of §2.4. `null` when the user closed it without choosing.
 *
 * `oncancel` as well as `onchange`, because a promise that is only ever settled by a choice is a
 * promise that never settles when there is no choice -- and the caller is a send the user is
 * standing in front of. Both handlers resolve, and the first one to arrive wins.
 */
export function pickPdfFile(picker: FilePicker = document): Promise<Uint8Array | null> {
	return new Promise((resolve) => {
		const input = picker.createElement("input");
		input.type = "file";
		input.accept = "application/pdf,.pdf";
		input.onchange = () => {
			const file = input.files?.[0];
			if (file === undefined) resolve(null);
			else void file.arrayBuffer().then((bytes) => resolve(new Uint8Array(bytes)));
		};
		input.oncancel = () => resolve(null);
		input.click();
	});
}
