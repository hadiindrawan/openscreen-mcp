import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCache } from "../../src/analysis/cache";
import { findBins } from "../../src/analysis/media";
import { resolvePaths } from "../../src/paths";
import { createStore } from "../../src/project/store";
import type { ToolContext } from "../../src/tools/context";
import { clip, singleClipDoc } from "./docs";
import { makeTestVideo } from "./media";

export const PROJECT_ID = "proj_test";

// click at 1 s → cursor rests 1–4 s (dwell, contains the click) → idle 4–6 s.
export const CURSOR_SAMPLES = [
	{ timeMs: 0, cx: 0.1, cy: 0.1, visible: true, interactionType: "move" },
	{ timeMs: 1000, cx: 0.6, cy: 0.4, visible: true, interactionType: "click" },
	{ timeMs: 4000, cx: 0.2, cy: 0.8, visible: true, interactionType: "move" },
];

/** A temp OpenScreen data dir holding one 6-second project backed by a real test video. */
export async function makeTestContext(opts: { appRunning?: boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "osmcp-ctx-"));
	const paths = resolvePaths({
		OPENSCREEN_DATA_DIR: dir,
		OPENSCREEN_MCP_HOME: join(dir, "mcp-home"),
		// Shared across tests so the Swift OCR helper compiles once per machine, not per test.
		OPENSCREEN_MCP_BIN: join(tmpdir(), "osmcp-test-bin"),
	});
	await mkdir(paths.projectsDir, { recursive: true });
	const bins = await findBins();
	const video = bins.ffmpeg ? await makeTestVideo(bins.ffmpeg, dir) : join(dir, "test.mp4");
	const doc = singleClipDoc();
	doc.timeline.clips = [clip("clip_a", 0, 6, 0)];
	doc.assets[0]!.originalPath = video;
	doc.assets[0]!.durationSec = 6;
	await writeFile(join(paths.projectsDir, `${PROJECT_ID}.openscreen`), JSON.stringify(doc, null, 2));
	await writeFile(`${video}.cursor.json`, JSON.stringify({ version: 2, provider: "native", samples: CURSOR_SAMPLES, assets: [] }));
	const ctx: ToolContext = {
		paths,
		bins,
		store: createStore(paths, async () => opts.appRunning ?? false),
		cache: createCache(paths.cacheDir),
	};
	return { ctx, dir, video, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
