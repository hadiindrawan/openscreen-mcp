# Sound Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `list_sounds`, `add_sound`, `add_sounds_on_clicks`, `find_typing` and `add_typing` to openscreen-mcp so Claude can put sound effects from the user's `~/sound-effects` folder on clicks, typing stretches and chosen moments, in OpenScreen's voiceover lane, without ever overlapping.

**Architecture:** A folder scanner resolves categories to files (durations via ffprobe); an importer hash-copies each used file into `mcp-media/` and registers it once per project as an `audio` asset; a pure placer turns events into clip-anchored `voiceover` audio tracks that never overlap each other or existing voiceover pills and skip cuts. Typing candidates come from the auto-censor OCR cache and are hints only. Everything writes through the existing store (validated, backed up, one undo per call).

**Tech Stack:** existing openscreen-mcp (Node ≥ 22, TypeScript, zod 4, MCP SDK 1.30, vitest 4.0.18), ffmpeg/ffprobe 7 (aac and libmp3lame encoders available for test tones).

**Spec:** `docs/superpowers/specs/2026-09-25-sound-effects-design.md`

## Global Constraints

- Sound effects use `kind: "voiceover"` only; the music lane is never read as an obstacle nor written.
- No two voiceover pills may overlap after any tool call (the app's `separateAudioLanes` must be a no-op).
- Supported extensions: `.mp3 .wav .m4a .aac` (case-insensitive); anything else in the folder is ignored.
- Default folder `~/sound-effects`; config `~/.openscreen-mcp/sounds.json` = `{ folder?, volumeDb? }`; defaults click −8, typing −12, whoosh −4, pop −6, any other −6 dB; clamp −60…12.
- Imported files go to `<dataDir>/mcp-media/<sha8>-<basename>`, copied once; one `audio` asset per path per project, `cameraTrack: null`, never `primaryAssetId`.
- Asset ids `asset_<uuid>`, track ids `audio_<uuid>` (never the `ext:` prefix).
- Placement: skip events inside cuts or inside existing voiceover pills; trim each sound to the next event / next pill / timeline end; drop < 60 ms; trimmed sounds get `fadeOutMs: 20`.
- Variant rotation: event k (time order) uses file `k mod n` of the category's files sorted by name.
- Fragments across clips share `trackId` (= first fragment id), `offsetMs` advances by elapsed ms unless `loop`, `fadeOutMs` only on the last fragment.
- Typing candidates are hints; tool output says to verify with `get_frames` before `add_typing`.
- Tests never touch the real home or OpenScreen data dirs (`makeTestContext` already isolates both).
- Run vitest as `rtk proxy npx vitest --run …`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Sound folder missing or empty** → a setup message naming the folder and the subfolders to create, not a crash. Pinned in Task 2.
2. **Junk files in the folder** (`.DS_Store`, `.ogg`, a text file) are ignored, not errors. Pinned in Task 2.
3. **The user already has a voiceover pill** → new sounds never overlap it (skip inside, trim before). Pinned in Task 4.
4. **Running `add_sounds_on_clicks` twice** → the second run places nothing and says every click is inside another sound, instead of stacking duplicates. Pinned in Task 7.
5. **File names with spaces/accents and the same file used twice** → copied once, one asset reused. Pinned in Task 3.

## File Structure

```
src/paths.ts                 + soundsConfig, mediaDir
src/project/types.ts         + AudioTrack, Asset
src/sounds/config.ts         NEW  sounds.json, defaults, ~ expansion, volumeFor
src/sounds/library.ts        NEW  scan folder, durations, resolve "category" | "category/file"
src/sounds/media.ts          NEW  hash-copy into mcp-media, ensureAudioAsset
src/sounds/place.ts          NEW  events → non-overlapping voiceover tracks (pure)
src/sounds/typing.ts         NEW  OCR frames + clicks → typing candidates (pure)
src/edit/regions.ts          + "sound" kind (list, find, remove whole track)
src/edit/update.ts           + volume for sounds
src/describe.ts              + sounds[]
src/tools/sounds.ts          NEW  tool logic
src/server.ts                + 5 tools; update_region gains volume
tests/helpers/tones.ts       NEW  ffmpeg sine tones + sound folder builder
tests/helpers/lanes.ts       NEW  port of OpenScreen separateAudioLanes (oracle)
```

---

### Task 1: Paths, types and sounds config

**Files:**
- Modify: `src/paths.ts`, `src/project/types.ts`, `tests/project/store.test.ts`
- Create: `src/sounds/config.ts`
- Test: `tests/sounds/config.test.ts`

**Interfaces:**
- Produces:
  - `Paths.soundsConfig: string` (= `<configDir>/sounds.json`), `Paths.mediaDir: string` (= `<dataDir>/mcp-media`)
  - types `AudioTrack = z.infer<typeof audioTrackSchema>`, `Asset = z.infer<typeof assetSchema>`
  - `DEFAULT_VOLUME_DB: Record<string, number>`, `FALLBACK_DB = -6`
  - `interface SoundsConfig { path: string; folder: string; volumeDb: Record<string, number> }`
  - `expandHome(p: string, home?: string): string`, `clampDb(db: number): number`
  - `loadSoundsConfig(path: string, home?: string): Promise<SoundsConfig>`
  - `volumeFor(config: SoundsConfig, category: string): number`

- [ ] **Step 1: Write the failing test** — `tests/sounds/config.test.ts`

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../../src/errors";
import { clampDb, expandHome, loadSoundsConfig, volumeFor } from "../../src/sounds/config";

let dir: string;
let file: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "osmcp-sounds-config-"));
	file = join(dir, "sounds.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("sounds config", () => {
	it("defaults to ~/sound-effects and the per-category volumes", async () => {
		const c = await loadSoundsConfig(file, "/Users/x");
		expect(c.folder).toBe("/Users/x/sound-effects");
		expect(volumeFor(c, "click")).toBe(-8);
		expect(volumeFor(c, "typing")).toBe(-12);
		expect(volumeFor(c, "whoosh")).toBe(-4);
		expect(volumeFor(c, "pop")).toBe(-6);
		expect(volumeFor(c, "ding")).toBe(-6);
	});

	it("reads folder and volume overrides, clamped to -60…12", async () => {
		await writeFile(file, JSON.stringify({ folder: "~/sfx", volumeDb: { click: -3, boom: 40, hush: -99 } }));
		const c = await loadSoundsConfig(file, "/Users/x");
		expect(c.folder).toBe("/Users/x/sfx");
		expect(volumeFor(c, "click")).toBe(-3);
		expect(volumeFor(c, "typing")).toBe(-12);
		expect(volumeFor(c, "boom")).toBe(12);
		expect(volumeFor(c, "hush")).toBe(-60);
	});

	it("names the file when it is malformed", async () => {
		await writeFile(file, "{ nope");
		await expect(loadSoundsConfig(file)).rejects.toThrow(file);
		await writeFile(file, JSON.stringify({ folders: "x" }));
		await expect(loadSoundsConfig(file)).rejects.toThrow(ToolError);
	});

	it("expands ~ only at the start and clamps dB", () => {
		expect(expandHome("~/a", "/h")).toBe("/h/a");
		expect(expandHome("/a/~/b", "/h")).toBe("/a/~/b");
		expect(clampDb(20)).toBe(12);
		expect(clampDb(-70)).toBe(-60);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/sounds/config.test.ts`
Expected: FAIL — cannot resolve `../../src/sounds/config`.

- [ ] **Step 3: Implement.** `src/paths.ts` — add to the `Paths` interface:

```ts
	soundsConfig: string;
	mediaDir: string;
```

and to the returned object:

```ts
		soundsConfig: join(configDir, "sounds.json"),
		mediaDir: join(dataDir, "mcp-media"),
```

In `tests/project/store.test.ts` add to the expected `resolvePaths` object:

```ts
			soundsConfig: join(dir, "home", "sounds.json"),
			mediaDir: join(dir, "mcp-media"),
```

`src/project/types.ts` — extend the type import with `assetSchema, audioTrackSchema` and add:

```ts
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type Asset = z.infer<typeof assetSchema>;
```

`src/sounds/config.ts`:

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/sounds tests/project && rtk proxy npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add sounds config, media/config paths and audio types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Sound library (scan and resolve)

**Files:**
- Create: `src/sounds/library.ts`, `tests/helpers/tones.ts`
- Test: `tests/sounds/library.test.ts`

**Interfaces:**
- Consumes: `run`, `requireBin` (analysis/media.ts), `ToolError`.
- Produces:
  - `AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac"]`, `ROOT_CATEGORY = "(root)"`
  - `interface SoundFile { category: string; name: string; path: string; durationSec: number }`
  - `interface SoundLibrary { folder: string; categories: Record<string, SoundFile[]> }` (files sorted by name; empty categories omitted)
  - `setupHint(folder: string): string`
  - `scanLibrary(folder: string, ffprobe: string | null): Promise<SoundLibrary>` (throws `ToolError` with the setup hint when missing or without usable files)
  - `resolveSound(lib: SoundLibrary, sound: string): SoundFile[]` (`"click"` → all of that category; `"click/soft.wav"` or a root file name → one; unknown → `ToolError` listing what exists)
  - test helpers: `makeTone(ffmpeg, path, seconds, hz = 800): Promise<void>`; `makeSoundFolder(ffmpeg, dir, spec: Record<string, [name: string, seconds: number][]>): Promise<string>` (returns the folder; category `(root)` writes into the folder itself)

- [ ] **Step 1: Write the tone helper** — `tests/helpers/tones.ts`

```ts
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
```

- [ ] **Step 2: Write the failing test** — `tests/sounds/library.test.ts`

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBins } from "../../src/analysis/media";
import { ToolError } from "../../src/errors";
import { resolveSound, scanLibrary } from "../../src/sounds/library";
import { makeSoundFolder } from "../helpers/tones";

const bins = await findBins();

describe("scanLibrary without files", () => {
	it("explains how to set up a missing folder", async () => {
		await expect(scanLibrary("/nonexistent/sound-effects", bins.ffprobe)).rejects.toThrow(
			/Create \/nonexistent\/sound-effects\/click\//,
		);
	});

	it("treats a folder with no audio files as not set up", async () => {
		const dir = await mkdtemp(join(tmpdir(), "osmcp-lib-empty-"));
		await mkdir(join(dir, "click"));
		await writeFile(join(dir, "click", "notes.txt"), "x");
		await expect(scanLibrary(dir, bins.ffprobe)).rejects.toThrow(ToolError);
		await rm(dir, { recursive: true, force: true });
	});
});

describe.skipIf(!bins.ffmpeg || !bins.ffprobe)("scanLibrary with files", () => {
	let dir: string;
	let folder: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-lib-"));
		folder = await makeSoundFolder(bins.ffmpeg!, dir, {
			click: [["b soft é.wav", 0.2], ["a hard.m4a", 0.3]],
			typing: [["keys.mp3", 1]],
			"(root)": [["pop.wav", 0.25]],
		});
		await writeFile(join(folder, "click", ".DS_Store"), "junk");
		await writeFile(join(folder, "click", "old.ogg"), "junk");
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("lists categories, sorted files and durations, ignoring junk", async () => {
		const lib = await scanLibrary(folder, bins.ffprobe);
		expect(Object.keys(lib.categories).sort()).toEqual(["(root)", "click", "typing"]);
		expect(lib.categories.click!.map((f) => f.name)).toEqual(["a hard.m4a", "b soft é.wav"]);
		expect(lib.categories.click![1]!.durationSec).toBeCloseTo(0.2, 2);
		expect(lib.categories.typing![0]!.durationSec).toBeCloseTo(1, 1);
	});

	it("resolves a category, a single file and a root file", async () => {
		const lib = await scanLibrary(folder, bins.ffprobe);
		expect(resolveSound(lib, "click")).toHaveLength(2);
		expect(resolveSound(lib, "click/b soft é.wav").map((f) => f.name)).toEqual(["b soft é.wav"]);
		expect(resolveSound(lib, "pop.wav")[0]!.category).toBe("(root)");
	});

	it("names what exists when the sound is unknown", async () => {
		const lib = await scanLibrary(folder, bins.ffprobe);
		expect(() => resolveSound(lib, "whoosh")).toThrow(/click, typing/);
		expect(() => resolveSound(lib, "click/nope.wav")).toThrow(/a hard\.m4a/);
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/sounds/library.test.ts`
Expected: FAIL — cannot resolve `../../src/sounds/library`.

- [ ] **Step 4: Implement `src/sounds/library.ts`**

```ts
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
	let entries: import("node:fs").Dirent[];
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/sounds/library.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: scan and resolve the user's sound effects folder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Import sounds into projects

**Files:**
- Create: `src/sounds/media.ts`
- Test: `tests/sounds/media.test.ts`

**Interfaces:**
- Consumes: `Paths.mediaDir`, `SoundFile`, `Doc`, `createId`.
- Produces:
  - `interface ImportedSound { path: string; sizeBytes: number; file: SoundFile }`
  - `importSound(mediaDir: string, file: SoundFile): Promise<ImportedSound>` (hash-copies once)
  - `ensureAudioAsset(doc: Doc, sound: ImportedSound): { doc: Doc; assetId: string }` (pure; reuses an asset with the same `originalPath`)

- [ ] **Step 1: Write the failing test** — `tests/sounds/media.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/sounds/media.test.ts`
Expected: FAIL — cannot resolve `../../src/sounds/media`.

- [ ] **Step 3: Implement `src/sounds/media.ts`**

```ts
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/sounds/media.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: import sound files into mcp-media and projects

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Place sounds in the voiceover lane

**Files:**
- Create: `src/sounds/place.ts`, `tests/helpers/lanes.ts`
- Test: `tests/sounds/place.test.ts`

**Interfaces:**
- Consumes: `anchorSpan`, `regionSpanSec`, `timelineDurationSec`, `trimSpanSec`, `Span` (edit/timemap.ts), `AudioTrack`, `Doc`, `createId`, `ToolError`.
- Produces:
  - `MIN_SOUND_SEC = 0.06`, `TRIM_FADE_MS = 20`
  - `interface SoundEvent { at: number; assetId: string; durationSec: number; gainDb: number; label: string; loopUntil?: number }` (timeline seconds)
  - `interface Skipped { at: number; reason: string }`
  - `interface PlaceResult { doc: Doc; ids: string[]; skipped: Skipped[] }`
  - `trackGroupId(t: AudioTrack): string`
  - `voiceoverPills(doc: Doc): Span[]` (collapsed by group, sorted)
  - `placeSounds(doc: Doc, events: SoundEvent[]): PlaceResult` (throws `ToolError` listing reasons when nothing was placed)
  - test oracle `separateAudioLanes(tracks: AudioTrack[]): AudioTrack[]` — port of OpenScreen's function

- [ ] **Step 1: Write the lane oracle** — `tests/helpers/lanes.ts` (port of `separateAudioLanes` + `collapseTracksToPills` from OpenScreen v1.12.2 `src/lib/ai-edition/document/audioTracks.ts`; used only to prove our output is already repaired)

```ts
import type { AudioTrack } from "../../src/project/types";

const groupOf = (t: AudioTrack) => t.trackId ?? t.id;

function pills(tracks: AudioTrack[], kind: AudioTrack["kind"]) {
	const byGroup = new Map<string, { id: string; startMs: number; endMs: number }>();
	for (const t of tracks.filter((x) => x.kind === kind)) {
		const g = groupOf(t);
		const p = byGroup.get(g);
		byGroup.set(g, p ? { id: g, startMs: Math.min(p.startMs, t.startMs), endMs: Math.max(p.endMs, t.endMs) } : { id: g, startMs: t.startMs, endMs: t.endMs });
	}
	return [...byGroup.values()].sort((a, b) => a.startMs - b.startMs);
}

/** OpenScreen's repair: push any same-kind pill that overlaps its predecessor later. */
export function separateAudioLanes(tracks: AudioTrack[]): AudioTrack[] {
	const shift = new Map<string, number>();
	for (const kind of ["voiceover", "music"] as const) {
		let cursor = Number.NEGATIVE_INFINITY;
		for (const pill of pills(tracks, kind)) {
			const span = Math.max(0, pill.endMs - pill.startMs);
			const start = Math.max(pill.startMs, cursor);
			if (start !== pill.startMs) shift.set(pill.id, start - pill.startMs);
			cursor = start + span;
		}
	}
	if (shift.size === 0) return tracks;
	return tracks.map((t) => {
		const by = shift.get(groupOf(t));
		return by === undefined ? t : { ...t, startMs: t.startMs + by, endMs: t.endMs + by };
	});
}
```

- [ ] **Step 2: Write the failing test** — `tests/sounds/place.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { cutRange } from "../../src/edit/cut";
import type { AudioTrack } from "../../src/project/types";
import { placeSounds, type SoundEvent } from "../../src/sounds/place";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { singleClipDoc, twoClipDoc } from "../helpers/docs";
import { separateAudioLanes } from "../helpers/lanes";

const ev = (at: number, durationSec = 0.3, extra: Partial<SoundEvent> = {}): SoundEvent => ({
	at,
	assetId: "asset_click",
	durationSec,
	gainDb: -8,
	label: "SFX click · a.wav",
	...extra,
});
const spans = (tracks: AudioTrack[]) => tracks.map((t) => [t.startMs, t.endMs]);
const valid = (doc: unknown) => documentSchema.safeParse(doc).error?.issues ?? [];

describe("placeSounds", () => {
	it("writes a fully specified voiceover track per event", () => {
		const { doc, ids, skipped } = placeSounds(singleClipDoc(), [ev(2)]);
		expect(skipped).toEqual([]);
		expect(doc.audioTracks[0]).toEqual({
			id: ids[0],
			trackId: ids[0],
			startMs: 2000,
			endMs: 2300,
			clipId: "clip_a",
			sourceStartSec: 2,
			sourceEndSec: 2.3,
			assetId: "asset_click",
			kind: "voiceover",
			durationSec: 0.3,
			offsetMs: 0,
			gainDb: -8,
			loop: false,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			label: "SFX click · a.wav",
			origin: "agent",
		});
		expect(ids[0]).toMatch(/^audio_/);
	});

	it("trims a sound to the next event and fades the trimmed tail", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(2.2), ev(2)]);
		expect(spans(doc.audioTracks)).toEqual([[2000, 2200], [2200, 2500]]);
		expect(doc.audioTracks.map((t) => t.fadeOutMs)).toEqual([20, 0]);
	});

	it("never overlaps an existing voiceover pill, but ignores music", () => {
		const base = singleClipDoc();
		const pill = (id: string, kind: "voiceover" | "music", startMs: number, endMs: number): AudioTrack => ({
			...placeSounds(singleClipDoc(), [ev(0)]).doc.audioTracks[0]!,
			id, trackId: id, kind, startMs, endMs, sourceStartSec: startMs / 1000, sourceEndSec: endMs / 1000, label: `existing ${id}`,
		});
		base.audioTracks = [pill("audio_vo", "voiceover", 5000, 8000), pill("audio_bgm", "music", 0, 30000)];
		const { doc, skipped } = placeSounds(base, [ev(4.9), ev(6), ev(9)]);
		expect(skipped).toEqual([{ at: 6, reason: "inside another sound" }]);
		const mine = doc.audioTracks.filter((t) => t.label.startsWith("SFX"));
		expect(spans(mine)).toEqual([[4900, 5000], [9000, 9300]]);
	});

	it("skips events inside cuts and outside the timeline", () => {
		const cut = cutRange(singleClipDoc(), { start: 10, end: 12, reason: "x" }).doc;
		const { skipped } = placeSounds(cut, [ev(11), ev(40), ev(1)]);
		expect(skipped).toEqual([
			{ at: 11, reason: "inside a cut" },
			{ at: 40, reason: "outside the timeline (0–30s)" },
		]);
	});

	it("drops a sound that would be shorter than 60 ms", () => {
		const { skipped, doc } = placeSounds(singleClipDoc(), [ev(2), ev(2.05)]);
		expect(skipped).toEqual([{ at: 2, reason: "too short to fit before the next sound (50 ms)" }]);
		expect(doc.audioTracks).toHaveLength(1);
	});

	it("clamps to the end of the timeline", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(29.9)]);
		expect(spans(doc.audioTracks)).toEqual([[29900, 30000]]);
	});

	it("loops a typing sound over a stretch", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(5, 1, { loopUntil: 9 })]);
		expect(doc.audioTracks[0]).toMatchObject({ startMs: 5000, endMs: 9000, loop: true, offsetMs: 0, fadeOutMs: 0 });
	});

	it("anchors across clips with a continuing offset", () => {
		// twoClipDoc: timeline 0–10 = source 0–10, 10–20 = source 20–30.
		const { doc, ids } = placeSounds(twoClipDoc(), [ev(9.5, 1)]);
		expect(doc.audioTracks.map((t) => [t.clipId, t.startMs, t.endMs, t.offsetMs, t.trackId])).toEqual([
			["clip_a", 9500, 10000, 0, ids[0]],
			["clip_b", 10000, 10500, 500, ids[0]],
		]);
	});

	it("produces a lane OpenScreen has nothing to repair", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(1, 1), ev(1.4, 1), ev(1.5, 0.3), ev(20, 2, { loopUntil: 25 }), ev(24)]);
		expect(separateAudioLanes(doc.audioTracks)).toEqual(doc.audioTracks);
		expect(valid(doc)).toEqual([]);
	});

	it("refuses when nothing could be placed, saying why", () => {
		expect(() => placeSounds(singleClipDoc(), [ev(40)])).toThrow(/No sound was placed: 40s outside the timeline/);
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/sounds/place.test.ts`
Expected: FAIL — cannot resolve `../../src/sounds/place`.

- [ ] **Step 4: Implement `src/sounds/place.ts`**

```ts
import { anchorSpan, regionSpanSec, type Span, timelineDurationSec, trimSpanSec } from "../edit/timemap";
import { ToolError } from "../errors";
import type { AudioTrack, Doc } from "../project/types";
import { createId } from "../vendor/shims";

export const MIN_SOUND_SEC = 0.06;
export const TRIM_FADE_MS = 20;
const EPS = 1e-6;

export interface SoundEvent {
	at: number;
	assetId: string;
	durationSec: number;
	gainDb: number;
	label: string;
	loopUntil?: number;
}

export interface Skipped {
	at: number;
	reason: string;
}

export interface PlaceResult {
	doc: Doc;
	ids: string[];
	skipped: Skipped[];
}

export const trackGroupId = (t: AudioTrack): string => t.trackId ?? t.id;

/** Existing voiceover-lane pills on the timeline, one span per track. */
export function voiceoverPills(doc: Doc): Span[] {
	const clips = doc.timeline.clips;
	const byGroup = new Map<string, Span>();
	for (const t of doc.audioTracks.filter((x) => x.kind === "voiceover")) {
		const s = regionSpanSec(clips, t);
		const g = trackGroupId(t);
		const p = byGroup.get(g);
		byGroup.set(g, p ? { start: Math.min(p.start, s.start), end: Math.max(p.end, s.end) } : s);
	}
	return [...byGroup.values()].sort((a, b) => a.start - b.start);
}

const inside = (spans: Span[], at: number) => spans.some((s) => at >= s.start - EPS && at < s.end - EPS);

export function placeSounds(doc: Doc, events: SoundEvent[]): PlaceResult {
	const clips = doc.timeline.clips;
	const duration = timelineDurationSec(clips);
	const cuts = doc.timeline.trimRanges.map((t) => trimSpanSec(clips, t)).filter((s): s is Span => s !== null);
	const pills = voiceoverPills(doc);
	const skipped: Skipped[] = [];

	const kept = [...events]
		.sort((a, b) => a.at - b.at)
		.filter((e) => {
			if (e.at < 0 || e.at >= duration) skipped.push({ at: e.at, reason: `outside the timeline (0–${Math.round(duration * 1000) / 1000}s)` });
			else if (inside(cuts, e.at)) skipped.push({ at: e.at, reason: "inside a cut" });
			else if (inside(pills, e.at)) skipped.push({ at: e.at, reason: "inside another sound" });
			else return true;
			return false;
		});

	const next = structuredClone(doc);
	const ids: string[] = [];
	kept.forEach((e, i) => {
		const natural = e.loopUntil ?? e.at + e.durationSec;
		const nextPill = pills.find((p) => p.start > e.at + EPS)?.start ?? Number.POSITIVE_INFINITY;
		const end = Math.min(natural, kept[i + 1]?.at ?? Number.POSITIVE_INFINITY, nextPill, duration);
		if (end - e.at < MIN_SOUND_SEC - EPS) {
			skipped.push({ at: e.at, reason: `too short to fit before the next sound (${Math.round((end - e.at) * 1000)} ms)` });
			return;
		}
		const fade = end < natural - EPS ? TRIM_FADE_MS : 0;
		const loop = e.loopUntil !== undefined;
		const fragments = anchorSpan(clips, e.at, end);
		const trackId = createId("audio");
		let elapsed = 0;
		fragments.forEach((f, k) => {
			next.audioTracks.push({
				id: k === 0 ? trackId : createId("audio"),
				trackId,
				startMs: f.startMs,
				endMs: f.endMs,
				clipId: f.clipId,
				sourceStartSec: f.sourceStartSec,
				sourceEndSec: f.sourceEndSec,
				assetId: e.assetId,
				kind: "voiceover",
				durationSec: e.durationSec,
				offsetMs: loop ? 0 : elapsed,
				gainDb: e.gainDb,
				loop,
				fadeInMs: 0,
				fadeOutMs: k === fragments.length - 1 ? fade : 0,
				muted: false,
				label: e.label,
				origin: "agent",
			});
			elapsed += f.endMs - f.startMs;
		});
		ids.push(trackId);
	});

	skipped.sort((a, b) => a.at - b.at);
	if (ids.length === 0) {
		throw new ToolError(`No sound was placed: ${skipped.map((s) => `${s.at}s ${s.reason}`).join("; ")}.`);
	}
	return { doc: next, ids, skipped };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/sounds/place.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: place sound effects in the voiceover lane without overlaps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Typing candidates

**Files:**
- Create: `src/sounds/typing.ts`
- Test: `tests/sounds/typing.test.ts`

**Interfaces:**
- Consumes: `OcrLine` (analysis/ocr.ts), `Click` (analysis/cursor.ts).
- Produces:
  - `interface OcrFrameLike { t: number; until: number; lines: OcrLine[] }` (source seconds; `OcrFrame` from censor/scan.ts satisfies it)
  - `interface TypingCandidate { start: number; end: number; before: string; after: string; nearClick: boolean }` (source seconds)
  - `typingCandidates(frames: OcrFrameLike[], clicks: Click[]): TypingCandidate[]` (sorted by start)

- [ ] **Step 1: Write the failing test** — `tests/sounds/typing.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { OcrLine } from "../../src/analysis/ocr";
import { type OcrFrameLike, typingCandidates } from "../../src/sounds/typing";

const L = (text: string, x = 0.35, y = 0.53, w = 0.1, h = 0.015): OcrLine => ({ text, conf: 1, x, y, w, h });
const F = (t: number, ...lines: OcrLine[]): OcrFrameLike => ({ t, until: t + 0.5, lines });

describe("typingCandidates", () => {
	it("finds text growing in place and merges nearby growth", () => {
		const frames = [F(8, L("m")), F(8.5, L("mut")), F(9, L("mutas")), F(9.5, L("mutasi")), F(12, L("mutasi"))];
		expect(typingCandidates(frames, [])).toEqual([
			{ start: 8, end: 9.5, before: "m", after: "mutasi", nearClick: false },
		]);
	});

	it("ignores caret and marker jitter", () => {
		const frames = [F(1, L("Worker")), F(1.5, L("Worker|")), F(2, L("Worker *"))];
		expect(typingCandidates(frames, [])).toEqual([]);
	});

	it("ignores the browser chrome and truncated labels", () => {
		const frames = [F(1, L("beta.example.io/a", 0.1, 0.05)), F(1.5, L("beta.example.io/abc", 0.1, 0.05)),
			F(2, L("STG New...", 0.3, 0.3)), F(2.5, L("STG New Match...", 0.3, 0.3))];
		expect(typingCandidates(frames, [])).toEqual([]);
	});

	it("splits growth separated by more than 1.5 s", () => {
		const frames = [F(1, L("a")), F(1.5, L("ab")), F(5, L("ab")), F(5.5, L("abc"))];
		expect(typingCandidates(frames, []).map((c) => [c.start, c.end])).toEqual([[1, 1.5], [5, 5.5]]);
	});

	it("flags growth on the line the user last clicked", () => {
		const frames = [F(15.5, L("Q 0", 0.25, 0.44)), F(16, L("Q 00", 0.25, 0.44)), F(16.5, L("Q 007", 0.25, 0.44))];
		const [c] = typingCandidates(frames, [{ sec: 15.2, cx: 0.3, cy: 0.45 }]);
		expect(c).toMatchObject({ before: "Q 0", after: "Q 007", nearClick: true });
		const [far] = typingCandidates(frames, [{ sec: 2, cx: 0.3, cy: 0.45 }]);
		expect(far!.nearClick).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/sounds/typing.test.ts`
Expected: FAIL — cannot resolve `../../src/sounds/typing`.

- [ ] **Step 3: Implement `src/sounds/typing.ts`**

```ts
import type { Click } from "../analysis/cursor";
import type { OcrLine } from "../analysis/ocr";

export interface OcrFrameLike {
	t: number;
	until: number;
	lines: OcrLine[];
}

export interface TypingCandidate {
	start: number;
	end: number;
	before: string;
	after: string;
	nearClick: boolean;
}

const SAME_PLACE = 0.01;
const MERGE_GAP_SEC = 1.5;
const CLICK_WINDOW_SEC = 8;
const CLICK_LINE_TOLERANCE = 0.06;
const CHROME_TOP = 0.12;

const clean = (s: string) => s.replace(/[\s|*•·]+$/u, "");
const alnum = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
const truncated = (s: string) => s.includes("…") || s.includes("...");

interface Growth {
	start: number;
	end: number;
	line: OcrLine;
	before: string;
	after: string;
}

/** Text that grows in place between OCR frames. A hint for typing, not proof: verify with frames. */
export function typingCandidates(frames: OcrFrameLike[], clicks: Click[]): TypingCandidate[] {
	const growths: Growth[] = [];
	for (let i = 1; i < frames.length; i++) {
		const prevFrame = frames[i - 1]!;
		const frame = frames[i]!;
		for (const cur of frame.lines) {
			if (cur.y < CHROME_TOP) continue;
			const prev = prevFrame.lines.find((p) => Math.abs(p.x - cur.x) < SAME_PLACE && Math.abs(p.y - cur.y) < SAME_PLACE);
			if (!prev || truncated(prev.text) || truncated(cur.text)) continue;
			const before = clean(prev.text);
			const after = clean(cur.text);
			if (alnum(before) >= 1 && after.startsWith(before) && alnum(after) > alnum(before)) {
				growths.push({ start: prevFrame.t, end: frame.t, line: cur, before, after });
			}
		}
	}

	const merged: Growth[] = [];
	for (const g of growths.sort((a, b) => a.start - b.start)) {
		const open = merged.find(
			(m) =>
				Math.abs(m.line.x - g.line.x) < SAME_PLACE &&
				Math.abs(m.line.y - g.line.y) < SAME_PLACE &&
				g.start - m.end <= MERGE_GAP_SEC,
		);
		if (open) {
			open.end = Math.max(open.end, g.end);
			open.after = g.after;
			open.line = g.line;
		} else {
			merged.push({ ...g });
		}
	}

	return merged
		.map((m) => {
			const lastClick = clicks.filter((c) => c.sec <= m.end && m.end - c.sec <= CLICK_WINDOW_SEC).at(-1);
			const nearClick = lastClick
				? Math.abs(lastClick.cy - (m.line.y + m.line.h / 2)) <= CLICK_LINE_TOLERANCE
				: false;
			return { start: m.start, end: m.end, before: m.before, after: m.after, nearClick };
		})
		.sort((a, b) => a.start - b.start);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/sounds/typing.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: detect typing candidates from OCR text growth

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sounds as regions (describe, remove, volume)

**Files:**
- Modify: `src/edit/regions.ts`, `src/edit/update.ts`, `src/describe.ts`, `tests/describe.test.ts`
- Test: `tests/sounds/regions.test.ts`

**Interfaces:**
- Consumes: `placeSounds`, `trackGroupId` (Task 4), `clampDb` (Task 1).
- Produces:
  - `RegionKind` gains `"sound"`; `allRegions` lists one entry per sound track (id = `trackId ?? id`, span = union of its fragments); `removeRegion` removes every fragment of that track.
  - `UpdateInput` gains `volume?: number`; `updateRegion` on a sound sets `gainDb` on every fragment, and refuses `start`/`end`.
  - `describeProject(doc).sounds: { id: string; start: number; end: number; label: string; volumeDb: number; loop: boolean; lane: "voiceover" | "music" }[]`

- [ ] **Step 1: Write the failing test** — `tests/sounds/regions.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { describeProject } from "../../src/describe";
import { allRegions, removeRegion } from "../../src/edit/regions";
import { updateRegion } from "../../src/edit/update";
import { placeSounds, type SoundEvent } from "../../src/sounds/place";
import { twoClipDoc } from "../helpers/docs";

const ev = (at: number, durationSec: number): SoundEvent => ({ at, assetId: "asset_x", durationSec, gainDb: -8, label: "SFX click · a.wav" });
const noCursor = () => null;

describe("sounds as regions", () => {
	// One sound spanning the clip boundary (two fragments) and one inside clip_b.
	const placed = placeSounds(twoClipDoc(), [ev(9.5, 1), ev(15, 0.3)]);

	it("describes each sound once, spanning its fragments", () => {
		expect(describeProject(placed.doc).sounds).toEqual([
			{ id: placed.ids[0], start: 9.5, end: 10.5, label: "SFX click · a.wav", volumeDb: -8, loop: false, lane: "voiceover" },
			{ id: placed.ids[1], start: 15, end: 15.3, label: "SFX click · a.wav", volumeDb: -8, loop: false, lane: "voiceover" },
		]);
		expect(allRegions(placed.doc).filter((r) => r.kind === "sound")).toHaveLength(2);
	});

	it("removes every fragment of a sound", () => {
		const { doc } = removeRegion(placed.doc, placed.ids[0]!);
		expect(doc.audioTracks.map((t) => t.trackId)).toEqual([placed.ids[1]]);
	});

	it("changes a sound's volume on all fragments, clamped", () => {
		const { doc } = updateRegion(placed.doc, { id: placed.ids[0]!, volume: 30 }, noCursor);
		expect(doc.audioTracks.filter((t) => t.trackId === placed.ids[0]).map((t) => t.gainDb)).toEqual([12, 12]);
	});

	it("refuses to move a sound", () => {
		expect(() => updateRegion(placed.doc, { id: placed.ids[0]!, start: 3 }, noCursor)).toThrow(/removing it and adding it again/);
		expect(() => updateRegion(placed.doc, { id: placed.ids[0]! }, noCursor)).toThrow(/only change volume/);
	});
});
```

In `tests/describe.test.ts`, add `sounds: [],` after the `speeds: […]` line of the expected object in "summarises every region in timeline seconds".

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/sounds/regions.test.ts tests/describe.test.ts`
Expected: FAIL — `sounds` is undefined / `volume` not handled.

- [ ] **Step 3: Implement.** In `src/edit/regions.ts`:

Change the kind union to

```ts
export type RegionKind = "zoom" | "text" | "blur" | "speed" | "cut" | "sound";
```

add below `speedRegions`:

```ts
/** Audio tracks folded into one entry per track (fragments share trackId). */
export function soundTracks(doc: Doc): { id: string; span: Span; first: Doc["audioTracks"][number] }[] {
	const clips = doc.timeline.clips;
	const byGroup = new Map<string, { id: string; span: Span; first: Doc["audioTracks"][number] }>();
	for (const t of doc.audioTracks) {
		const id = t.trackId ?? t.id;
		const s = regionSpanSec(clips, t);
		const g = byGroup.get(id);
		if (g) g.span = { start: Math.min(g.span.start, s.start), end: Math.max(g.span.end, s.end) };
		else byGroup.set(id, { id, span: s, first: t });
	}
	return [...byGroup.values()].sort((a, b) => a.span.start - b.span.start);
}
```

in `allRegions` add as the last array spread:

```ts
		...soundTracks(doc).map((s) => ({ kind: "sound" as const, id: s.id, span: s.span })),
```

and in `removeRegion`'s switch add:

```ts
		case "sound":
			next.audioTracks = next.audioTracks.filter((t) => (t.trackId ?? t.id) !== id);
			break;
```

Change the `regionNotFound` message to `No zoom, cut, text, blur, speed or sound region has id ${id}. Use describe_project.` and update the matching expectation in `tests/edit/zoom-cut.test.ts` ("rejects an unknown id") to `/No zoom, cut, text, blur, speed or sound region/`.

In `src/edit/update.ts`: add `volume?: number;` to `UpdateInput`, import `clampDb` from `../sounds/config`, and insert directly after the `if (!ref) throw regionNotFound(input.id);` line:

```ts
	if (ref.kind === "sound") {
		if (input.start !== undefined || input.end !== undefined) {
			throw new ToolError("Move a sound by removing it and adding it again.");
		}
		if (input.volume === undefined) throw new ToolError("For a sound, update_region can only change volume.");
		const next = structuredClone(doc);
		for (const t of next.audioTracks) {
			if ((t.trackId ?? t.id) === input.id) t.gainDb = clampDb(input.volume);
		}
		return { doc: next, ids: [input.id] };
	}
```

The early return narrows `ref.kind`, so the rest of `updateRegion` (overlap check and `switch`) needs no change.

In `src/describe.ts` import `soundTracks` from `./edit/regions` and add as the last property of the returned object:

```ts
		sounds: soundTracks(doc).map((s) => ({
			id: s.id,
			start: s.span.start,
			end: s.span.end,
			label: s.first.label,
			volumeDb: s.first.gainDb,
			loop: s.first.loop,
			lane: s.first.kind,
		})),
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests && rtk proxy npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: treat sound effects as regions (describe, remove, volume)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sound tools and MCP wiring

**Files:**
- Create: `src/tools/sounds.ts`
- Modify: `src/server.ts`, `tests/server.test.ts`
- Test: `tests/sounds/tools.test.ts`

**Interfaces:**
- Consumes: everything above; `applyEdit` (tools/edit.ts), `assetsOnTimeline` (tools/understand.ts), `loadCursorSamples`, `findClicks` (analysis/cursor.ts), `ocrAsset` (censor/scan.ts), `sourceToTimeline`, `sourceSpanToTimeline`, `trimSpanSec`.
- Produces:
  - `listSounds(ctx)` → `{ folder: string; config: string; categories: { name: string; volumeDb: number; files: { name: string; durationSec: number }[] }[] }`
  - `addSound(ctx, ref, sound: string, at: number, volume?: number)`
  - `addSoundsOnClicks(ctx, ref, category = "click", volume?: number)`
  - `findTyping(ctx, ref)` → `{ note: string; candidates: { start: number; end: number; before: string; after: string; nearClick: boolean }[] }`
  - `addTyping(ctx, ref, start: number, end: number, sound = "typing", volume?: number)`
  - every add returns `{ changedIds, project, reminder, skipped }`
  - MCP tools `list_sounds`, `add_sound`, `add_sounds_on_clicks`, `find_typing`, `add_typing` (22 tools total); `update_region` gains `volume`

- [ ] **Step 1: Write the failing test** — `tests/sounds/tools.test.ts`

```ts
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSound, addSoundsOnClicks, addTyping, findTyping, listSounds } from "../../src/tools/sounds";
import { makeTestContext } from "../helpers/context";
import { separateAudioLanes } from "../helpers/lanes";
import { makeSoundFolder } from "../helpers/tones";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeEach(async () => {
	t = await makeTestContext(); // 6 s project; cursor clicks at 1 s only (CURSOR_SAMPLES)
});
afterEach(() => t.cleanup());

const ready = () => Boolean(t.ctx.bins.ffmpeg && t.ctx.bins.ffprobe);

async function useFolder(spec: Record<string, [string, number][]>) {
	const folder = await makeSoundFolder(t.ctx.bins.ffmpeg!, t.dir, spec);
	await mkdir(dirname(t.ctx.paths.soundsConfig), { recursive: true });
	await writeFile(t.ctx.paths.soundsConfig, JSON.stringify({ folder }));
	return folder;
}

describe("sound tools", () => {
	it("tells the user how to set up a missing folder", async () => {
		await mkdir(dirname(t.ctx.paths.soundsConfig), { recursive: true });
		await writeFile(t.ctx.paths.soundsConfig, JSON.stringify({ folder: join(t.dir, "none") }));
		await expect(listSounds(t.ctx)).rejects.toThrow(/Create .*none\/click\//);
	});

	it("lists categories with default volumes", async () => {
		if (!ready()) return;
		await useFolder({ click: [["a.wav", 0.2]], whoosh: [["w.wav", 0.5]] });
		const list = await listSounds(t.ctx);
		expect(list.categories).toEqual([
			{ name: "click", volumeDb: -8, files: [{ name: "a.wav", durationSec: expect.closeTo(0.2, 2) }] },
			{ name: "whoosh", volumeDb: -4, files: [{ name: "w.wav", durationSec: expect.closeTo(0.5, 2) }] },
		]);
	});

	it("puts a click sound on every click, in one undoable save", async () => {
		if (!ready()) return;
		await useFolder({ click: [["a.wav", 0.2], ["b.wav", 0.2]] });
		const result = await addSoundsOnClicks(t.ctx, "latest");
		expect(result.skipped).toEqual([]);
		expect(result.project.sounds).toEqual([
			{ id: result.changedIds[0], start: 1, end: 1.2, label: "SFX click · a.wav", volumeDb: -8, loop: false, lane: "voiceover" },
		]);
		const loaded = await t.ctx.store.load("latest");
		expect(loaded.doc.assets.filter((a) => a.kind === "audio")).toHaveLength(1);
		expect(await readdir(t.ctx.paths.mediaDir)).toHaveLength(1);
		expect(separateAudioLanes(loaded.doc.audioTracks)).toEqual(loaded.doc.audioTracks);
		await t.ctx.store.undo("latest");
		expect((await t.ctx.store.load("latest")).doc.audioTracks).toEqual([]);
	});

	it("does not stack duplicates when run twice", async () => {
		if (!ready()) return;
		await useFolder({ click: [["a.wav", 0.2]] });
		await addSoundsOnClicks(t.ctx, "latest");
		await expect(addSoundsOnClicks(t.ctx, "latest")).rejects.toThrow(/No sound was placed: 1s inside another sound/);
	});

	it("adds one sound, a looped typing stretch, and reuses the asset", async () => {
		if (!ready()) return;
		await useFolder({ whoosh: [["w.wav", 0.5]], typing: [["k.wav", 1]] });
		await addSound(t.ctx, "latest", "whoosh", 0.2, -10);
		const typed = await addTyping(t.ctx, "latest", 3, 5.5);
		expect(typed.project.sounds.map((s: { start: number; end: number; loop: boolean; volumeDb: number }) => [s.start, s.end, s.loop, s.volumeDb])).toEqual([
			[0.2, 0.7, false, -10],
			[3, 5.5, true, -12],
		]);
		await addSound(t.ctx, "latest", "whoosh/w.wav", 2);
		const doc = (await t.ctx.store.load("latest")).doc;
		expect(doc.assets.filter((a) => a.kind === "audio")).toHaveLength(2);
	});

	it("rejects a typing stretch that ends before it starts", async () => {
		if (!ready()) return;
		await useFolder({ typing: [["k.wav", 1]] });
		await expect(addTyping(t.ctx, "latest", 4, 3)).rejects.toThrow(/after start/);
	});

	it("returns typing candidates as hints", async () => {
		if (!ready() || !t.ctx.bins.swiftc) return;
		const result = await findTyping(t.ctx, "latest"); // red/blue video: no text
		expect(result.candidates).toEqual([]);
		expect(result.note).toMatch(/get_frames/);
	});
});
```

In `tests/server.test.ts` change the tool-list test to "exposes the 22 tools" with:

```ts
		expect(names).toEqual([
			"add_blur", "add_sound", "add_sounds_on_clicks", "add_text", "add_typing", "add_zoom",
			"analyze_recording", "apply_censor", "cut_range", "describe_project", "find_text", "find_typing",
			"get_frames", "list_projects", "list_sounds", "preview_censor", "remove_region", "scan_sensitive",
			"set_speed", "transcribe", "undo_last_edit", "update_region",
		]);
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/sounds/tools.test.ts tests/server.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/sounds`; server lists 17 tools.

- [ ] **Step 3: Implement `src/tools/sounds.ts`**

```ts
import { findClicks, loadCursorSamples } from "../analysis/cursor";
import { ocrAsset } from "../censor/scan";
import { sourceSpanToTimeline, sourceToTimeline, type Span, trimSpanSec } from "../edit/timemap";
import { ToolError } from "../errors";
import type { Doc } from "../project/types";
import { loadSoundsConfig, volumeFor } from "../sounds/config";
import { resolveSound, ROOT_CATEGORY, scanLibrary, type SoundFile } from "../sounds/library";
import { ensureAudioAsset, type ImportedSound, importSound } from "../sounds/media";
import { placeSounds, type Skipped, type SoundEvent, voiceoverPills } from "../sounds/place";
import { typingCandidates } from "../sounds/typing";
import type { ToolContext } from "./context";
import { applyEdit } from "./edit";
import { assetsOnTimeline } from "./understand";

async function library(ctx: ToolContext) {
	const config = await loadSoundsConfig(ctx.paths.soundsConfig);
	return { config, lib: await scanLibrary(config.folder, ctx.bins.ffprobe) };
}

export async function listSounds(ctx: ToolContext) {
	const { config, lib } = await library(ctx);
	return {
		folder: lib.folder,
		config: config.path,
		categories: Object.entries(lib.categories)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, files]) => ({
				name,
				volumeDb: volumeFor(config, name),
				files: files.map((f) => ({ name: f.name, durationSec: Math.round(f.durationSec * 1000) / 1000 })),
			})),
	};
}

