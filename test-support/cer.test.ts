import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { characterErrorRate, levenshtein, normalizeForCer, structureObservation } from "./cer";

/** A reference page's body, read the way the nightly reads it: after the frontmatter block. */
function pageBody(name: string): string {
	const raw = readFileSync(join(process.cwd(), "test-fixtures", "ocr-reference", "pages", name), "utf8");
	const end = raw.indexOf("---", raw.indexOf("---") + 3);
	return raw.slice(end + 3).trim();
}

describe("the normaliser", () => {
	it("normalises to NFC, so a decomposed umlaut is not a reading error", () => {
		expect(normalizeForCer("Bücher")).toBe("Bücher");
	});

	it("does NOT apply NFKC -- the superscripts and ellipsis pages 06 and 12 measure must survive", () => {
		expect(normalizeForCer("a² + b² = c²")).toContain("²");
		expect(normalizeForCer("Drei Punkte …")).toContain("…");
	});

	it("repairs transport noise: BOM, CRLF, zero-width characters, exotic spaces", () => {
		expect(normalizeForCer("﻿Eine Zeile\r\nZweite Zeile")).toBe("Eine Zeile Zweite Zeile");
		expect(normalizeForCer("21 °C und 3​kg")).toBe("21 °C und 3kg");
	});

	it("collapses space runs and trailing whitespace", () => {
		expect(normalizeForCer("ein  Wort   mehr  ")).toBe("ein Wort mehr");
	});

	it("keeps indentation as nesting depth rather than stripping it -- page 04's trait", () => {
		expect(normalizeForCer("   a. water first")).toBe("  a. water first");
		expect(normalizeForCer("\tb. food")).toBe("  b. food");
	});

	it("joins a wrapped line inside a paragraph with a space, and keeps a blank line a paragraph break", () => {
		expect(normalizeForCer("Der Garten hinter\ndem Haus.\n\nZuerst der Boden.")).toBe(
			"Der Garten hinter dem Haus.\n\nZuerst der Boden.",
		);
	});

	it("never joins across a heading, a list item or a table row", () => {
		expect(normalizeForCer("# Titel\nProsa danach")).toBe("Titel\n\nProsa danach");
		expect(normalizeForCer("- erster\n- zweiter")).toBe("- erster\n- zweiter");
	});

	it("normalises every bullet flavour to a dash, so the marker choice is not a reading error", () => {
		expect(normalizeForCer("* eins\n+ zwei\n• drei\n– vier")).toBe("- eins\n- zwei\n- drei\n- vier");
	});

	it("renumbers ordinals canonically, so 1./1./1. and 1./2./3. collapse together while a dropped item still shows", () => {
		expect(normalizeForCer("1. a\n1. b\n1. c")).toBe(normalizeForCer("1. a\n2. b\n3. c"));
		expect(normalizeForCer("1) a\n2) b")).toBe("1. a\n2. b");
	});

	it("leaves page 04's lettered sub-items verbatim -- they are not CommonMark markers", () => {
		expect(normalizeForCer("   a. water first, at the bottom")).toContain("a. water first");
	});

	it("drops the table delimiter row and re-emits cells canonically, so a shifted pipe costs nothing", () => {
		const reference = "| Ort | Höhe |\n|---|---|\n| Talstation | 620 m |";
		const shifted = "| Ort | Höhe |\n|:---|:---|\n| Talstation  |620 m |";
		expect(normalizeForCer(shifted)).toBe(normalizeForCer(reference));
	});

	it("strips heading and emphasis markers -- a pen has no bold, so a guessed level or weight is not an error", () => {
		expect(normalizeForCer("# Packliste Wochenende")).toBe("Packliste Wochenende");
		expect(normalizeForCer("**fett** und *kursiv* und _unterstrichen_")).toBe("fett und kursiv und unterstrichen");
	});
});

describe("the metric", () => {
	it("counts edits over code points", () => {
		expect(levenshtein("kitten", "sitting")).toBe(3);
		expect(levenshtein("a²", "a2")).toBe(1);
	});

	it("reproduces the measured short-page arithmetic: one character on page 09 is 4.5 %", () => {
		const ref = pageBody("09-nearly-empty-en.md");
		expect(characterErrorRate(ref, "Ask again on Thursdax.")).toBeCloseTo(1 / 22, 3);
	});

	it("one misread word on page 09 is 9.1 % -- the arithmetic behind the catastrophe floor", () => {
		const ref = pageBody("09-nearly-empty-en.md");
		expect(characterErrorRate(ref, "Ask again on Tuesday.")).toBeCloseTo(2 / 22, 2);
	});

	it("is never capped at 100 %", () => {
		expect(characterErrorRate("kurz", "eine sehr viel längere Antwort als die Referenz je war")).toBeGreaterThan(1);
	});

	it("scores a perfect transcription of every reference page at zero", () => {
		for (const name of [
			"01-clean-prose-de.md",
			"03-bulleted-list-de.md",
			"04-numbered-list-en.md",
			"05-table-de.md",
			"06-formula-en.md",
			"11-numbers-de.md",
			"12-special-chars-de.md",
		]) {
			expect(characterErrorRate(pageBody(name), pageBody(name))).toBe(0);
		}
	});

	it("takes the minimum over declared alternates, each scored against its own length", () => {
		const cer = characterErrorRate("a² + b² = c²", "$a^2 + b^2 = c^2$", ["$a^2 + b^2 = c^2$"]);
		expect(cer).toBe(0);
	});

	it("refuses an empty reference body instead of dividing by zero", () => {
		expect(() => characterErrorRate("", "etwas")).toThrow();
	});
});

describe("the structure observation", () => {
	it("records page 05's table coming back as prose -- 41 % CER is indistinguishable from misreading without this", () => {
		const ref = pageBody("05-table-de.md");
		const asProse = "Talstation auf 620 m nach 0:00, Waldrand auf 890 m nach 0:45.";
		expect(structureObservation(ref, asProse)).toEqual({ table: "lost" });
		expect(structureObservation(ref, ref)).toEqual({ table: "ok" });
	});

	it("records a list that stopped being a list, and observes nothing the reference does not have", () => {
		const ref = pageBody("03-bulleted-list-de.md");
		expect(structureObservation(ref, "Regenjacke, Taschenlampe, Karte und Brot.").list).toBe("lost");
		expect(structureObservation(pageBody("01-clean-prose-de.md"), "irgendwas")).toEqual({});
	});
});
