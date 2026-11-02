// Which book a document becomes in Readwise: its title and, where anyone is named, its author
// (Readwise spec §1.2, §11 P7). Pure. Both are frozen per document the first time it is recorded
// (spec §3, P21), so this is asked once per document.

import type { EpubBook } from "./epub-text";
import type { ZoteroCreator, ZoteroItem } from "./zotero-client";

/** A Readwise book's key. `author` absent = omitted from the push, never blank (ticket 14 #4). */
export interface BookIdentity {
	readonly title: string;
	readonly author?: string;
}

export interface BookSources {
	/** The paper the Zotero pass linked this document to, when it did. */
	readonly zotero?: Pick<ZoteroItem, "title" | "creators">;
	/** The `.epub`'s OPF, for an EPUB whose book could be read. */
	readonly epub?: Pick<EpubBook, "title" | "authors">;
	/** The document's name on the tablet: the title nothing else supplies. */
	readonly visibleName: string;
}

/** Zotero's creators as one line: its authors, or every creator when it names no author. */
function zoteroAuthor(creators: readonly ZoteroCreator[]): string {
	const named = creators
		.map((creator) => ({ type: creator.creatorType, name: ("name" in creator ? creator.name : `${creator.firstName} ${creator.lastName}`).trim() }))
		.filter((creator) => creator.name.length > 0);
	const authors = named.filter((creator) => creator.type === "author");
	return (authors.length > 0 ? authors : named).map((creator) => creator.name).join(", ");
}

/** Title: Zotero item → EPUB `dc:title` → tablet name. Author: Zotero creators → EPUB `dc:creator`s → none. */
export function bookIdentity({ zotero, epub, visibleName }: BookSources): BookIdentity {
	const title = [zotero?.title, epub?.title].map((value) => value?.trim()).find((value) => value) ?? visibleName;
	const author = [zotero ? zoteroAuthor(zotero.creators) : "", (epub?.authors ?? []).join(", ")].find((value) => value.length > 0);
	return { title, ...(author === undefined ? {} : { author }) };
}