const label = (f: SoundFile) => `SFX ${f.category === ROOT_CATEGORY ? "sound" : f.category} · ${f.name}`;

/** Import every file first (copies, outside the project), then add assets and place in one save. */
async function place(
	ctx: ToolContext,
	ref: string,
	picks: { at: number; file: SoundFile; gainDb: number; loopUntil?: number }[],
) {
	const imported = new Map<string, ImportedSound>();
	for (const p of picks) {
		if (!imported.has(p.file.path)) imported.set(p.file.path, await importSound(ctx.paths.mediaDir, p.file));
	}
	let skipped: Skipped[] = [];
	const result = await applyEdit(ctx, ref, (doc) => {
		let next = doc;
		const assetIds = new Map<string, string>();
		for (const [path, sound] of imported) {
			const r = ensureAudioAsset(next, sound);
			next = r.doc;
			assetIds.set(path, r.assetId);
		}
		const events: SoundEvent[] = picks.map((p) => ({
			at: p.at,
			assetId: assetIds.get(p.file.path)!,
			durationSec: p.file.durationSec,
			gainDb: p.gainDb,
			label: label(p.file),
			...(p.loopUntil !== undefined ? { loopUntil: p.loopUntil } : {}),
		}));
		const placed = placeSounds(next, events);
		skipped = placed.skipped;
		return { doc: placed.doc, ids: placed.ids };
	});
	return { ...result, skipped };
}

