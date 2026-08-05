import { describe, expect, it, vi } from "vitest";
import {
	attachmentPath,
	cropAttachmentPath,
	DEFAULT_ATTACHMENTS_FOLDER,
	normalizeAttachmentsFolder,
	pruneCrops,
	writeAttachment,
	writeCropAttachment,
	type AttachmentStore,
} from "./attachment-writer";

function fakeStore(
	files: string[] = [],
): AttachmentStore & {
	ensureFolder: ReturnType<typeof vi.fn>;
	writeBinary: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
} {
	return {
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue(files),
		remove: vi.fn().mockResolvedValue(undefined),
	};
}

/** The paths `pruneCrops` removed, in call order. */
function removed(store: ReturnType<typeof fakeStore>): string[] {
	return store.remove.mock.calls.map((call) => call[0] as string);
}

describe("attachmentPath", () => {
	it("names a notebook-level attachment by docId only", () => {
		expect(attachmentPath("tagged-sync/attachments", "doc-1", null)).toBe("tagged-sync/attachments/doc-1.pdf");
	});

	it("names a page-level attachment by docId and pageId", () => {
		expect(attachmentPath("tagged-sync/attachments", "doc-1", "page-a")).toBe(
			"tagged-sync/attachments/doc-1-page-a.pdf",
		);
	});

	it("normalizes a trailing slash on the folder", () => {
		expect(attachmentPath("tagged-sync/attachments/", "doc-1", null)).toBe("tagged-sync/attachments/doc-1.pdf");
	});
});

describe("normalizeAttachmentsFolder", () => {
	it("trims whitespace and surrounding slashes", () => {
		expect(normalizeAttachmentsFolder("  /attachments/ ")).toBe("attachments");
	});

	it("keeps a nested folder path intact", () => {
		expect(normalizeAttachmentsFolder("files/remarkable")).toBe("files/remarkable");
	});

	it("falls back to the default for empty or slash-only input", () => {
		expect(normalizeAttachmentsFolder("")).toBe(DEFAULT_ATTACHMENTS_FOLDER);
		expect(normalizeAttachmentsFolder("  ")).toBe(DEFAULT_ATTACHMENTS_FOLDER);
		expect(normalizeAttachmentsFolder("/")).toBe(DEFAULT_ATTACHMENTS_FOLDER);
	});

	it("falls back to the default when a segment could escape the vault", () => {
		expect(normalizeAttachmentsFolder("..")).toBe(DEFAULT_ATTACHMENTS_FOLDER);
		expect(normalizeAttachmentsFolder("../outside")).toBe(DEFAULT_ATTACHMENTS_FOLDER);
		expect(normalizeAttachmentsFolder("attachments/../../outside")).toBe(DEFAULT_ATTACHMENTS_FOLDER);
		expect(normalizeAttachmentsFolder("./attachments")).toBe(DEFAULT_ATTACHMENTS_FOLDER);
	});
});

describe("writeAttachment", () => {
	it("ensures the folder exists, then writes the PDF bytes to the computed path", async () => {
		const store = fakeStore();
		const pdfBytes = new Uint8Array([1, 2, 3]);

		const path = await writeAttachment(store, DEFAULT_ATTACHMENTS_FOLDER, "doc-1", "page-a", pdfBytes);

		expect(path).toBe("tagged-sync/attachments/doc-1-page-a.pdf");
		expect(store.ensureFolder).toHaveBeenCalledWith("tagged-sync/attachments");
		expect(store.writeBinary).toHaveBeenCalledWith("tagged-sync/attachments/doc-1-page-a.pdf", expect.any(ArrayBuffer));
		const written = new Uint8Array(store.writeBinary.mock.calls[0][1]);
		expect(written).toEqual(pdfBytes);
	});

	it("overwrites in place -- writes unconditionally, with no existence check", async () => {
		const store = fakeStore();

		await writeAttachment(store, DEFAULT_ATTACHMENTS_FOLDER, "doc-1", null, new Uint8Array([9]));

		expect(store.writeBinary).toHaveBeenCalledTimes(1);
	});
});

describe("cropAttachmentPath", () => {
	it("names a crop by doc slug and note id", () => {
		expect(cropAttachmentPath("tagged-sync/attachments", "my-paper", "nt-4c8a17")).toBe(
			"tagged-sync/attachments/my-paper-nt-4c8a17.png",
		);
	});

	it("normalizes a trailing slash on the folder", () => {
		expect(cropAttachmentPath("tagged-sync/attachments/", "my-paper", "nt-4c8a17")).toBe(
			"tagged-sync/attachments/my-paper-nt-4c8a17.png",
		);
	});
});

describe("writeCropAttachment", () => {
	it("ensures the folder exists, then writes the PNG bytes to the deterministic path", async () => {
		const store = fakeStore();
		const png = new Uint8Array([137, 80, 78, 71]);

		const path = await writeCropAttachment(store, DEFAULT_ATTACHMENTS_FOLDER, "my-paper", "nt-4c8a17", png);

		expect(path).toBe("tagged-sync/attachments/my-paper-nt-4c8a17.png");
		expect(store.ensureFolder).toHaveBeenCalledWith("tagged-sync/attachments");
		expect(store.writeBinary).toHaveBeenCalledWith(path, expect.any(ArrayBuffer));
		expect(new Uint8Array(store.writeBinary.mock.calls[0][1])).toEqual(png);
	});
});

describe("pruneCrops", () => {
	it("removes only the crops whose note vanished from this sync", async () => {
		const store = fakeStore(["my-paper-nt-4c8a17.png", "my-paper-nt-9f21c4.png", "my-paper-nt-000001.png"]);

		await pruneCrops(store, DEFAULT_ATTACHMENTS_FOLDER, "my-paper", new Set(["nt-4c8a17"]));

		expect(store.list).toHaveBeenCalledWith("tagged-sync/attachments");
		expect(removed(store)).toEqual([
			"tagged-sync/attachments/my-paper-nt-9f21c4.png",
			"tagged-sync/attachments/my-paper-nt-000001.png",
		]);
	});

	it("never touches anything outside its own crop pattern", async () => {
		const store = fakeStore([
			"my-paper.pdf",
			"my-paper-page-a.pdf",
			"other-paper-nt-4c8a17.png",
			"my-paper-notes.png",
			"my-paper-nt-4C8A17.png",
			"my-paper-nt-4c8a1.png",
			"my-paper-nt-4c8a17.png.bak",
			"my-paper-nt-4c8a17-scan.png",
			"holiday photo.png",
		]);

		await pruneCrops(store, DEFAULT_ATTACHMENTS_FOLDER, "my-paper", new Set());

		expect(removed(store)).toEqual([]);
	});

	it("treats a doc slug with regex metacharacters literally, so the pattern cannot widen", async () => {
		const store = fakeStore(["a.b-nt-4c8a17.png", "axb-nt-4c8a17.png", "a-nt-4c8a17.png"]);

		await pruneCrops(store, DEFAULT_ATTACHMENTS_FOLDER, "a.b", new Set());

		expect(removed(store)).toEqual(["tagged-sync/attachments/a.b-nt-4c8a17.png"]);
	});
});
