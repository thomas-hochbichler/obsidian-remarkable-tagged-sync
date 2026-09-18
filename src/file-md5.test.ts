import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "../test-stubs/fake-obsidian";
import { md5Hex } from "./file-md5";

// The plugin is `isDesktopOnly`; the stub defaults to the least capable environment, so the one
// place this runs has to say where it is.
beforeEach(() => {
	Platform.isDesktop = true;
});

describe("the one hash Zotero speaks", () => {
	// Against the published vector, not against our own output: the number has to be the one Zotero
	// computed for the same bytes, or the silent match of §2.3 matches nothing.
	it("is MD5, lowercase hex", () => {
		expect(md5Hex(new TextEncoder().encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(md5Hex(new Uint8Array())).toBe("d41d8cd98f00b204e9800998ecf8427e");
	});

	it("is 32 characters for bytes that are not text at all", () => {
		expect(md5Hex(new Uint8Array([0, 255, 128, 1]))).toMatch(/^[0-9a-f]{32}$/);
	});

	// Not a guard against a real situation -- `isDesktopOnly` keeps the plugin off mobile -- but the
	// same refusal every other node-backed corner of this plugin makes, rather than a TypeError from
	// inside `require`.
	it("refuses rather than half-working where node is not there", () => {
		Platform.isDesktop = false;
		expect(() => md5Hex(new Uint8Array())).toThrow("desktop-only");
	});
});
