/**
 * Zotero, as the rest of the plugin sees it.
 *
 * There are two ways into a Zotero library and the spec (§2.1) treats them as *one* feature with two
 * connections rather than as a surface and a fallback: the Web API works with Zotero closed and is
 * the only surface a web-only user has, the Zotero 10 local API works offline and knows where the
 * file is on disk. Both are enough alone. So what the callers -- the matcher, the writer, the send
 * command -- talk to is this one interface, and which connection answered is never visible to them.
 *
 * Everything Zotero-shaped stops here. No caller sees `annotationSortIndex`, a library prefix, or
 * the fact that one connection pages and the other does not. What leaves this file is the plugin's
 * own vocabulary: an attachment, an item, an annotation.
 *
 * The split inside is by *what differs*, which is less than it looks: both connections speak API
 * version 3 with the same JSON, so the reads and the writes are written once here, over a
 * {@link ZoteroRequester} each connection supplies. What genuinely differs -- a base URL, how a
 * request is authenticated, whether a rejected credential can be repaired, and how you get at the
 * PDF bytes -- is all a connection has to answer.
 */

/** The one library this feature touches. Group libraries are refused (spec §1.3). */
export const ZOTERO_LIBRARY = "user";

/**
 * The tag that says an annotation is ours, and the only marker there is.
 *
 * It is written on every annotation we create and it is how they are read back
 * (`?itemType=annotation&tag=tagged-sync`), so it lives in one place rather than one per side. A
 * comment prefix was the alternative and was rejected in [08]: the comment is the user's to edit.
 */
export const OWNERSHIP_TAG = "tagged-sync";

/** Zotero's default highlight colour, and what an empty `annotationColor` becomes. */
export const DEFAULT_ANNOTATION_COLOR = "#ffd400";

export type ZoteroAnnotationType = "highlight" | "underline" | "note";

/**
 * A PDF attachment: the thing a reMarkable document is matched *to*, and the parent of every
 * annotation we write.
 *
 * `md5` is the field the silent match (§2.3) rides on, and it means two slightly different things
 * per connection -- the live on-disk hash locally, the synced hash on the web. Both are the hash of
 * the same bytes for a stored file; a linked file has none on the web at all, which is why the
 * matching table has a row for it.
 */
export interface ZoteroAttachment {
	readonly key: string;
	/** The bibliographic item this PDF hangs under, or `null` for a standalone attachment. */
	readonly parentKey: string | null;
	/** Stored files carry `filename`, linked files a path; this is the last segment either way. */
	readonly filename: string | null;
	readonly md5: string | null;
	readonly title: string;
}

/** A bibliographic item, in the four fields the note and the picker need (spec §4). */
export interface ZoteroItem {
	readonly key: string;
	readonly title: string;
	/** First creator's family name, for `Smith 2024 · Title`. */
	readonly creator: string | null;
	readonly year: string | null;
	/** Only when Zotero has one. Never invented, and never written back (spec §4). */
	readonly citationKey: string | null;
}

/** One of *our* annotations, as it stands in Zotero now -- the input to "did the user edit it?" (§3.3). */
export interface ZoteroAnnotation {
	readonly key: string;
	/**
	 * Which connection read it, and therefore the only one its {@link ZoteroAnnotation.version} means
	 * anything to. See the warning on `version`.
	 */
	readonly source: "local" | "web";
	readonly parentKey: string;
	readonly type: ZoteroAnnotationType;
	/** From `annotationPosition`, or `null` when the string is not one we can read. */
	readonly pageIndex: number | null;
	readonly text: string;
	readonly comment: string;
	readonly color: string;
	readonly pageLabel: string;
	readonly sortIndex: string;
	/** The raw JSON string, compared byte for byte against what we wrote. */
	readonly position: string;
	/**
	 * This connection's version of the item, for a `PATCH` precondition.
	 *
	 * ⚠️ Local and web versions are unrelated -- one item stood at 246 locally and 986 on the web the
	 * same second ([research/10]). So a version is only ever sent back to the connection it was read
	 * from, which is why it rides on the annotation together with {@link ZoteroAnnotation.source}.
	 * Sent to the other one it would be a precondition about a number that connection never issued:
	 * too low is a `412` the writer would read as "the user edited this", too high is a silent
	 * overwrite of an edit the user made.
	 */
	readonly version: number;
}

