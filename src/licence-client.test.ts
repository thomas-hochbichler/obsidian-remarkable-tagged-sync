import { describe, expect, it, vi } from "vitest";
import { createPolarLicenceApi, LICENCE_TIMEOUT_MS } from "./licence-client";

const ORG = "org_123";

// `licence-client.ts` reaches for `window.setTimeout`, which is Obsidian's rule for popout-window
// compatibility and does not exist under vitest. Delegated per call rather than captured, so a test
// that installs fake timers still sees them.
vi.stubGlobal("window", {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

/** Answers each call in turn, and records what was asked. */
function stubFetch(...responses: Response[]) {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
		const next = responses.shift();
		if (next === undefined) throw new Error("unexpected extra request");
		return next;
	});
	return { impl: impl as unknown as typeof fetch, calls };
}

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => new Response(null, { status: code });

// Polar's real bodies, copied from live calls on 2026-08-14. The two 404s differ only in `detail`.
const NEVER_EXISTED = new Response(JSON.stringify({ error: "ResourceNotFound", detail: "Not found" }), { status: 404 });
const REVOKED_404 = new Response(
	JSON.stringify({ error: "ResourceNotFound", detail: "License key is no longer active." }),
	{ status: 404 },
);
const REVOKED_403 = new Response(
	JSON.stringify({
		error: "NotPermitted",
		detail: "License key is no longer active. This license key can not be activated.",
	}),
	{ status: 403 },
);
const LIMIT_403 = new Response(
	JSON.stringify({ error: "NotPermitted", detail: "License key activation limit already reached" }),
	{ status: 403 },
);

describe("validate", () => {
	it("sends the key, the activation and the public organization id", async () => {
		const { impl, calls } = stubFetch(ok());
		expect(await createPolarLicenceApi(ORG, impl).validate("TSPRO-1", "act_1")).toBe("valid");
		expect(calls[0].url).toBe("https://api.polar.sh/v1/customer-portal/license-keys/validate");
		expect(calls[0].body).toEqual({ organization_id: ORG, key: "TSPRO-1", activation_id: "act_1" });
	});

	it("asks nothing further when the answer is yes", async () => {
		const { impl, calls } = stubFetch(ok());
		await createPolarLicenceApi(ORG, impl).validate("TSPRO-1", "act_1");
		expect(calls).toHaveLength(1);
	});

	// Polar answers 404 for every failure, so the second call asks the narrower question: is the
	// *key* alive? Without it, a stranger freeing a slot and a refund look identical.
	it("re-asks without the activation, and treats an answer as a freed slot", async () => {
		const { impl, calls } = stubFetch(status(404), ok());
		expect(await createPolarLicenceApi(ORG, impl).validate("TSPRO-1", "act_1")).toBe("unknown-activation");
		expect(calls[1].body).toEqual({ organization_id: ORG, key: "TSPRO-1" });
		expect(calls[1].body).not.toHaveProperty("activation_id");
	});

	it("calls the key dead only when it fails on its own too", async () => {
		const { impl } = stubFetch(status(404), NEVER_EXISTED);
		expect(await createPolarLicenceApi(ORG, impl).validate("TSPRO-1", "act_1")).toBe("unknown-key");
	});

	// Both 404s. The only thing separating a typo from a refund is the `detail` text.
	it("tells a withdrawn key apart from one that never existed", async () => {
		const { impl } = stubFetch(status(404), REVOKED_404);
		expect(await createPolarLicenceApi(ORG, impl).validate("TSPRO-1", "act_1")).toBe("withdrawn");
	});

	// The fallback must be the blunter sentence, never a wrong claim that someone was refunded.
	it("falls back to unknown-key when the body cannot be read", async () => {
		const { impl } = stubFetch(status(404), new Response("<html>gateway</html>", { status: 404 }));
		expect(await createPolarLicenceApi(ORG, impl).validate("TSPRO-1", "act_1")).toBe("unknown-key");
	});

	// Anything that is not a clear 404 is silence, and silence never locks Pro.
	it("treats a server fault as no answer, not as a verdict", async () => {
		const { impl } = stubFetch(status(500));
		expect(await createPolarLicenceApi(ORG, impl).validate("TSPRO-1", "act_1")).toBe("unreachable");

		const second = stubFetch(status(404), status(502));
		expect(await createPolarLicenceApi(ORG, second.impl).validate("TSPRO-1", "act_1")).toBe("unreachable");
	});
});

