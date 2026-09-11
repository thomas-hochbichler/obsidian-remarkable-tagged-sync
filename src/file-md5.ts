/**
 * MD5 of a file's bytes, which is the one hash Zotero speaks.
 *
 * Zotero stores an `md5` per attachment and that is what the silent match of §2.3 rides on, so the
 * plugin has to be able to produce the same number for a file it holds: the bytes Send just
 * uploaded, and later the bytes a synced document is made of. Nothing else in this plugin uses MD5 --
 * every hash of its own is SHA-256 -- and nothing here is a security claim.
 *
 * Node's own implementation, reached the way `ssh-connection.ts` reaches `crypto`: at the point of
 * use, behind the desktop check. The plugin is `isDesktopOnly`, so there is no environment it loads
 * in where this is missing.
 */

import { Platform } from "obsidian";

function nodeCrypto(): typeof import("crypto") {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: hashing a file is desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: see the file header.
	const loaded: unknown = require("crypto");
	return loaded as typeof import("crypto");
}

/** Lowercase hex, 32 characters -- the spelling Zotero's own `md5` field uses. */
export function md5Hex(bytes: Uint8Array): string {
	return nodeCrypto().createHash("md5").update(bytes).digest("hex");
}