/** What a patch needs to know about the annotation it is changing -- including which connection may take it. */
export type ZoteroAnnotationRef = Pick<ZoteroAnnotation, "key" | "version" | "source">;

/** The fields of an annotation we set. Everything else Zotero fills in. */
export interface AnnotationFields {
	/** Only meaningful for `highlight` and `underline`; Zotero's data layer refuses it on a `note`. */
	readonly text?: string;
	readonly comment?: string;
	readonly color?: string;
	readonly pageLabel?: string;
	readonly sortIndex?: string;
	/** A JSON **string**: `{"pageIndex":P,"rects":[[x1,y1,x2,y2],…]}`, PDF points, bottom-left origin. */
	readonly position?: string;
}

export interface NewAnnotation extends AnnotationFields {
	readonly type: ZoteroAnnotationType;
	readonly parentKey: string;
}

/**
 * What one `POST /items` batch did, by the position the caller sent.
 *
 * Aligned to the input rather than keyed by anything of Zotero's, because position is the only
 * identity a not-yet-created annotation has -- Zotero answers `success: {"0": "KEY"}` for exactly
 * that reason ([research/10] §12).
 */
export interface AnnotationsCreated {
	/** `keys[i]` is the new key for `items[i]`, or `null` where that one failed. */
	readonly keys: (string | null)[];
	/** One sentence per failure, in input order. Empty when everything landed. */
	readonly failures: string[];
}

/** A patch either wrote, or found the item changed underneath it -- which the caller reads as "the user edited it". */
export type PatchOutcome = "written" | "conflict";

export interface ZoteroStatus {
	readonly web: boolean;
	readonly local: boolean;
	/** The settings line, in the spec's own words (§2.1). */
	readonly summary: string;
}

/**
 * Why a Zotero call could not be made, in the words the sync's status line needs (spec §3.4.2).
 *
 * `reason` exists so that callers branch on a value rather than on a message: the writer skips on
 * every one of them, but only some of them are worth telling the user to go and fix.
 */
export type ZoteroFailure =
	/** The desktop app is not running, or nothing answered. */
	| "unreachable"
	/** Zotero is running with "Allow other applications" off. */
	| "not-enabled"
	/** The user clicked Deny in Zotero's dialog. */
	| "denied"
	/** The API key was rejected. */
	| "unauthorized"
	/** The server asked us to wait. */
	| "rate-limited"
	/** The item is gone: trashed, deleted, or never there. */
	| "not-found"
	/** Anything the server said that we have no better word for. */
	| "server";

export class ZoteroError extends Error {
	constructor(
		readonly reason: ZoteroFailure,
		message: string,
	) {
		super(message);
		this.name = "ZoteroError";
	}
}

