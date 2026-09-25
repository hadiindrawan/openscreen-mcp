import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBins, run } from "../../src/analysis/media";
import { sampleFrames } from "../../src/analysis/sample";
import { makeTestVideo } from "../helpers/media";

const bins = await findBins();

describe.skipIf(!bins.ffmpeg || !bins.ffprobe)("sampleFrames", () => {
	let dir: string;
	let video: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-sample-"));
		video = await makeTestVideo(bins.ffmpeg!, dir);
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("keeps only frames that change, with their source times", async () => {
		const out = join(dir, "frames");
		const frames = await sampleFrames(bins.ffmpeg!, video, out);
		expect(frames.map((f) => f.t)).toEqual([0, 3]);
		expect((await readdir(out)).sort()).toEqual(["000001.jpg", "000002.jpg"]);
		expect(frames[1]!.path).toBe(join(out, "000002.jpg"));
	});

	it("never upscales a video narrower than the limit", async () => {
		const frames = await sampleFrames(bins.ffmpeg!, video, join(dir, "small"));
		const { stdout } = await run(bins.ffprobe!, [
			"-v", "error", "-select_streams", "v", "-show_entries", "stream=width", "-of", "csv=p=0", frames[0]!.path,
		]);
		expect(stdout.toString().trim()).toBe("320");
	});
});
