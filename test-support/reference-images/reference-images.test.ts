// The reference-image gate (ticket 15): every committed PNG is decoded and compared, pixel for pixel,
// to what the rasterizer produces today.
//
// A stale image is worse than no image -- it shows a reader an input that was never measured, which is
// exactly the silent drift `renderVersion` exists to catch. So this runs on every commit rather than
// at release time, and it compares the *pixels* rather than the file bytes: the encoding is a build
// detail (a zlib version could change the compressed bytes with nothing changed about the image), the
// pixels are the claim.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePublicationPng, encodePublicationPng, IMAGES_DIR, referenceImages } from "./render";

describe("reference images", () => {
	// One test rather than fifteen: the failure names the page and how far it drifted, so splitting it
	// per page would buy nothing and put fifteen near-identical rows in the matrix.
	it("are the images the backends were given", () => {
		const drifted: string[] = [];
		for (const image of referenceImages()) {
			const path = join(IMAGES_DIR, `${image.name}.png`);
			if (!existsSync(path)) {
				drifted.push(`${image.name}: not committed`);
				continue;
			}
			const committed = decodePublicationPng(readFileSync(path));
			if (committed.width !== image.raster.width || committed.height !== image.raster.height) {
				drifted.push(`${image.name}: committed ${committed.width}x${committed.height}, rasterizes ${image.raster.width}x${image.raster.height}`);
				continue;
			}
			const differing = committed.pixels.reduce((count, pixel, at) => count + (pixel === image.raster.pixels[at] ? 0 : 1), 0);
			if (differing > 0) drifted.push(`${image.name}: ${differing} of ${image.raster.pixels.length} pixels differ`);
		}
		if (drifted.length > 0) {
			expect.fail(
				`The published input no longer matches the measured one:\n  ${drifted.join("\n  ")}\n` +
					`Regenerate with npm run images:update, in the commit that changed the drawing.`,
			);
		}
	});

	it("encodes the same image byte-identically twice, so a diff is always a change and never noise", () => {
		const [first] = referenceImages();
		expect(Buffer.from(encodePublicationPng(first.raster))).toEqual(Buffer.from(first.png));
	});

	// The whole point of compressing these: uncompressed they are 20 MB, which would land in every
	// clone and again in the history on every rasterizer change.
	it("stays small enough to live in the repo", () => {
		const bytes = referenceImages().reduce((sum, image) => sum + image.png.length, 0);
		expect(bytes).toBeLessThan(2 * 1024 * 1024);
	});
});