/** One way into the library. Both connections implement it; {@link createZoteroClient} picks between them. */
export interface ZoteroConnection {
	readonly id: "local" | "web";
	/** Names this connection in a status line: "your Zotero desktop app" / "zotero.org". */
	readonly label: string;
	/** Does anything answer? Never throws -- a probe is a question, not a call. */
	probe(): Promise<boolean>;
	/** The numeric user id, for the web-library URL (spec §4). `null` when this connection cannot say. */
	libraryId(): Promise<number | null>;
	/** Every PDF attachment in the personal library. The matcher's whole input (§2.3). */
	attachments(): Promise<ZoteroAttachment[]>;
	/** One attachment, or `null` when it is trashed or gone -- the "no longer found" row of §2.3. */
	attachment(key: string): Promise<ZoteroAttachment | null>;
	parentItem(key: string): Promise<ZoteroItem | null>;
	/** Top-level items for the send picker: `q=`, `qmode=titleCreatorYear` (spec §2.4). */
	search(query: string): Promise<ZoteroItem[]>;
	/** Where the PDF sits on this machine, or `null` when this connection cannot know. */
	filePath(key: string): Promise<string | null>;
	/** The PDF itself, or `null` when Zotero has no copy to hand out. */
	fileBytes(key: string): Promise<Uint8Array | null>;
	/** Our own annotations on one attachment, read by the ownership tag -- never through `/children`, which returns none. */
	ownAnnotations(parentKey: string): Promise<ZoteroAnnotation[]>;
	createAnnotations(items: NewAnnotation[]): Promise<AnnotationsCreated>;
	patchAnnotation(key: string, version: number, fields: AnnotationFields): Promise<PatchOutcome>;
}

/**
 * Everything a caller may do. One connection's shape, minus the parts that are about *being* a
 * connection -- and with the one call that cannot be routed freely spelled out differently.
 */
export interface ZoteroClient extends Omit<ZoteroConnection, "id" | "label" | "probe" | "patchAnnotation"> {
	status(): Promise<ZoteroStatus>;
	/** Goes to the connection the annotation was read from, or fails. Never to the other one -- see {@link ZoteroAnnotation.version}. */
	patchAnnotation(annotation: ZoteroAnnotationRef, fields: AnnotationFields): Promise<PatchOutcome>;
}

// --- The wire, written once ------------------------------------------------------------------

export interface ZoteroRequest {
	readonly method?: "GET" | "POST" | "PATCH";
	/** Library-relative: `/items?itemType=attachment`. The connection puts its own prefix in front. */
	readonly path: string;
	readonly body?: unknown;
	readonly headers?: Record<string, string>;
}

/**
 * The whole of what a connection has to do: make one request and hand back what came back.
 *
 * Authentication, a rejected key, a server asking us to wait -- all of that is the connection's,
 * because it is the only part the two do differently. What it must *not* do is interpret a status
 * code into a plugin word; {@link failureFor} does that once, for both.
 */
export type ZoteroRequester = (request: ZoteroRequest) => Promise<Response>;

/** How the PDF is reached, which is the second thing the two connections genuinely disagree on. */
export interface ZoteroFiles {
	path(key: string): Promise<string | null>;
	bytes(key: string): Promise<Uint8Array | null>;
}

/**
 * Stops waiting after `ms` and rejects. The request itself is abandoned rather than cancelled:
 * `fetch` here is esbuild-rewritten to Obsidian's `requestUrl`, which has no abort of its own.
 *
 * Here rather than in one of the two connections because both need it and neither owns it -- the
 * desktop's authorize call blocks on a modal and needs a far longer one than any web request.
 */
export async function withZoteroTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: number | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				// `window`, not the bare global, so the timer fires in a popout window too.
				timer = window.setTimeout(() => reject(new ZoteroError("unreachable", `${what} did not answer within ${ms} ms.`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) window.clearTimeout(timer);
	}
}

/** Zotero's page size, and ours. The local API has no pagination and simply answers everything. */
const PAGE_SIZE = 100;

/**
 * A ceiling on paging, so a server that keeps answering full pages ends as an error rather than as
 * a sync that never finishes. 100 pages is 10 000 PDF attachments -- past any personal library this
 * feature was designed for, and the ceiling says so in words when it is hit.
 */
const MAX_PAGES = 100;

/** Zotero refuses a write body of more than 50 objects, so batching is a wire rule and lives here. */
const MAX_BATCH = 50;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
	return typeof value === "object" && value !== null ? (value as Json) : {};
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The plugin's word for an HTTP status.
 *
 * 403 is read as "not enabled" only when Zotero says so in the body: the same status is how the web
 * API refuses a read-only key, and telling a web user to switch on a desktop setting they do not
 * have would send them somewhere there is nothing to fix.
 */