/** A category rotates through its files; the offset keeps consecutive calls varied too. */
function rotate(files: SoundFile[], k: number): SoundFile {
	return files[k % files.length]!;
}

export async function addSound(ctx: ToolContext, ref: string, sound: string, at: number, volume?: number) {
	const { config, lib } = await library(ctx);
	const files = resolveSound(lib, sound);
	const { doc } = await ctx.store.load(ref);
	const file = rotate(files, voiceoverPills(doc).length);
	return place(ctx, ref, [{ at, file, gainDb: volume ?? volumeFor(config, file.category) }]);
}

async function clickTimes(doc: Doc): Promise<number[]> {
	const times: number[] = [];
	for (const asset of assetsOnTimeline(doc)) {
		const samples = await loadCursorSamples(asset.video);
		for (const click of findClicks(samples ?? [])) times.push(...sourceToTimeline(doc.timeline.clips, asset.assetId, click.sec));
	}
	return times.sort((a, b) => a - b);
}

export async function addSoundsOnClicks(ctx: ToolContext, ref: string, category = "click", volume?: number) {
	const { config, lib } = await library(ctx);
	const files = resolveSound(lib, category);
	const { doc } = await ctx.store.load(ref);
	const times = await clickTimes(doc);
	if (times.length === 0) throw new ToolError("This recording has no recorded clicks.");
	return place(
		ctx,
		ref,
		times.map((at, k) => {
			const file = rotate(files, k);
			return { at, file, gainDb: volume ?? volumeFor(config, file.category) };
		}),
	);
}

