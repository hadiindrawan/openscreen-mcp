import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "../../src/analysis/media";

/** A sine tone; the codec follows the extension (.wav, .m4a → aac, .mp3 → libmp3lame). */
export async function makeTone(ffmpeg: string, path: string, seconds: number, hz = 800): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const codec = path.endsWith(".m4a") ? ["-c:a", "aac"] : path.endsWith(".mp3") ? ["-c:a", "libmp3lame"] : [];
	await run(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${seconds}`, ...codec, path]);
}

/** Build a sound folder: { click: [["a.wav", 0.2]], "(root)": [["pop.wav", 0.3]] }. */
export async function makeSoundFolder(
	ffmpeg: string,
	dir: string,
	spec: Record<string, [string, number][]>,
): Promise<string> {
	const folder = join(dir, "sound-effects");
	for (const [category, files] of Object.entries(spec)) {
		for (const [name, seconds] of files) {
			await makeTone(ffmpeg, category === "(root)" ? join(folder, name) : join(folder, category, name), seconds);
		}
	}
	return folder;
}