async function failureFor(response: Response): Promise<ZoteroError> {
	const body = await response.text().catch(() => "");
	if (response.status === 401) return new ZoteroError("unauthorized", "Zotero rejected the API key.");
	if (response.status === 403) {
		return body.includes("Local API is not enabled")
			? new ZoteroError("not-enabled", 'Zotero is running with "Allow other applications" switched off.')
			: new ZoteroError("unauthorized", "This Zotero API key may not write to the library.");
	}
	if (response.status === 404) return new ZoteroError("not-found", "Zotero does not have that item any more.");
	if (response.status === 429 || response.status === 503) {
		return new ZoteroError("rate-limited", "Zotero asked us to wait before asking again.");
	}
	return new ZoteroError("server", `Zotero answered ${response.status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`);
}

async function readJson(response: Response): Promise<unknown> {
	if (!response.ok) throw await failureFor(response);
	try {
		return await response.json();
	} catch {
		throw new ZoteroError("server", "Zotero answered something that is not JSON.");
	}
}

/** Every row of a list endpoint, following `start=` until a page comes back short. */
async function listAll(request: ZoteroRequester, path: string): Promise<Json[]> {
	const rows: Json[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const separator = path.includes("?") ? "&" : "?";
		const body = await readJson(await request({ path: `${path}${separator}limit=${PAGE_SIZE}&start=${page * PAGE_SIZE}` }));
		if (!Array.isArray(body)) throw new ZoteroError("server", "Zotero answered a list request with something else.");
		rows.push(...body.map(asRecord));
		if (body.length < PAGE_SIZE) return rows;
	}
	throw new ZoteroError("server", `Zotero kept answering full pages past ${MAX_PAGES * PAGE_SIZE} items.`);
}

/**
 * Is this row a PDF attachment we may use?
 *
 * Two exclusions, both from the spec rather than from convenience: EPUB and everything else is not
 * this feature (§1.3), and a trashed attachment is *gone* -- Zotero keeps answering for it, and a
 * note that silently kept writing into the trash would be worse than one that says the item is no
 * longer there (§2.3).
 */
function isUsablePdf(data: Json): boolean {
	return data.contentType === "application/pdf" && !data.deleted;
}

function toAttachment(data: Json): ZoteroAttachment {
	// A linked file has `path` instead of `filename`, and the path may carry a `attachments:` prefix
	// or be absolute. Only the last segment is ever compared against a tablet document name (§2.3).
	const path = asString(data.path);
	return {
		key: asString(data.key) ?? "",
		parentKey: asString(data.parentItem),
		filename: asString(data.filename) ?? (path === null ? null : (path.split("/").pop() ?? null)),
		md5: asString(data.md5),
		title: typeof data.title === "string" ? data.title : "",
	};
}

/**
 * The citation key, from either place Zotero keeps one.
 *
 * `citationKey` is the native field; Better BibTeX -- which is where most citekeys in the wild come
 * from -- writes `Citation Key: smith2024` into Extra instead. Reading both is what makes "only when
 * set" true for the libraries this feature is for. Neither is ever written back.
 */
function citationKeyOf(data: Json): string | null {
	const native = asString(data.citationKey);
	if (native !== null) return native;
	const extra = asString(data.extra);
	return extra === null ? null : (/^Citation Key:\s*(\S+)$/m.exec(extra)?.[1] ?? null);
}

function toItem(data: Json): ZoteroItem {
	const creators = Array.isArray(data.creators) ? data.creators.map(asRecord) : [];
	const first = creators[0];
	// A creator is either a two-field person or a single-field institution; both print as one name.
	const creator = first === undefined ? null : (asString(first.lastName) ?? asString(first.name));
	return {
		key: asString(data.key) ?? "",
		title: typeof data.title === "string" ? data.title : "",
		creator,
		// Zotero's `date` is free text ("2024-06", "June 2024", "in press"), so the year is taken as
		// the first four-digit run and nothing is inferred where there is none.
		year: /\b(\d{4})\b/.exec(asString(data.date) ?? "")?.[1] ?? null,
		citationKey: citationKeyOf(data),
	};
}

