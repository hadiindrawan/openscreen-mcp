import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { round3 } from "../edit/timemap";
import { run } from "./media";

export interface Transcript {
	language: string;
	segments: { startSec: number; endSec: number; text: string }[];
}

interface WhisperJson {
	result?: { language?: string };
	transcription?: { offsets: { from: number; to: number }; text: string }[];
}

export function parseWhisperJson(json: unknown): Transcript {
	const data = json as WhisperJson;
	return {
		language: data.result?.language ?? "unknown",
		segments: (data.transcription ?? [])
			.map((s) => ({
				startSec: round3(s.offsets.from / 1000),
				endSec: round3(s.offsets.to / 1000),
				text: s.text.trim(),
			}))
			.filter((s) => s.text.length > 0 && s.text !== "[BLANK_AUDIO]"),
	};
}

export async function transcribeVideo(opts: {
	ffmpeg: string;
	whisper: string;
	model: string;
	video: string;
	workDir: string;
}): Promise<Transcript> {
	await mkdir(opts.workDir, { recursive: true });
	const wav = join(opts.workDir, "audio.wav");
	const base = join(opts.workDir, "whisper");
	try {
		await run(
			opts.ffmpeg,
			["-y", "-hide_banner", "-loglevel", "error", "-i", opts.video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
			{ timeoutMs: 600_000 },
		);
		await run(opts.whisper, ["-m", opts.model, "-f", wav, "-l", "auto", "-oj", "-of", base, "-np"], {
			timeoutMs: 1_800_000,
		});
		return parseWhisperJson(JSON.parse(await readFile(`${base}.json`, "utf8")));
	} finally {
		await rm(opts.workDir, { recursive: true, force: true });
	}
}
