import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { round3 } from "../edit/timemap";
import { ToolError } from "../errors";
import { run } from "./media";

export interface SampledFrame {
	t: number;
	path: string;
}

/**
 * Frames at `fps`, minus near-duplicates (`mpdecimate`), at most `maxWidth` wide.
 * A kept frame stands for every dropped frame after it, so static screens cost one frame.
 */
export async function sampleFrames(
	ffmpeg: string,
	video: string,
	outDir: string,
	fps = 2,
	maxWidth = 1920,
): Promise<SampledFrame[]> {
	await mkdir(outDir, { recursive: true });
	const { stderr } = await run(
		ffmpeg,
		[
			"-hide_banner", "-nostats", "-i", video, "-an",
			"-vf", `fps=${fps},mpdecimate,scale='min(${maxWidth},iw)':-2,showinfo`,
			"-fps_mode", "vfr", "-q:v", "3",
			join(outDir, "%06d.jpg"),
		],
		{ timeoutMs: 600_000 },
	);
	const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => round3(Number(m[1])));
	const files = (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
	if (files.length !== times.length) {
		throw new ToolError(`Frame sampling mismatch for ${video}: ${files.length} files, ${times.length} timestamps.`);
	}
	return files.map((file, i) => ({ t: times[i]!, path: join(outDir, file) }));
}
