import type { Rect } from "../censor/classify";
import { ToolError } from "../errors";
import { run } from "./media";

export async function extractFrame(
	ffmpeg: string,
	video: string,
	sourceSec: number,
	width = 1280,
): Promise<Buffer> {
	const { stdout } = await run(ffmpeg, [
		"-hide_banner", "-loglevel", "error",
		"-ss", sourceSec.toFixed(3), "-i", video,
		"-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4",
		"-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
	]);
	if (stdout.length === 0) throw new ToolError(`No frame at ${sourceSec}s of ${video}.`);
	return stdout;
}

/** A frame with red outlines drawn around each 0–1 rect. */
export async function extractFrameWithBoxes(
	ffmpeg: string,
	video: string,
	sourceSec: number,
	rects: Rect[],
	width = 1280,
): Promise<Buffer> {
	const boxes = rects.map(
		(r) =>
			`drawbox=x=iw*${r.x.toFixed(4)}:y=ih*${r.y.toFixed(4)}:w=iw*${r.w.toFixed(4)}:h=ih*${r.h.toFixed(4)}:color=red@0.9:t=4`,
	);
	const { stdout } = await run(ffmpeg, [
		"-hide_banner", "-loglevel", "error",
		"-ss", sourceSec.toFixed(3), "-i", video,
		"-frames:v", "1", "-vf", [`scale=${width}:-2`, ...boxes].join(","), "-q:v", "4",
		"-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
	]);
	if (stdout.length === 0) throw new ToolError(`No frame at ${sourceSec}s of ${video}.`);
	return stdout;
}
