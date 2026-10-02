/**
 * "Change Profile for this page" (Pro, spec §5.1). The user's choice is frozen on the page. A note
 * untouched since the engine wrote it is made again with the new Profile, where it is; a note the user
 * edited stays as it is -- no longer updated, an ordinary file -- and a new note is made beside it.
 * There is no merge across Profiles: their Slots differ, and so would what "the same item" means.
 */

import { resolveFreePath } from "../note-builder";
import type { SyncIndex } from "../sync-engine";
import { type HostEnvironment, prepareRun, reviewStoresFor, REVIEW_LINK, type RunInputs } from "./host";
import { processPage } from "./page-engine";
import type { RerunOutcome } from "./rerun";
import { uneditedSinceBase } from "./review";
import { baseHash, slotsOf, templateFor } from "./sync-pass";

// An empty block (`---` right under `---`) is tried first, or it would run on to the body's next `---`.
const FRONTMATTER = /^---\r?\n(?:[\s\S]*?\r?\n)??---(?:\r?\n|$)/;

export async function changeProfile(env: HostEnvironment, run: RunInputs, index: SyncIndex, notePath: string, profileId: string, renderPath: string): Promise<RerunOutcome> {
	const row = Object.values(index.intelligenceRows ?? {}).find((candidate) => candidate.notePath === notePath && candidate.status === "active");
	if (row === undefined) return { message: "This note is not a page note from the Intelligence Engine." };
	const prepared = await prepareRun(env, { ...run, background: false });
	try {
		if (prepared.deps === undefined) return { message: prepared.paused ?? "Page extraction runs on another device. Switch it to this one under Intelligence in the settings." };
		const deps = prepared.deps;
		const profile = deps.settings.profiles.find((candidate) => candidate.id === profileId);
		if (profile === undefined) return { message: "That profile no longer exists." };

		const stores = reviewStoresFor(env, {});
		const base = await stores.baseStore.load(row.noteId);
		const note = await env.noteStore.read(notePath);
		if (base?.transcript == null || note === null) {
			// Nothing to extract from here: the choice is frozen, and the next sync that reads the page uses it.
			return {
				message: `"${profile.name}" is set for this page; its note follows on the next sync that reads the page. Run "Re-transcribe this note" to have it read.`,
				index: { ...index, intelligenceRows: { ...index.intelligenceRows, [row.syncKey]: { ...row, profileId } } },
			};
		}

		const slots = slotsOf(deps, profile);
		const noteId = deps.newNoteId();
		const seen = index.seenPages?.[row.syncKey];
		const pageHash = seen?.pageHash ?? null;
		const firstSeen = seen?.firstSeen ?? null;
		const title = notePath.slice(notePath.lastIndexOf("/") + 1).replace(/\.md$/, "");
		const outcome = await processPage({
			unit: { key: row.syncKey, pageHash, transcript: base.transcript, firstSeen },
			noteId,
			base: null,
			note: null,
			profile,
			slots,
			template: await templateFor(deps, profile, slots),
			backend: deps.backend,
			syncedAt: deps.now(),
			title: () => title,
			pageLink: `[[${renderPath}|${title}]]`,
			pageEmbed: `![[${renderPath}]]`,
			reviewLink: REVIEW_LINK,
			formatDate: deps.formatDate,
			formatTime: deps.formatTime,
			newId: deps.newId,
		});
		if (outcome.kind === "failed") return { message: `Extraction failed: ${outcome.reason}` };

		// The plugin's frontmatter keys come back with the next write of the page; until then the old
		// note's block is carried over whole, so `FROM #remarkable` keeps finding the page.
		const oldBlock = FRONTMATTER.exec(note)?.[0];
		const content = oldBlock !== undefined && !FRONTMATTER.test(outcome.content!) ? `${oldBlock}${outcome.content!}` : outcome.content!;

		const unedited = uneditedSinceBase(base, note.split("\n"));
		let path = notePath;
		if (unedited) {
			await env.noteStore.write(notePath, content);
			await stores.baseStore.discard(row.noteId);
		} else {
			const folder = notePath.slice(0, Math.max(notePath.lastIndexOf("/"), 0));
			path = await resolveFreePath(env.noteStore, folder, title, row.tag, row.docId);
			await env.createNote(path, content);
		}
		await stores.baseStore.save(outcome.base);
		const nextRow = { ...row, notePath: path, noteId, profileId, baseHash: baseHash(outcome.base), syncedAt: deps.now().toISOString(), frontmatterTags: undefined, frontmatterVersion: undefined };
		return {
			message: unedited ? `The note is made again with "${profile.name}".` : `The note has your edits, so it stays as it is; "${profile.name}" makes a new note beside it: ${path}.`,
			index: {
				...index,
				seenPages: { ...index.seenPages, [row.syncKey]: { scope: row.scope, pageHash, firstSeen, noteId } },
				intelligenceRows: { ...index.intelligenceRows, [row.syncKey]: nextRow },
			},
		};
	} finally {
		// A local model started for this command stops with it.
		prepared.dispose();
	}
}
