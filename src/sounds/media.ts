import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileExists } from "../analysis/media";
import type { Doc } from "../project/types";
import { createId } from "../vendor/shims";
import type { SoundFile } from "./library";

export interface ImportedSound {
	path: string;
	sizeBytes: number;
	file: SoundFile;
}

/** Copy a sound into the server's media folder once, named by content, so the user's folder can change freely. */
export async function importSound(mediaDir: string, file: SoundFile): Promise<ImportedSound> {
	const bytes = await readFile(file.path);
	const sha8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
	const path = join(mediaDir, `${sha8}-${basename(file.path)}`);
	if (!(await fileExists(path))) {
		await mkdir(mediaDir, { recursive: true });
		await copyFile(file.path, path);
	}
	return { path, sizeBytes: (await stat(path)).size, file };
}

export function ensureAudioAsset(doc: Doc, sound: ImportedSound): { doc: Doc; assetId: string } {
	const existing = doc.assets.find((a) => a.kind === "audio" && a.originalPath === sound.path);
	if (existing) return { doc, assetId: existing.id };
	const next = structuredClone(doc);
	const assetId = createId("asset");
	next.assets.push({
		id: assetId,
		kind: "audio",
		label: basename(sound.path).replace(/^[0-9a-f]{8}-/, ""),
		originalPath: sound.path,
		sizeBytes: sound.sizeBytes,
		durationSec: sound.file.durationSec,
		cameraTrack: null,
	});
	return { doc: next, assetId };
}
