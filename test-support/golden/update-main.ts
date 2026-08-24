// `npm run goldens:update` -- rewrites the render goldens, under the one condition that keeps the
// update from becoming a reflex: a change to what a user can see (`## pdf`, `## text layer`,
// `## raster`) is refused while `RENDER_VERSION` is still the version the committed golden was
// generated at. The renderer changing and the bump that makes every note re-render are one event;
// today's sync silently skips every page when they are shipped apart, and this is the first
// mechanical link between them. A change confined to `## scene` needs no bump -- nothing drawn
// moved.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RENDER_VERSION } from "../../src/sync-engine";
import { diagnoseGoldenChange, goldenRenderVersion, renderGolden } from "./extract";
import { GOLDENS_DIR, goldenTargets } from "./targets";

async function main() {
	mkdirSync(GOLDENS_DIR, { recursive: true });
	const refused: string[] = [];
	let written = 0;

	for (const target of goldenTargets()) {
		const path = join(GOLDENS_DIR, `${target.name}.golden.txt`);
		const fresh = await renderGolden(target);
		if (!existsSync(path)) {
			writeFileSync(path, fresh);
			console.log(`new   ${path}`);
			written++;
			continue;
		}
		const committed = readFileSync(path, "utf8");
		const diff = diagnoseGoldenChange(target.name, committed, fresh);
		if (diff === null) continue;
		const committedVersion = goldenRenderVersion(committed);
		if (diff.drawnChanged && committedVersion !== null && committedVersion >= RENDER_VERSION) {
			refused.push(
				`${target.name}: ${diff.changedSections.join(", ")} changed but RENDER_VERSION is still ${RENDER_VERSION} -- a drawn change without the bump makes every synced note keep its stale render. Bump RENDER_VERSION in src/sync-engine.ts in the same change, then update.`,
			);
			continue;
		}
		writeFileSync(path, fresh);
		console.log(`wrote ${path} (${diff.changedSections.join(", ")})`);
		written++;
	}

	if (refused.length > 0) {
		console.error("\ngoldens:update REFUSED:");
		for (const line of refused) console.error(`  ${line}`);
		process.exit(1);
	}
	console.log(written === 0 ? "goldens unchanged" : `${written} golden(s) written`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
