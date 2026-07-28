import { readFileSync } from "node:fs";
import { parseRmV6 } from "../src/rm-parser";

const path = process.argv[2];
if (!path) {
	console.error("Usage: npm run inspect:rm -- <path-to.rm>");
	process.exit(1);
}

const page = parseRmV6(new Uint8Array(readFileSync(path)));

console.log(`format version: ${page.formatVersion}`);
console.log(`layers: ${page.layers.length}`);
for (const layer of page.layers) {
	console.log(`- ${layer.id} ${JSON.stringify(layer.name)}: ${layer.strokes.length} stroke(s)`);
	for (const stroke of layer.strokes) {
		console.log(
			`    pen=${stroke.penType} color=${stroke.color} brushSize=${stroke.brushSize.toFixed(2)} points=${stroke.points.length}`,
		);
	}
}
