import { describe, expect, it, vi } from "vitest";
import { failoverNotice, openTransportChain } from "./transport-chain";
import { BothSourcesFailedError, type Transport, type TransportSession } from "./transport";

const SESSION: TransportSession = { api: {} as TransportSession["api"], close: async () => {} };

interface FakeOptions {
	id?: "cloud" | "ssh";
	label?: string;
	connected?: boolean;
	fails?: Error;
	unreachable?: boolean;
}

function fake({ id = "cloud", label = "the cloud", connected = true, fails, unreachable = false }: FakeOptions) {
	const open = vi.fn(async () => {
		if (fails) throw fails;
		return SESSION;
	});
	const transport: Transport = {
		id,
		label,
		status: () => ({ connected, summary: "", connectNotice: "" }),
		open,
		explainError: () => null,
		isUnreachable: () => unreachable,
	};
	return { transport, open };
}

describe("trying the other source", () => {
	it("uses the primary and does not touch the fallback when the primary answers", async () => {
		const primary = fake({});
		const fallback = fake({ id: "ssh" });

		const opened = await openTransportChain({ primary: primary.transport, fallback: fallback.transport });

		expect(opened.transport).toBe(primary.transport);
		expect(opened.failedOverFrom).toBeNull();
		expect(fallback.open).not.toHaveBeenCalled();
	});

	it("goes to the fallback when nobody answered, and says which way it went", async () => {
		const primary = fake({ fails: new Error("offline"), unreachable: true });
		const fallback = fake({ id: "ssh", label: "your reMarkable directly" });

		const opened = await openTransportChain({ primary: primary.transport, fallback: fallback.transport });

		expect(opened.transport).toBe(fallback.transport);
		expect(opened.failedOverFrom).toBe(primary.transport);
	});

	it("does not fail over on a refused credential", async () => {
		// The whole point of the distinction: syncing on over the other source would hide a connection
		// the user has to repair, and nothing would ever tell them.
		const primary = fake({ fails: new Error("401 unauthorized"), unreachable: false });
		const fallback = fake({ id: "ssh" });

		await expect(openTransportChain({ primary: primary.transport, fallback: fallback.transport })).rejects.toThrow(
			"401",
		);
		expect(fallback.open).not.toHaveBeenCalled();
	});

	it("does not try a fallback that is not configured", async () => {
		// "Not paired" is not a connection problem, and reporting it instead of the real failure would
		// send the user to the wrong screen.
		const primary = fake({ fails: new Error("offline"), unreachable: true });
		const fallback = fake({ id: "ssh", connected: false });

		await expect(openTransportChain({ primary: primary.transport, fallback: fallback.transport })).rejects.toThrow(
			"offline",
		);
		expect(fallback.open).not.toHaveBeenCalled();
	});

	// The caller words a failure in the primary's terms, since it never learned which source threw: with
	// the cloud down and the tablet asleep, the tablet's answer read as the cloud's unexpected one.
	it("keeps both failures when the fallback fails too", async () => {
		const down = new Error("net::ERR_NAME_NOT_RESOLVED");
		const asleep = new Error("No answer from your reMarkable.");
		const primary = fake({ fails: down, unreachable: true });
		const fallback = fake({ id: "ssh", fails: asleep });

		const failure = await openTransportChain({ primary: primary.transport, fallback: fallback.transport }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(BothSourcesFailedError);
		expect(failure).toMatchObject({ primary: primary.transport, fallback: fallback.transport, fallbackError: asleep });
		expect((failure as Error).message).toContain("net::ERR_NAME_NOT_RESOLVED");
		expect((failure as Error).message).toContain("No answer from your reMarkable.");
	});

	it("keeps a fallback's failure that is not an Error at all", async () => {
		const primary = fake({ fails: new Error("offline"), unreachable: true });
		const fallback = fake({ id: "ssh" });
		fallback.open.mockRejectedValueOnce("kaboom");

		const failure = await openTransportChain({ primary: primary.transport, fallback: fallback.transport }).catch((error: unknown) => error);

		expect((failure as Error).message).toContain("kaboom");
	});

	it("fails as the primary failed when there is no fallback at all", async () => {
		const primary = fake({ fails: new Error("offline"), unreachable: true });

		await expect(openTransportChain({ primary: primary.transport, fallback: null })).rejects.toThrow("offline");
	});

	it("names both sources in the one notice a failover gets", () => {
		const from = fake({ label: "the reMarkable cloud" }).transport;
		const to = fake({ id: "ssh", label: "your reMarkable" }).transport;

		expect(failoverNotice(from, to)).toBe(
			"Could not reach the reMarkable cloud — synced from your reMarkable instead.",
		);
	});
});
