import { describe, expect, it, vi } from "vitest";
import type { DigestPage } from "./digest-builder";
import { type ReadwiseClient, ReadwiseError, type ReadwiseItem } from "./readwise-client";
import { createReadwiseRecorder, pushToReadwise, type ReadwiseData, readwiseNotice, type ReadwiseUnit, startReadwiseRecording, tokenFingerprint } from "./readwise-push";
import { type ReadwiseBook, readwiseBook, type ReadwiseHighlight, type StoredReadwiseBooks } from "./readwise-state";
import { RENDER_VERSION, type SyncIndex, type SyncIndexRow } from "./sync-engine";

const DOC = "0f1e2d3c-doc";
const PAGE = "6a7b8c9d-page";
const KEY = `${PAGE}:1a2b`;

function page(sentence = "The weather station at Cape Marrow was built in the spring."): DigestPage {
	return {
		pageLabel: "12",
		embedPage: 1,
		source: { index: 11, widthPt: 612, heightPt: 792 },
		highlights: [{ id: "hl-9f21c4", key: KEY, sentence, rects: [], tool: "marker", marked: ["Cape Marrow"], color: null, notes: [], section: null, top: 0 }],
		notes: [],
	};
}

function unit(overrides: Partial<ReadwiseUnit> = {}): ReadwiseUnit {
	return { docId: DOC, pages: [page()], scope: "document", pageOrder: null, marginNotes: true, sources: async () => ({ visibleName: "cape-marrow_final" }), ...overrides };
}

/** A vault's `readwiseBooks`, as the recorder reads and writes it. */
function vault(books: StoredReadwiseBooks = {}) {
	const host = { books: () => books, setBooks: (next: StoredReadwiseBooks) => void (books = next) };
	return { host, books: () => books };
}

describe("the Readwise recorder", () => {
	it("records a unit's digest as what Readwise should hold, in a book named from its sources", async () => {
		const { host, books } = vault();

		await createReadwiseRecorder(host).record(unit({ sources: async () => ({ epub: { title: "Cape Marrow", authors: ["Ada Byrne"] }, visibleName: "cape-marrow_final" }) }));

		expect(readwiseBook(books(), DOC)).toEqual({
			title: "Cape Marrow",
			author: "Ada Byrne",
			highlights: { [KEY]: { want: { text: "The weather station at **Cape Marrow** was built in the spring.", location: 12 } } },
		});
	});

	// Spec §11 P21: the name is frozen at the first record, and an EPUB's costs a download.
	it("asks for the sources only for a document that has no book yet", async () => {
		const { host } = vault();
		const sources = vi.fn(async () => ({ visibleName: "cape-marrow_final" }));
		const recorder = createReadwiseRecorder(host);

		await recorder.record(unit({ sources }));
		await recorder.record(unit({ sources, pages: [page("The station was moved in the autumn.")] }));

		expect(sources).toHaveBeenCalledTimes(1);
	});
});

// ---- the push step (spec §4.3) ----

const FINGERPRINT = "a1b2c3d4e5f6";
const OTHER_FINGERPRINT = "0f0f0f0f0f0f";
const THIRD_FINGERPRINT = "123456123456";
const URL = `obsidian://tagged-sync?highlight=${DOC}/${KEY}`;
const TEXT = { text: "The weather station at **Cape Marrow** was built in the spring.", location: 12 };
const CHANGED = { text: "The station was **moved** in the autumn.", location: 12 };

interface FakeBook {
	readonly id: number;
	readonly title: string;
	readonly author: string | null;
	/** What the web app shows, after a rename there (spec §11 P25); a push resets it to `title`/`author`. */
	shown: { title: string; author: string | null };
	readonly highlights: Map<string, { id: number; text: string; note?: string }>;
}

type Method = Exclude<keyof ReadwiseClient, "check">;

/**
 * A Readwise account in memory, as far as the push talks to it: books grouped by title + author,
 * highlights by `highlight_url`. `fail` makes a method throw; `refuse` makes a create refuse those texts.
 */
