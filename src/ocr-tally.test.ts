import { describe, expect, it } from "vitest";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { describeOcrTally, type OcrTally, tallyOcr } from "./ocr-tally";
import { OffOcrBackend } from "./off-ocr-backend";
import type { RmPage } from "./rm-parser";
import { UnavailableOcrBackend } from "./vision-ocr-backend";

const SCENE: RmPage = { formatVersion: 6, layers: [] };

function backendAnswering(...answers: (OcrResult | Error)[]): OcrBackend {
	return {
		id: "ollama",
		metered: false,
		fingerprint: "ollama|http://localhost:11434/v1|qwen2.5vl:7b",
		model: "qwen2.5vl:7b",
		async recognize() {
			const answer = answers.shift();
			if (answer === undefined) throw new Error("no more answers");
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
}

/** The stand-in a run would use, and the tally it handed over on its first send. */
function tallied<T extends OcrBackend>(backend: T): { counted: T; tally: () => OcrTally } {
	let tally: OcrTally | null = null;
	const counted = tallyOcr(backend, (handed) => (tally = handed));
	return {
		counted,
		tally: () => {
			if (tally === null) throw new Error("nothing was sent");
			return tally;
		},
	};
}

describe("tallyOcr", () => {
	it("counts pages and margin notes apart, by what came back", async () => {
		const { counted, tally } = tallied(
			backendAnswering(
				{ status: "ok", pages: [{ status: "ok", text: "a" }, { status: "skipped", text: "" }, { status: "failed", text: "" }], text: "a", confidence: null },
				{ status: "skipped", pages: [{ status: "skipped", text: "" }], text: "", confidence: null },
				{ status: "ok", pages: [{ status: "ok", text: "Nachfragen" }], text: "Nachfragen", confidence: null },
			),
		);
		await counted.recognize([SCENE, SCENE, SCENE]);
		await counted.recognize([SCENE], undefined, "note");
		await counted.recognize([SCENE], undefined, "note");

		expect(tally().pages).toEqual({ read: 1, empty: 1, failed: 1, unavailable: 0 });
		expect(tally().notes).toEqual({ read: 1, empty: 1, failed: 0, unavailable: 0 });
		expect(tally().model).toBe("qwen2.5vl:7b");
	});

	it("counts a backend that never looked as not run, every image of it", async () => {
		const { counted, tally } = tallied(new UnavailableOcrBackend("vision"));
		await counted.recognize([SCENE, SCENE]);
		expect(tally().pages.unavailable).toBe(2);
		expect(tally().model).toBeNull();
	});

	/** A backend may answer for the whole call without a per-page list; its status then speaks for every image. */
	it("counts an answer without a page list by its status, every image of it", async () => {
		const { counted, tally } = tallied(
			backendAnswering(
				{ status: "ok", pages: null, text: "a\n\nb", confidence: null },
				{ status: "skipped", pages: null, text: "", confidence: null },
			),
		);
		await counted.recognize([SCENE, SCENE]);
		await counted.recognize([SCENE], undefined, "note");

		expect(tally().pages).toEqual({ read: 2, empty: 0, failed: 0, unavailable: 0 });
		expect(tally().notes).toEqual({ read: 0, empty: 1, failed: 0, unavailable: 0 });
	});

	/** The unavailable notice and the re-transcribe gate ask `instanceof`; a plain wrapper would answer them wrong. */
	it("hands back a stand-in that answers instanceof and every field as the adapter does", () => {
		const { counted } = tallied(new UnavailableOcrBackend("vision", true));
		expect(counted).toBeInstanceOf(UnavailableOcrBackend);
		expect(counted.notReadyNotice).toBe(true);
		expect(counted.id).toBe("vision");
	});

	/**
	 * Apple Vision's adapter is one object for the whole session. Replacing its `recognize` in place
	 * wrapped it once more on every sync, and every older tally went on counting.
	 */
	it("leaves the adapter itself untouched, so runs never stack", async () => {
		const backend = backendAnswering(...Array.from({ length: 2 }, (): OcrResult => ({ status: "ok", pages: [{ status: "ok", text: "a" }], text: "a", confidence: null })));
		const recognize = backend.recognize;
		const first = tallied(backend);
		await first.counted.recognize([SCENE]);
		const second = tallied(backend);
		await second.counted.recognize([SCENE]);

		expect(backend.recognize).toBe(recognize);
		expect(first.tally().pages.read).toBe(1);
		expect(second.tally().pages.read).toBe(1);
	});

	/** A cancelled re-transcribe, or a sync with nothing changed, must not wipe the last run's figures. */
	it("hands the tally over once, on the first image sent, and not at all when nothing is", async () => {
		const handed: OcrTally[] = [];
		const counted = tallyOcr(
			backendAnswering(...Array.from({ length: 3 }, (): OcrResult => ({ status: "skipped", pages: [], text: "", confidence: null }))),
			(tally) => handed.push(tally),
		);
		tallyOcr(backendAnswering(), (tally) => handed.push(tally));
		await counted.recognize([]);
		expect(handed).toHaveLength(0);

		await counted.recognize([SCENE]);
		await counted.recognize([SCENE]);
		expect(handed).toHaveLength(1);
	});

	// "Off" answers every image `skipped`, which counted as forty blank pages and replaced the last real run.
	it("leaves Off alone: it reads nothing, so there is nothing to report", async () => {
		const handed: OcrTally[] = [];
		const off = new OffOcrBackend();

		const counted = tallyOcr(off, (tally) => handed.push(tally));
		await counted.recognize([SCENE, SCENE]);

		expect(counted).toBe(off);
		expect(handed).toHaveLength(0);
	});

	it("hands the tally over before the backend reads, so a run that fails still reports", async () => {
		let seenBeforeRead = false;
		let handed = false;
		const backend: OcrBackend = {
			...backendAnswering(),
			async recognize() {
				seenBeforeRead = handed;
				throw new Error("spawn failed");
			},
		};
		const counted = tallyOcr(backend, () => (handed = true));
		await expect(counted.recognize([SCENE])).rejects.toThrow("spawn failed");
		expect(seenBeforeRead).toBe(true);
	});

	it("counts a throw as failed and still throws it", async () => {
		const { counted, tally } = tallied(backendAnswering(new Error("spawn failed")));
		await expect(counted.recognize([SCENE], undefined, "note")).rejects.toThrow("spawn failed");
		expect(tally().notes.failed).toBe(1);
	});

	it("keeps what cut answers off, and only the first few", async () => {
		const cut = { promptTokens: 4076, answerTokens: 20, context: 4096, reasoning: false, repeatedLines: 0, lines: 4 };
		const answer: OcrResult = { status: "failed", pages: [{ status: "failed", text: "" }], text: "", confidence: null, cutOffs: [cut, cut, cut] };
		const { counted, tally } = tallied(backendAnswering(answer, { ...answer }));
		await counted.recognize([SCENE]);
		await counted.recognize([SCENE]);
		expect(tally().cutOffs).toHaveLength(5);
	});

	it("keeps each warning once, and only the first few", async () => {
		const failed = (warning: string): OcrResult => ({ status: "failed", pages: [{ status: "failed", text: "" }], text: "", confidence: null, warnings: [warning] });
		const { counted, tally } = tallied(backendAnswering(...["a", "a", "b", "c", "d", "e", "f"].map(failed)));
		for (let i = 0; i < 7; i++) await counted.recognize([SCENE], undefined, "note");
		expect(tally().warnings).toEqual(["a", "b", "c", "d", "e"]);
		expect(tally().notes.failed).toBe(7);
	});
});

describe("describeOcrTally", () => {
	it("says when no model is set rather than printing an empty name", () => {
		const lines = describeOcrTally({ backend: "ollama", model: "", pages: { read: 0, empty: 0, failed: 0, unavailable: 0 }, notes: { read: 0, empty: 0, failed: 0, unavailable: 0 }, warnings: [], cutOffs: [] });
		expect(lines[0]).toBe("Last transcription: ollama, model (none set)");
	});

	it("leaves the model out where there is none to name", () => {
		const lines = describeOcrTally({ backend: "vision", model: null, pages: { read: 3, empty: 0, failed: 0, unavailable: 0 }, notes: { read: 0, empty: 0, failed: 0, unavailable: 2 }, warnings: [], cutOffs: [] });
		expect(lines).toContain("Last transcription: vision");
		expect(lines).toContain("Margin notes: 0 read, 0 empty, 0 failed, 2 not run");
		expect(lines).toContain("Transcription warnings: none");
		expect(lines).toContain("Cut-off answers: none");
	});

	// Each figure that tells the causes apart, and "unknown" where the server did not say, so a pasted
	// block never reads as a measurement that was not made.
	it("lists what cut each answer off", () => {
		const lines = describeOcrTally({
			backend: "ollama",
			model: "qwen2.5vl:3b",
			pages: { read: 21, empty: 0, failed: 1, unavailable: 0 },
			notes: { read: 0, empty: 0, failed: 0, unavailable: 0 },
			warnings: [],
			cutOffs: [
				{ promptTokens: 4076, answerTokens: 20, context: 4096, reasoning: false, repeatedLines: 0, lines: 4 },
				{ promptTokens: null, answerTokens: null, context: null, reasoning: true, repeatedLines: 0, lines: 0 },
			],
		});
		expect(lines.slice(-3)).toEqual([
			"Cut-off answers:",
			"- prompt 4076 + answer 20 = 4096 tokens, context 4096, reasoning: no, repeated lines: 0 of 4",
			"- tokens unknown, context unknown, reasoning: yes, repeated lines: 0 of 0",
		]);
	});
});
