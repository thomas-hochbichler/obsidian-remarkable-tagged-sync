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

/**
 * Which library an item lives in: the personal one, or a group by Zotero's numeric id (ticket 26).
 *
 * On every attachment, item and annotation the client hands out, and on every request a connection
 * makes, because a key is only unique *within* a library -- `ATT1` in the personal library and
 * `ATT1` in a group are two files. The link in `data.json` stores it in this shape, so a link says
 * which library it is into, and a build that predates groups reads a group link as "not ours to
 * act on" rather than as a personal-library key it would then write into.
 */
export type ZoteroLibrary = "user" | { readonly group: number };

/** A group library a connection can see: Zotero's id, and the name people in it call it. */
export interface ZoteroGroup {
	readonly id: number;
	readonly name: string;
}

export function sameLibrary(a: ZoteroLibrary, b: ZoteroLibrary): boolean {
	return a === "user" ? b === "user" : b !== "user" && a.group === b.group;
}

/** The segment a library's items hang under, the same on both APIs: `/users/<id>` or `/groups/<id>`. */
export function libraryPath(library: ZoteroLibrary, userSegment: string): string {
	return library === "user" ? userSegment : `/groups/${library.group}`;
}

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
	readonly library: ZoteroLibrary;
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
	readonly library: ZoteroLibrary;
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
	readonly library: ZoteroLibrary;
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

/** What a patch needs to know about the annotation it is changing -- including which connection may take it, and which library it is in. */
export type ZoteroAnnotationRef = Pick<ZoteroAnnotation, "key" | "version" | "source" | "library">;

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
	/**
	 * The library takes no writes from this user or key -- a group they may only read (ticket 26).
	 * An answer about the library, not about the connection: the other one would refuse the same
	 * way, so it is never fallen back on, and the write is never re-routed into another library.
	 */
	| "read-only"
	/** Anything the server said that we have no better word for. */
	| "server";

export class ZoteroError extends Error {
	constructor(
		readonly reason: ZoteroFailure,
		message: string,
		/** Which connection said no. Set for `read-only`, where the fix differs: a key on zotero.org, a membership in the desktop app. */
		readonly connection?: "local" | "web",
	) {
		super(message);
		this.name = "ZoteroError";
	}
}

/** Whose library a connection opens: the id every web-library URL needs, the username only zotero.org has. */
export interface ZoteroAccount {
	readonly id: number;
	readonly username: string | null;
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
	/** The account's zotero.org username, which its web reader URLs hang under. Only zotero.org knows it. */
	username(): Promise<string | null>;
	/** The group libraries this connection can see (ticket 26). Membership only: whether it may *write* into one is answered by the write. */
	groups(): Promise<ZoteroGroup[]>;
	/** Every PDF attachment in one library. The matcher's whole input (§2.3), library by library. */
	attachments(library: ZoteroLibrary): Promise<ZoteroAttachment[]>;
	/** One attachment, or `null` when it is trashed or gone -- the "no longer found" row of §2.3. */
	attachment(key: string, library: ZoteroLibrary): Promise<ZoteroAttachment | null>;
	parentItem(key: string, library: ZoteroLibrary): Promise<ZoteroItem | null>;
	/** Top-level items for the send picker: `q=`, `qmode=titleCreatorYear` (spec §2.4). */
	search(query: string, library: ZoteroLibrary): Promise<ZoteroItem[]>;
	/** Top-level items carrying one tag, for the tag-driven send (spec §2.6). A tag on a PDF's own row is not seen -- on purpose. */
	itemsWithTag(tag: string, library: ZoteroLibrary): Promise<ZoteroItem[]>;
	/** Where the PDF sits on this machine, or `null` when this connection cannot know. */
	filePath(key: string, library: ZoteroLibrary): Promise<string | null>;
	/** The PDF itself, or `null` when Zotero has no copy to hand out. */
	fileBytes(key: string, library: ZoteroLibrary): Promise<Uint8Array | null>;
	/** Our own annotations on one attachment, read by the ownership tag -- never through `/children`, which returns none. */
	ownAnnotations(parentKey: string, library: ZoteroLibrary): Promise<ZoteroAnnotation[]>;
	/** All into one library: a batch is one attachment's annotations, and an attachment is in one library. */
	createAnnotations(items: NewAnnotation[], library: ZoteroLibrary): Promise<AnnotationsCreated>;
	patchAnnotation(key: string, version: number, fields: AnnotationFields, library: ZoteroLibrary): Promise<PatchOutcome>;
	/** Into Zotero's trash, never erased: `DELETE` on the local API is a permanent erase, and the trash is what makes this reversible (§3.3). */
	trashAnnotation(key: string, version: number, library: ZoteroLibrary): Promise<PatchOutcome>;
}

