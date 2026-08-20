import { describe, expect, it, vi } from "vitest";
import {
	attachmentPath,
	DEFAULT_ATTACHMENTS_FOLDER,
	normalizeAttachmentsFolder,
	writeAttachment,
	type AttachmentStore,
} from "./attachment-writer";

function fakeStore(): AttachmentStore & {
	ensureFolder: ReturnType<typeof vi.fn>;
	writeBinary: ReturnType<typeof vi.fn>;
} {
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
		// One call and one only -- an "overwrite" that deleted first would be two, and the gap between
		// them is where a crash leaves the note embedding a file that is no longer there.
		expect(store.writeBinary.mock.calls[0][0]).toBe("tagged-sync/attachments/doc-1.pdf");
	});

	// Gap G35. This is the only function in the file that touches the outside world, and both of its
	// outward calls can fail: a full disk, a read-only vault, a folder the user turned into a file, a
	// sync client holding the path. Neither failure had a test.
	describe("when the vault refuses", () => {
		it("passes a failed folder creation up, without writing bytes into a folder that is not there", async () => {
			const store = {
				ensureFolder: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
				writeBinary: vi.fn(),
			};

			await expect(writeAttachment(store, DEFAULT_ATTACHMENTS_FOLDER, "doc-1", null, new Uint8Array([1]))).rejects.toThrow(
				"EACCES",
			);
			// The order is the point: no write is attempted against a path whose folder does not exist,
			// so the failure the user sees names the folder rather than the file.
			expect(store.writeBinary).not.toHaveBeenCalled();
		});

		it("passes a failed write up rather than returning a path to a file that was never written", async () => {
			// The caller embeds the returned path in a note. Swallowing this would put an embed in
			// somebody's vault pointing at nothing, and the sync would report success.
			const store = {
				ensureFolder: vi.fn().mockResolvedValue(undefined),
				writeBinary: vi.fn().mockRejectedValue(new Error("ENOSPC: no space left on device")),
			};

			await expect(writeAttachment(store, DEFAULT_ATTACHMENTS_FOLDER, "doc-1", null, new Uint8Array([1]))).rejects.toThrow(
				"ENOSPC",
			);
		});
	});

	it("writes an empty render as the empty file it is, rather than skipping it", async () => {
		// A page with nothing on it still renders to a valid, tiny PDF; a zero-length body would be a
		// renderer failure, and silently not writing would leave the note embedding the *previous*
		// render -- which is worse than an obviously empty one.
		const store = fakeStore();

		await writeAttachment(store, DEFAULT_ATTACHMENTS_FOLDER, "doc-1", null, new Uint8Array([]));

		expect(store.writeBinary).toHaveBeenCalledTimes(1);
		expect(new Uint8Array(store.writeBinary.mock.calls[0][1])).toEqual(new Uint8Array([]));
	});
});
