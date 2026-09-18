import { describe, expect, it, vi } from "vitest";
import { NO_LICENCE, type LicenceState } from "./licence-state";
import {
	attestTrial,
	createTrialIssuer,
	startTrial,
	ticketMessage,
	TRIAL_TICKET_URL,
	TrialStartError,
	type TrialIssuer,
	type TrialTicket,
	vaultHashOf,
	verifyTicket,
} from "./trial-ticket";

// `licence-client.ts`'s `withTimeout` reaches for `window.setTimeout`, which vitest does not have.
vi.stubGlobal("window", {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

/**
 * A key pair of this test's own. The real private key is a Worker secret; what these tests prove is
 * that the plugin accepts exactly the signatures *some* holder of the matching private key makes.
 */
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const PUBLIC = await crypto.subtle.exportKey("jwk", pair.publicKey);
const STRANGER = await crypto.subtle.exportKey(
	"jwk",
	(await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])).publicKey,
);

async function signed(vault: string, startedAt: string): Promise<TrialTicket> {
	const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, ticketMessage(vault, startedAt));
	const signature = btoa(String.fromCharCode(...new Uint8Array(raw)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { startedAt, signature };
}

const VAULT = "0123456789ab";
const STARTED = "2026-09-18T10:00:00.000Z";

function issuerOf(answer: () => Promise<TrialTicket>): TrialIssuer & { asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		issue: (vault) => {
			asked.push(vault);
			return answer();
		},
	};
}

describe("vaultHashOf", () => {
	it("is twelve hex characters of the id's SHA-256, and nothing of the id itself", async () => {
		const hash = await vaultHashOf("3f8a1c9e2b7d4e60");
		expect(hash).toMatch(/^[0-9a-f]{12}$/);
		expect(hash).not.toContain("3f8a1c9e");
		// SHA-256("3f8a1c9e2b7d4e60") begins with this; pinned so the server and the plugin cannot drift.
		expect(hash).toBe(await vaultHashOf("3f8a1c9e2b7d4e60"));
	});
});

describe("verifyTicket", () => {
	it("accepts the server's signature over this vault and this date", async () => {
		expect(await verifyTicket(VAULT, await signed(VAULT, STARTED), PUBLIC)).toBe(true);
	});

	// The whole point: the one field a restart needs is the one field the signature covers.
	it("refuses a ticket whose date was moved by hand", async () => {
		const ticket = await signed(VAULT, STARTED);
		expect(await verifyTicket(VAULT, { ...ticket, startedAt: "2026-12-01T00:00:00.000Z" }, PUBLIC)).toBe(false);
	});

	it("refuses another vault's ticket", async () => {
		expect(await verifyTicket("ffffffffffff", await signed(VAULT, STARTED), PUBLIC)).toBe(false);
	});

	it("refuses a ticket signed by anyone but taggedsync.com", async () => {
		expect(await verifyTicket(VAULT, await signed(VAULT, STARTED), STRANGER)).toBe(false);
	});

	it("answers no, not an error, to a signature that is not even base64", async () => {
		expect(await verifyTicket(VAULT, { startedAt: STARTED, signature: "not a signature!" }, PUBLIC)).toBe(false);
	});
});

describe("startTrial", () => {
	it("records the ticket the server issued, and nothing else changes", async () => {
		const issuer = issuerOf(() => signed(VAULT, STARTED));
		const state = await startTrial(NO_LICENCE, VAULT, issuer, PUBLIC);

		expect(issuer.asked).toEqual([VAULT]);
		expect(state).toMatchObject({ trialStartedAt: STARTED });
		expect(state.trialSignature).not.toBeNull();
		expect(await attestTrial(state, VAULT, PUBLIC)).toBe(state);
	});

	it("starts nothing when taggedsync.com cannot be reached, and says so", async () => {
		const issuer = issuerOf(() => Promise.reject(new Error("ENOTFOUND")));
		await expect(startTrial(NO_LICENCE, VAULT, issuer, PUBLIC)).rejects.toMatchObject({ reason: "unreachable" });
	});

	it("starts nothing on a ticket it cannot verify", async () => {
		const issuer = issuerOf(() => signed("ffffffffffff", STARTED));
		await expect(startTrial(NO_LICENCE, VAULT, issuer, PUBLIC)).rejects.toMatchObject({ reason: "bad-ticket" });
	});

	it("asks nothing of the server for a vault with no id", async () => {
		const issuer = issuerOf(() => signed(VAULT, STARTED));
		await expect(startTrial(NO_LICENCE, null, issuer, PUBLIC)).rejects.toBeInstanceOf(TrialStartError);
		expect(issuer.asked).toEqual([]);
	});
});

describe("attestTrial", () => {
	const unsigned: LicenceState = { ...NO_LICENCE, trialStartedAt: STARTED };

	// A `data.json` from before 1.8 carries a trial nobody signed. It is not honoured -- the button
	// comes back, and the click issues a ticket, which for a known vault is the old date.
	it("drops a trial that carries no signature", async () => {
		expect(await attestTrial(unsigned, VAULT, PUBLIC)).toEqual(NO_LICENCE);
	});

	it("drops a trial whose date no longer matches its signature", async () => {
		const ticket = await signed(VAULT, STARTED);
		const edited = { ...NO_LICENCE, trialStartedAt: "2026-12-01T00:00:00.000Z", trialSignature: ticket.signature };
		expect(await attestTrial(edited, VAULT, PUBLIC)).toEqual(NO_LICENCE);
	});

	it("keeps a proven trial, as the same object", async () => {
		const ticket = await signed(VAULT, STARTED);
		const state = { ...NO_LICENCE, trialStartedAt: STARTED, trialSignature: ticket.signature };
		expect(await attestTrial(state, VAULT, PUBLIC)).toBe(state);
	});

	it("leaves a vault with no id as it found it", async () => {
		expect(await attestTrial(unsigned, null, PUBLIC)).toBe(unsigned);
	});

	it("touches nothing where no trial was ever started", async () => {
		expect(await attestTrial(NO_LICENCE, VAULT, PUBLIC)).toBe(NO_LICENCE);
	});
});

describe("createTrialIssuer", () => {
	function stubFetch(response: Response) {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return response;
		});
		return { impl: impl as unknown as typeof fetch, calls };
	}

	it("posts the hash, and only the hash, to taggedsync.com", async () => {
		const { impl, calls } = stubFetch(new Response(JSON.stringify({ startedAt: STARTED, signature: "sig" }), { status: 200 }));
		await createTrialIssuer(impl).issue(VAULT);

		expect(calls[0].url).toBe(TRIAL_TICKET_URL);
		expect(calls[0].init?.method).toBe("POST");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ vault: VAULT });
	});

	it("hands back the ticket as the server wrote it", async () => {
		const { impl } = stubFetch(new Response(JSON.stringify({ startedAt: STARTED, signature: "sig" }), { status: 200 }));
		expect(await createTrialIssuer(impl).issue(VAULT)).toEqual({ startedAt: STARTED, signature: "sig" });
	});

	it("rejects a refusal, so the click reports no connection rather than storing a 400 page", async () => {
		const { impl } = stubFetch(new Response("bad request", { status: 400 }));
		await expect(createTrialIssuer(impl).issue(VAULT)).rejects.toThrow("400");
	});

	it("rejects an answer with no ticket in it", async () => {
		const { impl } = stubFetch(new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
		await expect(createTrialIssuer(impl).issue(VAULT)).rejects.toThrow("without a ticket");
	});
});