export async function addTyping(ctx: ToolContext, ref: string, start: number, end: number, sound = "typing", volume?: number) {
	if (!(end > start)) throw new ToolError(`end (${end}s) must be after start (${start}s).`);
	const { config, lib } = await library(ctx);
	const files = resolveSound(lib, sound);
	const { doc } = await ctx.store.load(ref);
	const file = rotate(files, voiceoverPills(doc).length);
	return place(ctx, ref, [{ at: start, file, gainDb: volume ?? volumeFor(config, file.category), loopUntil: end }]);
}

export async function findTyping(ctx: ToolContext, ref: string) {
	const { doc } = await ctx.store.load(ref);
	const clips = doc.timeline.clips;
	const cuts = doc.timeline.trimRanges.map((t) => trimSpanSec(clips, t)).filter((s): s is Span => s !== null);
	const candidates: { start: number; end: number; before: string; after: string; nearClick: boolean }[] = [];
	for (const asset of assetsOnTimeline(doc)) {
		const frames = await ocrAsset(ctx, asset);
		const clicks = findClicks((await loadCursorSamples(asset.video)) ?? []);
		for (const c of typingCandidates(frames, clicks)) {
			for (const span of sourceSpanToTimeline(clips, asset.assetId, c.start, c.end)) {
				if (cuts.some((cut) => span.start >= cut.start && span.start < cut.end)) continue;
				candidates.push({ start: span.start, end: span.end, before: c.before, after: c.after, nearClick: c.nearClick });
			}
		}
	}
	return {
		note: "Hints only: OCR text growth also catches carets, avatars and date pickers. Check each with get_frames (or ask the user) before add_typing.",
		candidates: candidates.sort((a, b) => a.start - b.start),
	};
}
```

- [ ] **Step 4: Register the tools in `src/server.ts`.** Import:

```ts
import { addSound, addSoundsOnClicks, addTyping, findTyping, listSounds } from "./tools/sounds";
```

Append to `INSTRUCTIONS` (new last line inside the template string):

```
Sound effects come from the user's own folder (list_sounds) and go in the voiceover lane; they never overlap each other. Confirm typing stretches with get_frames before add_typing.
```

In the `update_region` input schema add `volume: z.number().min(-60).max(12).optional().describe("Sound volume in dB."),` and append ` For a sound, only volume can change.` to its description; append ` A sound id removes that whole sound.` to `remove_region`'s description.

Register before `return server;`:

```ts
	server.registerTool(
		"list_sounds",
		{ description: "List the user's sound effects (folder, categories, files, lengths, default volume).", inputSchema: {} },
		guarded(async () => json(await listSounds(ctx))),
	);

	server.registerTool(
		"add_sound",
		{
			description: 'Place one sound effect at a timeline time. sound is a category ("whoosh", a variant is picked) or "category/file.wav".',
			inputSchema: {
				project,
				sound: z.string().min(1),
				at: sec.describe("Timeline seconds."),
				volume: z.number().min(-60).max(12).optional().describe("dB; default is the category's volume."),
			},
		},
		guarded(async (a) => json(await addSound(ctx, a.project, a.sound, a.at, a.volume))),
	);

	server.registerTool(
		"add_sounds_on_clicks",
		{
			description: "Put a sound on every recorded click (not inside cuts or other sounds), rotating through the category's variants. One undo removes them all.",
			inputSchema: {
				project,
				category: z.string().default("click"),
				volume: z.number().min(-60).max(12).optional(),
			},
		},
		guarded(async (a) => json(await addSoundsOnClicks(ctx, a.project, a.category, a.volume))),
	);

	server.registerTool(
		"find_typing",
		{
			description: "Candidate typing stretches from on-screen text growth. Hints only — verify each with get_frames before add_typing.",
			inputSchema: { project },
		},
		guarded(async (a) => json(await findTyping(ctx, a.project))),
	);

	server.registerTool(
		"add_typing",
		{
			description: "Loop a typing sound over a confirmed typing stretch (timeline seconds).",
			inputSchema: {
				...span,
				sound: z.string().default("typing"),
				volume: z.number().min(-60).max(12).optional(),
			},
		},
		guarded(async (a) => json(await addTyping(ctx, a.project, a.start, a.end, a.sound, a.volume))),
	);
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `rtk proxy npm test && rtk proxy npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add sound effect tools and expose them over MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Build, README and acceptance

**Files:**
- Modify: `README.md`, `docs/acceptance.md`

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `dist/index.js` rebuilt.

- [ ] **Step 2: Read-only check through the built server** (OpenScreen may stay open). `list_sounds` against the real config must explain the missing `~/sound-effects`; `find_typing` on the 35 s recording must return candidates including one around 8–9.5 s (`mutas…` → `mutasi`) and the hint note:

```bash
node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "acceptance", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "ignore" }));
console.log((await c.listTools()).tools.length, "tools");
const l = await c.callTool({ name: "list_sounds", arguments: {} });
console.log("list_sounds:", l.isError ? "error" : "ok", l.content[0].text.slice(0, 200));
const f = await c.callTool({ name: "find_typing", arguments: { project: "proj_0dbaa405-6a72-41b9-a849-557b7b133df2" } });
console.log(f.content[0].text.slice(0, 1200));
await c.close();'
```

Record the output in `docs/acceptance.md` under a new "Sound effects" section.

- [ ] **Step 3: README.** Add a "Sound effects" section after "Censor before posting":

````markdown
## Sound effects

Put your own sounds in `~/sound-effects/<category>/` (mp3, wav, m4a, aac), e.g.
`click/`, `typing/`, `whoosh/`, `pop/`. Then ask Claude: "Add click sounds to my latest
recording and a typing sound where I type the filter." Sounds go in OpenScreen's voiceover
lane (your background music keeps the music lane), never overlap, skip cut sections, and each
call is one undo. Change the folder or default volumes in `~/.openscreen-mcp/sounds.json`:

```json
{ "folder": "~/sound-effects", "volumeDb": { "click": -8, "typing": -12, "whoosh": -4, "pop": -6 } }
```

Used files are copied to `~/Library/Application Support/openscreen/mcp-media/`, so moving your
folder never breaks a project. Typing detection is a hint; Claude checks frames before adding.
````

and add `list_sounds`, `find_typing` to the "Understand" column and `add_sound`, `add_sounds_on_clicks`, `add_typing` to the "Edit" column of the tools table.

- [ ] **Step 4: Manual acceptance with the user** (edits their project; OpenScreen closed): after they create `~/sound-effects/click/` and `typing/` with files, run `add_sounds_on_clicks` and one confirmed `add_typing` on the latest recording; reopen OpenScreen; reorder a clip and undo that in the app; confirm the sounds stayed on their clicks; export and listen (success criteria 1–4). Record the result in `docs/acceptance.md`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: sound effects README section and acceptance notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
