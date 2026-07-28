import { describe, expect, it, vi } from "vitest";
import { attachmentPath, DEFAULT_ATTACHMENTS_FOLDER, normalizeAttachmentsFolder, writeAttachment, type AttachmentStore } from "./attachment-writer";

function fakeStore(): AttachmentStore & { ensureFolder: ReturnType<typeof vi.fn>; writeBinary: ReturnType<typeof vi.fn> } {
	return {
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
	};
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
