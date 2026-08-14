import { describe, expect, it, vi } from "vitest";
import { createPolarLicenceApi } from "./licence-client";

const ORG = "org_123";

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
		const { impl } = stubFetch(status(404), status(404));
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

	it("maps 404 to an unknown key and 403 to a full licence", async () => {
		const gone = stubFetch(status(404));
		expect(await createPolarLicenceApi(ORG, gone.impl).activate("TSPRO-1", "v")).toEqual({
			outcome: "unknown-key",
		});

		const full = stubFetch(status(403));
		expect(await createPolarLicenceApi(ORG, full.impl).activate("TSPRO-1", "v")).toEqual({
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