/**
 * Everything a caller may do. One connection's shape, minus the parts that are about *being* a
 * connection, with the listings widened over every enabled library -- and with the one call that
 * cannot be routed freely spelled out differently.
 */
export interface ZoteroClient extends Omit<ZoteroConnection, "id" | "label" | "probe" | "attachments" | "search" | "itemsWithTag" | "patchAnnotation" | "trashAnnotation"> {
	/**
	 * Which connections answered, for the settings line. **Never rejects** -- it is built out of
	 * {@link ZoteroConnection.probe}, and "nothing answered" is one of its answers rather than a
	 * failure. The settings tab relies on that: it has no second arm to fall back to.
	 */
	status(): Promise<ZoteroStatus>;
	/**
	 * The libraries this client reads and writes: the personal one, then the groups this vault
	 * switched on, in the setting's order (ticket 26). A dialog that lists items from more than one
	 * of them names the library beside each; with one there is nothing to tell apart.
	 */
	readonly libraries: readonly ZoteroLibrary[];
	/** A library as a person reads it: "your library", or the group's name as the setting stored it. */
	libraryName(library: ZoteroLibrary): string;
	/** Every PDF attachment of every enabled library. The matcher's whole input (§2.3). */
	attachments(): Promise<ZoteroAttachment[]>;
	/** The send picker's search, over every enabled library. */
	search(query: string): Promise<ZoteroItem[]>;
	/** The tag-driven send's listing, over every enabled library. */
	itemsWithTag(tag: string): Promise<ZoteroItem[]>;
	/** Goes to the connection the annotation was read from, or fails. Never to the other one -- see {@link ZoteroAnnotation.version}. */
	patchAnnotation(annotation: ZoteroAnnotationRef, fields: AnnotationFields): Promise<PatchOutcome>;
	/** Same routing as {@link ZoteroClient.patchAnnotation}, for the same reason. */
	trashAnnotation(annotation: ZoteroAnnotationRef): Promise<PatchOutcome>;
}

// --- The wire, written once ------------------------------------------------------------------

