import { describe, expect, it, vi } from "vitest";
import { failoverNotice, openTransportChain } from "./transport-chain";
import type { Transport, TransportSession } from "./transport";

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
