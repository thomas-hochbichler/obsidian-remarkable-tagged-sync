import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform } from "obsidian";
import { type FilePicker, pickPdfFile, readLocalFile } from "./desktop-files";

let directory: string;

beforeEach(async () => {
	Platform.isDesktop = true;
	directory = await mkdtemp(join(tmpdir(), "tagged-sync-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("reading a file Zotero named", () => {
	it("hands back its bytes", async () => {
		const path = join(directory, "paper.pdf");
		await writeFile(path, Buffer.from([0x25, 0x50, 0x44, 0x46]));

		expect(await readLocalFile(path)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
	});

	it("answers null for a file that is not there, so the send falls through to the download", async () => {
		expect(await readLocalFile(join(directory, "gone.pdf"))).toBeNull();
	});

	it("lets every other reason through rather than turning it into a needless download", async () => {
		await expect(readLocalFile(directory)).rejects.toThrow();
	});

	it("refuses on a platform with no filesystem to read", async () => {
		Platform.isDesktop = false;

		await expect(readLocalFile("/anywhere")).rejects.toThrow("desktop-only");
	});
});

describe("the one file dialog", () => {
	/** As much of an `<input type=file>` as the picker touches. */
	function picker(files: { arrayBuffer(): Promise<ArrayBuffer> }[] | null): { picker: FilePicker; open: () => void; cancel: () => void; input: ReturnType<FilePicker["createElement"]> } {
		const input = {
			type: "",
			accept: "",
			onchange: null as ((this: unknown, event: Event) => unknown) | null,
			oncancel: null as ((this: unknown, event: Event) => unknown) | null,
			files,
			click: vi.fn(),
		};
		return {
			picker: { createElement: () => input },
			open: () => input.onchange?.call(input, new Event("change")),
			cancel: () => input.oncancel?.call(input, new Event("cancel")),
			input,
		};
	}

	const pdf = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

	it("asks for a PDF and hands back the bytes of the one chosen", async () => {
		const { picker: source, open, input } = picker([pdf]);
		const bytes = pickPdfFile(source);
		open();

		expect(input.accept).toContain("pdf");
		expect(input.click).toHaveBeenCalled();
		expect(await bytes).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("settles on a cancelled dialog rather than leaving the send waiting for ever", async () => {
		const { picker: source, cancel } = picker([pdf]);
		const bytes = pickPdfFile(source);
		cancel();

		expect(await bytes).toBeNull();
	});

	it("answers null for a change event that carries no file at all", async () => {
		const { picker: source, open } = picker(null);
		const bytes = pickPdfFile(source);
		open();

		expect(await bytes).toBeNull();
	});
});
