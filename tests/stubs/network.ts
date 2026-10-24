import { vi } from "vitest";
import type { Fetch } from "../../src/obsidian-fetch";

/**
 * Every request the plugin makes goes through `obsidianFetch`, imported by name, so that is what a
 * test answers in place of zotero.org, the desktop app or the licence server. Unset, it stays real --
 * and the real one reaches the stub `requestUrl`, which throws, so a request nobody expected cannot
 * pass quietly.
 *
 * `vi.mock` is hoisted above the imports, so its factory cannot close over this module; it loads it
 * instead, which is why the line every test file keeps is
 *
 *     vi.mock("./obsidian-fetch", async () => (await import("../tests/stubs/network")).obsidianFetchModule());
 */
let answer: Fetch | null = null;

/** Answers every request from now on with `impl`, until `resetNetwork`. */
export function stubNetwork(impl: Fetch): void {
	answer = impl;
}

export function resetNetwork(): void {
	answer = null;
}

/** The real `obsidian-fetch` module, with `obsidianFetch` answered by `stubNetwork` while one is set. */
export async function obsidianFetchModule(): Promise<typeof import("../../src/obsidian-fetch")> {
	const actual = await vi.importActual<typeof import("../../src/obsidian-fetch")>("../../src/obsidian-fetch");
	return {
		...actual,
		obsidianFetch: (input, init) => (answer ?? actual.obsidianFetch)(input, init),
	};
}
