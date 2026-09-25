import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCache } from "../../src/analysis/cache";
import { extractFrame } from "../../src/analysis/frames";
import { findBins, hasAudio } from "../../src/analysis/media";
import { detectScenes } from "../../src/analysis/scenes";
import { parseWhisperJson } from "../../src/analysis/transcript";
import { ToolError } from "../../src/errors";
import { makeTestVideo } from "../helpers/media";

const bins = await findBins();

describe("parseWhisperJson", () => {
	it("turns whisper-cli -oj output into sentence segments", () => {
		expect(
			parseWhisperJson({
				result: { language: "en" },
				transcription: [
					{ offsets: { from: 0, to: 1500 }, text: " Open the settings page." },
					{ offsets: { from: 1500, to: 2000 }, text: " [BLANK_AUDIO]" },
					{ offsets: { from: 2000, to: 4200 }, text: " Then click save." },
				],
			}),
		).toEqual({
			language: "en",
			segments: [
				{ startSec: 0, endSec: 1.5, text: "Open the settings page." },
				{ startSec: 2, endSec: 4.2, text: "Then click save." },
			],
		});
	});
});

describe.skipIf(!bins.ffmpeg || !bins.ffprobe)("ffmpeg-backed helpers", () => {
	let dir: string;
	let video: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-media-"));
		video = await makeTestVideo(bins.ffmpeg!, dir);
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("detects the hard cut at 3 s", async () => {
		const scenes = (await detectScenes(bins.ffmpeg!, video)).filter((t) => t > 0.1);
		expect(scenes).toHaveLength(1);
		expect(scenes[0]).toBeCloseTo(3, 1);
	});

	it("extracts a JPEG frame", async () => {
		const jpeg = await extractFrame(bins.ffmpeg!, video, 1, 160);
		expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	});

	it("fails clearly past the end of the video", async () => {
		await expect(extractFrame(bins.ffmpeg!, video, 60)).rejects.toThrow(ToolError);
	});

	it("reports that the test video has no audio", async () => {
		expect(await hasAudio(bins.ffprobe!, video)).toBe(false);
	});

	it("caches per asset and invalidates when the video changes", async () => {
		const cache = createCache(join(dir, "cache"));
		await cache.set("asset_1", "scenes", video, [3]);
		expect(await cache.get<number[]>("asset_1", "scenes", video)).toEqual([3]);
		await utimes(video, new Date(), new Date(Date.now() + 60_000));
		expect(await cache.get<number[]>("asset_1", "scenes", video)).toBeNull();
	});
});
