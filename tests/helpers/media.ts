import { join } from "node:path";
import { run } from "../../src/analysis/media";

/** 6 s silent video: red for 3 s, then a hard cut to blue for 3 s. */
export async function makeTestVideo(ffmpeg: string, dir: string): Promise<string> {
	const out = join(dir, "test.mp4");
	await run(ffmpeg, [
		"-y", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=320x240:d=3:r=30",
		"-f", "lavfi", "-i", "color=c=blue:s=320x240:d=3:r=30",
		"-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0",
		"-pix_fmt", "yuv420p",
		out,
	]);
	return out;
}