function fakeReadwise() {
	const books: FakeBook[] = [];
	const calls: string[] = [];
	const fail = new Map<Method, ReadwiseError>();
	const refuse = new Set<string>();
	let next = 1000;
	const thrown = (method: Method) => {
		const error = fail.get(method);
		if (error) throw error;
	};
	const client: ReadwiseClient = {
		check: async () => "ok",
		async ourBooks() {
			calls.push("books");
			thrown("ourBooks");
			return books.map((book) => ({ id: book.id, ...book.shown }));
		},
		async push(items: readonly ReadwiseItem[]) {
			calls.push(`push ${items.length}`);
			thrown("push");
			const refused = items.filter((item) => refuse.has(item.text)).map((item) => item.url);
			if (refused.length > 0) return { kind: "refused", urls: refused };
			const touched = new Map<FakeBook, number[]>();
			const ids = new Map<string, number>();
			for (const item of items) {
				const author = item.author ?? null;
				let book = books.find((candidate) => candidate.title === item.title && candidate.author === author);
				if (book === undefined) {
					book = { id: next++, title: item.title, author, shown: { title: item.title, author }, highlights: new Map() };
					books.push(book);
				}
				book.shown = { title: book.title, author: book.author };
				const id = book.highlights.get(item.url)?.id ?? next++;
				book.highlights.set(item.url, { id, text: item.text, ...(item.note === undefined ? {} : { note: item.note }) });
				touched.set(book, [...(touched.get(book) ?? []), id]);
				ids.set(item.url, id);
			}
			return { kind: "pushed", books: [...touched].map(([book, highlightIds]) => ({ id: book.id, title: book.title, author: book.author, highlightIds })), ids };
		},
		async bookHighlights(bookId: number) {
			calls.push(`highlights of ${bookId}`);
			thrown("bookHighlights");
			const book = books.find((candidate) => candidate.id === bookId);
			return [...(book?.highlights ?? [])].map(([url, { id }]) => ({ id, url }));
		},
		async remove(highlightId: number) {
			calls.push(`delete ${highlightId}`);
			thrown("remove");
			for (const book of books) for (const [url, { id }] of book.highlights) if (id === highlightId) book.highlights.delete(url);
		},
		async rename(bookId: number, names) {
			calls.push(`rename ${bookId}`);
			thrown("rename");
			const book = books.find((candidate) => candidate.id === bookId)!;
			book.shown = { title: names.title ?? book.shown.title, author: names.author ?? book.shown.author };
		},
	};
	/** A book of ours already in the account, as an earlier push left it. */
	const seed = (title: string, author: string | null, highlights: Record<string, { id: number; text: string }> = {}): FakeBook => {
		const book: FakeBook = { id: next++, title, author, shown: { title, author }, highlights: new Map(Object.entries(highlights)) };
		books.push(book);
		return book;
	};
	const texts = () => books.flatMap((book) => [...book.highlights.values()].map((highlight) => highlight.text));
	return { client, books, calls, fail, refuse, seed, texts };
}

function book(highlights: Record<string, ReadwiseHighlight>, extra: Partial<ReadwiseBook> = {}): ReadwiseBook {
	return { title: "Cape Marrow", author: "Ada Byrne", highlights, ...extra };
}

function data(books: Record<string, ReadwiseBook>, extra: Partial<ReadwiseData> = {}): ReadwiseData {
	return { readwiseBooks: books, readwiseAccount: FINGERPRINT, ...extra };
}

const after = (state: ReadwiseData, docId = DOC) => readwiseBook(state.readwiseBooks, docId);

