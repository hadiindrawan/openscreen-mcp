import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { basename, join } from "node:path";
import { ToolError } from "../errors";

export interface Bins {
	ffmpeg: string | null;
	ffprobe: string | null;
	whisper: string | null;
}

// MCP hosts often start servers with a minimal PATH, so also look where Homebrew installs.
const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export async function findBinary(
	name: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
	const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...EXTRA_DIRS];
	for (const dir of dirs) {
		const candidate = join(dir, name);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return null;
}

export async function findBins(env: Record<string, string | undefined> = process.env): Promise<Bins> {
	return {
		ffmpeg: await findBinary("ffmpeg", env),
		ffprobe: await findBinary("ffprobe", env),
		whisper: await findBinary("whisper-cli", env),
	};
}

export function requireBin(path: string | null, name: string, hint: string): string {
	if (!path) throw new ToolError(`${name} not found. ${hint}`);
	return path;
}

export function run(
	bin: string,
	args: string[],
	opts: { timeoutMs?: number } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			bin,
			args,
			{ encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000 },
			(error, stdout, stderr) => {
				const errText = stderr.toString();
				if (error) {
					const tail = errText.trim().split("\n").slice(-3).join(" ");
					reject(new ToolError(`${basename(bin)} failed: ${tail || error.message}`));
				} else {
					resolve({ stdout, stderr: errText });
				}
			},
		);
	});
}

export async function hasAudio(ffprobe: string, video: string): Promise<boolean> {
	const { stdout } = await run(ffprobe, [
		"-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", video,
	]);
	return stdout.toString().trim().length > 0;
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