describe("activate", () => {
	it("returns the activation id Polar issued", async () => {
		const { impl, calls } = stubFetch(ok({ id: "act_new", license_key_id: "lk_1" }));
		expect(await createPolarLicenceApi(ORG, impl).activate("TSPRO-1", "Work vault")).toEqual({
			outcome: "valid",
			activationId: "act_new",
		});
		expect(calls[0].body).toEqual({ organization_id: ORG, key: "TSPRO-1", label: "Work vault" });
	});

	// A 200 without an id would otherwise be stored as a working activation that Polar cannot match.
	it("refuses an answer that carries no id", async () => {
		const { impl } = stubFetch(ok({ license_key_id: "lk_1" }));
		expect(await createPolarLicenceApi(ORG, impl).activate("TSPRO-1", "v")).toEqual({ outcome: "unreachable" });
	});

	it("maps 404 to an unknown key", async () => {
		const gone = stubFetch(status(404));
		expect(await createPolarLicenceApi(ORG, gone.impl).activate("TSPRO-1", "v")).toEqual({
			outcome: "unknown-key",
		});
	});

	// Polar refuses with 403 both when the slots are full and when the key is no longer active. Told
	// apart wrongly, someone whose licence was withdrawn reads that their key is on fifty devices.
	it("calls a full licence full, and a withdrawn one withdrawn", async () => {
		const full = stubFetch(LIMIT_403);
		expect(await createPolarLicenceApi(ORG, full.impl).activate("TSPRO-1", "v")).toEqual({
			outcome: "activation-limit",
		});
		expect(full.calls).toHaveLength(1);

		const gone = stubFetch(REVOKED_403);
		expect(await createPolarLicenceApi(ORG, gone.impl).activate("TSPRO-1", "v")).toEqual({
			outcome: "withdrawn",
		});
	});

	it("falls back to the limit message when the body cannot be read", async () => {
		const { impl } = stubFetch(status(403));
		expect(await createPolarLicenceApi(ORG, impl).activate("TSPRO-1", "v")).toEqual({
			outcome: "activation-limit",
		});
	});
});

describe("deactivate", () => {
	it("names the activation to free", async () => {
		const { impl, calls } = stubFetch(status(204));
		await createPolarLicenceApi(ORG, impl).deactivate("TSPRO-1", "act_1");
		expect(calls[0].url).toBe("https://api.polar.sh/v1/customer-portal/license-keys/deactivate");
		expect(calls[0].body).toEqual({ organization_id: ORG, key: "TSPRO-1", activation_id: "act_1" });
	});
});

// Gap G33, and it was a bug rather than a test gap: there was no timeout anywhere on a Polar call.
// `refreshLicenceIfGated` is **awaited on the sync path**, so a server that accepts the connection
// and never answers did not fail the licence check -- it hung the sync, with the status bar spinning
// and no way out but closing Obsidian. Every failure this file already handled is a server that
// answers *something*.
describe("a licence server that never answers", () => {
	/** A fetch that accepts the connection and then does nothing at all, for ever. */
	const neverAnswers = (() => {
		return vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
	})();

	it("stops waiting, rather than leaving the sync that awaited it hanging", async () => {
		const api = createPolarLicenceApi(ORG, neverAnswers, 5);

		// It rejects, and `licence-check.ts` turns a rejection into `unreachable` -- the outcome that
		// keeps Pro working on the last good verdict. That mapping is tested there; what could not be
		// tested anywhere was that the call ends at all.
		await expect(api.validate("TSPRO-1", "act_1")).rejects.toThrow(/did not answer/);
	});

	it("stops waiting on an activation too, so the paste field cannot hang either", async () => {
		const api = createPolarLicenceApi(ORG, neverAnswers, 5);

		await expect(api.activate("TSPRO-1", "My Vault")).rejects.toThrow(/did not answer/);
	});

	it("names the limit it gave up on, so a support mail says which one was hit", async () => {
		const api = createPolarLicenceApi(ORG, neverAnswers, 5);

		await expect(api.validate("TSPRO-1", "act_1")).rejects.toThrow("5 ms");
	});

	it("gives a working server long enough to answer on a slow connection", async () => {
		// The limit is not so tight that an ordinary slow response trips it. Ten seconds is long enough
		// for a bad connection and short enough that somebody who hits it presses Sync again rather
		// than filing a bug about a frozen plugin.
		expect(LICENCE_TIMEOUT_MS).toBe(10_000);

		const slow = vi.fn(
			async () => await new Promise<Response>((resolve) => setTimeout(() => resolve(ok()), 5)),
		) as unknown as typeof fetch;

		await expect(createPolarLicenceApi(ORG, slow, 200).validate("TSPRO-1", "act_1")).resolves.toBe("valid");
	});

	it("does not leave a timer running behind a call that answered in time", async () => {
		// A pending timer per request would keep the event loop alive after a sync finished, which on
		// desktop Obsidian is a plugin that will not unload cleanly -- and the timeout here is a minute,
		// so it would hold it for a minute per licence call.
		vi.useFakeTimers();
		try {
			const before = vi.getTimerCount();

			await createPolarLicenceApi(ORG, stubFetch(ok()).impl, 60_000).validate("TSPRO-1", "act_1");

			expect(vi.getTimerCount()).toBe(before);
		} finally {
			vi.useRealTimers();
		}
	});
});
