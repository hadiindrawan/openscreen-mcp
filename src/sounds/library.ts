import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { requireBin, run } from "../analysis/media";
import { ToolError } from "../errors";

export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac"];
export const ROOT_CATEGORY = "(root)";

export interface SoundFile {
	category: string;
	name: string;
	path: string;
	durationSec: number;
}

export interface SoundLibrary {
	folder: string;
	categories: Record<string, SoundFile[]>;
}

export function setupHint(folder: string): string {
	return `No sound effects found. Create ${folder}/click/ (and typing/, whoosh/, pop/ …), drop .mp3/.wav/.m4a/.aac files in, then retry.`;
}

const durations = new Map<string, number>();

async function durationOf(ffprobe: string, path: string): Promise<number | null> {
	const s = await stat(path);
	const key = `${path}:${s.size}:${Math.round(s.mtimeMs)}`;
	const cached = durations.get(key);
	if (cached !== undefined) return cached;
	try {
		const { stdout } = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
		const value = Number.parseFloat(stdout.toString().trim());
		if (!Number.isFinite(value) || value <= 0) return null;
		durations.set(key, value);
		return value;
	} catch {
		return null;
	}
}

const isAudio = (name: string) => !name.startsWith(".") && AUDIO_EXTENSIONS.includes(extname(name).toLowerCase());

export async function scanLibrary(folder: string, ffprobe: string | null): Promise<SoundLibrary> {
	let entries: Dirent[];
	try {
		entries = await readdir(folder, { withFileTypes: true });
	} catch {
		throw new ToolError(setupHint(folder));
	}
	const probe = requireBin(ffprobe, "ffprobe", "Install it with `brew install ffmpeg`.");
	const categories: Record<string, SoundFile[]> = {};
	const add = async (category: string, dir: string, name: string) => {
		if (!isAudio(name)) return;
		const path = join(dir, name);
		const durationSec = await durationOf(probe, path);
		if (durationSec === null) return;
		(categories[category] ??= []).push({ category, name, path, durationSec });
	};
	for (const entry of entries) {
		if (entry.isDirectory() && !entry.name.startsWith(".")) {
			const dir = join(folder, entry.name);
			for (const name of await readdir(dir)) await add(entry.name, dir, name);
		} else if (entry.isFile()) {
			await add(ROOT_CATEGORY, folder, entry.name);
		}
	}
	for (const files of Object.values(categories)) files.sort((a, b) => a.name.localeCompare(b.name));
	if (Object.keys(categories).length === 0) throw new ToolError(setupHint(folder));
	return { folder, categories };
}

export function resolveSound(lib: SoundLibrary, sound: string): SoundFile[] {
	const names = Object.keys(lib.categories).filter((c) => c !== ROOT_CATEGORY).sort();
	if (lib.categories[sound] && sound !== ROOT_CATEGORY) return lib.categories[sound]!;
	const slash = sound.indexOf("/");
	if (slash > 0) {
		const category = sound.slice(0, slash);
		const name = sound.slice(slash + 1);
		const files = lib.categories[category];
		if (!files) throw new ToolError(`No sound category "${category}". Categories: ${names.join(", ")}.`);
		const file = files.find((f) => f.name === name);
		if (!file) throw new ToolError(`No file "${name}" in ${category}. Files: ${files.map((f) => f.name).join(", ")}.`);
		return [file];
	}
	const root = lib.categories[ROOT_CATEGORY]?.find((f) => f.name === sound);
	if (root) return [root];
	throw new ToolError(`No sound "${sound}". Categories: ${names.join(", ")}.`);
}
