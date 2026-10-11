import { describe, expect, it } from "vitest";
import { pushUnique } from "./push-unique";

describe("pushUnique", () => {
	it("appends in order and skips what is already there", () => {
		const list = ["a"];
		pushUnique(list, ["b", "a", "c", "b"]);
		expect(list).toEqual(["a", "b", "c"]);
	});

	it("stops at the limit", () => {
		const list: string[] = [];
		pushUnique(list, ["a", "a", "b", "c", "d"], 2);
		expect(list).toEqual(["a", "b"]);
	});
});
