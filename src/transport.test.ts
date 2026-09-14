import { describe, expect, it, vi } from "vitest";
import { CloudTransport } from "./cloud-transport";
import type { RemarkableAuth } from "./remarkable-auth";
import { NOT_CONNECTED_NOTICE } from "./sync-guards";
import { explainTransportError, type Transport } from "./transport";

vi.mock("rmapi-js", () => ({
	session: vi.fn(() => ({
		raw: {},
		listItems: async () => [],
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

	it("closes without needing the session it never opened a socket for", async () => {
		const transport = cloudWith({ session: () => Promise.resolve("session-token") });

		const session = await transport.open();

		await expect(session.close()).resolves.toBeUndefined();
	});
});

describe("explainTransportError", () => {
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
});
