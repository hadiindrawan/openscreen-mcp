import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Cache {
	get<T>(assetId: string, name: string, video: string): Promise<T | null>;
	set<T>(assetId: string, name: string, video: string, value: T): Promise<void>;
}

/** Per-asset JSON cache, invalidated when the video's size or mtime changes. */
export function createCache(dir: string): Cache {
	const file = (assetId: string, name: string) =>
		join(dir, assetId.replace(/[^A-Za-z0-9_-]/g, "_"), `${name}.json`);
	const key = async (video: string) => {
		const s = await stat(video);
		return `${s.size}:${Math.round(s.mtimeMs)}`;
	};
	return {
		async get<T>(assetId: string, name: string, video: string): Promise<T | null> {
			try {
				const stored = JSON.parse(await readFile(file(assetId, name), "utf8")) as { key: string; value: T };
				return stored.key === (await key(video)) ? stored.value : null;
			} catch {
				return null;
			}
		},
		async set<T>(assetId: string, name: string, video: string, value: T): Promise<void> {
			const path = file(assetId, name);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, JSON.stringify({ key: await key(video), value }));
		},
	};
}