export interface ZoteroRequest {
	readonly method?: "GET" | "POST" | "PATCH";
	/** Which library `path` is relative to. The connection turns it into `/users/<id>` or `/groups/<id>`. */
	readonly library: ZoteroLibrary;
	/** Library-relative: `/items?itemType=attachment`. The connection puts the library's prefix in front. */
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
	path(key: string, library: ZoteroLibrary): Promise<string | null>;
	bytes(key: string, library: ZoteroLibrary): Promise<Uint8Array | null>;
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
 * have would send them somewhere there is nothing to fix. On a *write*, 403 is the library's answer
 * -- the desktop app's `Write access denied` for a group the user may only read, zotero.org's for a
 * key that reads it -- and the other connection would say the same, so it is `read-only`, which
 * the client never falls back on (ticket 26).
 */
async function failureFor(response: Response, write: boolean, connection?: "local" | "web"): Promise<ZoteroError> {
	const body = await response.text().catch(() => "");
	if (response.status === 401) return new ZoteroError("unauthorized", "Zotero rejected the API key.");
	if (response.status === 403) {
		if (body.includes("Local API is not enabled")) return new ZoteroError("not-enabled", 'Zotero is running with "Allow other applications" switched off.');
		return write
			? new ZoteroError("read-only", "Zotero refused to write into that library.", connection)
			: new ZoteroError("unauthorized", "This Zotero API key may not read the library.");
	}
	if (response.status === 404) return new ZoteroError("not-found", "Zotero does not have that item any more.");
	if (response.status === 429 || response.status === 503) {
		return new ZoteroError("rate-limited", "Zotero asked us to wait before asking again.");
	}
	return new ZoteroError("server", `Zotero answered ${response.status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`);
}

async function readJson(response: Response, write = false, connection?: "local" | "web"): Promise<unknown> {
	if (!response.ok) throw await failureFor(response, write, connection);
	try {
		return await response.json();
	} catch {
		throw new ZoteroError("server", "Zotero answered something that is not JSON.");
	}
}

/** Every row of a list endpoint, following `start=` until a page comes back short. */
async function listAll(request: ZoteroRequester, library: ZoteroLibrary, path: string): Promise<Json[]> {
	const rows: Json[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const separator = path.includes("?") ? "&" : "?";
		const body = await readJson(await request({ library, path: `${path}${separator}limit=${PAGE_SIZE}&start=${page * PAGE_SIZE}` }));
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

function toAttachment(data: Json, library: ZoteroLibrary): ZoteroAttachment {
	// A linked file has `path` instead of `filename`, and the path may carry a `attachments:` prefix
	// or be absolute. Only the last segment is ever compared against a tablet document name (§2.3).
	const path = asString(data.path);
	return {
		key: asString(data.key) ?? "",
		library,
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

function toItem(data: Json, library: ZoteroLibrary): ZoteroItem {
	const creators = Array.isArray(data.creators) ? data.creators.map(asRecord) : [];
	const first = creators[0];
	// A creator is either a two-field person or a single-field institution; both print as one name.
	const creator = first === undefined ? null : (asString(first.lastName) ?? asString(first.name));
	return {
		key: asString(data.key) ?? "",
		library,
		title: typeof data.title === "string" ? data.title : "",
		creator,
		// Zotero's `date` is free text ("2024-06", "June 2024", "in press"), so the year is taken as
		// the first four-digit run and nothing is inferred where there is none.
		year: /\b(\d{4})\b/.exec(asString(data.date) ?? "")?.[1] ?? null,
		citationKey: citationKeyOf(data),
	};
}

/**
 * A group row, from either API: the web nests the name under `data`, and the id sits at the top of
 * the row and again inside. A row with no usable id or name is not a library anyone can switch on.
 */
function toGroup(row: Json): ZoteroGroup | null {
	const data = asRecord(row.data);
	const id = typeof row.id === "number" ? row.id : typeof data.id === "number" ? data.id : null;
	const name = asString(data.name);
	return id === null || name === null ? null : { id, name };
}

function toAnnotation(data: Json, source: "local" | "web", library: ZoteroLibrary): ZoteroAnnotation | null {
	const type = data.annotationType;
	if (type !== "highlight" && type !== "underline" && type !== "note") return null;
	const parentKey = asString(data.parentItem);
	if (parentKey === null) return null;
	const position = typeof data.annotationPosition === "string" ? data.annotationPosition : "";
	return {
		key: asString(data.key) ?? "",
		library,
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
	accountOf: () => Promise<ZoteroAccount | null>,
): ZoteroConnection {
	const itemData = async (key: string, library: ZoteroLibrary): Promise<Json | null> => {
		try {
			return asRecord(asRecord(await readJson(await request({ library, path: `/items/${key}` }))).data);
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
				await request({ library: "user", path: "/items/top?limit=1" });
				return true;
			} catch {
				return false;
			}
		},
		libraryId: async () => (await accountOf())?.id ?? null,
		username: async () => (await accountOf())?.username ?? null,
		async groups() {
			// Hangs under the *user* prefix on both APIs -- `/users/0/groups` locally, `/users/<id>/groups`
			// on the web -- and lists membership, not write access: the desktop app answers every group
			// its database holds, zotero.org every group the key may read.
			const rows = await listAll(request, "user", "/groups");
			return rows.map(toGroup).filter((group): group is ZoteroGroup => group !== null);
		},
		async attachments(library) {
			const rows = await listAll(request, library, "/items?itemType=attachment");
			return rows
				.map((row) => asRecord(row.data))
				.filter(isUsablePdf)
				.map((data) => toAttachment(data, library));
		},
		async attachment(key, library) {
			const data = await itemData(key, library);
			return data === null || !isUsablePdf(data) ? null : toAttachment(data, library);
		},
		async parentItem(key, library) {
			const data = await itemData(key, library);
			return data === null ? null : toItem(data, library);
		},
		async search(query, library) {
			// `/items/top`, so the picker lists papers rather than their own PDFs; `titleCreatorYear` is
			// the quick-search mode a user's fingers already know from Zotero itself (spec §2.4).
			const rows = await listAll(request, library, `/items/top?q=${encodeURIComponent(query)}&qmode=titleCreatorYear`);
			return rows.map((row) => toItem(asRecord(row.data), library));
		},
		async itemsWithTag(tag, library) {
			// `/items/top` again, and for the same reason: the paper is what gets tagged and what gets
			// sent. A tag on the attachment row is not found here, and §2.6 says so rather than
			// searching both -- one tag placed two ways would otherwise send the same paper twice.
			const rows = await listAll(request, library, `/items/top?tag=${encodeURIComponent(tag)}`);
			return rows.map((row) => toItem(asRecord(row.data), library));
		},
		filePath: (key, library) => files.path(key, library),
		fileBytes: (key, library) => files.bytes(key, library),
		async ownAnnotations(parentKey, library) {
			// Filtered by the ownership tag on the server and by the parent here, because Zotero has no
			// server-side filter for "annotations of this attachment" -- `/children` answers none at all
			// ([research/10] §6), which is the trap this row exists to stay out of.
			const rows = await listAll(request, library, `/items?itemType=annotation&tag=${encodeURIComponent(OWNERSHIP_TAG)}`);
			return rows
				.map((row) => toAnnotation(asRecord(row.data), id, library))
				.filter((annotation): annotation is ZoteroAnnotation => annotation !== null && annotation.parentKey === parentKey);
		},
		async createAnnotations(items, library) {
			const keys: (string | null)[] = [];
			const failures: string[] = [];
			// Chunked here rather than by the caller: "at most 50 per request" is a fact about Zotero's
			// write endpoint, and the caller that knows it is the caller that would forget it.
			for (let offset = 0; offset < items.length; offset += MAX_BATCH) {
				const batch = items.slice(offset, offset + MAX_BATCH);
				const body = await readJson(
					await request({
						method: "POST",
						library,
						path: "/items",
						body: batch.map(annotationBody),
						headers: { "Zotero-Write-Token": writeToken() },
					}),
					true,
					id,
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
		patchAnnotation: (key, version, fields, library) => patchUnderVersion(key, version, patchBody(fields), library),
		// `deleted: true` is how both APIs move an item to the trash; the same precondition guards it,
		// because an annotation the user touched since we read it is theirs to keep (§3.3).
		trashAnnotation: (key, version, library) => patchUnderVersion(key, version, { deleted: true }, library),
	};

	async function patchUnderVersion(key: string, version: number, body: Json, library: ZoteroLibrary): Promise<PatchOutcome> {
		const response = await request({
			method: "PATCH",
			library,
			path: `/items/${key}`,
			body,
			// The precondition is the whole point of patching rather than putting: an annotation the
			// user edited in Zotero since we read it comes back 412, and 412 means "leave it alone"
			// (§3.3), not "try harder".
			headers: { "If-Unmodified-Since-Version": String(version) },
		});
		if (response.status === 412) return "conflict";
		if (!response.ok) throw await failureFor(response, true, id);
		return "written";
	}
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
 *
 * **Libraries** (ticket 26): the personal one and the groups the vault switched on, listed one after
 * the other by every call that lists. A group is the one library a connection may honestly not
 * *have* -- the desktop app holds only the groups it syncs -- so for a group, "not found" on a
 * listing falls through to the other connection like an outage would, and a group no connection
 * holds lists as empty rather than failing every document of the run.
 */
export function createZoteroClient(connections: { local?: ZoteroConnection; web?: ZoteroConnection; groups?: readonly ZoteroGroup[] }): ZoteroClient | null {
	const { local, web } = connections;
	if (local === undefined && web === undefined) return null;
	const order = [local, web].filter((connection): connection is ZoteroConnection => connection !== undefined);
	const groups = connections.groups ?? [];
	const libraries: ZoteroLibrary[] = ["user", ...groups.map((group) => ({ group: group.id }))];

	async function call<T>(work: (connection: ZoteroConnection) => Promise<T>, fallsThrough: (error: ZoteroError) => boolean = canFallBack): Promise<T> {
		let last: unknown;
		for (const connection of order) {
			try {
				return await work(connection);
			} catch (error) {
				// Only "we could not use this connection" falls through. A 404, a refused write body, a
				// malformed answer -- those are answers, and the second connection would answer the same.
				if (!(error instanceof ZoteroError) || !fallsThrough(error)) throw error;
				last = error;
			}
		}
		throw last;
	}

	/** One listing over every enabled library, in order. See the header on a group a connection does not hold. */
	async function listEach<T>(work: (connection: ZoteroConnection, library: ZoteroLibrary) => Promise<T[]>): Promise<T[]> {
		const rows: T[] = [];
		for (const library of libraries) {
			try {
				rows.push(...(await call((connection) => work(connection, library), (error) => canFallBack(error) || (library !== "user" && error.reason === "not-found"))));
			} catch (error) {
				if (library === "user" || !(error instanceof ZoteroError) || error.reason !== "not-found") throw error;
			}
		}
		return rows;
	}

	return {
		libraries,
		libraryName(library) {
			if (library === "user") return "your library";
			// The name the setting stored when the group was switched on; a link into a group that has
			// since been unticked is named by its number, which is still something to look up.
			return groups.find((group) => group.id === library.group)?.name ?? `group ${library.group}`;
		},
		async status() {
			const [localUp, webUp] = await Promise.all([local?.probe() ?? Promise.resolve(false), web?.probe() ?? Promise.resolve(false)]);
			return { local: localUp, web: webUp, summary: statusSummary(localUp, webUp) };
		},
		libraryId: () => call((connection) => connection.libraryId()),
		// Not a `call`: the desktop app answers `null` rather than failing, and there is no falling through a `null`.
		username: async () => (await web?.username()) ?? null,
		groups: () => call((connection) => connection.groups()),
		attachments: () => listEach((connection, library) => connection.attachments(library)),
		attachment: (key, library) => call((connection) => connection.attachment(key, library)),
		parentItem: (key, library) => call((connection) => connection.parentItem(key, library)),
		search: (query) => listEach((connection, library) => connection.search(query, library)),
		itemsWithTag: (tag) => listEach((connection, library) => connection.itemsWithTag(tag, library)),
		filePath: (key, library) => call((connection) => connection.filePath(key, library)),
		fileBytes: (key, library) => call((connection) => connection.fileBytes(key, library)),
		ownAnnotations: (parentKey, library) => call((connection) => connection.ownAnnotations(parentKey, library)),
		// ⚠️ Not falling back mid-batch: if the desktop accepted twelve of fifty and then went away, the
		// web must not be handed the same fifty. `call` re-runs the *whole* work function, so a create
		// that got as far as an answer keeps its answer, and only one that never reached Zotero at all
		// is tried again elsewhere.
		createAnnotations: (items, library) => call((connection) => connection.createAnnotations(items, library)),
		/**
		 * Routed by the annotation's own source, and not routed anywhere else.
		 *
		 * This is the one call the fallback may not touch: the precondition it sends is a version only
		 * the connection that issued it can compare. When that connection is the one that is down, the
		 * patch is skipped and reported -- the next sync patches it, because write-back is add-and-
		 * refresh and nothing was lost (§3.3).
		 */
		patchAnnotation: async (annotation, fields) => await sourceOf(annotation).patchAnnotation(annotation.key, annotation.version, fields, annotation.library),
		trashAnnotation: async (annotation) => await sourceOf(annotation).trashAnnotation(annotation.key, annotation.version, annotation.library),
	};

	function sourceOf(annotation: ZoteroAnnotationRef): ZoteroConnection {
		const connection = order.find((candidate) => candidate.id === annotation.source);
		if (connection === undefined) {
			throw new ZoteroError("unreachable", `That annotation was read from ${annotation.source === "local" ? "the Zotero desktop app" : "zotero.org"}, which is not connected now.`);
		}
		return connection;
	}
}

/** The failures that mean "this connection could not answer", as opposed to "this is the answer". */
const CAN_FALL_BACK: ZoteroFailure[] = ["unreachable", "not-enabled", "denied", "unauthorized", "rate-limited"];
const canFallBack = (error: ZoteroError): boolean => CAN_FALL_BACK.includes(error.reason);

/**
 * The settings line's four states, in the spec's words (§2.1). With both up it also says which one
 * is asked (desk test 2026-09-13: a green line naming two connections says nothing about the order).
 */
function statusSummary(local: boolean, web: boolean): string {
	if (local && web) return "Connected via desktop and web. The desktop app is asked first; zotero.org answers when it is closed.";
	if (local) return "Connected via desktop.";
	if (web) return "Connected via web.";
	return "Not connected.";
}
