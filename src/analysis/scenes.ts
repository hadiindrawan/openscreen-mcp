import { round3 } from "../edit/timemap";
import { run } from "./media";

/** Source seconds where the picture changes sharply (page loads, dialogs, tab switches). */
export async function detectScenes(ffmpeg: string, video: string, threshold = 0.3): Promise<number[]> {
	const { stderr } = await run(
		ffmpeg,
		[
			"-hide_banner", "-nostats", "-i", video, "-an",
			"-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
			"-f", "null", "-",
		],
		{ timeoutMs: 600_000 },
	);
	const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => round3(Number(m[1])));
	return [...new Set(times)].sort((a, b) => a - b);
}