function toAnnotation(data: Json, source: "local" | "web"): ZoteroAnnotation | null {
	const type = data.annotationType;
	if (type !== "highlight" && type !== "underline" && type !== "note") return null;
	const parentKey = asString(data.parentItem);
	if (parentKey === null) return null;
	const position = typeof data.annotationPosition === "string" ? data.annotationPosition : "";
	return {
		key: asString(data.key) ?? "",
		source,
		parentKey,
		type,
		pageIndex: pageIndexOf(position),
		text: typeof data.annotationText === "string" ? data.annotationText : "",
		comment: typeof data.annotationComment === "string" ? data.annotationComment : "",
		color: typeof data.annotationColor === "string" ? data.annotationColor : "",
		pageLabel: typeof data.annotationPageLabel === "string" ? data.annotationPageLabel : "",
		sortIndex: typeof data.annotationSortIndex === "string" ? data.annotationSortIndex : "",
		position,
		version: typeof data.version === "number" ? data.version : 0,
	};
}

/**
 * The page out of a position string.
 *
 * Read rather than trusted: re-adoption (§3.3) matches on it, and an annotation whose position we
 * cannot read must fail to match rather than match everything on page 0.
 */
function pageIndexOf(position: string): number | null {
	try {
		const parsed = asRecord(JSON.parse(position));
		return typeof parsed.pageIndex === "number" ? parsed.pageIndex : null;
	} catch {
		return null;
	}
}

/**
 * The write body, in the one order Zotero's data layer accepts.
 *
 * ⚠️ `annotationType` must be the **first** `annotation*` key: `fromJSON` loops over the keys as
 * they come and every other setter throws `annotationType must be set before other annotation
 * properties`. JSON.stringify keeps insertion order for string keys, so the order written here is
 * the order that goes on the wire -- which is why this is built key by key rather than spread from
 * the caller's object.
 */
function annotationBody(item: NewAnnotation): Json {
	const body: Json = { itemType: "annotation", annotationType: item.type, parentItem: item.parentKey };
	// Zotero refuses `annotationText` on a sticky note, so a caller that sets it anyway is corrected
	// here rather than failing the whole batch it happened to share.
	if (item.type !== "note" && item.text !== undefined) body.annotationText = item.text;
	if (item.comment !== undefined) body.annotationComment = item.comment;
	body.annotationColor = item.color ?? DEFAULT_ANNOTATION_COLOR;
	body.annotationPageLabel = item.pageLabel ?? "";
	if (item.sortIndex !== undefined) body.annotationSortIndex = item.sortIndex;
	if (item.position !== undefined) body.annotationPosition = item.position;
	body.tags = [{ tag: OWNERSHIP_TAG }];
	return body;
}

function patchBody(fields: AnnotationFields): Json {
	const body: Json = {};
	if (fields.text !== undefined) body.annotationText = fields.text;
	if (fields.comment !== undefined) body.annotationComment = fields.comment;
	if (fields.color !== undefined) body.annotationColor = fields.color;
	if (fields.pageLabel !== undefined) body.annotationPageLabel = fields.pageLabel;
	if (fields.sortIndex !== undefined) body.annotationSortIndex = fields.sortIndex;
	if (fields.position !== undefined) body.annotationPosition = fields.position;
	return body;
}

/** A `Zotero-Write-Token`: 5–32 chars, unused for 12 h, so that a retried batch is not written twice. */
function writeToken(): string {
	return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("").slice(0, 32);
}

/**
 * One connection, built out of the two things that differ. Everything below this line is shared by
 * the web and the desktop, and is written once.
 */
