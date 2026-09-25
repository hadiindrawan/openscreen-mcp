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
