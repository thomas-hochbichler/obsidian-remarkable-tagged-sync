import { describe, expect, it } from "vitest";
import { matchItems, normaliseText, similarity } from "./matcher";

const base = (...texts: string[]) => texts.map((text, i) => ({ id: `b${i}`, text }));

describe("normaliseText", () => {
	it("ignores case, punctuation and spacing", () => {
		expect(normaliseText("  Call  BOB, today! ")).toBe("call bob today");
	});

	it("keeps letters with accents and umlauts", () => {
		expect(normaliseText("Größe prüfen")).toBe("größe prüfen");
	});
});

describe("similarity", () => {
	it("is 1 for the same words in another order and 0 for no shared word", () => {
		expect(similarity("call bob today", "today call bob")).toBe(1);
		expect(similarity("call bob", "buy milk")).toBe(0);
	});

	it("is 0 for two empty texts rather than NaN", () => {
		expect(similarity("", "")).toBe(0);
	});
});

describe("matchItems", () => {
	it("matches lines whose text is unchanged up to case and punctuation", () => {
		const result = matchItems([{ text: "call Bob." }, { text: "Buy milk" }], base("Buy milk", "Call Bob"));
		expect(result.lineToBase).toEqual(["b1", "b0"]);
		expect(result.deleted).toEqual([]);
	});

	it("matches a lightly edited line to its item", () => {
		const result = matchItems([{ text: "Call Bob about the invoice today" }], base("Call Bob about the invoice"));
		expect(result.lineToBase).toEqual(["b0"]);
	});

	it("reads a heavy rewrite as a user-added line and a deleted item", () => {
		// Benign by design: the tombstone stops the model's old item from coming back, and the
		// user's own line is kept -- nothing is lost or duplicated.
		const result = matchItems([{ text: "Ring the accountant" }], base("Call Bob about the invoice"));
		expect(result.lineToBase).toEqual([null]);
		expect(result.deleted).toEqual(["b0"]);
	});

	it("matches one to one, so two lines never claim the same item", () => {
		const result = matchItems([{ text: "Buy milk" }, { text: "Buy milk" }], base("Buy milk"));
		expect(result.lineToBase).toEqual(["b0", null]);
	});

	it("gives an item to the most similar line first", () => {
		const result = matchItems([{ text: "Call Bob about invoice" }, { text: "Call Bob about the invoice today" }], base("Call Bob about the invoice today please"));
		expect(result.lineToBase).toEqual([null, "b0"]);
	});

	it("breaks a tie by position", () => {
		const result = matchItems([{ text: "Email Anna report" }, { text: "Email Anna report" }], base("Email Anna the report", "Email Anna the report"));
		expect(result.lineToBase).toEqual(["b0", "b1"]);
	});

	it("prefers an exact match over a closer position", () => {
		const result = matchItems([{ text: "Buy oat milk" }, { text: "Buy milk" }], base("Buy milk", "Buy oat milk"));
		expect(result.lineToBase).toEqual(["b1", "b0"]);
	});
});
