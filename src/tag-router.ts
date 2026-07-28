export type TagFolderMap = Record<string, string>;

export class TagRouter {
	constructor(private readonly mapping: TagFolderMap) {}

	resolveFolder(tag: string): string | null {
		return this.mapping[tag] ?? null;
	}
}
