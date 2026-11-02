import { describe, expect, it } from "vitest";
import { bookIdentity } from "./readwise-book";

const SMITH = { creatorType: "author", firstName: "Anna", lastName: "Smith" } as const;
const LEE = { creatorType: "author", firstName: "Bo", lastName: "Lee" } as const;

// Readwise spec §1.2 and §11 P7: which name the Readwise book gets, and who it is by.
describe("bookIdentity", () => {
	it.each([
		{
			case: "a Zotero paper, ahead of the book's own metadata and the tablet's name",
			input: { zotero: { title: "Best Practices für Prompting", creators: [SMITH] }, epub: { title: "Other", authors: ["Someone"] }, visibleName: "prompting.pdf" },
			expected: { title: "Best Practices für Prompting", author: "Anna Smith" },
		},
		{
			case: "several authors, in Zotero's order",
			input: { zotero: { title: "Retrieval", creators: [SMITH, LEE] }, visibleName: "retrieval" },
			expected: { title: "Retrieval", author: "Anna Smith, Bo Lee" },
		},
		{
			case: "an institution, by its one name",
			input: { zotero: { title: "Annual Report", creators: [{ creatorType: "author", name: "World Health Organization" }] }, visibleName: "report" },
			expected: { title: "Annual Report", author: "World Health Organization" },
		},
		{
			case: "only the authors when a paper also has editors",
			input: { zotero: { title: "Handbook", creators: [{ creatorType: "editor", firstName: "Eve", lastName: "Editor" }, SMITH] }, visibleName: "handbook" },
			expected: { title: "Handbook", author: "Anna Smith" },
		},
		{
			case: "every creator when a paper has editors only",
			input: { zotero: { title: "Proceedings", creators: [{ creatorType: "editor", firstName: "Eve", lastName: "Editor" }, { creatorType: "seriesEditor", firstName: "", lastName: "Gray" }] }, visibleName: "proceedings" },
			expected: { title: "Proceedings", author: "Eve Editor, Gray" },
		},
		{
			case: "the editors when the only author's name is blank",
			input: { zotero: { title: "Proceedings", creators: [{ creatorType: "author", name: "  " }, { creatorType: "editor", firstName: "Eve", lastName: "Editor" }] }, visibleName: "proceedings" },
			expected: { title: "Proceedings", author: "Eve Editor" },
		},
		{
			case: "no author at all for a paper with no creators",
			input: { zotero: { title: "Untitled draft", creators: [] }, visibleName: "draft" },
			expected: { title: "Untitled draft" },
		},
		{
			case: "the tablet's name when the Zotero item's title is blank",
			input: { zotero: { title: "   ", creators: [SMITH] }, visibleName: "scan 42" },
			expected: { title: "scan 42", author: "Anna Smith" },
		},
		{
			case: "an EPUB's own title and authors",
			input: { epub: { title: "Good Omens", authors: ["Terry Pratchett", "Neil Gaiman"] }, visibleName: "good-omens" },
			expected: { title: "Good Omens", author: "Terry Pratchett, Neil Gaiman" },
		},
		{
			case: "the tablet's name, and no author, for an EPUB without metadata",
			input: { epub: { authors: [] }, visibleName: "Alice" },
			expected: { title: "Alice" },
		},
		{
			case: "the tablet's name, and no author, for a notebook",
			input: { visibleName: "Meeting notes" },
			expected: { title: "Meeting notes" },
		},
	].map((row) => [row.case, row] as const))("names %s", (_case, { input, expected }) => {
		expect(bookIdentity(input)).toEqual(expected);
	});

	// Never blank: Readwise refuses a blank author, and a placeholder would be a made-up author.
	it("leaves out the author key rather than sending it empty", () => {
		expect(bookIdentity({ visibleName: "Meeting notes" })).not.toHaveProperty("author");
	});
});
