import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CursorSample,
	findClicks,
	findStillStretches,
	loadCursorSamples,
	medianPosition,
} from "../../src/analysis/cursor";

const s = (timeMs: number, cx: number, cy: number, interactionType = "move"): CursorSample => ({
	timeMs,
	cx,
	cy,
	interactionType,
});

const samples = [
	s(0, 0.1, 0.1),
	s(500, 0.2, 0.2),
	s(1000, 0.5, 0.5, "click"),
	s(5000, 0.8, 0.8),
	s(5100, 0.803, 0.8),
];

describe("cursor analysis", () => {
	it("finds clicks", () => {
		expect(findClicks(samples)).toEqual([{ sec: 1, cx: 0.5, cy: 0.5 }]);
	});

	it("classifies still stretches: with a click → dwell, long and click-free → idle", () => {
		expect(findStillStretches(samples, 10_000)).toEqual([
			{ startSec: 1, endSec: 5, cx: 0.5, cy: 0.5, kind: "dwell" },
			{ startSec: 5, endSec: 10, cx: 0.8, cy: 0.8, kind: "idle" },
		]);
	});

	it("calls a short click-free stillness a dwell", () => {
		expect(findStillStretches([s(0, 0.1, 0.1), s(1700, 0.5, 0.5)], 1700)).toEqual([
			{ startSec: 0, endSec: 1.7, cx: 0.1, cy: 0.1, kind: "dwell" },
		]);
	});

	it("returns nothing without samples", () => {
		expect(findStillStretches([], 5000)).toEqual([]);
	});

	it("takes the median position inside a window", () => {
		expect(medianPosition(samples, 0, 1.2)).toEqual({ cx: 0.2, cy: 0.2 });
		expect(medianPosition(samples, 20, 21)).toBeNull();
	});

	it("loads the cursor file next to a video, sorted, or null when absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "osmcp-cursor-"));
		const video = join(dir, "rec.mp4");
		await writeFile(`${video}.cursor.json`, JSON.stringify({ version: 2, samples: [s(900, 0.3, 0.3), s(100, 0.1, 0.1)] }));
		expect((await loadCursorSamples(video))!.map((x) => x.timeMs)).toEqual([100, 900]);
		expect(await loadCursorSamples(join(dir, "none.mp4"))).toBeNull();
		await rm(dir, { recursive: true, force: true });
	});
});
