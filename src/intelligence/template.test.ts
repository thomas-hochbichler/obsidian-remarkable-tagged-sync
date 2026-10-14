import { describe, expect, it } from "vitest";
import { analyseTemplate, renderTemplate, starterTemplate } from "./template";

describe("analyseTemplate", () => {
	it("makes a placeholder alone under its own heading a region, blank lines allowed", () => {
		expect(analyseTemplate("# Day\n\n## Tasks\n\n{{ts.tasks}}\n\n## Notes\nfree text", ["tasks"])).toEqual({ tasks: { kind: "region", heading: { level: 2, text: "Tasks" } } });
	});

	it("fills a placeholder once when it shares its heading, sits in a sentence, a callout or before any heading", () => {
		const template = ["{{ts.summary}}", "## Both", "{{ts.tasks}}", "{{ts.decisions}}", "## Inline", "Mood: {{ts.mood}}", "## Callout", "> {{ts.ideas}}"].join("\n");
		expect(analyseTemplate(template, ["summary", "tasks", "decisions", "mood", "ideas"])).toEqual({
			summary: { kind: "once" },
			tasks: { kind: "once" },
			decisions: { kind: "once" },
			mood: { kind: "once" },
			ideas: { kind: "once" },
		});
	});

	it("reports a Slot the template does not place", () => {
		expect(analyseTemplate("## Tasks\n{{ts.tasks}}", ["summary"])).toEqual({ summary: { kind: "absent" } });
	});
});

describe("renderTemplate", () => {
	const values = {
		ts: { tasks: "- [ ] Call Bob", "date.written": "2026-09-28", "page.link": "![[p3.png]]", summary: "" },
		title: "2026-09-28 Work p3",
		formatDate: (format: string | null) => (format === null ? "2026-09-28" : `date(${format})`),
		formatTime: (format: string | null) => (format === null ? "10:00" : `time(${format})`),
	};

	it("fills ts variables and the core title, date and time, with formats", () => {
		expect(renderTemplate("# {{title}}\n{{date}} {{date:DD.MM.}} {{time}} {{time:HH}}\nwritten {{ts.date.written}}\n## Tasks\n{{ts.tasks}}\n{{ts.page.link}}", values)).toBe(
			"# 2026-09-28 Work p3\n2026-09-28 date(DD.MM.) 10:00 time(HH)\nwritten 2026-09-28\n## Tasks\n- [ ] Call Bob\n![[p3.png]]",
		);
	});

	it("fills a Slot the Profile does not run, or one with nothing extracted, with nothing, and leaves other braces alone", () => {
		expect(renderTemplate("{{ts.decisions}}|{{ts.summary}}|{{other}}", values)).toBe("||{{other}}");
	});
});

describe("starterTemplate", () => {
	it("gives every body Slot its own heading, so every Slot is a region, and a frontmatter Slot none", () => {
		const starter = starterTemplate([
			{ id: "tasks", name: "Tasks" },
			{ id: "summary", name: "Summary" },
			{ id: "tags", name: "Tags", property: "tags" },
		]);
		expect(starter).not.toContain("Tags");
		expect(analyseTemplate(starter, ["tasks", "summary"])).toEqual({
			tasks: { kind: "region", heading: { level: 2, text: "Tasks" } },
			summary: { kind: "region", heading: { level: 2, text: "Summary" } },
		});
		expect(starter).toContain("{{ts.page.link}}");
	});
});
