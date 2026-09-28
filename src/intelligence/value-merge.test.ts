import { describe, expect, it } from "vitest";
import type { Proposal } from "./merge";
import { mergeTagList, mergeValue } from "./value-merge";

const ids = () => {
	let n = 0;
	return () => `v${++n}`;
};

describe("mergeValue", () => {
	it("writes the first value directly, and nothing when the note already says it", () => {
		expect(mergeValue({ base: undefined, note: null, model: "gut", proposals: [], proposeFirst: false, newId: ids() })).toEqual({ base: "gut", write: "gut", proposals: [] });
		expect(mergeValue({ base: undefined, note: "gut", model: "gut", proposals: [], proposeFirst: false, newId: ids() }).write).toBeUndefined();
	});

	it("proposes a first topical pick of a local model instead of writing it, and writes nothing for no pick", () => {
		expect(mergeValue({ base: undefined, note: null, model: "Alpha", proposals: [], proposeFirst: true, newId: ids() })).toEqual({
			base: null,
			write: undefined,
			proposals: [{ kind: "replace", id: "v1", text: "Alpha", value: "Alpha" }],
		});
		expect(mergeValue({ base: undefined, note: null, model: null, proposals: [], proposeFirst: true, newId: ids() })).toEqual({ base: null, write: undefined, proposals: [] });
	});

	it("follows the page while the user has not touched the value, and clears a stale proposal", () => {
		const stale: Proposal = { kind: "replace", id: "p", text: "x" };
		expect(mergeValue({ base: "gut", note: "gut", model: "ok", proposals: [stale], proposeFirst: false, newId: ids() })).toEqual({ base: "ok", write: "ok", proposals: [] });
		expect(mergeValue({ base: "gut", note: "gut", model: "gut", proposals: [], proposeFirst: false, newId: ids() }).write).toBeUndefined();
		expect(mergeValue({ base: "gut", note: "gut", model: null, proposals: [], proposeFirst: false, newId: ids() })).toMatchObject({ base: null, write: null });
	});

	it("keeps a value the user edited and proposes a new one once; proposes nothing when the page says what it said", () => {
		const first = mergeValue({ base: "gut", note: "super", model: "ok", proposals: [], proposeFirst: false, newId: ids() });
		expect(first).toEqual({ base: "gut", write: undefined, proposals: [{ kind: "replace", id: "v1", text: "ok", value: "ok" }] });
		expect(mergeValue({ base: "gut", note: "super", model: "gut", proposals: first.proposals, proposeFirst: false, newId: ids() }).proposals).toEqual(first.proposals);
		expect(mergeValue({ base: ["a"], note: ["b"], model: ["a", "c"], proposals: [], proposeFirst: false, newId: ids() }).proposals[0]).toMatchObject({ text: "a, c", value: ["a", "c"] });
		expect(mergeValue({ base: "gut", note: "super", model: null, proposals: [], proposeFirst: false, newId: ids() }).proposals[0]).toMatchObject({ text: "", value: null });
	});
});

describe("mergeTagList", () => {
	it("adds the page's tags beside the user's and remembers which are the engine's", () => {
		expect(mergeTagList({ added: [], buried: [], note: ["remarkable/work", "mine"], model: ["budget", "mine"] })).toEqual({ write: ["remarkable/work", "mine", "budget"], added: ["budget"], buried: [] });
	});

	it("removes only its own tags when the page drops them, never the user's or the plugin's", () => {
		expect(mergeTagList({ added: ["budget", "hiring"], buried: [], note: ["remarkable/work", "budget", "hiring", "mine"], model: ["hiring"] })).toEqual({ write: ["remarkable/work", "hiring", "mine"], added: ["hiring"], buried: [] });
	});

	it("buries a tag of its own the user removed and never adds it again", () => {
		const first = mergeTagList({ added: ["budget"], buried: [], note: ["mine"], model: ["budget"] });
		expect(first).toEqual({ write: undefined, added: [], buried: ["budget"] });
		expect(mergeTagList({ added: first.added, buried: first.buried, note: ["mine"], model: ["budget", "q4"] })).toEqual({ write: ["mine", "q4"], added: ["q4"], buried: ["budget"] });
	});

	it("changes nothing when the page says what it said", () => {
		expect(mergeTagList({ added: ["budget"], buried: [], note: ["budget"], model: ["budget"] }).write).toBeUndefined();
	});
});
