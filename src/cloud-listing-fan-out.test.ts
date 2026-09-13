import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_REQUESTS_IN_FLIGHT, obsidianFetch } from "./obsidian-fetch";
import { openSession } from "./remarkable-session";

// Issue #160, the reporter's case end to end: the real rmapi-js listing a large account through the
// shim. Why the shim carries the bound is told once, at `MAX_REQUESTS_IN_FLIGHT`.
//
// The cloud below is a fake with one property of the real thing: a finite number of requests can be
// open at the same time. The bound is far lower than Electron's, because the number is not the point;
// that there *is* one is.

const CONCURRENT_REQUESTS_THE_RUNTIME_ALLOWS = 64;
const DOCUMENTS_IN_THE_ACCOUNT = 300;

const cloud = vi.hoisted(() => ({
	/** `GET /sync/v3/files/<hash>` answers with the text stored under that hash. */
	files: new Map<string, string>(),
	rootHash: "",
	inFlight: 0,
	peakInFlight: 0,
}));

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		requestUrl: async (options: { url: string }) => {
			cloud.inFlight++;
			cloud.peakInFlight = Math.max(cloud.peakInFlight, cloud.inFlight);
			try {
				if (cloud.inFlight > CONCURRENT_REQUESTS_THE_RUNTIME_ALLOWS) throw new Error("net::ERR_INSUFFICIENT_RESOURCES");
				// A round trip takes time; without it the answers would arrive before the next request left.
				await new Promise((resolve) => setTimeout(resolve, 1));
				const text = options.url.endsWith("/sync/v4/root")
					? JSON.stringify({ hash: cloud.rootHash, generation: 1, schemaVersion: 3 })
					: cloud.files.get(options.url.slice(options.url.lastIndexOf("/") + 1));
				if (text === undefined) return { status: 404, headers: {}, arrayBuffer: new ArrayBuffer(0) };
				return { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode(text).buffer };
			} finally {
				cloud.inFlight--;
			}
		},
	};
});

/** A 64-hex "hash" the raw API's validation accepts; the content behind it is whatever the test stores. */
const hashOf = (name: string) => Buffer.from(name).toString("hex").padEnd(64, "0");

function fillAccount(documents: number): void {
	cloud.files.clear();
	const rootLines: string[] = [];
	for (let i = 0; i < documents; i++) {
		const id = `doc${i}`;
		const metadata = JSON.stringify({ visibleName: `Notebook ${i}`, lastModified: "0", parent: "", pinned: false, type: "DocumentType" });
		const content = JSON.stringify({
			coverPageNumber: 0,
			documentMetadata: {},
			extraMetadata: {},
			fileType: "notebook",
			fontName: "",
			lineHeight: -1,
			orientation: "portrait",
			pageCount: 1,
			textAlignment: "",
			textScale: 1,
			tags: [],
		});
		cloud.files.set(hashOf(`${id}meta`), metadata);
		cloud.files.set(hashOf(`${id}content`), content);
		// A document's file list: schema version 3, one line per file, `hash:type:name:subfiles:size`.
		cloud.files.set(hashOf(id), `3\n${hashOf(`${id}meta`)}:0:${id}.metadata:0:${metadata.length}\n${hashOf(`${id}content`)}:0:${id}.content:0:${content.length}\n`);
		rootLines.push(`${hashOf(id)}:80000000:${id}:2:0`);
	}
	cloud.rootHash = hashOf("root");
	cloud.files.set(cloud.rootHash, `3\n${rootLines.join("\n")}\n`);
}

beforeEach(() => {
	cloud.inFlight = 0;
	cloud.peakInFlight = 0;
	// esbuild rewrites rmapi-js's free `fetch` to the shim at build time (see fetch-shim.ts); the test
	// runner does not bundle, so the same routing is done here by hand.
	vi.stubGlobal("fetch", obsidianFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("listing a large account", () => {
	it("survives a runtime that allows only so many requests at once", async () => {
		fillAccount(DOCUMENTS_IN_THE_ACCOUNT);
		const api = openSession("session-token");

		await expect(api.listItems()).resolves.toHaveLength(DOCUMENTS_IN_THE_ACCOUNT);
		// Exactly the shim's bound, not merely under the runtime's: with 300 file lists queued at once
		// the shim is full from the first moment, so a bound that drifted upward would show here.
		expect(cloud.peakInFlight).toBe(MAX_REQUESTS_IN_FLIGHT);
	});
});