describe("pushToReadwise", () => {
	it("sends nothing while nothing is pending and the token is the one the state belongs to", async () => {
		const readwise = fakeReadwise();
		const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7 } }, { bookId: 3 }) });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();
		expect(readwise.calls).toEqual([]);
	});

	it("pushes a document for the first time, and keeps the book id and highlight ids it learns", async () => {
		const readwise = fakeReadwise();
		const state = data({ [DOC]: book({ [KEY]: { want: TEXT } }) }, { readwiseAccount: undefined });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

		expect(readwise.texts()).toEqual([TEXT.text]);
		const [landed] = readwise.books;
		expect(after(state)).toEqual(book({ [KEY]: { pushed: TEXT, id: [...landed.highlights.values()][0].id } }, { bookId: landed.id }));
		expect(state.readwiseAccount).toBe(FINGERPRINT);
	});

	it("sends the book's frozen title and author with every item, and a note only where there is one", async () => {
		const readwise = fakeReadwise();
		const sent: ReadwiseItem[] = [];
		const push = readwise.client.push;
		readwise.client.push = async (items) => {
			sent.push(...items);
			return await push(items);
		};
		const state = data({ [DOC]: book({ [KEY]: { want: { ...TEXT, note: "check the date" } }, [`${PAGE}:3c4d`]: { want: CHANGED } }) });

		await pushToReadwise(state, readwise.client, FINGERPRINT);

		expect(sent).toEqual([
			{ title: "Cape Marrow", author: "Ada Byrne", ...TEXT, note: "check the date", url: URL },
			{ title: "Cape Marrow", author: "Ada Byrne", ...CHANGED, url: `obsidian://tagged-sync?highlight=${DOC}/${PAGE}:3c4d` },
		]);
	});

	// Ticket 14 #4: never blank, never a placeholder. Readwise answers `null` for it.
	it("omits the author of a book nobody named, and still learns the book's id", async () => {
		const readwise = fakeReadwise();
		const sent: ReadwiseItem[] = [];
		const push = readwise.client.push;
		readwise.client.push = async (items) => {
			sent.push(...items);
			return await push(items);
		};
		const state = data({ [DOC]: { title: "cape-marrow_final", highlights: { [KEY]: { want: TEXT } } } });

		await pushToReadwise(state, readwise.client, FINGERPRINT);

		expect(sent).toEqual([{ title: "cape-marrow_final", ...TEXT, url: URL }]);
		expect(after(state)!.bookId).toBe(readwise.books[0].id);
	});

	// Spec §11 P5: ids are best effort; what landed is recorded either way.
	it("records what landed when the answer names no book or id it can match", async () => {
		const readwise = fakeReadwise();
		readwise.client.push = async () => ({ kind: "pushed", books: [], ids: new Map() });
		const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED }, [`${PAGE}:3c4d`]: { want: TEXT } }) });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

		expect(after(state)).toEqual(book({ [KEY]: { pushed: CHANGED, id: 7 }, [`${PAGE}:3c4d`]: { pushed: TEXT } }));
	});

	it("sends nothing more when Readwise refuses every item", async () => {
		const readwise = fakeReadwise();
		readwise.refuse.add(TEXT.text);
		const state = data({ [DOC]: book({ [KEY]: { want: TEXT } }) });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

		expect(readwise.calls).toEqual(["books", "push 1"]);
		expect(after(state)!.highlights[KEY]).toEqual({ want: TEXT, rejected: TEXT });
	});

	// Only readwise.io's answers are a push that stopped; anything else is a bug, and is not hidden as one.
	it("lets an error that is not readwise.io's through", async () => {
		const readwise = fakeReadwise();
		readwise.client.push = async () => {
			throw new RangeError("at most 1000 highlights per call, not 1001");
		};

		await expect(pushToReadwise(data({ [DOC]: book({ [KEY]: { want: TEXT } }) }), readwise.client, FINGERPRINT)).rejects.toThrow(RangeError);
	});

	it("sends at most 1,000 highlights per call", async () => {
		const readwise = fakeReadwise();
		const highlights = Object.fromEntries(Array.from({ length: 1001 }, (_, n) => [`${PAGE}:${n.toString(16)}`, { want: { text: `line ${n}`, location: 1 } }]));
		const state = data({ [DOC]: book(highlights) });

		await pushToReadwise(state, readwise.client, FINGERPRINT);

		expect(readwise.calls).toEqual(["books", "push 1000", "push 1"]);
		expect(Object.values(after(state)!.highlights).every((record) => record.pushed && record.want === undefined)).toBe(true);
	});

	// Spec §11 P13: one bad item never blocks the rest, and never raises a notice on every sync.
	it("sets aside what Readwise refuses and sends the rest once more", async () => {
		const readwise = fakeReadwise();
		readwise.refuse.add(CHANGED.text);
		const state = data({ [DOC]: book({ [KEY]: { want: TEXT }, [`${PAGE}:3c4d`]: { want: CHANGED } }) });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

		expect(readwise.texts()).toEqual([TEXT.text]);
		expect(after(state)!.highlights[`${PAGE}:3c4d`]).toEqual({ want: CHANGED, rejected: CHANGED });
		expect(after(state)!.highlights[KEY].pushed).toEqual(TEXT);
		// Set aside until it changes on the tablet: the next push leaves it alone.
		readwise.calls.length = 0;
		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();
		expect(readwise.calls).toEqual([]);
	});

	it("stops when Readwise refuses the re-send too", async () => {
		const readwise = fakeReadwise();
		readwise.refuse.add(CHANGED.text);
		const push = readwise.client.push;
		let call = 0;
		readwise.client.push = async (items) => (++call === 2 ? { kind: "refused", urls: [items[0].url] } : await push(items));
		const state = data({ [DOC]: book({ [KEY]: { want: TEXT }, [`${PAGE}:3c4d`]: { want: CHANGED } }) });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBe("bad-request");
		expect(after(state)!.highlights[KEY]).toEqual({ want: TEXT });
	});

	it("stops at the first error and keeps everything that has not landed pending for the next sync", async () => {
		const readwise = fakeReadwise();
		readwise.fail.set("push", new ReadwiseError("unreachable", "Could not reach readwise.io."));
		const state = data({ [DOC]: book({ [KEY]: { want: TEXT } }) });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBe("unreachable");
		expect(after(state)!.highlights[KEY]).toEqual({ want: TEXT });

		// Nothing changed on the tablet: the next sync's push alone retries it (spec §11 P1).
		readwise.fail.clear();
		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();
		expect(readwise.texts()).toEqual([TEXT.text]);
	});

	it.each(["rejected", "no-api"] as const)("stops at once on %s", async (kind) => {
		const readwise = fakeReadwise();
		readwise.fail.set("ourBooks", new ReadwiseError(kind, "no"));
		const state = data({ [DOC]: book({ [KEY]: { want: TEXT } }) });

		expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBe(kind);
		expect(readwise.calls).toEqual(["books"]);
	});

	describe("deletes", () => {
		it("deletes an erased highlight by its id, before anything is created", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: null }, [`${PAGE}:3c4d`]: { want: CHANGED } }, { bookId: landed.id }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

			expect(readwise.calls).toEqual(["books", "delete 7", "push 1"]);
			expect(readwise.texts()).toEqual([CHANGED.text]);
			expect(after(state)!.highlights[KEY]).toBeUndefined();
		});

		it("finds the id of a highlight it never learnt through its book's listing", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, want: null } }, { bookId: landed.id }) });

			await pushToReadwise(state, readwise.client, FINGERPRINT);

			expect(readwise.calls).toEqual(["books", `highlights of ${landed.id}`, "delete 7"]);
			expect(after(state)!.highlights).toEqual({});
		});

		it("drops a delete its book's listing does not find: it is already gone", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne");
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, want: null } }, { bookId: landed.id }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();
			expect(after(state)!.highlights).toEqual({});
		});

		it("keeps a delete pending when its book's listing fails", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			readwise.fail.set("bookHighlights", new ReadwiseError("unreachable", "no"));
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, want: null } }, { bookId: landed.id }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBe("unreachable");
			expect(after(state)!.highlights[KEY]).toEqual({ pushed: TEXT, want: null });
		});

		// Spec §4.3 step 3: nothing addressable, so the highlight stays in Readwise (accepted).
		it("drops a delete in a book whose id it never learnt", async () => {
			const readwise = fakeReadwise();
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, want: null } }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();
			expect(readwise.calls).toEqual(["books"]);
			expect(after(state)!.highlights).toEqual({});
		});
	});

	describe("a book deleted in Readwise (ticket 14 #2)", () => {
		it("is marked deleted, its pending changes dropped, and never pushed again", async () => {
			const readwise = fakeReadwise();
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED }, [`${PAGE}:3c4d`]: { want: CHANGED } }, { bookId: 3 }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

			expect(readwise.calls).toEqual(["books"]);
			expect(after(state)).toEqual(book({ [KEY]: { pushed: TEXT, id: 7 } }, { bookId: 3, deleted: true }));
		});

		// Spec §11 P24: pushing without the listing would recreate a book the user deleted.
		it("is not looked for when the listing fails, and nothing is sent", async () => {
			const readwise = fakeReadwise();
			readwise.fail.set("ourBooks", new ReadwiseError("unreachable", "no"));
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: 3 }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBe("unreachable");
			expect(readwise.calls).toEqual(["books"]);
			expect(after(state)!.deleted).toBeUndefined();
			expect(after(state)!.highlights[KEY].want).toEqual(CHANGED);
		});
	});

	describe("the account check (spec §11 P4)", () => {
		it("keeps the state for a new token of the same account", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7 } }, { bookId: landed.id }) });

			expect(await pushToReadwise(state, readwise.client, OTHER_FINGERPRINT)).toBeNull();

			expect(readwise.calls).toEqual(["books"]);
			expect(state.readwiseAccount).toBe(OTHER_FINGERPRINT);
			expect(after(state)!.highlights[KEY]).toEqual({ pushed: TEXT, id: 7 });
		});

		it("keeps the state when there is nothing to compare: no book id yet", async () => {
			const readwise = fakeReadwise();
			const state = data({ [DOC]: book({ [KEY]: { want: TEXT } }) }, { readwiseAccount: OTHER_FINGERPRINT });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();
			expect(readwise.texts()).toEqual([TEXT.text]);
			expect(state.readwiseAccount).toBe(FINGERPRINT);
		});

		it("drops the state for another account, and leaves the backfill to the next sync", async () => {
			const readwise = fakeReadwise();
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: 3 }) }, { readwiseRecording: true });

			expect(await pushToReadwise(state, readwise.client, OTHER_FINGERPRINT)).toBeNull();

			expect(readwise.calls).toEqual(["books"]);
			expect(state).toEqual({ readwiseBooks: {}, readwiseAccount: OTHER_FINGERPRINT, readwiseAccountBefore: FINGERPRINT });
		});

		it("does not store a token whose account could not be checked", async () => {
			const readwise = fakeReadwise();
			readwise.fail.set("ourBooks", new ReadwiseError("unreachable", "no"));
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7 } }, { bookId: 3 }) });

			expect(await pushToReadwise(state, readwise.client, OTHER_FINGERPRINT)).toBe("unreachable");
			expect(state.readwiseAccount).toBe(FINGERPRINT);
		});

		// Computer A pushes to account A, computer B to account B: B dropped A's state once; A switching
		// back would drop B's, and each drop costs a re-read of every margin note.
		it("stops two computers on two accounts instead of backfilling each other", async () => {
			const accountB = fakeReadwise();
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7 } }, { bookId: 3 }) }, { readwiseAccount: OTHER_FINGERPRINT, readwiseAccountBefore: FINGERPRINT });

			expect(await pushToReadwise(state, accountB.client, FINGERPRINT)).toBe("clash");

			expect(state.readwiseAccountClash).toBe(true);
			expect(after(state)!.highlights[KEY]).toEqual({ pushed: TEXT, id: 7 });
			// Both computers now stop before any call.
			accountB.calls.length = 0;
			expect(await pushToReadwise(state, accountB.client, FINGERPRINT)).toBe("clash");
			expect(await pushToReadwise(state, accountB.client, OTHER_FINGERPRINT)).toBe("clash");
			expect(accountB.calls).toEqual([]);
		});

		// Computer B dropped A's state and has not pushed yet: there is nothing to compare, but A coming
		// back to the fingerprint just replaced is the same clash -- or A backfills, then B, then A again.
		it("stops a computer that comes back to the token just replaced before the other one pushed", async () => {
			const readwise = fakeReadwise();
			const state = data({ [DOC]: book({ [KEY]: { want: TEXT } }) }, { readwiseAccount: OTHER_FINGERPRINT, readwiseAccountBefore: FINGERPRINT });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBe("clash");

			expect(readwise.calls).toEqual([]);
			expect(state.readwiseAccountClash).toBe(true);
			expect(state.readwiseAccount).toBe(OTHER_FINGERPRINT);
		});

		// The "no fingerprint stored" leg alone: book ids remembered, but nothing says which token they came with.
		it("keeps the state when no fingerprint was ever stored, whatever book ids it remembers", async () => {
			const readwise = fakeReadwise();
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7 } }, { bookId: 3 }) }, { readwiseAccount: undefined });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

			expect(readwise.calls).toEqual([]);
			expect(state.readwiseAccount).toBe(FINGERPRINT);
			expect(after(state)!.bookId).toBe(3);
		});

		it("lets a third token clear the clash and be checked like any other", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7 } }, { bookId: landed.id }) }, { readwiseAccount: OTHER_FINGERPRINT, readwiseAccountBefore: FINGERPRINT, readwiseAccountClash: true });

			expect(await pushToReadwise(state, readwise.client, THIRD_FINGERPRINT)).toBeNull();

			expect(state.readwiseAccountClash).toBeUndefined();
			expect(state.readwiseAccount).toBe(THIRD_FINGERPRINT);
		});
	});

	describe("the user's names for a book (spec §11 P25)", () => {
		it("puts back a title and author the user gave the book, after a push reset them", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			landed.shown = { title: "Marrow, the station book", author: "A. Byrne" };
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: landed.id }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();

			expect(readwise.calls).toEqual(["books", "push 1", `rename ${landed.id}`]);
			expect(landed.shown).toEqual({ title: "Marrow, the station book", author: "A. Byrne" });
			expect(after(state)!.shown).toEqual({ title: "Marrow, the station book", author: "A. Byrne" });
		});

		it("puts back an author alone, leaving our title", async () => {
			const readwise = fakeReadwise();
			const renames: unknown[] = [];
			const rename = readwise.client.rename;
			readwise.client.rename = async (bookId, names) => {
				renames.push(names);
				await rename(bookId, names);
			};
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			landed.shown = { title: "Cape Marrow", author: "A. Byrne" };
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: landed.id }) });

			await pushToReadwise(state, readwise.client, FINGERPRINT);

			expect(renames).toEqual([{ author: "A. Byrne" }]);
			expect(landed.shown).toEqual({ title: "Cape Marrow", author: "A. Byrne" });
		});

		it("lets an error that is not readwise.io's through a rename", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			landed.shown = { title: "Marrow", author: "Ada Byrne" };
			readwise.client.rename = async () => {
				throw new TypeError("names is undefined");
			};
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: landed.id }) });

			await expect(pushToReadwise(state, readwise.client, FINGERPRINT)).rejects.toThrow(TypeError);
		});

		it("keeps owing a rename that failed, and retries it on the next push with nothing else pending", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			landed.shown = { title: "Marrow, the station book", author: "Ada Byrne" };
			readwise.fail.set("rename", new ReadwiseError("unreachable", "no"));
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: landed.id }) });

			expect(await pushToReadwise(state, readwise.client, FINGERPRINT)).toBeNull();
			expect(after(state)!.shown).toEqual({ title: "Marrow, the station book", owed: true });
			expect(landed.shown.title).toBe("Cape Marrow");

			readwise.fail.clear();
			await pushToReadwise(state, readwise.client, FINGERPRINT);
			expect(landed.shown.title).toBe("Marrow, the station book");
			expect(after(state)!.shown).toEqual({ title: "Marrow, the station book" });
		});

		it("forgets the user's names once they renamed the book back to ours", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: landed.id, shown: { title: "Marrow" } }) });

			await pushToReadwise(state, readwise.client, FINGERPRINT);

			expect(readwise.calls).toEqual(["books", "push 1"]);
			expect(after(state)!.shown).toBeUndefined();
		});

		it("reads a blank author in the listing as ours: a blank cannot be put back", async () => {
			const readwise = fakeReadwise();
			const landed = readwise.seed("Cape Marrow", "Ada Byrne", { [URL]: { id: 7, text: TEXT.text } });
			landed.shown = { title: "Cape Marrow", author: null };
			const state = data({ [DOC]: book({ [KEY]: { pushed: TEXT, id: 7, want: CHANGED } }, { bookId: landed.id }) });

			await pushToReadwise(state, readwise.client, FINGERPRINT);

			expect(readwise.calls).toEqual(["books", "push 1"]);
			expect(after(state)!.shown).toBeUndefined();
		});
	});
});

