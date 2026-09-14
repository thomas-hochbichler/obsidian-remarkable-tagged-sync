import { describe, expect, it, vi } from "vitest";
import type { DeviceFileStat } from "./device-api";
import { findOrCreateFolder, RESTART_COMMAND, sendOverSsh, type DeviceSendTarget } from "./ssh-send";
import type { SendDocument } from "./zotero-send";

const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const parse = (bytes: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

/** A tablet as a map of paths, which is the same trick `device-api`'s own tests play. */
function device(files: Record<string, Uint8Array> = {}) {
	const written = new Map<string, Uint8Array>();
	const commands: string[] = [];
	let ids = 0;
	const target: DeviceSendTarget = {
		list: async (): Promise<DeviceFileStat[]> => Object.keys(files).map((path) => ({ path, size: files[path].length, mtimeMs: 0 })),
		read: async (path) => {
			const bytes = files[path];
			if (bytes === undefined) throw new Error(`no ${path}`);
			return bytes;
		},
		write: async (path, bytes) => {
			written.set(path, bytes);
		},
		exec: async (command) => {
			commands.push(command);
			return "";
		},
	};
	return { target, written, commands, newId: () => `id-${++ids}` };
}

const document: SendDocument = { visibleName: "Best Practices für Prompting", bytes: new Uint8Array([37, 80, 68, 70]), folder: "Zotero" };

describe("the tablet's Zotero folder", () => {
	it("is the one that is there, found by its name", async () => {
		const tablet = device({ [`${FOLDER_ID}.metadata`]: json({ type: "CollectionType", visibleName: "Zotero", parent: "" }) });
		expect(await findOrCreateFolder(tablet.target, "Zotero", tablet.newId)).toBe(FOLDER_ID);
		expect(tablet.written.size).toBe(0);
	});

	it("is created where the tablet has none", async () => {
		const tablet = device();
		expect(await findOrCreateFolder(tablet.target, "Zotero", tablet.newId)).toBe("id-1");
		expect(parse(tablet.written.get("id-1.metadata")!)).toMatchObject({ type: "CollectionType", visibleName: "Zotero", parent: "" });
		expect(parse(tablet.written.get("id-1.content")!)).toEqual({ tags: [] });
	});

	// A folder named Zotero nested inside another folder is somebody's own arrangement; collecting
	// papers into it would put them where the user cannot find them from the home screen.
	it("is never one nested inside another folder", async () => {
		const tablet = device({ [`${FOLDER_ID}.metadata`]: json({ type: "CollectionType", visibleName: "Zotero", parent: OTHER_ID }) });
		expect(await findOrCreateFolder(tablet.target, "Zotero", tablet.newId)).toBe("id-1");
	});

	// The device keeps a tombstone until its next cloud sync clears it -- the same rule `device-api`'s
	// listing follows.
	it("is never a folder the user has deleted", async () => {
		const tablet = device({ [`${FOLDER_ID}.metadata`]: json({ type: "CollectionType", visibleName: "Zotero", parent: "", deleted: true }) });
		expect(await findOrCreateFolder(tablet.target, "Zotero", tablet.newId)).toBe("id-1");
	});

	it("is never a document that happens to be called Zotero", async () => {
		const tablet = device({ [`${FOLDER_ID}.metadata`]: json({ type: "DocumentType", visibleName: "Zotero", parent: "" }) });
		expect(await findOrCreateFolder(tablet.target, "Zotero", tablet.newId)).toBe("id-1");
	});

	// Two sends in a row have to mean the same folder, and the tablet's listing has no order to promise.
	it("is the same one of two every time", async () => {
		const both = {
			[`${OTHER_ID}.metadata`]: json({ type: "CollectionType", visibleName: "Zotero", parent: "" }),
			[`${FOLDER_ID}.metadata`]: json({ type: "CollectionType", visibleName: "Zotero", parent: "" }),
		};
		const tablet = device(both);
		expect(await findOrCreateFolder(tablet.target, "Zotero", tablet.newId)).toBe(FOLDER_ID);
	});

	// The device is live: xochitl writes while we read, and a half-written file is an ordinary sight
	// rather than something this command may repair.
	it("passes over a metadata file it cannot read", async () => {
		const tablet = device({ [`${FOLDER_ID}.metadata`]: new TextEncoder().encode("{ half writ") });
		expect(await findOrCreateFolder(tablet.target, "Zotero", tablet.newId)).toBe("id-1");
	});

	it("looks at nothing but the top-level metadata files", async () => {
		const tablet = device({ [`${FOLDER_ID}/page.metadata`]: json({ type: "CollectionType", visibleName: "Zotero" }), "notes.txt": json({}) });
		const read = vi.spyOn(tablet.target, "read");
		await findOrCreateFolder(tablet.target, "Zotero", tablet.newId);
		expect(read).not.toHaveBeenCalled();
	});
});

describe("putting a PDF on the tablet", () => {
	it("writes the three files xochitl needs, into the folder", async () => {
		const tablet = device({ [`${FOLDER_ID}.metadata`]: json({ type: "CollectionType", visibleName: "Zotero", parent: "" }) });
		const { docId } = await sendOverSsh(tablet.target, document, tablet.newId);

		expect([...tablet.written.keys()]).toEqual([`${docId}.pdf`, `${docId}.content`, `${docId}.metadata`]);
		expect(tablet.written.get(`${docId}.pdf`)).toEqual(document.bytes);
		expect(parse(tablet.written.get(`${docId}.metadata`)!)).toMatchObject({
			type: "DocumentType",
			visibleName: "Best Practices für Prompting",
			parent: FOLDER_ID,
		});
	});

	// No tag (2026-09-13): the reader tags the document on the tablet when they want it back, and
	// `.content` carries the empty list xochitl writes for an untagged document.
	it("carries no tag, in the shape a cloud upload has", async () => {
		const tablet = device();
		const { docId } = await sendOverSsh(tablet.target, document, tablet.newId);
		const content = parse(tablet.written.get(`${docId}.content`)!);

		expect(content.tags).toEqual([]);
		expect(content).toMatchObject({ fileType: "pdf", formatVersion: 1, pageCount: 1, sizeInBytes: "4" });
	});

	// The `.metadata` is what makes the bytes a document. Written last, a connection that drops
	// part-way leaves stray files rather than an entry that opens onto nothing.
	it("writes the metadata last of the three", async () => {
		const tablet = device();
		await sendOverSsh(tablet.target, document, tablet.newId);
		expect([...tablet.written.keys()].at(-1)).toMatch(/\.metadata$/);
	});

	// ⚠️ The measurement: files dropped into `xochitl/` are not noticed, there is no directory watch,
	// and no upload endpoint is reachable on a Paper Pro. Without this line the document is on the
	// disk and never in *My files*.
	it("restarts the reading app, which is the only thing that makes the document appear", async () => {
		const tablet = device();
		await sendOverSsh(tablet.target, document, tablet.newId);
		expect(tablet.commands).toEqual([RESTART_COMMAND]);
	});

	// Nothing else in the plugin mints a document id, and a send that reused one would overwrite a
	// document on the tablet -- which is the one thing §1.2 promises never happens.
	it("mints its own ids where the caller names none", async () => {
		const tablet = device();
		const { docId } = await sendOverSsh(tablet.target, document);
		expect(docId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it("restarts only after every file is written", async () => {
		const order: string[] = [];
		const tablet = device();
		const target: DeviceSendTarget = {
			...tablet.target,
			write: async (path) => void order.push(path),
			exec: async (command) => {
				order.push(command);
				return "";
			},
		};
		await sendOverSsh(target, document, tablet.newId);
		expect(order.at(-1)).toBe(RESTART_COMMAND);
	});
});