export function createZoteroConnection(
	id: "local" | "web",
	label: string,
	request: ZoteroRequester,
	files: ZoteroFiles,
	libraryIdOf: () => Promise<number | null>,
): ZoteroConnection {
	const itemData = async (key: string): Promise<Json | null> => {
		try {
			return asRecord(asRecord(await readJson(await request({ path: `/items/${key}` }))).data);
		} catch (error) {
			// "Gone" is an answer, not a failure: §2.3 keeps the note and drops the Zotero part. Every
			// other reason -- offline, a rejected key -- stays a throw, because it is repairable and the
			// user has to be told which one it was.
			if (error instanceof ZoteroError && error.reason === "not-found") return null;
			throw error;
		}
	};

	return {
		id,
		label,
		async probe() {
			try {
				await request({ path: "/items/top?limit=1" });
				return true;
			} catch {
				return false;
			}
		},
		libraryId: libraryIdOf,
		async attachments() {
			const rows = await listAll(request, "/items?itemType=attachment");
			return rows.map((row) => asRecord(row.data)).filter(isUsablePdf).map(toAttachment);
		},
		async attachment(key) {
			const data = await itemData(key);
			return data === null || !isUsablePdf(data) ? null : toAttachment(data);
		},
		async parentItem(key) {
			const data = await itemData(key);
			return data === null ? null : toItem(data);
		},
		async search(query) {
			// `/items/top`, so the picker lists papers rather than their own PDFs; `titleCreatorYear` is
			// the quick-search mode a user's fingers already know from Zotero itself (spec §2.4).
			const rows = await listAll(request, `/items/top?q=${encodeURIComponent(query)}&qmode=titleCreatorYear`);
			return rows.map((row) => toItem(asRecord(row.data)));
		},
		filePath: (key) => files.path(key),
		fileBytes: (key) => files.bytes(key),
		async ownAnnotations(parentKey) {
			// Filtered by the ownership tag on the server and by the parent here, because Zotero has no
			// server-side filter for "annotations of this attachment" -- `/children` answers none at all
			// ([research/10] §6), which is the trap this row exists to stay out of.
			const rows = await listAll(request, `/items?itemType=annotation&tag=${encodeURIComponent(OWNERSHIP_TAG)}`);
			return rows
				.map((row) => toAnnotation(asRecord(row.data), id))
				.filter((annotation): annotation is ZoteroAnnotation => annotation !== null && annotation.parentKey === parentKey);
		},
		async createAnnotations(items) {
			const keys: (string | null)[] = [];
			const failures: string[] = [];
			// Chunked here rather than by the caller: "at most 50 per request" is a fact about Zotero's
			// write endpoint, and the caller that knows it is the caller that would forget it.
			for (let offset = 0; offset < items.length; offset += MAX_BATCH) {
				const batch = items.slice(offset, offset + MAX_BATCH);
				const body = await readJson(
					await request({
						method: "POST",
						path: "/items",
						body: batch.map(annotationBody),
						headers: { "Zotero-Write-Token": writeToken() },
					}),
				);
				const success = asRecord(asRecord(body).success);
				const failed = asRecord(asRecord(body).failed);
				batch.forEach((_item, index) => {
					const key = asString(success[String(index)]);
					keys.push(key);
					if (key === null) {
						const reason = asString(asRecord(failed[String(index)]).message) ?? "Zotero refused it without saying why";
						failures.push(reason);
					}
				});
			}
			return { keys, failures };
		},
		async patchAnnotation(key, version, fields) {
			const response = await request({
				method: "PATCH",
				path: `/items/${key}`,
				body: patchBody(fields),
				// The precondition is the whole point of patching rather than putting: an annotation the
				// user edited in Zotero since we read it comes back 412, and 412 means "leave it alone"
				// (§3.3), not "try harder".
				headers: { "If-Unmodified-Since-Version": String(version) },
			});
			if (response.status === 412) return "conflict";
			if (!response.ok) throw await failureFor(response);
			return "written";
		},
	};
}

