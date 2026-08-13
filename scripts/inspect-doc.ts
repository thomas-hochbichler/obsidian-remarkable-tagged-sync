import { readFileSync } from "node:fs";
import { auth, session as remarkableSession } from "rmapi-js";
import { getDocumentFiles } from "../src/page-hash";

const dataPath = process.argv[2];
const docId = process.argv[3];
if (!dataPath || !docId) {
	console.error("Usage: npm run inspect:doc -- <path-to-plugin-data.json> <docId>");
	process.exit(1);
}

async function main() {
	const deviceToken = JSON.parse(readFileSync(dataPath, "utf8")).deviceToken as string;
	const api = remarkableSession(await auth(deviceToken));

	const entry = (await api.listItems()).find((item) => item.id === docId);
	if (!entry) throw new Error(`no entry ${docId}`);
	console.log(`visibleName: ${entry.visibleName}  hash: ${entry.hash}`);

	const content = (await api.getContent(entry.id, entry.hash)) as Record<string, unknown>;
	console.log(`fileType: ${JSON.stringify(content.fileType)}  formatVersion: ${JSON.stringify(content.formatVersion)}`);
	console.log(`legacy pages[]: ${Array.isArray(content.pages) ? (content.pages as string[]).length : "absent"}`);

	const { pages: pageHashes, images } = await getDocumentFiles(api, entry.id, entry.hash);
	console.log(`.rm files present: ${pageHashes.size}, images: ${images.size}`);

	const cPages = (content.cPages as { pages?: Record<string, unknown>[] } | undefined)?.pages ?? [];
	console.log(`cPages.pages: ${cPages.length}`);
	console.log("raw-order# | idx | deleted | redir | has .rm | id");
	cPages.forEach((page, i) => {
		const id = page.id as string;
		console.log(
			[
				String(i).padStart(3),
				JSON.stringify((page.idx as { value?: string })?.value).padEnd(8),
				JSON.stringify(page.deleted ?? null).padEnd(34),
				JSON.stringify((page.redir as { value?: number })?.value ?? null).padEnd(5),
				pageHashes.has(id) ? "rm " : "-- ",
				id,
			].join(" | "),
		);
	});

	console.log("\npageTags:", JSON.stringify(content.pageTags ?? null));

}
main();
