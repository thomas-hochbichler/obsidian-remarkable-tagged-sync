import { describe, expect, it } from "vitest";
import { PrintFailure } from "./print-surface";
import { ANOTHER_SEND_RUNNING, type CopiesQuestion, sendFromVault, tagHint, type VaultFile, type VaultSendDeps } from "./vault-send";
import { sendFor, type StoredVaultSends, type VaultSend } from "./vault-sends";
import { type EarlierCopy, type EarlierCopyLook, SEND_NEEDS_TRANSPORT, type SendDocument, type SendTransport } from "./zotero-send";

// One vault send end to end (send spec §2, §3, §8), with everything outside it faked: the transport
// records what it was asked, the printer and the dialog answer as a test says, the record lives in
// memory and is saved through the deps as the plugin saves data.json.

const NOW = new Date("2026-11-13T10:00:00.000Z");
const NOTE: VaultFile = { path: "Specs/Login-Spec.md", basename: "Login-Spec", extension: "md" };
const PDF: VaultFile = { path: "Papers/Paper.pdf", basename: "Paper", extension: "pdf" };
const PRINTED = new Uint8Array([7, 7, 7]);
const PDF_BYTES = new Uint8Array([1, 2, 3]);

/** An earlier copy of `NOTE`, as the record has it. */
function earlier(overrides: Partial<VaultSend> = {}): VaultSend {
	return { origin: NOTE.path, kind: "note", sentAt: "2026-11-10T09:00:00.000Z", name: "Login-Spec", folderId: "folder-1", seenAt: "2026-11-11T09:00:00.000Z", ...overrides };
}

interface Harness {
	deps: VaultSendDeps;
	record: { sends: StoredVaultSends; saves: number };
	/** Every call the transport and the dialog saw, in order. */
	calls: string[];
	uploads: SendDocument[];
	looked: EarlierCopy[][];
	questions: CopiesQuestion[];
	reports: string[];
	printed: string[];
}

interface Options {
	transport?: "cloud" | "ssh" | null;
	sends?: StoredVaultSends;
	markdown?: string;
	tags?: string[];
	/** What the look answers; a function to see what it was asked, an Error to reject. */
	look?: EarlierCopyLook | Error | ((copies: readonly EarlierCopy[]) => EarlierCopyLook);
	/** What moving each copy to the trash answers, by id: `false` for "changed since", an Error to throw. Default `true`. */
	trash?: Record<string, boolean | Error>;
	/** The dialog's answer: `true` for the trash. Default: closed, which keeps. */
	answer?: boolean;
	print?: () => Promise<Uint8Array>;
	upload?: (document: SendDocument) => Promise<{ docId: string; folderId: string }>;
}

