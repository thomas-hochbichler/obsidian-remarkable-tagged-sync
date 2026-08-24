// The render-golden gate (ticket 12): the whole render cluster's output, regenerated on every run
// and compared to the committed text. A failure names the section and the common delta -- "9 of 77
// operations differ, all of them moved by (+7.0, +0.0) pt" is a diagnosis; 77 changed lines is a
// puzzle that gets goldens updated by reflex, which is the failure mode this format exists to
// avoid. Accepting a drawn change costs a RENDER_VERSION bump, enforced by goldens:update.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnoseGoldenChange, renderGolden } from "./extract";
import { GOLDENS_DIR, goldenTargets } from "./targets";

describe("render goldens", () => {
	for (const target of goldenTargets()) {
		it(`${target.name} renders exactly its committed golden`, async () => {
			const path = join(GOLDENS_DIR, `${target.name}.golden.txt`);
			if (!existsSync(path)) expect.fail(`${path} does not exist -- generate it with npm run goldens:update`);
			const diff = diagnoseGoldenChange(target.name, readFileSync(path, "utf8"), await renderGolden(target));
			if (diff !== null) expect.fail(diff.message);
		});
	}

	it("renders byte-identical goldens twice, so a diff is always a change and never noise", async () => {
		const target = goldenTargets()[0];
		expect(await renderGolden(target)).toBe(await renderGolden(target));
	});
});
