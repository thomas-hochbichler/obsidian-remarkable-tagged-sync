import { describe, it, expect } from "vitest";
import { judgeVerdict, STALE_HOURS } from "./nightly-verdict.mjs";

const NOW = new Date("2026-08-19T12:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const verdict = (parts) => ({
	schema: 1,
	commit: "abc1234",
	runId: "1234567890",
	runUrl: "https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/actions/runs/1234567890",
	parts: {
		contract: { status: "pass", measuredAt: hoursAgo(9), detail: {} },
		ocr: { status: "pass", measuredAt: hoursAgo(9), detail: {} },
		...parts,
	},
});

describe("judgeVerdict", () => {
	it("lets a release through when both halves of last night measured and passed", () => {
		const { problems, notes } = judgeVerdict(verdict(), NOW);
		expect(problems).toEqual([]);
		expect(notes).toEqual(["contract: pass, measured 9 h ago", "ocr: pass, measured 9 h ago"]);
	});

	it("blocks the release when the contract half found the live API broken", () => {
		const { problems } = judgeVerdict(verdict({ contract: { status: "catastrophe", measuredAt: hoursAgo(2) } }), NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("`contract` is a catastrophe");
	});

	it("treats a new key in a live response as a report, not a blocker", () => {
		const { problems, notes } = judgeVerdict(verdict({ contract: { status: "degraded", measuredAt: hoursAgo(3) } }), NOW);
		expect(problems).toEqual([]);
		expect(notes).toContain("contract: degraded, measured 3 h ago");
	});

	it("refuses a verdict older than three nights, however green it says it is", () => {
		const { problems } = judgeVerdict(verdict({ ocr: { status: "pass", measuredAt: hoursAgo(STALE_HOURS + 1) } }), NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("older than 72 h");
	});

	it("still accepts a verdict measured just inside the window, so a quiet weekend does not block a release", () => {
		const { problems } = judgeVerdict(verdict({ ocr: { status: "pass", measuredAt: hoursAgo(STALE_HOURS - 1) } }), NOW);
		expect(problems).toEqual([]);
	});

	it("does not block on a quota or a 503 that the plugin did not cause", () => {
		const { problems, notes } = judgeVerdict(
			verdict({ ocr: { status: "unknown", measuredAt: hoursAgo(2), lastMeasuredAt: hoursAgo(26) } }),
			NOW,
		);
		expect(problems).toEqual([]);
		expect(notes).toContain("ocr: unknown, but really measured 26 h ago");
	});

	it("blocks once nothing has really been measured for three nights, whatever the reason was", () => {
		const { problems } = judgeVerdict(
			verdict({ ocr: { status: "unknown", measuredAt: hoursAgo(2), lastMeasuredAt: hoursAgo(STALE_HOURS + 5) } }),
			NOW,
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("indistinguishable from having no gate");
	});

	it("does not let last night's number stand in for a half that could not be measured at all", () => {
		const { problems } = judgeVerdict(verdict({ ocr: { status: "unknown", measuredAt: hoursAgo(2) } }), NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("never produced a real measurement");
	});

	it("blocks when a night measured only one of the two halves", () => {
		const half = verdict();
		delete half.parts.ocr;
		const { problems } = judgeVerdict(half, NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("part `ocr` is missing");
	});

	it("blocks on a hand-edited verdict rather than reading it as a pass", () => {
		const edited = verdict();
		edited.note = "re-ran this by hand, looked fine";
		const { problems } = judgeVerdict(edited, NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("unknown key `note`");
	});

	it("blocks on a part whose freshness cannot be established", () => {
		const { problems } = judgeVerdict(verdict({ contract: { status: "pass", measuredAt: "last tuesday" } }), NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("no readable `measuredAt`");
	});

	it("blocks when no verdict file exists at all, which is the state every repo starts in", () => {
		const { problems } = judgeVerdict(null, NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("missing");
	});

	it("refuses a verdict written by a newer nightly than this gate understands", () => {
		const { problems } = judgeVerdict({ ...verdict(), schema: 2 }, NOW);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("expected 1");
	});
});
