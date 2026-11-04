import { describe, expect, it, vi } from "vitest";
import { CloudTransport } from "./cloud-transport";
import type { RemarkableAuth } from "./remarkable-auth";
import { NOT_CONNECTED_NOTICE } from "./sync-guards";
import { BothSourcesFailedError, explainTransportError, type Transport, type TransportSession } from "./transport";
import { openTransportChain } from "./transport-chain";

vi.mock("rmapi-js", () => ({
	session: vi.fn(() => ({
		raw: {},
		listItems: async () => [
			{ id: "folder-1", visibleName: "Zotero", parent: "", type: "CollectionType" },
			{ id: "doc-1", visibleName: "Prompting", parent: "folder-1", type: "DocumentType" },
		],
		putFolder: async () => ({ id: "folder-1" }),
		putPdf: async () => ({ id: "doc-1" }),
	})),
	auth: vi.fn(),
	register: vi.fn(),
	// Imported by `cloud-send.ts`, which the cloud transport's own `putPdf` goes through.
	GenerationError: class GenerationError extends Error {},
}));

function cloudWith(auth: Partial<RemarkableAuth>): CloudTransport {
	return new CloudTransport(auth as RemarkableAuth);
}

/** A transport that words everything, to prove the two layers are asked in the right order. */
function opinionated(sentence: string | null): Transport {
	return {
		id: "ssh",
		label: "Direct device",
		status: () => ({ connected: true, summary: "", connectNotice: "" }),
		open: () => Promise.reject(new Error("not used")),
		explainError: () => sentence,
		isUnreachable: () => false,
	};
}

describe("CloudTransport", () => {
	it("is connected exactly when a device token is stored", () => {
		expect(cloudWith({ isConnected: () => true }).status().connected).toBe(true);
		expect(cloudWith({ isConnected: () => false }).status().connected).toBe(false);
	});

	it("refuses a run with the wording the pre-flight already used", () => {
		expect(cloudWith({ isConnected: () => false }).status().connectNotice).toBe(NOT_CONNECTED_NOTICE);
	});

	it("fails over on an offline error but never on a refused credential", () => {
		const transport = cloudWith({});

		expect(transport.isUnreachable(new Error("fetch failed"))).toBe(true);
		expect(transport.isUnreachable(new Error("401 unauthorized"))).toBe(false);
	});

	// "If that is not reachable" asks this very question: a name that did not resolve stopped the sync
	// with the tablet right there on the same Wi-Fi.
	it("hands over to the fallback when Chromium says the cloud's name did not resolve", async () => {
		const cloud = cloudWith({ session: () => Promise.reject(new Error("net::ERR_NAME_NOT_RESOLVED")) });
		const tablet: Transport = { ...opinionated(null), open: () => Promise.resolve({ api: {} as TransportSession["api"], close: async () => {} }) };

		const opened = await openTransportChain({ primary: cloud, fallback: tablet });

		expect(opened.transport).toBe(tablet);
		expect(opened.failedOverFrom).toBe(cloud);
	});

	it("closes without needing the session it never opened a socket for", async () => {
		const transport = cloudWith({ session: () => Promise.resolve("session-token") });

		const session = await transport.open();

		await expect(session.close()).resolves.toBeUndefined();
	});
});

describe("explainTransportError", () => {
	it("says the primary was not there and lets the fallback word its own failure", () => {
		const primary = cloudWith({});
		const failure = new BothSourcesFailedError(primary, new Error("net::ERR_NAME_NOT_RESOLVED"), opinionated("The tablet is asleep."), new Error("no answer"));

		const notice = explainTransportError(primary, failure, "sync");

		expect(notice).toBe(`Could not reach ${primary.label}. The tablet is asleep.`);
		expect(notice).not.toContain("did not expect");
	});

	it("prefers the transport's own wording", () => {
		expect(explainTransportError(opinionated("The tablet is asleep."), new Error("boom"), "sync")).toBe(
			"The tablet is asleep.",
		);
	});

	it("falls through to the neutral wording for an error the transport does not claim", () => {
		// A vault name conflict means the same thing whichever source the bytes came from.
		const sentence = explainTransportError(opinionated(null), new Error("File already exists."), "sync");

		expect(sentence).toContain("local name conflict");
	});
});

describe("sending a PDF through the cloud", () => {
	// A session of its own. The one `open()` hands out is the engine's six read methods, and widening
	// that so a send could borrow it would put `putPdf` within reach of the sync engine.
	it("opens its own session and hands back the id the cloud gave", async () => {
		const session = vi.fn(async () => "token");
		const cloud = cloudWith({ isConnected: () => true, session });

		expect(await cloud.putPdf({ visibleName: "Prompting", bytes: new Uint8Array([37]), folder: "Zotero" })).toEqual({ docId: "doc-1" });
		expect(session).toHaveBeenCalled();
	});

	it("names what the folder holds through a session of its own, too", async () => {
		const session = vi.fn(async () => "token");
		const cloud = cloudWith({ isConnected: () => true, session });

		expect(await cloud.namesIn("Zotero")).toEqual(["Prompting"]);
		expect(session).toHaveBeenCalled();
	});
});