function harness(options: Options = {}): Harness {
	const record = { sends: structuredClone(options.sends ?? {}), saves: 0 };
	const h: Harness = { record, calls: [], uploads: [], looked: [], questions: [], reports: [], printed: [], deps: undefined as unknown as VaultSendDeps };
	const cloud: SendTransport = {
		label: "reMarkable's cloud",
		namesIn: async () => {
			h.calls.push("namesIn");
			return [];
		},
		putPdf:
			options.upload ??
			(async (document) => {
				h.calls.push(`putPdf ${document.visibleName}`);
				h.uploads.push(document);
				return { docId: "new-doc", folderId: "folder-1" };
			}),
		earlierCopies: async (copies) => {
			h.calls.push(`look ${copies.map((copy) => copy.docId).join(",")}`);
			h.looked.push([...copies]);
			const look = options.look ?? { copies: copies.map((copy) => ({ docId: copy.docId, state: "gone" as const })), strangerNamed: false };
			if (look instanceof Error) throw look;
			return typeof look === "function" ? look(copies) : look;
		},
		moveToTrash: async (ref) => {
			h.calls.push(`trash ${ref.id}`);
			const answer = options.trash?.[ref.id] ?? true;
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
	const ssh: SendTransport = { label: "your reMarkable", namesIn: cloud.namesIn, putPdf: cloud.putPdf };
	h.deps = {
		transport: options.transport === null ? null : options.transport === "ssh" ? ssh : cloud,
		folder: "Obsidian",
		sends: () => record.sends,
		saveSends: async (sends) => {
			record.sends = sends;
			record.saves += 1;
		},
		readPdf: async () => PDF_BYTES,
		readNote: async () => options.markdown ?? "# Login\n\nThe spec.",
		printNote: async (file) => {
			h.printed.push(file.path);
			return options.print === undefined ? PRINTED : options.print();
		},
		askAboutUsersCopies: async (question) => {
			h.calls.push("ask");
			h.questions.push(question);
			return options.answer ?? false;
		},
		mappedTags: options.tags ?? ["sync"],
		report: (_state, message) => h.reports.push(message),
		now: () => NOW,
	};
	return h;
}

/** A look that classes the named copies so, and every other one as gone. */
function classed(states: Record<string, "untouched" | "users">, strangerNamed = false): (copies: readonly EarlierCopy[]) => EarlierCopyLook {
	return (copies) => ({
		copies: copies.map((copy) => {
			const state = states[copy.docId];
			return state === undefined ? { docId: copy.docId, state: "gone" as const } : { docId: copy.docId, state, ref: { id: copy.docId, hash: `hash-${copy.docId}` } };
		}),
		strangerNamed,
	});
}

const SENT = 'Sent "Login-Spec" to your reMarkable, into "Obsidian". Tag it, or any page of it, with "sync" on the tablet to bring your marks back as one note.';

describe("a first send (send spec §2, §8)", () => {
	it("prints a note, puts it in the send folder under the file's name, records it, and says where it went", async () => {
		const h = harness();

		const notice = await sendFromVault(h.deps, NOTE);

		expect(notice).toBe(SENT);
		expect(h.printed).toEqual([NOTE.path]);
		expect(h.uploads).toEqual([{ visibleName: "Login-Spec", bytes: PRINTED, folder: "Obsidian" }]);
		expect(sendFor(h.record.sends, "new-doc")).toEqual({ origin: NOTE.path, kind: "note", sentAt: NOW.toISOString(), name: "Login-Spec", folderId: "folder-1" });
		expect(h.reports).toEqual(['Tagged Sync: sending "Login-Spec" to reMarkable\'s cloud…', 'Tagged Sync: sent "Login-Spec"']);
	});

	it("sends a PDF as it is, without printing it", async () => {
		const h = harness();

		const notice = await sendFromVault(h.deps, PDF);

		expect(notice).toBe('Sent "Paper" to your reMarkable, into "Obsidian". Tag it, or any page of it, with "sync" on the tablet to bring your marks back as one note.');
		expect(h.printed).toEqual([]);
		expect(h.uploads[0].bytes).toBe(PDF_BYTES);
		expect(sendFor(h.record.sends, "new-doc")?.kind).toBe("pdf");
	});

	it("names the document through the tablet's own name rule: no / or :, at most 120 characters", async () => {
		const h = harness();

		await sendFromVault(h.deps, { path: "a.md", basename: `Spec: v2 ${"x".repeat(200)}`, extension: "md" });

		expect(h.uploads[0].visibleName).toBe(`Spec- v2 ${"x".repeat(111)}`);
	});

	it("calls a file with no name before its extension Untitled", async () => {
		const h = harness();

		await sendFromVault(h.deps, { path: "Specs/.md", basename: "", extension: "md" });

		expect(h.uploads[0].visibleName).toBe("Untitled");
	});

	it("refuses an empty note before anything touches the tablet", async () => {
		const h = harness({ markdown: "---\ntags: [spec]\n---\n\n  \n" });

		expect(await sendFromVault(h.deps, NOTE)).toBe('"Login-Spec" is empty. There is nothing to send.');
		expect([h.printed, h.calls, h.record.saves]).toEqual([[], [], 0]);
		expect(h.reports).toEqual(["Tagged Sync: nothing sent"]);
	});

	it("says why a note could not be printed, and sends nothing", async () => {
		const h = harness({ print: () => Promise.reject(new PrintFailure("unsupported", "this Obsidian cannot print in the background")) });

		expect(await sendFromVault(h.deps, NOTE)).toBe('"Login-Spec" could not be printed, so nothing was sent: this Obsidian cannot print in the background.');
		expect([h.calls, h.record.saves]).toEqual([[], 0]);
		expect(h.reports).toEqual(["Tagged Sync: nothing sent"]);
	});

	it("asks for a restart after the reason where a refused print blocks every later one", async () => {
		const h = harness({ print: () => Promise.reject(new PrintFailure("failed", "Printing failed.", true)) });

		expect(await sendFromVault(h.deps, NOTE)).toBe('"Login-Spec" could not be printed, so nothing was sent: Printing failed. Restart Obsidian before you try again.');
	});

	it("passes on the message of a printer that threw something else", async () => {
		const h = harness({ print: () => Promise.reject(new Error("render broke")) });

		expect(await sendFromVault(h.deps, NOTE)).toBe('"Login-Spec" could not be printed, so nothing was sent: render broke.');
		expect(h.calls).toEqual([]);
		// Not even an Error: its text is the reason.
		expect(await sendFromVault(harness({ print: () => Promise.reject("no printer") }).deps, NOTE)).toBe('"Login-Spec" could not be printed, so nothing was sent: no printer.');
	});

	it("says another send is running where the print surface is still busy with one", async () => {
		const h = harness({ print: () => Promise.reject(new PrintFailure("busy", ANOTHER_SEND_RUNNING)) });

		expect(await sendFromVault(h.deps, NOTE)).toBe(ANOTHER_SEND_RUNNING);
		expect(h.calls).toEqual([]);
	});

	it("says there is no route, and touches nothing", async () => {
		const h = harness({ transport: null });

		expect(await sendFromVault(h.deps, NOTE)).toBe(SEND_NEEDS_TRANSPORT);
		expect([h.printed, h.calls, h.record.saves]).toEqual([[], [], 0]);
		expect(h.reports).toEqual(["Tagged Sync: nothing sent"]);
	});

	it("records nothing and clears nothing when the upload fails, and says why in the existing sentence", async () => {
		const h = harness({
			sends: { old: earlier() },
			look: classed({ old: "untouched" }),
			upload: () => Promise.reject(new Error("HTTP 503")),
		});

		expect(await sendFromVault(h.deps, NOTE)).toBe("Sending to your reMarkable failed: HTTP 503");
		expect(h.calls).toEqual(["look old"]);
		expect([h.record.saves, Object.keys(h.record.sends)]).toEqual([0, ["old"]]);
		expect(h.reports.at(-1)).toBe("Tagged Sync: nothing sent");
		// A rejection that is no Error still says why.
		expect(await sendFromVault(harness({ upload: () => Promise.reject("offline") }).deps, NOTE)).toBe("Sending to your reMarkable failed: offline");
	});

	it("refuses a second send while one runs, and leaves the status line to the first", async () => {
		let release: (value: { docId: string; folderId: string }) => void = () => undefined;
		const h = harness({ upload: () => new Promise((resolve) => (release = resolve)) });

		const first = sendFromVault(h.deps, NOTE);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const reportsBefore = [...h.reports];
		expect(await sendFromVault(h.deps, PDF)).toBe(ANOTHER_SEND_RUNNING);
		expect(h.reports).toEqual(reportsBefore);

		release({ docId: "new-doc", folderId: "folder-1" });
		expect(await first).toBe(SENT);
		// Once it is done, the next one goes.
		expect(await sendFromVault(harness().deps, PDF)).toContain('Sent "Paper"');
	});

	it("writes into the record as it is after the upload, so an entry a sync added meanwhile stays", async () => {
		const h = harness();
		h.deps = {
			...h.deps,
			transport: {
				...h.deps.transport!,
				putPdf: async () => {
					h.record.sends = { ...h.record.sends, other: earlier({ origin: "Other.md" }) };
					return { docId: "new-doc", folderId: "folder-1" };
				},
			},
		};

		await sendFromVault(h.deps, NOTE);

		expect(Object.keys(h.record.sends).sort()).toEqual(["new-doc", "other"]);
	});
});

describe("the status line of a vault send (send spec §8)", () => {
	it("names the route while it sends, then says sent -- or nothing sent after a refusal or a failure", async () => {
		const lines = async (options: Options, file = NOTE) => {
			const h = harness(options);
			await sendFromVault(h.deps, file);
			return h.reports;
		};

		expect(await lines({})).toEqual(['Tagged Sync: sending "Login-Spec" to reMarkable\'s cloud…', 'Tagged Sync: sent "Login-Spec"']);
		expect(await lines({ transport: "ssh" }, PDF)).toEqual(['Tagged Sync: sending "Paper" to your reMarkable…', 'Tagged Sync: sent "Paper"']);
		expect(await lines({ transport: null })).toEqual(["Tagged Sync: nothing sent"]);
		expect(await lines({ markdown: "" })).toEqual(["Tagged Sync: nothing sent"]);
		expect(await lines({ print: () => Promise.reject(new PrintFailure("timeout", "the print view did not open")) })).toEqual(["Tagged Sync: nothing sent"]);
		expect(await lines({ upload: () => Promise.reject(new Error("HTTP 503")) })).toEqual(['Tagged Sync: sending "Login-Spec" to reMarkable\'s cloud…', "Tagged Sync: nothing sent"]);
	});
});

describe("the tag hint (send spec §8.1)", () => {
	it("names the one mapped tag", () => {
		expect(tagHint(["sync"])).toBe('Tag it, or any page of it, with "sync" on the tablet to bring your marks back as one note.');
	});

	it("names several mapped tags", () => {
		expect(tagHint(["sync", "work"])).toBe('Tag it, or any page of it, with one of your sync tags ("sync", "work") on the tablet to bring your marks back as one note.');
	});

	it("names at most three, then …", () => {
		expect(tagHint(["a", "b", "c", "d"])).toBe('Tag it, or any page of it, with one of your sync tags ("a", "b", "c", …) on the tablet to bring your marks back as one note.');
	});

	it("says to map one where none is mapped", () => {
		expect(tagHint([])).toBe("No tag is mapped for sync yet. Map one in the settings, then tag the document or any page of it to bring your marks back as one note.");
	});

	it("ends the Sent sentence of every send", async () => {
		const h = harness({ tags: ["sync", "work"] });

		expect(await sendFromVault(h.deps, NOTE)).toBe('Sent "Login-Spec" to your reMarkable, into "Obsidian". Tag it, or any page of it, with one of your sync tags ("sync", "work") on the tablet to bring your marks back as one note.');
	});
});

describe("a second send over the cloud (send spec §3)", () => {
	it("looks at the earlier copies before the upload, with the name and folder they were sent as", async () => {
		const h = harness({ sends: { old: earlier(), lost: earlier({ name: undefined, folderId: undefined, sentAt: "2026-11-11T09:00:00.000Z" }), other: earlier({ origin: "Other.md" }) } });

		await sendFromVault(h.deps, NOTE);

		expect(h.calls).toEqual(["look old,lost", "putPdf Login-Spec"]);
		expect(h.looked[0]).toEqual([{ docId: "old", name: "Login-Spec", folderId: "folder-1" }, { docId: "lost" }]);
	});

	it("uploads into the folder the look found, and leaves the lookup to the upload where the look found none or failed", async () => {
		const found = harness({ look: { copies: [], strangerNamed: false, folderId: "folder-1" } });
		const none = harness({ look: { copies: [], strangerNamed: false } });
		const failed = harness({ look: new Error("HTTP 502") });

		for (const h of [found, none, failed]) await sendFromVault(h.deps, NOTE);

		expect(found.uploads[0]).toEqual({ visibleName: "Login-Spec", bytes: PRINTED, folder: "Obsidian", folderId: "folder-1" });
		expect(none.uploads[0]).not.toHaveProperty("folderId");
		expect(failed.uploads[0]).not.toHaveProperty("folderId");
	});

	it("swaps an untouched copy into the trash after the upload, without a question", async () => {
		const h = harness({ sends: { old: earlier() }, look: classed({ old: "untouched" }) });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The earlier copy, which nobody had written on, is in the tablet's trash.`);
		expect(h.calls).toEqual(["look old", "putPdf Login-Spec", "trash old"]);
	});

	it("speaks of two untouched copies in the plural", async () => {
		const h = harness({ sends: { a: earlier(), b: earlier() }, look: classed({ a: "untouched", b: "untouched" }) });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The 2 earlier copies, which nobody had written on, are in the tablet's trash.`);
	});

	it("says nothing about a copy that is gone", async () => {
		const h = harness({ sends: { old: earlier() } });

		expect(await sendFromVault(h.deps, NOTE)).toBe(SENT);
		expect(h.calls).not.toContain("trash old");
	});

	it("asks about a copy of the user's after the upload, and clears it on Move it to the trash", async () => {
		const h = harness({ sends: { old: earlier() }, look: classed({ old: "users" }), answer: true });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The earlier copy is in the tablet's trash.`);
		expect(h.calls).toEqual(["look old", "putPdf Login-Spec", "ask", "trash old"]);
		expect(h.questions).toEqual([
			{
				title: '"Login-Spec" has an earlier copy with your marks',
				body: "The new version is on your tablet. The earlier copy has your writing or a tag on it, or you moved it. Marks you have not synced yet go with it if you clear it; the tablet's trash keeps it until you empty it.",
				keepText: "Keep it",
				trashText: "Move it to the trash",
			},
		]);
	});

	it("keeps a copy of the user's when the dialog is closed, remembers it, and never asks about it again", async () => {
		const h = harness({ sends: { old: earlier() }, look: classed({ old: "users" }) });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The earlier copy with your marks is still there.`);
		expect(h.calls).not.toContain("trash old");
		expect(sendFor(h.record.sends, "old")?.kept).toBe(true);

		// The next send: the kept copy is not looked at or asked about -- but named.
		const next = harness({ sends: h.record.sends, look: classed({ "new-doc": "untouched" }) });
		next.deps = { ...next.deps, transport: { ...next.deps.transport!, putPdf: async () => ({ docId: "newer-doc", folderId: "folder-1" }) } };
		expect(await sendFromVault(next.deps, NOTE)).toBe(`${SENT} The earlier copy, which nobody had written on, is in the tablet's trash. The earlier copy with your marks is still there.`);
		expect(next.looked[0].map((copy) => copy.docId)).toEqual(["new-doc"]);
		expect(next.questions).toEqual([]);
	});

	it("makes no entry for a kept copy whose entry left the record while the dialog was open", async () => {
		const h = harness({ sends: { old: earlier() }, look: classed({ old: "users" }) });
		h.deps = {
			...h.deps,
			askAboutUsersCopies: async () => {
				const { old: _dropped, ...rest } = h.record.sends;
				h.record.sends = rest;
				return false;
			},
		};

		await sendFromVault(h.deps, NOTE);

		expect(Object.keys(h.record.sends)).toEqual(["new-doc"]);
	});

	it("asks once about several copies of the user's, and the answer applies to all", async () => {
		const h = harness({ sends: { a: earlier(), b: earlier() }, look: classed({ a: "users", b: "users" }), answer: true });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The 2 earlier copies are in the tablet's trash.`);
		expect(h.calls).toEqual(["look a,b", "putPdf Login-Spec", "ask", "trash a", "trash b"]);
		expect(h.questions.map((question) => [question.title, question.keepText, question.trashText])).toEqual([['"Login-Spec" has 2 earlier copies with your marks', "Keep them", "Move them to the trash"]]);
	});

	it("records the new document and says the earlier copy is still there when clearing fails", async () => {
		const h = harness({ sends: { a: earlier(), b: earlier() }, look: classed({ a: "untouched", b: "users" }), answer: true, trash: { a: false, b: new Error("HTTP 500") } });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The 2 earlier copies could not be moved to the trash and are still there.`);
		expect(sendFor(h.record.sends, "new-doc")).not.toBeNull();
	});

	it("leaves the copy where it is, and says so, on a transport that can look but has no trash", async () => {
		const h = harness({ sends: { old: earlier() }, look: classed({ old: "untouched" }) });
		const { moveToTrash: _none, ...noTrash } = h.deps.transport!;
		h.deps = { ...h.deps, transport: noTrash };

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The earlier copy could not be moved to the trash and is still there.`);
	});

	it("still uploads and records when the look fails, clears nothing, asks nothing, and says so", async () => {
		const h = harness({ sends: { old: earlier() }, look: new Error("HTTP 502") });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} The earlier copy could not be checked and is still there.`);
		expect(h.calls).toEqual(["look old", "putPdf Login-Spec"]);
		expect(sendFor(h.record.sends, "new-doc")).not.toBeNull();
	});

	it("says nothing of an earlier copy when a look fails for an origin with none", async () => {
		const h = harness({ sends: { gone: earlier({ goneAt: "2026-11-12T09:00:00.000Z" }) }, look: new Error("HTTP 502") });

		expect(await sendFromVault(h.deps, NOTE)).toBe(SENT);
	});

	it("adds the new one beside a document of the same name that is not ours, and says so", async () => {
		const h = harness({ look: { copies: [], strangerNamed: true } });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} A document of that name was already there. This one was added beside it.`);
		expect(h.calls).toEqual(["look ", "putPdf Login-Spec"]);
	});

	it("puts the additions in the table's order", async () => {
		const h = harness({
			sends: { a: earlier(), b: earlier(), c: earlier(), kept: earlier({ kept: true }) },
			look: classed({ a: "untouched", b: "users", c: "untouched" }, true),
			answer: true,
			trash: { c: false },
		});

		expect(await sendFromVault(h.deps, NOTE)).toBe(
			`${SENT} The earlier copy, which nobody had written on, is in the tablet's trash. The earlier copy with your marks is still there. The earlier copy is in the tablet's trash. The earlier copy could not be moved to the trash and is still there. A document of that name was already there. This one was added beside it.`,
		);
	});
});

describe("a second send over SSH (send spec §3, 05 #12)", () => {
	it("looks at nothing, clears nothing, and says the earlier copy is still there", async () => {
		const h = harness({ transport: "ssh", sends: { old: earlier() } });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} Over SSH nothing is replaced. The earlier copy is still there.`);
		expect(h.calls).toEqual(["putPdf Login-Spec"]);
		expect(h.reports[0]).toBe('Tagged Sync: sending "Login-Spec" to your reMarkable…');
	});

	it("speaks of every copy the record does not know to be gone, kept ones included, in the plural", async () => {
		const h = harness({ transport: "ssh", sends: { a: earlier(), b: earlier({ kept: true }), gone: earlier({ goneAt: "2026-11-12T09:00:00.000Z" }) } });

		expect(await sendFromVault(h.deps, NOTE)).toBe(`${SENT} Over SSH nothing is replaced. The 2 earlier copies are still there.`);
	});

	it("says nothing more for an origin whose copies are all gone", async () => {
		const h = harness({ transport: "ssh", sends: { gone: earlier({ goneAt: "2026-11-12T09:00:00.000Z" }) } });

		expect(await sendFromVault(h.deps, NOTE)).toBe(SENT);
	});
});