/**
 * The two connections as one.
 *
 * **Local first, web as a per-call fallback** (spec §2.1), and the fallback is per *call* on
 * purpose: a desktop app that is closed when the sync starts and open ten minutes later should not
 * leave the run talking to zotero.org for the rest of its life, and the reverse -- a laptop that
 * loses the network mid-run -- is the same story from the other side.
 *
 * A fallback happens when the local connection could not be *reached or used* -- unreachable, the
 * setting switched off, a denied or rejected key. It never happens on an answer: an item the desktop
 * says is gone is gone, and asking the web the same question would only find the copy that has not
 * synced yet.
 */
export function createZoteroClient(connections: { local?: ZoteroConnection; web?: ZoteroConnection }): ZoteroClient | null {
	const { local, web } = connections;
	if (local === undefined && web === undefined) return null;
	const order = [local, web].filter((connection): connection is ZoteroConnection => connection !== undefined);

	async function call<T>(work: (connection: ZoteroConnection) => Promise<T>): Promise<T> {
		let last: unknown;
		for (const connection of order) {
			try {
				return await work(connection);
			} catch (error) {
				// Only "we could not use this connection" falls through. A 404, a refused write body, a
				// malformed answer -- those are answers, and the second connection would answer the same.
				if (!(error instanceof ZoteroError) || !CAN_FALL_BACK.includes(error.reason)) throw error;
				last = error;
			}
		}
		throw last;
	}

	return {
		async status() {
			const [localUp, webUp] = await Promise.all([local?.probe() ?? Promise.resolve(false), web?.probe() ?? Promise.resolve(false)]);
			return { local: localUp, web: webUp, summary: statusSummary(localUp, webUp) };
		},
		libraryId: () => call((connection) => connection.libraryId()),
		attachments: () => call((connection) => connection.attachments()),
		attachment: (key) => call((connection) => connection.attachment(key)),
		parentItem: (key) => call((connection) => connection.parentItem(key)),
		search: (query) => call((connection) => connection.search(query)),
		filePath: (key) => call((connection) => connection.filePath(key)),
		fileBytes: (key) => call((connection) => connection.fileBytes(key)),
		ownAnnotations: (parentKey) => call((connection) => connection.ownAnnotations(parentKey)),
		// ⚠️ Not falling back mid-batch: if the desktop accepted twelve of fifty and then went away, the
		// web must not be handed the same fifty. `call` re-runs the *whole* work function, so a create
		// that got as far as an answer keeps its answer, and only one that never reached Zotero at all
		// is tried again elsewhere.
		createAnnotations: (items) => call((connection) => connection.createAnnotations(items)),
		/**
		 * Routed by the annotation's own source, and not routed anywhere else.
		 *
		 * This is the one call the fallback may not touch: the precondition it sends is a version only
		 * the connection that issued it can compare. When that connection is the one that is down, the
		 * patch is skipped and reported -- the next sync patches it, because write-back is add-and-
		 * refresh and nothing was lost (§3.3).
		 */
		async patchAnnotation(annotation, fields) {
			const connection = order.find((candidate) => candidate.id === annotation.source);
			if (connection === undefined) {
				throw new ZoteroError("unreachable", `That annotation was read from ${annotation.source === "local" ? "the Zotero desktop app" : "zotero.org"}, which is not connected now.`);
			}
			return await connection.patchAnnotation(annotation.key, annotation.version, fields);
		},
	};
}

/** The failures that mean "this connection could not answer", as opposed to "this is the answer". */
const CAN_FALL_BACK: ZoteroFailure[] = ["unreachable", "not-enabled", "denied", "unauthorized", "rate-limited"];

/** The settings line's four states, in the spec's words (§2.1). */
function statusSummary(local: boolean, web: boolean): string {
	if (local && web) return "Connected via desktop and web.";
	if (local) return "Connected via desktop.";
	if (web) return "Connected via web.";
	return "Not connected.";
}
