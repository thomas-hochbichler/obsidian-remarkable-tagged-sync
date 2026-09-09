// Writes the committed reference images: `npm run images:update`.
//
// Run this when `reference-images.test.ts` fails because the rasterizer or the PNG encoder changed.
// That failure is not noise: the images are the published *input* to every number on the accuracy
// page, so regenerating them is publishing a new input, and it belongs in the same commit as the
// change that caused it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGES_DIR, referenceImages } from "./render";

mkdirSync(IMAGES_DIR, { recursive: true });
let bytes = 0;
for (const image of referenceImages()) {
	writeFileSync(join(IMAGES_DIR, `${image.name}.png`), image.png);
	bytes += image.png.length;
	console.log(`${image.name.padEnd(30)} ${image.raster.width}x${image.raster.height}  ${(image.png.length / 1024).toFixed(0)} KiB`);
}
console.log(`\n-> ${IMAGES_DIR}  (${(bytes / 1024 / 1024).toFixed(2)} MiB)`);
