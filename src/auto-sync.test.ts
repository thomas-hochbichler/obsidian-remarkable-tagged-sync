import { describe, expect, it } from "vitest";
import { isIntervalSyncDue, isMeteredProvider } from "./auto-sync";
// Registers this build's backends, which is what `isMeteredProvider` reads. Nothing here is metered;
// backends that are, are covered alongside their own registration.
import "./vision-register";

describe("isMeteredProvider", () => {
	it("is false for Apple Vision", () => {
		expect(isMeteredProvider("vision")).toBe(false);
	});

	it("is false for a backend this build does not have", () => {
		expect(isMeteredProvider("openai")).toBe(false);
	});
});

describe("isIntervalSyncDue", () => {
	const now = Date.parse("2026-07-23T12:00:00.000Z");

	it("is due when there is no recorded last sync", () => {
		expect(isIntervalSyncDue(null, 6, now)).toBe(true);
	});

	it("is not due when less than the interval has elapsed", () => {
		const oneHourAgo = new Date(now - 1 * 3_600_000).toISOString();
		expect(isIntervalSyncDue(oneHourAgo, 6, now)).toBe(false);
	});

	it("is due when at least the interval has elapsed", () => {
		const sevenHoursAgo = new Date(now - 7 * 3_600_000).toISOString();
		expect(isIntervalSyncDue(sevenHoursAgo, 6, now)).toBe(true);
	});

	it("is due at exactly the interval boundary", () => {
		const sixHoursAgo = new Date(now - 6 * 3_600_000).toISOString();
		expect(isIntervalSyncDue(sixHoursAgo, 6, now)).toBe(true);
	});

	it("is due when the stored timestamp is unparseable", () => {
		expect(isIntervalSyncDue("not-a-date", 6, now)).toBe(true);
	});
});
