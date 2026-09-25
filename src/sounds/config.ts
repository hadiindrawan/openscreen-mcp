import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolError } from "../errors";

export const DEFAULT_VOLUME_DB: Record<string, number> = { click: -8, typing: -12, whoosh: -4, pop: -6 };
export const FALLBACK_DB = -6;

export interface SoundsConfig {
	path: string;
	folder: string;
	volumeDb: Record<string, number>;
}

const fileSchema = z
	.object({
		folder: z.string().min(1).optional(),
		volumeDb: z.record(z.string(), z.number()).optional(),
	})
	.strict();

export function expandHome(p: string, home = homedir()): string {
	return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

export function clampDb(db: number): number {
	return Math.min(12, Math.max(-60, db));
}

export async function loadSoundsConfig(path: string, home = homedir()): Promise<SoundsConfig> {
	const base: SoundsConfig = { path, folder: join(home, "sound-effects"), volumeDb: { ...DEFAULT_VOLUME_DB } };
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return base;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new ToolError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	const parsed = fileSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0]!;
		throw new ToolError(`${path}: ${issue.path.join(".") || "(root)"} ${issue.message}`);
	}
	const volumeDb = { ...base.volumeDb };
	for (const [category, db] of Object.entries(parsed.data.volumeDb ?? {})) volumeDb[category] = clampDb(db);
	return { path, folder: parsed.data.folder ? expandHome(parsed.data.folder, home) : base.folder, volumeDb };
}

export function volumeFor(config: SoundsConfig, category: string): number {
	return config.volumeDb[category] ?? FALLBACK_DB;
}
