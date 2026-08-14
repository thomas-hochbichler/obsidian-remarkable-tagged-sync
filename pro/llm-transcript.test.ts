import { describe, expect, it } from "vitest";
import { sanitizeTranscript, TRANSCRIPTION_PROMPT } from "./llm-transcript";

describe("sanitizeTranscript", () => {
	it("leaves a normal transcript unchanged", () => {
		const text = "# Notes\n\n- one\n- two\n\nA paragraph.";
		expect(sanitizeTranscript(text)).toBe(text);
	});

	it("removes a whole-response ```markdown fence and its closer", () => {
		const text = "```markdown\n# Notes\n\n- one\n```";
		expect(sanitizeTranscript(text)).toBe("# Notes\n\n- one");
	});

	it("removes a bare ``` fence wrapping the whole response", () => {
		const text = "```\n# Notes\n```";
		expect(sanitizeTranscript(text)).toBe("# Notes");
	});

	it("removes a ```md fence wrapping the whole response", () => {
		const text = "```md\nhello\n```";
		expect(sanitizeTranscript(text)).toBe("hello");
	});

	it("keeps an inner ```python block intact", () => {
		const text = "Here is some code:\n\n```python\nprint('hi')\n```\n\nDone.";
		expect(sanitizeTranscript(text)).toBe(text);
	});

	it("does not strip a whole-response ```python fence (non-md info string)", () => {
		const text = "```python\nprint('hi')\n```";
		expect(sanitizeTranscript(text)).toBe(text);
	});

	it("does not strip a fence that does not reach both edges", () => {
		const text = "```markdown\n# Notes\n```\n\ntrailing text";
		expect(sanitizeTranscript(text)).toBe(text);
	});

	it("removes a 'Here is the transcript:' preamble line and the blank line after it", () => {
		const text = "Here is the transcript:\n\n# Notes\n\n- one";
		expect(sanitizeTranscript(text)).toBe("# Notes\n\n- one");
	});

	it("removes a 'Here are the transcription.' preamble line", () => {
		const text = "Here are the transcription.\nsome text";
		expect(sanitizeTranscript(text)).toBe("some text");
	});

	it("strips a preamble line then an outer fence", () => {
		const text = "Here is the transcript:\n```markdown\n# Notes\n```";
		expect(sanitizeTranscript(text)).toBe("# Notes");
	});

	it("does not treat an ordinary first sentence as preamble", () => {
		const text = "Here is my grocery list for the week.\n\n- milk";
		expect(sanitizeTranscript(text)).toBe(text);
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeTranscript("\n\n# Notes\n\n")).toBe("# Notes");
	});

	it("returns empty string for empty input", () => {
		expect(sanitizeTranscript("")).toBe("");
	});
});

describe("TRANSCRIPTION_PROMPT", () => {
	it("names GFM task lists and tables", () => {
		expect(TRANSCRIPTION_PROMPT).toContain("task lists");
		expect(TRANSCRIPTION_PROMPT).toContain("tables");
	});

	it("carries an anti-invention rule", () => {
		expect(TRANSCRIPTION_PROMPT.toLowerCase()).toContain("do not invent");
	});
});