describe("readwiseNotice (spec §6)", () => {
	const waiting = (count: number): StoredReadwiseBooks =>
		Object.fromEntries(Array.from({ length: count }, (_, n) => [`doc-${n}`, book({ [KEY]: { want: TEXT } }, { title: `Book ${n}` })]));

	it.each([
		["rejected", "Readwise: the access token was not accepted — paste a new one in Settings → Tagged Sync → Readwise."],
		["no-api", "Readwise: your plan doesn't include API access, so nothing was pushed."],
		["clash", "Readwise: this computer and another push to different accounts, so nothing was pushed."],
	] as const)("says what %s means", (failure, notice) => {
		expect(readwiseNotice(failure, waiting(2))).toBe(notice);
	});

	it.each(["unreachable", "bad-request"] as const)("counts the documents %s left waiting", (failure) => {
		expect(readwiseNotice(failure, waiting(2))).toBe("Readwise: 2 documents not pushed — will retry next sync.");
		expect(readwiseNotice(failure, waiting(1))).toBe("Readwise: 1 document not pushed — will retry next sync.");
	});

	it("says nothing when nothing is left waiting or nothing failed", () => {
		expect(readwiseNotice("unreachable", waiting(0))).toBeNull();
		expect(readwiseNotice(null, waiting(2))).toBeNull();
	});
});

