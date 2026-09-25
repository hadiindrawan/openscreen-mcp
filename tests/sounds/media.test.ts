import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBins } from "../../src/analysis/media";
import { ensureAudioAsset, importSound } from "../../src/sounds/media";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { singleClipDoc } from "../helpers/docs";
import { makeTone } from "../helpers/tones";

const bins = await findBins();

describe.skipIf(!bins.ffmpeg)("importSound / ensureAudioAsset", () => {
	let dir: string;
	let src: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-media-"));
		src = join(dir, "sfx", "soft click é.wav");
		await makeTone(bins.ffmpeg!, src, 0.2);
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	const file = () => ({ category: "click", name: "soft click é.wav", path: src, durationSec: 0.2 });

	it("copies a file once under a content-hash name", async () => {
		const media = join(dir, "mcp-media");
		const a = await importSound(media, file());
		const b = await importSound(media, file());
		expect(a.path).toBe(b.path);
		expect(a.path).toMatch(/[0-9a-f]{8}-soft click é\.wav$/);
		expect(await readdir(media)).toHaveLength(1);
		expect(a.sizeBytes).toBe((await stat(src)).size);
	});

	it("adds one audio asset per file and reuses it", async () => {
		const sound = await importSound(join(dir, "mcp-media"), file());
		const doc = singleClipDoc();
		const primary = doc.project.primaryAssetId;
		const first = ensureAudioAsset(doc, sound);
		const second = ensureAudioAsset(first.doc, sound);
		expect(second.assetId).toBe(first.assetId);
		expect(second.doc.assets).toHaveLength(doc.assets.length + 1);
		expect(second.doc.assets.at(-1)).toEqual({
			id: first.assetId,
			kind: "audio",
			label: "soft click é.wav",
			originalPath: sound.path,
			sizeBytes: sound.sizeBytes,
			durationSec: 0.2,
			cameraTrack: null,
		});
		expect(first.assetId).toMatch(/^asset_/);
		expect(second.doc.project.primaryAssetId).toBe(primary);
		expect(documentSchema.safeParse(second.doc).success).toBe(true);
	});
});
