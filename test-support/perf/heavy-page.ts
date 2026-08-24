// The deterministic heavy page both halves of the perf gate measure (ticket 21). Real device
// pages are too fast to time -- the measured medians were 0.2-5 ms with noise at 2.5-12x the
// median -- so the signal has to come from a page big enough to swamp the noise: at 2000 strokes
// x 50 points the same machine measured 210 ms with a 17 % spread. The stroke pattern is a fixed
// arithmetic walk, never random, so every run renders byte-identical work.

import type { RmPage, RmStroke } from "../../src/rm-parser";

export function heavyPage(strokes: number, pointsPer = 50): RmPage {
	const layerStrokes: RmStroke[] = [];
	for (let s = 0; s < strokes; s++) {
		const points = [];
		for (let p = 0; p < pointsPer; p++) {
			points.push({ x: -600 + ((s * 37 + p * 11) % 1200), y: (s * 53 + p * 7) % 1800, speed: 0, width: 8, pressure: 128, direction: 0 });
		}
		layerStrokes.push({ layerId: "0001", id: String(s), timestamp: "0001", penType: 17, color: 0, brushSize: 2, points });
	}
	return { formatVersion: 6, layers: [{ id: "0001", name: "Layer 1", visible: true, strokes: layerStrokes }] };
}