describe("startReadwiseRecording (spec §5)", () => {
	const row = (docId: string): SyncIndexRow => ({ syncKey: `${docId}:sync`, docId, pageId: null, tag: "sync", entryHash: "h", pageHash: null, notePath: `${docId}.md`, status: "active", syncedAt: "2026-11-02T00:00:00.000Z", renderVersion: RENDER_VERSION });
	const index = (): SyncIndex => ({ rootHash: "root", mappings: "m", rows: { a: row("doc-a"), b: { ...row("doc-b"), status: "orphaned" } } });

	it("makes every active document due once when recording starts, and marks that it has", () => {
		const data: { syncIndex: SyncIndex; readwiseRecording?: true } = { syncIndex: index() };

		expect(startReadwiseRecording(data, true)).toBe(true);

		expect(data.readwiseRecording).toBe(true);
		expect(data.syncIndex.rows.a.renderVersion).toBeUndefined();
		expect(data.syncIndex.rows.b.renderVersion).toBe(RENDER_VERSION);
		// Started once: the next sync changes nothing.
		expect(startReadwiseRecording(data, true)).toBe(false);
		expect(data.syncIndex.rows.a.renderVersion).toBeUndefined();
	});

	// Switched off, licence lapsed: the flag goes, so switching back on is a backfill again.
	it("forgets the backfill while recording is off", () => {
		const data: { syncIndex: SyncIndex; readwiseRecording?: true } = { syncIndex: index(), readwiseRecording: true };

		expect(startReadwiseRecording(data, false)).toBe(true);
		expect(data.readwiseRecording).toBeUndefined();
		expect(data.syncIndex.rows.a.renderVersion).toBe(RENDER_VERSION);
		expect(startReadwiseRecording(data, false)).toBe(false);
	});
});

describe("tokenFingerprint (spec §11 P4)", () => {
	it("is the first 12 hex of the token's SHA-256", async () => {
		expect(await tokenFingerprint("abc")).toBe("ba7816bf8f01");
	});
});
