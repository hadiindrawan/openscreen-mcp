# Auto-censor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `scan_sensitive`, `find_text`, `preview_censor` and `apply_censor` to openscreen-mcp so Claude can find sensitive text in a recording with Apple Vision OCR and cover it with tracked mosaic blurs after the user confirms.

**Architecture:** ffmpeg samples only the frames that change (`fps=2,mpdecimate`), a compiled Swift helper runs Apple Vision on them, and the OCR is cached per asset. Pure functions classify each frame's text into categories, track items over time into static segments, and turn chosen findings into clip-anchored blur annotations written through the existing store (validated, backed up, one undo).

**Tech Stack:** existing openscreen-mcp (Node ≥ 22, TypeScript, zod 4, MCP SDK 1.30, vitest 4.0.18), ffmpeg 7 (no `drawtext` in this build), `swiftc` 6.2 + Vision/AppKit.

**Spec:** `docs/superpowers/specs/2026-09-25-auto-censor-design.md`

## Global Constraints

- macOS only. OCR = Apple Vision `VNRecognizeTextRequest`, `.accurate`, language correction off.
- Frames are sampled with `fps=2,mpdecimate` and scaled to at most 1920 px wide.
- All rects inside the censor pipeline are 0–1 fractions of the source video frame, top-left origin, `{ x, y, w, h }`.
- Blur annotations are percentages of the clip's screen rect; a clip `cropRegion` remaps them.
- Over-cover: rect padding 0.4 % per side; spans start 0.25 s early, end 0.25 s late; minimum 0.3 s.
- Findings group all items of one rule; ids are `f1…fn`, reset by every `scan_sensitive`.
- `apply_censor` writes all blurs in **one** `store.save` (one `undo_last_edit` reverts it) and refuses a scan older than the project file.
- Default style `mosaic`, default intensity 16.
- Blur↔blur overlap is allowed; zoom, text and speed keep their overlap rule.
- Masked examples show the first 2 characters then `•••`, never a full value.
- Config at `~/.openscreen-mcp/censor.json` (override dir with `OPENSCREEN_MCP_HOME`); compiled helper in `~/.openscreen-mcp/bin` (override with `OPENSCREEN_MCP_BIN`).
- Tests never read or write the real `~/.openscreen-mcp` or the real OpenScreen data dir.
- Run vitest as `rtk proxy npx vitest --run …` (the RTK hook hides results otherwise).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Video narrower than 1920 px** (a 1280 px recording, the 320 px test video) must not be upscaled or distorted: `scale='min(1920,iw)':-2`. Pinned in Task 4.
2. **A recording with no sensitive text** (or no text at all) must return an empty findings list with no error. Pinned in Task 8.
3. **The project's video is missing**: the scan reports it in `notes` and carries on. Pinned in Task 8.
4. **Applying after the project changed** (e.g. applying twice, or an edit in the app) must refuse with "run scan_sensitive again", never write stale boxes. Pinned in Task 9.
5. **Many items of one kind** (a column of 20 UUIDs) must be one finding, not 20. Pinned in Task 5 (grouping) and Task 8 (end to end).

## File Structure

```
src/paths.ts                    + configDir, binDir, censorConfig
src/analysis/media.ts           + swiftc in Bins
src/analysis/ocr.ts             NEW  Swift helper source, compile-once, batch runner
src/analysis/sample.ts          NEW  mpdecimate frame sampler
src/analysis/frames.ts          + extractFrameWithBoxes (red outlines for preview)
src/edit/annotate.ts            blurAnnotation() extracted; addBlur no longer repels blurs
src/edit/update.ts              blur updates no longer repel
src/censor/config.ts            NEW  censor.json loading, matchers
src/censor/classify.ts          NEW  OCR lines → detections (pure)
src/censor/track.ts             NEW  detections over time → grouped segments (pure)
src/censor/apply.ts             NEW  findings → blur annotations (pure)
src/censor/scan.ts              NEW  OCR cache, scan store, scan/find/preview/apply logic
src/tools/understand.ts         export assetsOnTimeline + AssetOnTimeline
src/server.ts                   + 4 tools, instructions line
tests/helpers/render.ts         NEW  Swift text-frame renderer → test videos
tests/helpers/context.ts        per-test OPENSCREEN_MCP_HOME, shared OPENSCREEN_MCP_BIN
```

---

### Task 1: Allow overlapping blurs and share the blur builder

**Files:**
- Modify: `src/edit/annotate.ts`, `src/edit/update.ts`
- Test: `tests/edit/annotate-speed-update.test.ts`

**Interfaces:**
- Produces: `interface BlurLook { style: "blur" | "mosaic"; shape: "rectangle" | "oval"; intensity: number }`; `blurAnnotation(id: string, f: Fragment, rect: { x: number; y: number; width: number; height: number }, look: BlurLook, zIndex: number): AnnotationRegion` (rect in percent).

- [ ] **Step 1: Add the failing tests** (append inside `describe("addBlur", …)`)

```ts
	it("allows blurs that overlap in time", () => {
		const first = addBlur(singleClipDoc(), { start: 1, end: 5, rect: { x: 0, y: 0, width: 10, height: 10 } });
		const second = addBlur(first.doc, { start: 2, end: 6, rect: { x: 50, y: 50, width: 10, height: 10 } });
		expect(second.doc.annotations).toHaveLength(2);
		expect(valid(second.doc)).toEqual([]);
	});

	it("lets an update move a blur over another blur", () => {
		const a = addBlur(singleClipDoc(), { start: 1, end: 2, rect: { x: 0, y: 0, width: 10, height: 10 } });
		const b = addBlur(a.doc, { start: 3, end: 4, rect: { x: 0, y: 0, width: 10, height: 10 } });
		expect(() => updateRegion(b.doc, { id: a.ids[0]!, end: 3.5 }, noCursor)).not.toThrow();
	});
```

And a new `describe` at the end of the file:

```ts
describe("blurAnnotation", () => {
	it("builds a fully specified blur annotation", () => {
		const f = { clipId: "clip_a", assetId: "x", sourceStartSec: 1, sourceEndSec: 2, startMs: 1000, endMs: 2000 };
		expect(
			blurAnnotation("annotation_1", f, { x: 1, y: 2, width: 3, height: 4 }, { style: "mosaic", shape: "rectangle", intensity: 16 }, 7),
		).toMatchObject({
			id: "annotation_1",
			type: "blur",
			startMs: 1000,
			endMs: 2000,
			clipId: "clip_a",
			position: { x: 1, y: 2 },
			size: { width: 3, height: 4 },
			zIndex: 7,
			blurData: { type: "mosaic", shape: "rectangle", color: "white", intensity: 16, blockSize: 16 },
		});
	});
});
```

Update the import line: `import { addBlur, addText, blurAnnotation } from "../../src/edit/annotate";`

- [ ] **Step 2: Run to verify they fail**

Run: `rtk proxy npx vitest --run tests/edit/annotate-speed-update.test.ts`
Expected: FAIL — `blurAnnotation` is not exported; "allows blurs that overlap" throws `overlaps blur`.

- [ ] **Step 3: Implement.** In `src/edit/annotate.ts` add the import `import { anchorSpan, type Fragment, fragmentSpan } from "./timemap";` (replacing the existing timemap import), then replace the whole `addBlur` function with:

```ts
export interface BlurLook {
	style: "blur" | "mosaic";
	shape: "rectangle" | "oval";
	intensity: number;
}

/** One blur annotation for one clip fragment; rect in percent of the clip's screen rect. */
export function blurAnnotation(
	id: string,
	f: Fragment,
	rect: { x: number; y: number; width: number; height: number },
	look: BlurLook,
	zIndex: number,
): AnnotationRegion {
	return {
		id,
		startMs: f.startMs,
		endMs: f.endMs,
		clipId: f.clipId,
		sourceStartSec: f.sourceStartSec,
		sourceEndSec: f.sourceEndSec,
		type: "blur",
		content: "",
		position: { x: rect.x, y: rect.y },
		size: { width: rect.width, height: rect.height },
		style: baseStyle(),
		zIndex,
		blurData: {
			type: look.style,
			shape: look.shape,
			color: "white",
			intensity: look.intensity,
			blockSize: look.intensity,
		},
	};
}

/** Blurs may overlap each other in time: a privacy mask often needs several at once. */
export function addBlur(doc: Doc, input: BlurInput): EditResult {
	const { x, y, width, height } = input.rect;
	if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > 100 || y + height > 100) {
		throw new ToolError(
			"rect must lie inside the frame: x, y, width and height are percentages with x + width ≤ 100 and y + height ≤ 100.",
		);
	}
	const fragments = anchorSpan(doc.timeline.clips, input.start, input.end);
	const next = structuredClone(doc);
	const look: BlurLook = { style: input.style ?? "blur", shape: input.shape ?? "rectangle", intensity: 12 };
	const ids = fragments.map((f) => {
		const id = createId("annotation");
		next.annotations.push(blurAnnotation(id, f, input.rect, look, nextZIndex(next)));
		return id;
	});
	return { doc: next, ids };
}
```

In `src/edit/update.ts` change

```ts
	if (ref.kind !== "cut") assertNoOverlap(doc, ref.kind, [fragmentSpan(f)], input.id);
```

to

```ts
	if (ref.kind !== "cut" && ref.kind !== "blur") assertNoOverlap(doc, ref.kind, [fragmentSpan(f)], input.id);
```

- [ ] **Step 4: Run the edit tests and typecheck**

Run: `rtk proxy npx vitest --run tests/edit && rtk proxy npx tsc --noEmit`
Expected: all PASS (the existing blur test still sees intensity 12 / blockSize 12).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: allow overlapping blurs and extract blurAnnotation builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Paths and censor config

**Files:**
- Modify: `src/paths.ts`, `tests/project/store.test.ts` (expected `resolvePaths` object), `tests/helpers/context.ts`
- Create: `src/censor/config.ts`
- Test: `tests/censor/config.test.ts`

**Interfaces:**
- Produces:
  - `Paths` gains `configDir`, `binDir`, `censorConfig: string`.
  - `CATEGORIES = ["money", "emails", "names", "secrets", "urls", "chrome"] as const`, `type Category`.
  - `interface Matcher { source: string; re: RegExp }` (`re` always has the `g` flag), `compileMatcher(entry: string): Matcher` (throws `ToolError` on a bad regex).
  - `interface CensorConfig { path: string; categories: Record<Category, boolean>; alwaysHide: Matcher[]; neverHide: Matcher[]; names: Matcher[]; moneyHeaders: string[]; nameHeaders: string[] }`
  - `loadCensorConfig(path: string): Promise<CensorConfig>`, `defaultCensorConfig(path: string): CensorConfig`
  - `restrictCategories(config: CensorConfig, only?: Category[]): CensorConfig`
  - `describeConfig(config: CensorConfig): { path; categories; alwaysHide: string[]; neverHide: string[]; names: string[]; moneyHeaders: string[]; nameHeaders: string[] }`

- [ ] **Step 1: Write the failing test** — `tests/censor/config.test.ts`

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileMatcher, describeConfig, loadCensorConfig, restrictCategories } from "../../src/censor/config";
import { ToolError } from "../../src/errors";

let dir: string;
let file: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "osmcp-config-"));
	file = join(dir, "censor.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("compileMatcher", () => {
	it("treats plain strings as case-insensitive substrings", () => {
		const m = compileMatcher("a.b");
		expect("xA.Bx a.b".match(m.re)).toEqual(["A.B", "a.b"]);
		expect("axb".match(m.re)).toBeNull();
	});

	it("treats /…/flags as a regex and always adds g", () => {
		const m = compileMatcher("/sewu\\s+segar/i");
		expect("PT SEWU  SEGAR".match(m.re)).toEqual(["SEWU  SEGAR"]);
		expect(m.re.flags).toContain("g");
	});

	it("rejects an invalid regex", () => {
		expect(() => compileMatcher("/([a-/")).toThrow(ToolError);
	});
});

describe("loadCensorConfig", () => {
	it("defaults to every category on when the file is absent", async () => {
		const config = await loadCensorConfig(file);
		expect(describeConfig(config)).toEqual({
			path: file,
			categories: { money: true, emails: true, names: true, secrets: true, urls: true, chrome: true },
			alwaysHide: [],
			neverHide: [],
			names: [],
			moneyHeaders: [],
			nameHeaders: [],
		});
	});

	it("reads categories and lists from the file", async () => {
		await writeFile(
			file,
			JSON.stringify({
				categories: { chrome: false },
				alwaysHide: ["ADONAN", "/sewu/i"],
				neverHide: ["neverhide"],
				names: ["Hadi"],
				moneyHeaders: ["Nominal"],
				nameHeaders: ["Nasabah"],
			}),
		);
		const d = describeConfig(await loadCensorConfig(file));
		expect(d.categories.chrome).toBe(false);
		expect(d.categories.money).toBe(true);
		expect(d.alwaysHide).toEqual(["ADONAN", "/sewu/i"]);
		expect(d.names).toEqual(["Hadi"]);
		expect(d.moneyHeaders).toEqual(["Nominal"]);
		expect(d.nameHeaders).toEqual(["Nasabah"]);
	});

	it("names the file on malformed JSON", async () => {
		await writeFile(file, "{ nope");
		await expect(loadCensorConfig(file)).rejects.toThrow(file);
	});

	it("rejects unknown keys", async () => {
		await writeFile(file, JSON.stringify({ hideEverything: true }));
		await expect(loadCensorConfig(file)).rejects.toThrow(ToolError);
	});

	it("restricts to requested categories", async () => {
		const only = restrictCategories(await loadCensorConfig(file), ["emails"]);
		expect(describeConfig(only).categories).toEqual({
			money: false, emails: true, names: false, secrets: false, urls: false, chrome: false,
		});
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/censor/config.test.ts`
Expected: FAIL — cannot resolve `../../src/censor/config`.

- [ ] **Step 3: Implement.** `src/paths.ts` — add the three fields:

```ts
export interface Paths {
	dataDir: string;
	projectsDir: string;
	backupsDir: string;
	cacheDir: string;
	whisperModel: string;
	configDir: string;
	binDir: string;
	censorConfig: string;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
	const dataDir =
		env.OPENSCREEN_DATA_DIR ?? join(homedir(), "Library", "Application Support", "openscreen");
	const configDir = env.OPENSCREEN_MCP_HOME ?? join(homedir(), ".openscreen-mcp");
	return {
		dataDir,
		projectsDir: join(dataDir, "projects"),
		backupsDir: join(dataDir, "mcp-backups"),
		cacheDir: join(dataDir, "mcp-cache"),
		whisperModel:
			env.OPENSCREEN_WHISPER_MODEL ??
			join(dataDir, "stt-models", "whisper-ggml", "ggml-small-q8_0.bin"),
		configDir,
		binDir: env.OPENSCREEN_MCP_BIN ?? join(configDir, "bin"),
		censorConfig: join(configDir, "censor.json"),
	};
}
```

In `tests/project/store.test.ts` the `beforeEach` becomes
`paths = resolvePaths({ OPENSCREEN_DATA_DIR: dir, OPENSCREEN_MCP_HOME: join(dir, "home") });`
and the expected object in "derives every directory from the data dir" gains:

```ts
			configDir: join(dir, "home"),
			binDir: join(dir, "home", "bin"),
			censorConfig: join(dir, "home", "censor.json"),
```

In `tests/helpers/context.ts` replace the `resolvePaths` line with:

```ts
	const paths = resolvePaths({
		OPENSCREEN_DATA_DIR: dir,
		OPENSCREEN_MCP_HOME: join(dir, "mcp-home"),
		// Shared across tests so the Swift OCR helper compiles once per machine, not per test.
		OPENSCREEN_MCP_BIN: join(tmpdir(), "osmcp-test-bin"),
	});
```

`src/censor/config.ts`:

```ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ToolError } from "../errors";

export const CATEGORIES = ["money", "emails", "names", "secrets", "urls", "chrome"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Matcher {
	source: string;
	re: RegExp;
}

export interface CensorConfig {
	path: string;
	categories: Record<Category, boolean>;
	alwaysHide: Matcher[];
	neverHide: Matcher[];
	names: Matcher[];
	moneyHeaders: string[];
	nameHeaders: string[];
}

const fileSchema = z
	.object({
		categories: z
			.object({
				money: z.boolean().optional(),
				emails: z.boolean().optional(),
				names: z.boolean().optional(),
				secrets: z.boolean().optional(),
				urls: z.boolean().optional(),
				chrome: z.boolean().optional(),
			})
			.strict()
			.optional(),
		alwaysHide: z.array(z.string().min(1)).optional(),
		neverHide: z.array(z.string().min(1)).optional(),
		names: z.array(z.string().min(1)).optional(),
		moneyHeaders: z.array(z.string().min(1)).optional(),
		nameHeaders: z.array(z.string().min(1)).optional(),
	})
	.strict();

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "text" → case-insensitive substring; "/pattern/flags" → regex. Always global. */
export function compileMatcher(entry: string): Matcher {
	const regex = /^\/(.+)\/([a-z]*)$/.exec(entry);
	try {
		if (regex) {
			const flags = regex[2]!.includes("g") ? regex[2]! : `${regex[2]}g`;
			return { source: entry, re: new RegExp(regex[1]!, flags) };
		}
		return { source: entry, re: new RegExp(escapeRegex(entry), "gi") };
	} catch (error) {
		throw new ToolError(`Invalid pattern ${entry}: ${(error as Error).message}`);
	}
}

export function defaultCensorConfig(path: string): CensorConfig {
	return {
		path,
		categories: { money: true, emails: true, names: true, secrets: true, urls: true, chrome: true },
		alwaysHide: [],
		neverHide: [],
		names: [],
		moneyHeaders: [],
		nameHeaders: [],
	};
}

export async function loadCensorConfig(path: string): Promise<CensorConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return defaultCensorConfig(path);
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
	const file = parsed.data;
	const base = defaultCensorConfig(path);
	return {
		path,
		categories: { ...base.categories, ...file.categories },
		alwaysHide: (file.alwaysHide ?? []).map(compileMatcher),
		neverHide: (file.neverHide ?? []).map(compileMatcher),
		names: (file.names ?? []).map(compileMatcher),
		moneyHeaders: file.moneyHeaders ?? [],
		nameHeaders: file.nameHeaders ?? [],
	};
}

export function restrictCategories(config: CensorConfig, only?: Category[]): CensorConfig {
	if (!only?.length) return config;
	const categories = Object.fromEntries(
		Object.entries(config.categories).map(([c, on]) => [c, on && only.includes(c as Category)]),
	) as Record<Category, boolean>;
	return { ...config, categories };
}

export function describeConfig(config: CensorConfig) {
	return {
		path: config.path,
		categories: config.categories,
		alwaysHide: config.alwaysHide.map((m) => m.source),
		neverHide: config.neverHide.map((m) => m.source),
		names: config.names.map((m) => m.source),
		moneyHeaders: config.moneyHeaders,
		nameHeaders: config.nameHeaders,
	};
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/censor tests/project && rtk proxy npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add censor config and config/bin paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Swift OCR helper and test-frame renderer

**Files:**
- Modify: `src/analysis/media.ts` (`swiftc` in `Bins`)
- Create: `src/analysis/ocr.ts`, `tests/helpers/render.ts`
- Test: `tests/analysis/ocr.test.ts`

**Interfaces:**
- Produces:
  - `Bins.swiftc: string | null`
  - `interface OcrLine { text: string; conf: number; x: number; y: number; w: number; h: number }` (0–1, top-left)
  - `interface OcrResult { path: string; lines: OcrLine[]; error?: string }`
  - `ensureOcrHelper(binDir: string, swiftc: string | null): Promise<string>` (path of the compiled helper)
  - `runOcr(helper: string, paths: string[]): Promise<OcrResult[]>` (same order as `paths`)
  - test helpers: `interface TextItem { x: number; y: number; size: number; text: string }` (pixels, top-left), `renderFrame(swiftc, out, width, height, items): Promise<void>`, `makeTextVideo(ffmpeg, swiftc, dir, frames: TextItem[][], width = 1280, height = 720): Promise<string>` (each frame shown for 1 s, 30 fps output)

- [ ] **Step 1: Add `swiftc` to `Bins`.** In `src/analysis/media.ts`:

```ts
export interface Bins {
	ffmpeg: string | null;
	ffprobe: string | null;
	whisper: string | null;
	swiftc: string | null;
}
```

and in `findBins` add `swiftc: await findBinary("swiftc", env),`.

- [ ] **Step 2: Write the test renderer** — `tests/helpers/render.ts`

```ts
import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/analysis/media";

const RENDER_SWIFT = `import AppKit
// render <out.png> <width> <height> [<x> <y> <size> <text>]...  (x, y = top-left, pixels)
let a = Array(CommandLine.arguments.dropFirst())
let w = Int(a[1])!, h = Int(a[2])!
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: w, height: h).fill()
var i = 3
while i + 3 < a.count {
  let x = Double(a[i])!, y = Double(a[i + 1])!, size = Double(a[i + 2])!, text = a[i + 3]
  let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.black]
  let s = NSAttributedString(string: text, attributes: attrs)
  s.draw(at: NSPoint(x: x, y: Double(h) - y - s.size().height))
  i += 4
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[0]))
`;

export interface TextItem {
	x: number;
	y: number;
	size: number;
	text: string;
}

let compiled: Promise<string> | null = null;

function renderer(swiftc: string): Promise<string> {
	compiled ??= (async () => {
		const sha = createHash("sha256").update(RENDER_SWIFT).digest("hex").slice(0, 8);
		const dir = join(tmpdir(), "osmcp-test-bin");
		const out = join(dir, `render-${sha}`);
		try {
			await access(out);
			return out;
		} catch {
			await mkdir(dir, { recursive: true });
			await writeFile(`${out}.swift`, RENDER_SWIFT);
			await run(swiftc, ["-O", `${out}.swift`, "-o", out], { timeoutMs: 300_000 });
			return out;
		}
	})();
	return compiled;
}

export async function renderFrame(
	swiftc: string,
	out: string,
	width: number,
	height: number,
	items: TextItem[],
): Promise<void> {
	const args = items.flatMap((t) => [String(t.x), String(t.y), String(t.size), t.text]);
	await run(await renderer(swiftc), [out, String(width), String(height), ...args]);
}

/** One rendered frame per second, encoded at 30 fps. */
export async function makeTextVideo(
	ffmpeg: string,
	swiftc: string,
	dir: string,
	frames: TextItem[][],
	width = 1280,
	height = 720,
): Promise<string> {
	for (const [i, items] of frames.entries()) {
		await renderFrame(swiftc, join(dir, `frame${i}.png`), width, height, items);
	}
	const out = join(dir, "text.mp4");
	await run(ffmpeg, [
		"-y", "-v", "error", "-framerate", "1", "-i", join(dir, "frame%d.png"),
		"-vf", "fps=30", "-pix_fmt", "yuv420p", out,
	]);
	return out;
}
```

- [ ] **Step 3: Write the failing test** — `tests/analysis/ocr.test.ts`

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBins } from "../../src/analysis/media";
import { ensureOcrHelper, runOcr } from "../../src/analysis/ocr";
import { ToolError } from "../../src/errors";
import { renderFrame } from "../helpers/render";

const bins = await findBins();
const BIN = join(tmpdir(), "osmcp-test-bin");

describe("ensureOcrHelper", () => {
	it("explains how to get swiftc when it is missing", async () => {
		const empty = await mkdtemp(join(tmpdir(), "osmcp-nobin-"));
		await expect(ensureOcrHelper(empty, null)).rejects.toThrow(/xcode-select --install/);
		await expect(ensureOcrHelper(empty, null)).rejects.toThrow(ToolError);
		await rm(empty, { recursive: true, force: true });
	});
});

describe.skipIf(!bins.swiftc)("Apple Vision OCR helper", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-ocr-"));
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("compiles once and reuses the binary", async () => {
		const a = await ensureOcrHelper(BIN, bins.swiftc);
		const b = await ensureOcrHelper(BIN, bins.swiftc);
		expect(a).toBe(b);
		expect(a).toMatch(/ocr-[0-9a-f]{8}$/);
	});

	it("reads text with top-left normalized boxes, in input order", async () => {
		const image = join(dir, "a.png");
		await renderFrame(bins.swiftc!, image, 1280, 720, [
			{ x: 40, y: 40, size: 28, text: "alice@example.com" },
			{ x: 900, y: 600, size: 26, text: "Balance" },
		]);
		const [result, missing] = await runOcr(await ensureOcrHelper(BIN, bins.swiftc), [image, join(dir, "none.png")]);
		const email = result!.lines.find((l) => l.text === "alice@example.com")!;
		expect(email.x).toBeCloseTo(40 / 1280, 1);
		expect(email.y).toBeCloseTo(40 / 720, 1);
		expect(email.w).toBeGreaterThan(0.1);
		const balance = result!.lines.find((l) => l.text === "Balance")!;
		expect(balance.y).toBeGreaterThan(0.8);
		expect(missing).toMatchObject({ path: join(dir, "none.png"), lines: [], error: "cannot read image" });
	});
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/analysis/ocr.test.ts`
Expected: FAIL — cannot resolve `../../src/analysis/ocr`.

- [ ] **Step 5: Implement `src/analysis/ocr.ts`**

```ts
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolError } from "../errors";
import { fileExists, requireBin, run } from "./media";

// Compiled on first use; the binary name carries this source's hash, so editing it recompiles.
const OCR_SWIFT = `import AppKit
import Foundation
import Vision
// ocr <image>... -> one JSON line per image: {"path","lines":[{"text","conf","x","y","w","h"}]}
// Boxes are 0-1 fractions of the image with a top-left origin.
for path in CommandLine.arguments.dropFirst() {
  var out: [String: Any] = ["path": path]
  if let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    do {
      try VNImageRequestHandler(cgImage: cg).perform([req])
      out["lines"] = (req.results ?? []).compactMap { o -> [String: Any]? in
        guard let c = o.topCandidates(1).first else { return nil }
        let b = o.boundingBox
        return ["text": c.string, "conf": Double(c.confidence), "x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)]
      }
    } catch {
      out["lines"] = [[String: Any]]()
      out["error"] = error.localizedDescription
    }
  } else {
    out["lines"] = [[String: Any]]()
    out["error"] = "cannot read image"
  }
  let data = try! JSONSerialization.data(withJSONObject: out)
  print(String(data: data, encoding: .utf8)!)
}
`;

export interface OcrLine {
	text: string;
	conf: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OcrResult {
	path: string;
	lines: OcrLine[];
	error?: string;
}

const BATCH = 50;

export async function ensureOcrHelper(binDir: string, swiftc: string | null): Promise<string> {
	const sha = createHash("sha256").update(OCR_SWIFT).digest("hex").slice(0, 8);
	const out = join(binDir, `ocr-${sha}`);
	if (await fileExists(out)) return out;
	const compiler = requireBin(
		swiftc,
		"swiftc",
		"Install the Xcode command line tools with `xcode-select --install`, then retry.",
	);
	await mkdir(binDir, { recursive: true });
	await writeFile(`${out}.swift`, OCR_SWIFT);
	try {
		await run(compiler, ["-O", `${out}.swift`, "-o", out], { timeoutMs: 300_000 });
	} catch (error) {
		throw new ToolError(`Could not compile the OCR helper: ${(error as Error).message}`);
	}
	return out;
}

export async function runOcr(helper: string, paths: string[]): Promise<OcrResult[]> {
	const results: OcrResult[] = [];
	for (let i = 0; i < paths.length; i += BATCH) {
		const { stdout } = await run(helper, paths.slice(i, i + BATCH), { timeoutMs: 600_000 });
		for (const line of stdout.toString().split("\n")) {
			if (line.trim()) results.push(JSON.parse(line) as OcrResult);
		}
	}
	return results;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/analysis && rtk proxy npx tsc --noEmit`
Expected: all PASS (first run compiles two Swift binaries into `$TMPDIR/osmcp-test-bin`, a few seconds each).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Apple Vision OCR helper and test-frame renderer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Changed-frame sampler

**Files:**
- Create: `src/analysis/sample.ts`
- Test: `tests/analysis/sample.test.ts`

**Interfaces:**
- Consumes: `run` (media.ts), `makeTestVideo` (tests/helpers/media.ts — 320×240, red 0–3 s, blue 3–6 s).
- Produces: `interface SampledFrame { t: number; path: string }` (t = source seconds); `sampleFrames(ffmpeg: string, video: string, outDir: string, fps = 2, maxWidth = 1920): Promise<SampledFrame[]>`.

- [ ] **Step 1: Write the failing test** — `tests/analysis/sample.test.ts`

```ts
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBins, run } from "../../src/analysis/media";
import { sampleFrames } from "../../src/analysis/sample";
import { makeTestVideo } from "../helpers/media";

const bins = await findBins();

describe.skipIf(!bins.ffmpeg || !bins.ffprobe)("sampleFrames", () => {
	let dir: string;
	let video: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-sample-"));
		video = await makeTestVideo(bins.ffmpeg!, dir);
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("keeps only frames that change, with their source times", async () => {
		const out = join(dir, "frames");
		const frames = await sampleFrames(bins.ffmpeg!, video, out);
		expect(frames.map((f) => f.t)).toEqual([0, 3]);
		expect((await readdir(out)).sort()).toEqual(["000001.jpg", "000002.jpg"]);
		expect(frames[1]!.path).toBe(join(out, "000002.jpg"));
	});

	it("never upscales a video narrower than the limit", async () => {
		const frames = await sampleFrames(bins.ffmpeg!, video, join(dir, "small"));
		const { stdout } = await run(bins.ffprobe!, [
			"-v", "error", "-select_streams", "v", "-show_entries", "stream=width", "-of", "csv=p=0", frames[0]!.path,
		]);
		expect(stdout.toString().trim()).toBe("320");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/analysis/sample.test.ts`
Expected: FAIL — cannot resolve `../../src/analysis/sample`.

- [ ] **Step 3: Implement `src/analysis/sample.ts`**

```ts
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { round3 } from "../edit/timemap";
import { ToolError } from "../errors";
import { run } from "./media";

export interface SampledFrame {
	t: number;
	path: string;
}

/**
 * Frames at `fps`, minus near-duplicates (`mpdecimate`), at most `maxWidth` wide.
 * A kept frame stands for every dropped frame after it, so static screens cost one frame.
 */
export async function sampleFrames(
	ffmpeg: string,
	video: string,
	outDir: string,
	fps = 2,
	maxWidth = 1920,
): Promise<SampledFrame[]> {
	await mkdir(outDir, { recursive: true });
	const { stderr } = await run(
		ffmpeg,
		[
			"-hide_banner", "-nostats", "-i", video, "-an",
			"-vf", `fps=${fps},mpdecimate,scale='min(${maxWidth},iw)':-2,showinfo`,
			"-fps_mode", "vfr", "-q:v", "3",
			join(outDir, "%06d.jpg"),
		],
		{ timeoutMs: 600_000 },
	);
	const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => round3(Number(m[1])));
	const files = (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
	if (files.length !== times.length) {
		throw new ToolError(`Frame sampling mismatch for ${video}: ${files.length} files, ${times.length} timestamps.`);
	}
	return files.map((file, i) => ({ t: times[i]!, path: join(outDir, file) }));
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/analysis/sample.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add changed-frame sampler

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Classify OCR text into detections

**Files:**
- Create: `src/censor/classify.ts`
- Test: `tests/censor/classify.test.ts`

**Interfaces:**
- Consumes: `OcrLine` (Task 3), `CensorConfig`, `Category`, `Matcher`, `defaultCensorConfig`, `compileMatcher` (Task 2).
- Produces:
  - `interface Rect { x: number; y: number; w: number; h: number }` (0–1, top-left)
  - `type DetectionCategory = Category | "custom"`
  - `interface Detection { category: DetectionCategory; group: string; groupLabel: string; key: string; sample: string; rect: Rect }`
  - `mask(text: string): string`
  - `termDetections(lines: OcrLine[], matcher: Matcher, meta: { category: DetectionCategory; group: string; groupLabel: string }): Detection[]`
  - `classifyFrame(lines: OcrLine[], config: CensorConfig): Detection[]`

Groups and labels (fixed strings used by later tasks and tests):

| Group | Label | Category |
|---|---|---|
| `urls:addressbar` | `Address bar URL` | urls |
| `urls:query` | `Links with query strings` | urls |
| `chrome` | `Browser chrome (tabs, address bar, bookmarks)` | chrome |
| `column:<header lowercased>` | `<Header as read> column` | money or names |
| `emails` | `Email addresses` | emails |
| `secrets:key` | `API keys and tokens` | secrets |
| `secrets:uuid` | `IDs (UUIDs)` | secrets |
| `money:amounts` | `Currency amounts` | money |
| `money:numbers` | `Long numbers (7+ digits)` | money |
| `names:terms` | `Names from your config` | names |
| `custom:<entry>` | `Matches "<entry>"` | custom |

- [ ] **Step 1: Write the failing test** — `tests/censor/classify.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { OcrLine } from "../../src/analysis/ocr";
import { classifyFrame, type Detection, mask, termDetections } from "../../src/censor/classify";
import { compileMatcher, defaultCensorConfig, restrictCategories } from "../../src/censor/config";

const L = (text: string, x: number, y: number, w: number, h = 0.015): OcrLine => ({ text, conf: 1, x, y, w, h });

// Synthetic layout modelled on the user's test recording (a browser showing a transactions table).
const rows = [0, 1, 2].flatMap((k) => {
	const y = 0.241 + 0.032 * k;
	return [
		L(`032f28dd-ce92-439b-a5b4-d8220b2d20e${k}`, 0.038, y, 0.121, 0.007),
		L(`ACME TRADING REF00001${k}`, 0.24, y, 0.141),
		L(`120338${k}`, 0.532, y, 0.028),
		L("CR", 0.778, y, 0.01),
		L(`120863994${k}`, 0.815, y, 0.038),
	];
});
const frame: OcrLine[] = [
	L("beta.example.io/table/views?company=%7B123%7D", 0.087, 0.052, 0.5, 0.017),
	L("Pancake", 0.006, 0.088, 0.029, 0.013),
	L("Grafana", 0.52, 0.086, 0.04, 0.017),
	L("Worker", 0.48, 0.128, 0.039),
	L("neverhide Bq Id", 0.038, 0.212, 0.049, 0.013),
	L("Trans Description", 0.24, 0.212, 0.049, 0.013),
	L("Mutasi", 0.532, 0.212, 0.022, 0.012),
	L("Type", 0.778, 0.212, 0.015, 0.012),
	L("Balance", 0.815, 0.212, 0.025, 0.012),
	...rows,
	L("contact alice@example.com today", 0.05, 0.95, 0.3),
	L("token sk-live4f9a8b7c6d5e4f3a2b1c0d9e", 0.05, 0.9, 0.3),
	L("Total Rp 1.250.000", 0.6, 0.95, 0.1),
];

const groups = (ds: Detection[]) => [...new Set(ds.map((d) => d.group))].sort();
const one = (ds: Detection[], group: string) => ds.filter((d) => d.group === group);

describe("mask", () => {
	it("keeps two characters", () => {
		expect(mask("alice@example.com")).toBe("al•••");
		expect(mask("a")).toBe("••");
	});
});

describe("classifyFrame", () => {
	const all = classifyFrame(frame, defaultCensorConfig("/x"));

	it("finds every category on a realistic frame", () => {
		expect(groups(all)).toEqual([
			"chrome",
			"column:balance",
			"column:mutasi",
			"column:trans description",
			"emails",
			"money:amounts",
			"secrets:key",
			"secrets:uuid",
			"urls:addressbar",
		]);
	});

	it("covers a whole column with one detection, including left-aligned wider cells", () => {
		const [balance] = one(all, "column:balance");
		expect(balance).toMatchObject({ category: "money", groupLabel: "Balance column", sample: "1208639940" });
		expect(balance!.rect.y).toBeCloseTo(0.212, 3);
		expect(balance!.rect.y + balance!.rect.h).toBeCloseTo(0.305 + 0.015, 3);
		const [desc] = one(all, "column:trans description");
		expect(desc!.category).toBe("names");
		expect(desc!.rect.w).toBeCloseTo(0.141, 3);
	});

	it("does not also report column values as loose numbers", () => {
		expect(one(all, "money:numbers")).toEqual([]);
	});

	it("bands the browser chrome down to the bookmarks row, not the page nav", () => {
		const [chrome] = one(all, "chrome");
		expect(chrome!.rect).toEqual({ x: 0, y: 0, w: 1, h: expect.closeTo(0.103 + 0.005, 3) });
	});

	it("groups every UUID into one group with one key each", () => {
		const uuids = one(all, "secrets:uuid");
		expect(uuids).toHaveLength(3);
		expect(new Set(uuids.map((d) => d.key)).size).toBe(3);
	});

	it("narrows a match inside a longer line", () => {
		const [email] = one(all, "emails");
		expect(email!.sample).toBe("alice@example.com");
		expect(email!.rect.x).toBeGreaterThan(0.05);
		expect(email!.rect.w).toBeLessThan(0.3);
	});

	it("honours disabled categories", () => {
		const onlyEmails = classifyFrame(frame, restrictCategories(defaultCensorConfig("/x"), ["emails"]));
		expect(groups(onlyEmails)).toEqual(["emails"]);
	});

	it("applies alwaysHide, names and neverHide", () => {
		const config = {
			...defaultCensorConfig("/x"),
			alwaysHide: [compileMatcher("ACME")],
			names: [compileMatcher("alice")],
			neverHide: [compileMatcher("/^sk-/")],
		};
		const ds = classifyFrame(frame, config);
		expect(one(ds, "custom:ACME")).toHaveLength(3);
		expect(one(ds, "custom:ACME")[0]!.groupLabel).toBe('Matches "ACME"');
		expect(one(ds, "names:terms")[0]!.sample).toBe("alice");
		expect(one(ds, "secrets:key")).toEqual([]);
	});

	it("finds nothing on a frame without sensitive text", () => {
		expect(classifyFrame([L("Welcome", 0.4, 0.5, 0.2), L("Get started", 0.4, 0.6, 0.2)], defaultCensorConfig("/x"))).toEqual([]);
	});
});

describe("termDetections", () => {
	it("finds every occurrence of a term with its own key", () => {
		const ds = termDetections(frame, compileMatcher("ACME"), { category: "custom", group: "custom:ACME", groupLabel: "x" });
		expect(ds).toHaveLength(3);
		expect(ds[0]!.rect.x).toBeCloseTo(0.24, 3);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/censor/classify.test.ts`
Expected: FAIL — cannot resolve `../../src/censor/classify`.

- [ ] **Step 3: Implement `src/censor/classify.ts`**

```ts
import type { OcrLine } from "../analysis/ocr";
import type { Category, CensorConfig, Matcher } from "./config";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type DetectionCategory = Category | "custom";

export interface Detection {
	category: DetectionCategory;
	group: string;
	groupLabel: string;
	key: string;
	sample: string;
	rect: Rect;
}

const MONEY_HEADERS = ["balance", "saldo", "amount", "mutasi", "total", "price", "debit", "credit", "account", "rekening", "cheque", "no rek"];
const NAME_HEADERS = ["name", "customer", "client", "merchant", "payee", "description", "trans description", "keterangan", "remark"];

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const KEY_PREFIX = /\b(?:sk-[\w-]{8,}|sk_live_\w{8,}|gh[po]_\w{20,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN = /[A-Za-z0-9_-]{24,}/g;
const URL_LIKE = /(?:https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)+\/\S*)/;
const QUERY_URL = /(?:https?:\/\/|\b[\w-]+(?:\.[\w-]+)+\/)\S*\?\S+/g;
const CURRENCY = /(?:Rp\.?|IDR|USD|\$|€|£|¥)\s?\d[\d.,]*/g;
const LONG_NUMBER = /\b\d{7,}\b/g;

export function mask(text: string): string {
	return text.length <= 2 ? "••" : `${text.slice(0, 2)}•••`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** The part of a line's box that holds characters [start, end), assuming even character widths. */
function subRect(line: OcrLine, start: number, end: number): Rect {
	const n = Math.max(1, line.text.length);
	return { x: line.x + (line.w * start) / n, y: line.y, w: (line.w * (end - start)) / n, h: line.h };
}

const lineRect = (l: OcrLine): Rect => ({ x: l.x, y: l.y, w: l.w, h: l.h });

function union(rects: Rect[]): Rect {
	const x0 = Math.min(...rects.map((r) => r.x));
	const y0 = Math.min(...rects.map((r) => r.y));
	const x1 = Math.max(...rects.map((r) => r.x + r.w));
	const y1 = Math.max(...rects.map((r) => r.y + r.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

type Meta = { category: DetectionCategory; group: string; groupLabel: string };

function regexDetections(line: OcrLine, re: RegExp, meta: Meta, keyPrefix: string): Detection[] {
	return [...line.text.matchAll(new RegExp(re.source, re.flags))].map((m) => ({
		...meta,
		key: `${keyPrefix}${m[0].toLowerCase()}`,
		sample: m[0],
		rect: subRect(line, m.index!, m.index! + m[0].length),
	}));
}

export function termDetections(lines: OcrLine[], matcher: Matcher, meta: Meta): Detection[] {
	return lines.flatMap((line) => regexDetections(line, matcher.re, meta, `${meta.group}:`));
}

function headerKind(text: string, config: CensorConfig): "money" | "names" | null {
	const n = norm(text);
	const words = n.split(" ");
	const hit = (list: string[]) =>
		list.some((w) => {
			const word = norm(w);
			return n === word || (words.length <= 3 && ` ${n} `.includes(` ${word} `));
		});
	if (config.categories.money && hit([...MONEY_HEADERS, ...config.moneyHeaders])) return "money";
	if (config.categories.names && hit([...NAME_HEADERS, ...config.nameHeaders])) return "names";
	return null;
}

const ALIGN = 0.01;

function columnCells(header: OcrLine, lines: OcrLine[]): OcrLine[] {
	const aligned = (c: OcrLine) =>
		Math.abs(c.x - header.x) <= ALIGN ||
		Math.abs(c.x + c.w / 2 - (header.x + header.w / 2)) <= ALIGN ||
		Math.abs(c.x + c.w - (header.x + header.w)) <= ALIGN;
	const below = lines
		.filter((c) => c !== header && c.y > header.y + header.h / 2 && aligned(c))
		.sort((a, b) => a.y - b.y);
	const cells: OcrLine[] = [];
	let prev = header;
	for (const c of below) {
		if (c.y - (prev.y + prev.h) > 3 * prev.h) break;
		cells.push(c);
		prev = c;
	}
	return cells;
}

function addressBar(lines: OcrLine[]): OcrLine | null {
	return lines.filter((l) => l.y < 0.12 && URL_LIKE.test(l.text)).sort((a, b) => a.y - b.y)[0] ?? null;
}

function chromeBand(bar: OcrLine, lines: OcrLine[]): Rect {
	const barBottom = bar.y + bar.h;
	const next = lines.filter((l) => l.y > barBottom && l.y - barBottom <= 0.035).sort((a, b) => a.y - b.y);
	const row = next.length ? next.filter((l) => Math.abs(l.y - next[0]!.y) <= 0.01) : [];
	const bottom = Math.max(barBottom, ...row.map((l) => l.y + l.h));
	return { x: 0, y: 0, w: 1, h: Math.min(1, bottom + 0.005) };
}

export function classifyFrame(lines: OcrLine[], config: CensorConfig): Detection[] {
	const on = config.categories;
	const out: Detection[] = [];
	const consumed = new Set<OcrLine>();

	const bar = addressBar(lines);
	if (bar) {
		consumed.add(bar);
		if (on.urls) out.push({ category: "urls", group: "urls:addressbar", groupLabel: "Address bar URL", key: "addressbar", sample: bar.text, rect: lineRect(bar) });
		if (on.chrome) out.push({ category: "chrome", group: "chrome", groupLabel: "Browser chrome (tabs, address bar, bookmarks)", key: "chrome", sample: bar.text, rect: chromeBand(bar, lines) });
	}

	for (const header of lines) {
		if (consumed.has(header)) continue;
		const kind = headerKind(header.text, config);
		if (!kind) continue;
		const cells = columnCells(header, lines).filter((c) => !consumed.has(c));
		if (cells.length === 0) continue;
		for (const c of [header, ...cells]) consumed.add(c);
		const name = norm(header.text);
		out.push({
			category: kind,
			group: `column:${name}`,
			groupLabel: `${header.text} column`,
			key: `column:${name}`,
			sample: cells[0]!.text,
			rect: union([header, ...cells].map(lineRect)),
		});
	}

	for (const line of lines) {
		if (on.emails) out.push(...regexDetections(line, EMAIL, { category: "emails", group: "emails", groupLabel: "Email addresses" }, "email:"));
		if (on.secrets) {
			const keys = regexDetections(line, KEY_PREFIX, { category: "secrets", group: "secrets:key", groupLabel: "API keys and tokens" }, "key:");
			const uuids = regexDetections(line, UUID, { category: "secrets", group: "secrets:uuid", groupLabel: "IDs (UUIDs)" }, "uuid:");
			const taken = [...keys, ...uuids].map((d) => d.sample);
			const tokens = regexDetections(line, LONG_TOKEN, { category: "secrets", group: "secrets:key", groupLabel: "API keys and tokens" }, "key:")
				.filter((d) => /[A-Za-z]/.test(d.sample) && /\d/.test(d.sample))
				.filter((d) => !taken.some((t) => t.includes(d.sample) || d.sample.includes(t)));
			out.push(...keys, ...uuids, ...tokens);
		}
		if (consumed.has(line)) continue;
		if (on.urls) out.push(...regexDetections(line, QUERY_URL, { category: "urls", group: "urls:query", groupLabel: "Links with query strings" }, "url:"));
		if (on.money) {
			const amounts = regexDetections(line, CURRENCY, { category: "money", group: "money:amounts", groupLabel: "Currency amounts" }, "amount:");
			out.push(...amounts);
			out.push(
				...regexDetections(line, LONG_NUMBER, { category: "money", group: "money:numbers", groupLabel: "Long numbers (7+ digits)" }, "number:")
					.filter((d) => !amounts.some((a) => a.sample.replace(/\D/g, "").includes(d.sample))),
			);
		}
	}

	if (on.names) {
		for (const m of config.names) out.push(...termDetections(lines, m, { category: "names", group: "names:terms", groupLabel: "Names from your config" }));
	}
	for (const m of config.alwaysHide) {
		out.push(...termDetections(lines, m, { category: "custom", group: `custom:${m.source}`, groupLabel: `Matches "${m.source}"` }));
	}

	return out.filter((d) => !config.neverHide.some((m) => new RegExp(m.re.source, m.re.flags.replace("g", "")).test(d.sample)));
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/censor/classify.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS. If a rule fires on something the test fixture does not expect, fix the rule, not the fixture: the fixture mirrors the real recording's layout.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: classify OCR text into sensitive-content detections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Track detections over time

**Files:**
- Create: `src/censor/track.ts`
- Test: `tests/censor/track.test.ts`

**Interfaces:**
- Consumes: `Detection`, `DetectionCategory`, `Rect`, `mask` (Task 5).
- Produces:
  - `interface FrameDetections { t: number; until: number; detections: Detection[] }` (source seconds; `until` = next kept frame's t)
  - `interface Segment { start: number; end: number; rect: Rect }` (source seconds, padded rect)
  - `interface TrackedGroup { category: DetectionCategory; group: string; label: string; examples: string[]; segments: Segment[] }`
  - `trackDetections(frames: FrameDetections[], assetEndSec: number): TrackedGroup[]`
  - constants `PAD = 0.004`, `LEAD = 0.25`, `MIN_SEGMENT = 0.3`, `MIN_IOU = 0.6`

- [ ] **Step 1: Write the failing test** — `tests/censor/track.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { Detection, Rect } from "../../src/censor/classify";
import { type FrameDetections, trackDetections } from "../../src/censor/track";

const det = (key: string, rect: Rect, group = "emails", sample = "alice@example.com"): Detection => ({
	category: "emails",
	group,
	groupLabel: "Email addresses",
	key,
	sample,
	rect,
});
const R = (x: number, y: number, w = 0.2, h = 0.05): Rect => ({ x, y, w, h });
const frames = (...list: [number, number, Detection[]][]): FrameDetections[] =>
	list.map(([t, until, detections]) => ({ t, until, detections }));

describe("trackDetections", () => {
	it("merges a static item into one padded, over-covering segment", () => {
		const [g] = trackDetections(frames([0, 3, [det("a", R(0.1, 0.1))]], [3, 6, [det("a", R(0.1, 0.1))]]), 6);
		expect(g).toMatchObject({ group: "emails", label: "Email addresses", examples: ["al•••"] });
		expect(g!.segments).toHaveLength(1);
		expect(g!.segments[0]!.start).toBe(0);
		expect(g!.segments[0]!.end).toBe(6);
		expect(g!.segments[0]!.rect.x).toBeCloseTo(0.096, 6);
		expect(g!.segments[0]!.rect.w).toBeCloseTo(0.208, 6);
	});

	it("chains a scrolling item into consecutive segments", () => {
		const [g] = trackDetections(frames([0, 3, [det("a", R(0.1, 0.5))]], [3, 6, [det("a", R(0.1, 0.3))]]), 6);
		expect(g!.segments.map((s) => [s.start, s.end])).toEqual([[0, 3.25], [2.75, 6]]);
	});

	it("keeps an item that moves a little as one segment", () => {
		const [g] = trackDetections(frames([0, 1, [det("a", R(0.1, 0.5))]], [1, 2, [det("a", R(0.1, 0.505))]]), 2);
		expect(g!.segments).toHaveLength(1);
		expect(g!.segments[0]!.rect.h).toBeCloseTo(0.055 + 0.008, 6);
	});

	it("splits an item that disappears and returns", () => {
		const [g] = trackDetections(
			frames([0, 1, [det("a", R(0.1, 0.1))]], [1, 2, []], [2, 3, [det("a", R(0.1, 0.1))]]),
			3,
		);
		expect(g!.segments.map((s) => [s.start, s.end])).toEqual([[0, 1.25], [1.75, 3]]);
	});

	it("tracks two copies of the same text at different places separately", () => {
		const both = [det("a", R(0.1, 0.1)), det("a", R(0.1, 0.6))];
		const [g] = trackDetections(frames([0, 2, both], [2, 4, both]), 4);
		expect(g!.segments).toHaveLength(2);
	});

	it("groups many keys of one rule into one finding with up to 3 examples", () => {
		const uuids = ["u1aaaa", "u2bbbb", "u3cccc", "u4dddd"].map((k, i) =>
			det(k, R(0.1, 0.1 * (i + 1)), "secrets:uuid", k),
		);
		const groups = trackDetections(frames([0, 2, uuids]), 2);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.segments).toHaveLength(4);
		expect(groups[0]!.examples).toEqual(["u1•••", "u2•••", "u3•••"]);
	});

	it("stretches a blink to the minimum length and clamps to the asset", () => {
		const [g] = trackDetections(frames([5.9, 5.95, [det("a", R(0, 0, 1, 1))]]), 6);
		const s = g!.segments[0]!;
		expect(s.end).toBe(6);
		expect(s.end - s.start).toBeCloseTo(0.35, 6);
		expect(s.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});

	it("returns nothing for no detections", () => {
		expect(trackDetections(frames([0, 6, []]), 6)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/censor/track.test.ts`
Expected: FAIL — cannot resolve `../../src/censor/track`.

- [ ] **Step 3: Implement `src/censor/track.ts`**

```ts
import { round3 } from "../edit/timemap";
import { type Detection, type DetectionCategory, mask, type Rect } from "./classify";

export interface FrameDetections {
	t: number;
	until: number;
	detections: Detection[];
}

export interface Segment {
	start: number;
	end: number;
	rect: Rect;
}

export interface TrackedGroup {
	category: DetectionCategory;
	group: string;
	label: string;
	examples: string[];
	segments: Segment[];
}

export const PAD = 0.004;
export const LEAD = 0.25;
export const MIN_SEGMENT = 0.3;
export const MIN_IOU = 0.6;

function iou(a: Rect, b: Rect): number {
	const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
	const inter = ix * iy;
	return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

function union(rects: Rect[]): Rect {
	const x0 = Math.min(...rects.map((r) => r.x));
	const y0 = Math.min(...rects.map((r) => r.y));
	const x1 = Math.max(...rects.map((r) => r.x + r.w));
	const y1 = Math.max(...rects.map((r) => r.y + r.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function pad(r: Rect): Rect {
	const x0 = Math.max(0, r.x - PAD);
	const y0 = Math.max(0, r.y - PAD);
	const x1 = Math.min(1, r.x + r.w + PAD);
	const y1 = Math.min(1, r.y + r.h + PAD);
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

interface Open {
	group: string;
	first: Rect;
	rects: Rect[];
	firstT: number;
	lastUntil: number;
}

function close(open: Open, assetEnd: number): Segment {
	let start = Math.max(0, open.firstT - LEAD);
	let end = Math.min(assetEnd, open.lastUntil + LEAD);
	if (end - start < MIN_SEGMENT) {
		end = Math.min(assetEnd, start + MIN_SEGMENT);
		start = Math.max(0, end - MIN_SEGMENT);
	}
	return { start: round3(start), end: round3(end), rect: pad(union(open.rects)) };
}

/** Per key, consecutive frames whose rect overlaps the segment's first rect (IoU ≥ 0.6) extend it. */
export function trackDetections(frames: FrameDetections[], assetEndSec: number): TrackedGroup[] {
	const groups = new Map<string, TrackedGroup>();
	const open = new Map<string, Open[]>();

	for (const frame of frames) {
		const seen = new Map<string, Open[]>();
		for (const d of frame.detections) {
			let g = groups.get(d.group);
			if (!g) {
				g = { category: d.category, group: d.group, label: d.groupLabel, examples: [], segments: [] };
				groups.set(d.group, g);
			}
			const example = mask(d.sample);
			if (g.examples.length < 3 && !g.examples.includes(example)) g.examples.push(example);

			const id = `${d.group}|${d.key}`;
			const candidates = open.get(id) ?? [];
			const taken = seen.get(id) ?? [];
			const match = candidates
				.filter((o) => !taken.includes(o))
				.map((o) => ({ o, score: iou(o.first, d.rect) }))
				.filter((c) => c.score >= MIN_IOU)
				.sort((a, b) => b.score - a.score)[0]?.o;
			const segment = match ?? { group: d.group, first: d.rect, rects: [], firstT: frame.t, lastUntil: frame.until };
			segment.rects.push(d.rect);
			segment.lastUntil = frame.until;
			seen.set(id, [...taken, segment]);
		}
		for (const [id, list] of open) {
			const kept = seen.get(id) ?? [];
			for (const o of list) {
				if (!kept.includes(o)) groups.get(o.group)!.segments.push(close(o, assetEndSec));
			}
		}
		open.clear();
		for (const [id, list] of seen) open.set(id, list);
	}
	for (const list of open.values()) {
		for (const o of list) groups.get(o.group)!.segments.push(close(o, assetEndSec));
	}
	for (const g of groups.values()) g.segments.sort((a, b) => a.start - b.start || a.rect.y - b.rect.y);
	return [...groups.values()];
}
```

Each open segment remembers its group, so custom patterns containing `|` (regex alternation) are safe.

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/censor/track.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: track detections over time into padded segments

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Turn findings into blur annotations

**Files:**
- Create: `src/censor/apply.ts`
- Test: `tests/censor/apply.test.ts`

**Interfaces:**
- Consumes: `blurAnnotation`, `BlurLook` (Task 1), `Segment` (Task 6), `anchorSpan`, `sourceSpanToTimeline` (timemap), `createId`, `EditResult`.
- Produces: `interface CensorLook { style: "blur" | "mosaic"; intensity: number }`; `censorAnnotations(doc: Doc, findings: { assetId: string; segments: Segment[] }[], look: CensorLook): EditResult` (throws `ToolError` when nothing lands on the timeline).

- [ ] **Step 1: Write the failing test** — `tests/censor/apply.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { censorAnnotations } from "../../src/censor/apply";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { ASSET_ID, clip, singleClipDoc, twoClipDoc } from "../helpers/docs";

const look = { style: "mosaic" as const, intensity: 16 };
const seg = (start: number, end: number, x = 0.5, y = 0.1, w = 0.1, h = 0.2) => ({ start, end, rect: { x, y, w, h } });

describe("censorAnnotations", () => {
	it("adds one mosaic blur per segment in percent of the frame", () => {
		const { doc, ids } = censorAnnotations(singleClipDoc(), [{ assetId: ASSET_ID, segments: [seg(1, 4)] }], look);
		expect(ids).toHaveLength(1);
		expect(doc.annotations[0]).toMatchObject({
			type: "blur",
			startMs: 1000,
			endMs: 4000,
			clipId: "clip_a",
			position: { x: 50, y: 10 },
			size: { width: 10, height: 20 },
			blurData: { type: "mosaic", intensity: 16, blockSize: 16 },
		});
		expect(documentSchema.safeParse(doc).error?.issues ?? []).toEqual([]);
	});

	it("places a segment on every clip that plays it, in timeline seconds", () => {
		// twoClipDoc: timeline 0–10 = source 0–10, timeline 10–20 = source 20–30.
		const { doc } = censorAnnotations(twoClipDoc(), [{ assetId: ASSET_ID, segments: [seg(8, 22)] }], look);
		expect(doc.annotations.map((a) => [a.clipId, a.startMs, a.endMs])).toEqual([
			["clip_a", 8000, 10000],
			["clip_b", 10000, 12000],
		]);
	});

	it("maps rects into a cropped clip and drops what the crop hides", () => {
		const cropped = singleClipDoc();
		cropped.timeline.clips = [{ ...clip("clip_a", 0, 30, 0), cropRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } }];
		const { doc } = censorAnnotations(
			cropped,
			[{ assetId: ASSET_ID, segments: [seg(1, 2, 0.6, 0.1, 0.1, 0.1), seg(3, 4, 0.1, 0.1, 0.1, 0.1)] }],
			look,
		);
		expect(doc.annotations).toHaveLength(1);
		expect(doc.annotations[0]!.position.x).toBeCloseTo(20, 6);
		expect(doc.annotations[0]!.size.width).toBeCloseTo(20, 6);
	});

	it("stacks new blurs above existing annotations", () => {
		const first = censorAnnotations(singleClipDoc(), [{ assetId: ASSET_ID, segments: [seg(1, 2)] }], look);
		const second = censorAnnotations(first.doc, [{ assetId: ASSET_ID, segments: [seg(1, 2), seg(3, 4)] }], look);
		expect(second.doc.annotations.map((a) => a.zIndex)).toEqual([1, 2, 3]);
	});

	it("refuses when nothing lands on the timeline", () => {
		expect(() => censorAnnotations(singleClipDoc(), [{ assetId: "asset_other", segments: [seg(1, 2)] }], look)).toThrow(
			/not on the timeline/,
		);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/censor/apply.test.ts`
Expected: FAIL — cannot resolve `../../src/censor/apply`.

- [ ] **Step 3: Implement `src/censor/apply.ts`**

```ts
import { blurAnnotation } from "../edit/annotate";
import type { EditResult } from "../edit/regions";
import { anchorSpan, sourceSpanToTimeline } from "../edit/timemap";
import { ToolError } from "../errors";
import type { Clip, Doc } from "../project/types";
import { createId } from "../vendor/shims";
import type { Rect } from "./classify";
import type { Segment } from "./track";

export interface CensorLook {
	style: "blur" | "mosaic";
	intensity: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A 0–1 source rect → 0–1 of what the clip shows, or null when its crop hides it all. */
function intoCrop(rect: Rect, crop: Clip["cropRegion"]): Rect | null {
	if (!crop) return rect;
	const x0 = Math.max(0, (rect.x - crop.x) / crop.width);
	const y0 = Math.max(0, (rect.y - crop.y) / crop.height);
	const x1 = Math.min(1, (rect.x + rect.w - crop.x) / crop.width);
	const y1 = Math.min(1, (rect.y + rect.h - crop.y) / crop.height);
	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function censorAnnotations(
	doc: Doc,
	findings: { assetId: string; segments: Segment[] }[],
	look: CensorLook,
): EditResult {
	const next = structuredClone(doc);
	const clips = next.timeline.clips;
	let zIndex = next.annotations.reduce((max, a) => Math.max(max, a.zIndex), 0);
	const ids: string[] = [];
	for (const finding of findings) {
		for (const segment of finding.segments) {
			for (const span of sourceSpanToTimeline(clips, finding.assetId, segment.start, segment.end)) {
				for (const fragment of anchorSpan(clips, span.start, span.end)) {
					if (fragment.assetId !== finding.assetId) continue;
					const clip = clips.find((c) => c.id === fragment.clipId)!;
					const rect = intoCrop(segment.rect, clip.cropRegion);
					if (!rect) continue;
					const id = createId("annotation");
					zIndex += 1;
					next.annotations.push(
						blurAnnotation(
							id,
							fragment,
							{ x: r2(rect.x * 100), y: r2(rect.y * 100), width: r2(rect.w * 100), height: r2(rect.h * 100) },
							{ style: look.style, shape: "rectangle", intensity: look.intensity },
							zIndex,
						),
					);
					ids.push(id);
				}
			}
		}
	}
	if (ids.length === 0) throw new ToolError("Nothing to blur: the selected findings are not on the timeline.");
	return { doc: next, ids };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/censor/apply.test.ts && rtk proxy npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: turn censor findings into clip-anchored blur annotations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Scan and find_text (OCR cache + findings store)

**Files:**
- Modify: `src/tools/understand.ts` (export `AssetOnTimeline`, `assetsOnTimeline`)
- Create: `src/censor/scan.ts`
- Test: `tests/censor/scan.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7, `ToolContext`, `fileExists`, `requireBin`, `sourceSpanToTimeline`.
- Produces:
  - `interface OcrFrame { t: number; until: number; lines: OcrLine[]; error?: string }`
  - `interface ScanFinding extends TrackedGroup { id: string; assetId: string }`
  - `interface FindingSummary { id: string; category: string; label: string; examples: string[]; time: string | null; blurs: number }`
  - `interface ScanStore { projectId: string; projectSha256: string; config: ReturnType<typeof describeConfig>; findings: ScanFinding[] }`
  - `ocrAsset(ctx, asset: AssetOnTimeline): Promise<OcrFrame[]>`
  - `scanProject(ctx, ref, opts: { categories?: Category[]; force?: boolean }): Promise<{ findings: FindingSummary[]; config: …; notes: string[] }>`
  - `findText(ctx, ref, query: string, label?: string): Promise<FindingSummary[]>`
  - `loadFreshScan(ctx, ref): Promise<{ loaded: LoadedProject; scan: ScanStore }>` (throws the stale-scan `ToolError`)
  - `STALE_SCAN = "The project changed since the last scan (or was never scanned). Run scan_sensitive again."`

The standard censor test video (used here and in Task 9), 1280×720, 6 frames of 1 s:
- frames 0–2: `alice@example.com` at (40, 40, 28pt); `token sk-live4f9a8b7c6d5e4f3a2b1c0d9e` at (40, 300, 22pt); `Balance` at (900, 120, 26pt) with `1208639943`, `1242026427`, `1204647040` below it at y 160, 200, 240.
- frames 3–5: the same, with the whole Balance column 60 px higher (a scroll).

- [ ] **Step 1: Add the shared fixture to `tests/helpers/render.ts`** (append):

```ts
/** The standard censor fixture: an email, an API key, and a Balance column that scrolls up at 3 s. */
export function censorFixtureFrames(): TextItem[][] {
	return [0, 1, 2, 3, 4, 5].map((i) => {
		const top = i < 3 ? 120 : 60;
		return [
			{ x: 40, y: 40, size: 28, text: "alice@example.com" },
			{ x: 40, y: 300, size: 22, text: "token sk-live4f9a8b7c6d5e4f3a2b1c0d9e" },
			{ x: 900, y: top, size: 26, text: "Balance" },
			{ x: 900, y: top + 40, size: 26, text: "1208639943" },
			{ x: 900, y: top + 80, size: 26, text: "1242026427" },
			{ x: 900, y: top + 120, size: 26, text: "1204647040" },
		];
	});
}
```

- [ ] **Step 2: Write the failing test** — `tests/censor/scan.test.ts`

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findText, loadFreshScan, scanProject } from "../../src/censor/scan";
import { makeTestContext, PROJECT_ID } from "../helpers/context";
import { censorFixtureFrames, makeTextVideo } from "../helpers/render";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeEach(async () => {
	t = await makeTestContext();
});
afterEach(() => t.cleanup());

const ready = () => Boolean(t.ctx.bins.ffmpeg && t.ctx.bins.swiftc);

/** Point the test project at a freshly rendered text video. */
async function useTextVideo(): Promise<string> {
	const video = await makeTextVideo(t.ctx.bins.ffmpeg!, t.ctx.bins.swiftc!, t.dir, censorFixtureFrames());
	const file = join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`);
	const doc = JSON.parse(await readFile(file, "utf8"));
	doc.assets[0].originalPath = video;
	await writeFile(file, JSON.stringify(doc, null, 2));
	return video;
}

describe("scanProject", () => {
	it("finds the email, the key and the scrolling column", async () => {
		if (!ready()) return;
		await useTextVideo();
		const result = await scanProject(t.ctx, "latest", {});
		const byLabel = Object.fromEntries(result.findings.map((f) => [f.label, f]));
		expect(Object.keys(byLabel).sort()).toEqual(["API keys and tokens", "Balance column", "Email addresses"]);
		expect(byLabel["Email addresses"]).toMatchObject({ category: "emails", examples: ["al•••"], time: "0.00–6.00s", blurs: 1 });
		expect(byLabel["Balance column"]).toMatchObject({ category: "money", blurs: 2 });
		expect(result.findings.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
		expect(result.notes).toEqual([]);
		expect(result.config.path).toBe(t.ctx.paths.censorConfig);
	});

	it("returns no findings for a recording without sensitive text", async () => {
		if (!ready()) return;
		const result = await scanProject(t.ctx, "latest", {}); // the red/blue test video
		expect(result.findings).toEqual([]);
	});

	it("reports a missing video instead of failing", async () => {
		const file = join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`);
		const doc = JSON.parse(await readFile(file, "utf8"));
		doc.assets[0].originalPath = join(t.dir, "gone.mp4");
		await writeFile(file, JSON.stringify(doc, null, 2));
		const result = await scanProject(t.ctx, "latest", {});
		expect(result.findings).toEqual([]);
		expect(result.notes.join(" ")).toMatch(/Video missing/);
	});

	it("restricts to requested categories", async () => {
		if (!ready()) return;
		await useTextVideo();
		const result = await scanProject(t.ctx, "latest", { categories: ["emails"] });
		expect(result.findings.map((f) => f.label)).toEqual(["Email addresses"]);
	});
});

describe("findText", () => {
	it("adds a finding for any text the rules missed", async () => {
		if (!ready()) return;
		await useTextVideo();
		await scanProject(t.ctx, "latest", {});
		const [added] = await findText(t.ctx, "latest", "token", "Token label");
		expect(added).toMatchObject({ id: "f4", category: "custom", label: "Token label", time: "0.00–6.00s" });
		const { scan } = await loadFreshScan(t.ctx, "latest");
		expect(scan.findings).toHaveLength(4);
	});

	it("says so when the text never appears", async () => {
		if (!ready()) return;
		await useTextVideo();
		await expect(findText(t.ctx, "latest", "nowhere-to-be-seen")).rejects.toThrow(/does not appear/);
	});
});

describe("loadFreshScan", () => {
	it("refuses when there is no scan", async () => {
		await expect(loadFreshScan(t.ctx, "latest")).rejects.toThrow(/Run scan_sensitive again/);
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `rtk proxy npx vitest --run tests/censor/scan.test.ts`
Expected: FAIL — cannot resolve `../../src/censor/scan`.

- [ ] **Step 4: Export the timeline-asset helper.** In `src/tools/understand.ts` change `interface AssetOnTimeline` to `export interface AssetOnTimeline` and `function assetsOnTimeline` to `export function assetsOnTimeline`.

- [ ] **Step 5: Implement `src/censor/scan.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileExists, requireBin } from "../analysis/media";
import { ensureOcrHelper, type OcrLine, runOcr } from "../analysis/ocr";
import { sampleFrames } from "../analysis/sample";
import { round3, sourceSpanToTimeline } from "../edit/timemap";
import { ToolError } from "../errors";
import type { LoadedProject } from "../project/store";
import type { Doc } from "../project/types";
import type { ToolContext } from "../tools/context";
import { type AssetOnTimeline, assetsOnTimeline } from "../tools/understand";
import { classifyFrame, termDetections } from "./classify";
import { type Category, compileMatcher, describeConfig, loadCensorConfig, restrictCategories } from "./config";
import { type TrackedGroup, trackDetections } from "./track";

export const STALE_SCAN =
	"The project changed since the last scan (or was never scanned). Run scan_sensitive again.";

export interface OcrFrame {
	t: number;
	until: number;
	lines: OcrLine[];
	error?: string;
}

export interface ScanFinding extends TrackedGroup {
	id: string;
	assetId: string;
}

export interface FindingSummary {
	id: string;
	category: string;
	label: string;
	examples: string[];
	time: string | null;
	blurs: number;
}

export interface ScanStore {
	projectId: string;
	projectSha256: string;
	config: ReturnType<typeof describeConfig>;
	findings: ScanFinding[];
}

const OCR_CACHE = "ocr-v1";

const assetEnd = (asset: AssetOnTimeline, frames: OcrFrame[]) =>
	asset.endMs > 0 ? asset.endMs / 1000 : (frames.at(-1)?.until ?? 0);

export async function ocrAsset(ctx: ToolContext, asset: AssetOnTimeline): Promise<OcrFrame[]> {
	const cached = await ctx.cache.get<OcrFrame[]>(asset.assetId, OCR_CACHE, asset.video);
	if (cached) return cached;
	const ffmpeg = requireBin(ctx.bins.ffmpeg, "ffmpeg", "Install it with `brew install ffmpeg`.");
	const helper = await ensureOcrHelper(ctx.paths.binDir, ctx.bins.swiftc);
	const work = join(ctx.paths.cacheDir, "tmp", randomUUID());
	try {
		const sampled = await sampleFrames(ffmpeg, asset.video, work);
		const results = await runOcr(helper, sampled.map((s) => s.path));
		const last = sampled.at(-1)?.t ?? 0;
		const end = asset.endMs > 0 ? asset.endMs / 1000 : last + 0.5;
		const frames: OcrFrame[] = sampled.map((s, i) => ({
			t: s.t,
			until: sampled[i + 1]?.t ?? Math.max(end, s.t),
			lines: results[i]?.lines ?? [],
			...(results[i]?.error ? { error: results[i]!.error } : {}),
		}));
		await ctx.cache.set(asset.assetId, OCR_CACHE, asset.video, frames);
		return frames;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

const scanFile = (ctx: ToolContext, projectId: string) => join(ctx.paths.cacheDir, "scans", `${projectId}.json`);

async function readScan(ctx: ToolContext, projectId: string): Promise<ScanStore | null> {
	try {
		return JSON.parse(await readFile(scanFile(ctx, projectId), "utf8")) as ScanStore;
	} catch {
		return null;
	}
}

async function writeScan(ctx: ToolContext, scan: ScanStore): Promise<void> {
	const file = scanFile(ctx, scan.projectId);
	await mkdir(join(ctx.paths.cacheDir, "scans"), { recursive: true });
	await writeFile(file, JSON.stringify(scan));
}

export async function loadFreshScan(ctx: ToolContext, ref: string): Promise<{ loaded: LoadedProject; scan: ScanStore }> {
	const loaded = await ctx.store.load(ref);
	const scan = await readScan(ctx, loaded.id);
	if (!scan || scan.projectSha256 !== loaded.sha256) throw new ToolError(STALE_SCAN);
	return { loaded, scan };
}

function summarize(doc: Doc, f: ScanFinding): FindingSummary {
	const spans = f.segments.flatMap((s) => sourceSpanToTimeline(doc.timeline.clips, f.assetId, s.start, s.end));
	const time = spans.length
		? `${Math.min(...spans.map((s) => s.start)).toFixed(2)}–${Math.max(...spans.map((s) => s.end)).toFixed(2)}s`
		: null;
	return { id: f.id, category: f.category, label: f.label, examples: f.examples, time, blurs: spans.length };
}

export async function scanProject(ctx: ToolContext, ref: string, opts: { categories?: Category[]; force?: boolean }) {
	const loaded = await ctx.store.load(ref);
	const config = restrictCategories(await loadCensorConfig(ctx.paths.censorConfig), opts.categories);
	const notes: string[] = [];
	const found: Omit<ScanFinding, "id">[] = [];
	for (const asset of assetsOnTimeline(loaded.doc)) {
		if (!(await fileExists(asset.video))) {
			notes.push(`Video missing: ${asset.video}; not scanned.`);
			continue;
		}
		if (opts.force) await ctx.cache.set(asset.assetId, OCR_CACHE, asset.video, null);
		const frames = await ocrAsset(ctx, asset);
		const unreadable = frames.filter((f) => f.error).length;
		if (unreadable) notes.push(`${unreadable} frame(s) of ${basename(asset.video)} could not be read and were skipped.`);
		const groups = trackDetections(
			frames.map((f) => ({ t: f.t, until: f.until, detections: classifyFrame(f.lines, config) })),
			assetEnd(asset, frames),
		);
		for (const g of groups) found.push({ ...g, assetId: asset.assetId });
	}
	const findings = found.map((f, i) => ({ ...f, id: `f${i + 1}` }));
	await writeScan(ctx, { projectId: loaded.id, projectSha256: loaded.sha256, config: describeConfig(config), findings });
	return { findings: findings.map((f) => summarize(loaded.doc, f)), config: describeConfig(config), notes };
}

export async function findText(ctx: ToolContext, ref: string, query: string, label?: string): Promise<FindingSummary[]> {
	const loaded = await ctx.store.load(ref);
	let scan = await readScan(ctx, loaded.id);
	if (!scan || scan.projectSha256 !== loaded.sha256) {
		await scanProject(ctx, ref, {});
		scan = (await readScan(ctx, loaded.id))!;
	}
	const matcher = compileMatcher(query);
	const meta = { category: "custom" as const, group: `custom:${query}`, groupLabel: label ?? `Matches "${query}"` };
	const added: ScanFinding[] = [];
	for (const asset of assetsOnTimeline(loaded.doc)) {
		if (!(await fileExists(asset.video))) continue;
		const frames = await ocrAsset(ctx, asset);
		const groups = trackDetections(
			frames.map((f) => ({ t: f.t, until: f.until, detections: termDetections(f.lines, matcher, meta) })),
			assetEnd(asset, frames),
		);
		for (const g of groups) added.push({ ...g, assetId: asset.assetId, id: `f${scan.findings.length + added.length + 1}` });
	}
	if (added.length === 0) throw new ToolError(`"${query}" does not appear in any scanned frame.`);
	scan.findings.push(...added);
	await writeScan(ctx, scan);
	return added.map((f) => summarize(loaded.doc, f));
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `rtk proxy npx vitest --run tests/censor && rtk proxy npx tsc --noEmit`
Expected: all PASS. The first run compiles the OCR helper into the shared test bin dir.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scan projects for sensitive text and add custom findings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Preview and apply, exposed as MCP tools

**Files:**
- Modify: `src/analysis/frames.ts`, `src/censor/scan.ts`, `src/server.ts`
- Test: `tests/censor/preview-apply.test.ts`, `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 8 exports, `applyEdit` (tools/edit.ts), `censorAnnotations` (Task 7), `Frame` (tools/understand.ts), `timelineToSource`.
- Produces:
  - `extractFrameWithBoxes(ffmpeg: string, video: string, sourceSec: number, rects: Rect[], width = 1280): Promise<Buffer>`
  - `previewCensor(ctx, ref, opts: { findings?: string[]; times?: number[]; max: number }): Promise<Frame[]>`
  - `applyCensor(ctx, ref, ids: string[], look: CensorLook)` → same shape as `applyEdit`'s result
  - MCP tools `scan_sensitive`, `find_text`, `preview_censor`, `apply_censor` (17 tools total)

- [ ] **Step 1: Write the failing tests** — `tests/censor/preview-apply.test.ts`

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCensor, previewCensor, scanProject } from "../../src/censor/scan";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { makeTestContext, PROJECT_ID } from "../helpers/context";
import { censorFixtureFrames, makeTextVideo } from "../helpers/render";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeEach(async () => {
	t = await makeTestContext();
	if (!t.ctx.bins.ffmpeg || !t.ctx.bins.swiftc) return;
	const video = await makeTextVideo(t.ctx.bins.ffmpeg, t.ctx.bins.swiftc, t.dir, censorFixtureFrames());
	const file = join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`);
	const doc = JSON.parse(await readFile(file, "utf8"));
	doc.assets[0].originalPath = video;
	await writeFile(file, JSON.stringify(doc, null, 2));
});
afterEach(() => t.cleanup());

const ready = () => Boolean(t.ctx.bins.ffmpeg && t.ctx.bins.swiftc);
const idOf = (findings: { id: string; label: string }[], label: string) => findings.find((f) => f.label === label)!.id;

describe("previewCensor", () => {
	it("draws the boxes and names the findings in the caption", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		const email = idOf(findings, "Email addresses");
		const [frame] = await previewCensor(t.ctx, "latest", { findings: [email], times: [1], max: 8 });
		expect(frame!.caption).toBe(`t=1.00s: ${email} Email addresses`);
		expect([...frame!.jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	});

	it("picks one frame per finding by default", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		const frames = await previewCensor(t.ctx, "latest", { max: 8 });
		expect(frames.length).toBeGreaterThanOrEqual(1);
		expect(frames.length).toBeLessThanOrEqual(findings.length);
	});
});

describe("applyCensor", () => {
	it("writes every chosen blur in one save and one undo", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		const ids = findings.map((f) => f.id);
		const result = await applyCensor(t.ctx, "latest", ids, { style: "mosaic", intensity: 16 });
		expect(result.changedIds).toHaveLength(4); // email 1 + key 1 + column 2
		expect(result.project.blurs).toHaveLength(4);
		const onDisk = JSON.parse(await readFile(join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`), "utf8"));
		expect(documentSchema.safeParse(onDisk).success).toBe(true);
		await t.ctx.store.undo("latest");
		expect((await t.ctx.store.load("latest")).doc.annotations).toEqual([]);
	});

	it("refuses to apply a stale scan", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		await applyCensor(t.ctx, "latest", [findings[0]!.id], { style: "mosaic", intensity: 16 });
		await expect(
			applyCensor(t.ctx, "latest", [findings[0]!.id], { style: "mosaic", intensity: 16 }),
		).rejects.toThrow(/Run scan_sensitive again/);
	});

	it("rejects unknown finding ids", async () => {
		if (!ready()) return;
		await scanProject(t.ctx, "latest", {});
		await expect(applyCensor(t.ctx, "latest", ["f99"], { style: "mosaic", intensity: 16 })).rejects.toThrow(/f99/);
	});
});
```

In `tests/server.test.ts`, replace the expected tool list in "exposes the 13 tools" with (and rename the test to "exposes the 17 tools"):

```ts
		expect(names).toEqual([
			"add_blur", "add_text", "add_zoom", "analyze_recording", "apply_censor", "cut_range",
			"describe_project", "find_text", "get_frames", "list_projects", "preview_censor",
			"remove_region", "scan_sensitive", "set_speed", "transcribe", "undo_last_edit", "update_region",
		]);
```

and add at the end of the `describe("MCP server", …)` block:

```ts
	it("scans a project with no sensitive text over MCP", async () => {
		const { json, ctx } = await setup();
		if (!ctx.bins.ffmpeg || !ctx.bins.swiftc) return;
		const result = await json("scan_sensitive", {});
		expect(result.findings).toEqual([]);
		expect(result.config.path).toBe(ctx.paths.censorConfig);
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `rtk proxy npx vitest --run tests/censor/preview-apply.test.ts tests/server.test.ts`
Expected: FAIL — `applyCensor` / `previewCensor` not exported; server lists 13 tools.

- [ ] **Step 3: Add `extractFrameWithBoxes` to `src/analysis/frames.ts`**

```ts
import type { Rect } from "../censor/classify";

/** A frame with red outlines drawn around each 0–1 rect. */
export async function extractFrameWithBoxes(
	ffmpeg: string,
	video: string,
	sourceSec: number,
	rects: Rect[],
	width = 1280,
): Promise<Buffer> {
	const boxes = rects.map(
		(r) =>
			`drawbox=x=iw*${r.x.toFixed(4)}:y=ih*${r.y.toFixed(4)}:w=iw*${r.w.toFixed(4)}:h=ih*${r.h.toFixed(4)}:color=red@0.9:t=4`,
	);
	const { stdout } = await run(ffmpeg, [
		"-hide_banner", "-loglevel", "error",
		"-ss", sourceSec.toFixed(3), "-i", video,
		"-frames:v", "1", "-vf", [`scale=${width}:-2`, ...boxes].join(","), "-q:v", "4",
		"-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
	]);
	if (stdout.length === 0) throw new ToolError(`No frame at ${sourceSec}s of ${video}.`);
	return stdout;
}
```

- [ ] **Step 4: Add preview and apply to `src/censor/scan.ts`** — change the existing timemap import to `import { round3, sourceSpanToTimeline, timelineToSource } from "../edit/timemap";` and add:

```ts
import { extractFrameWithBoxes } from "../analysis/frames";
import { applyEdit } from "../tools/edit";
import type { Frame } from "../tools/understand";
import { type CensorLook, censorAnnotations } from "./apply";
```

and append:

```ts
function pick(scan: ScanStore, ids: string[] | undefined): ScanFinding[] {
	if (!ids?.length) return scan.findings;
	return ids.map((id) => {
		const f = scan.findings.find((x) => x.id === id);
		if (!f) throw new ToolError(`Unknown finding ${id}. Use the ids from the latest scan_sensitive.`);
		return f;
	});
}

/** Middle of a finding's longest segment, on the timeline. */
function busiestTime(doc: Doc, f: ScanFinding): number | null {
	const longest = [...f.segments].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
	if (!longest) return null;
	const span = sourceSpanToTimeline(doc.timeline.clips, f.assetId, longest.start, longest.end)[0];
	return span ? round3((span.start + span.end) / 2) : null;
}

export async function previewCensor(
	ctx: ToolContext,
	ref: string,
	opts: { findings?: string[]; times?: number[]; max: number },
): Promise<Frame[]> {
	const ffmpeg = requireBin(ctx.bins.ffmpeg, "ffmpeg", "Install it with `brew install ffmpeg`.");
	const { loaded, scan } = await loadFreshScan(ctx, ref);
	const chosen = pick(scan, opts.findings);
	const doc = loaded.doc;
	const wanted = opts.times?.length
		? opts.times
		: chosen.map((f) => busiestTime(doc, f)).filter((t): t is number => t !== null);
	const times = [...new Set(wanted.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b).slice(0, opts.max);
	const out: Frame[] = [];
	for (const t of times) {
		const position = timelineToSource(doc.timeline.clips, t);
		if (!position) throw new ToolError(`${t}s is outside the timeline.`);
		const video = doc.assets.find((a) => a.id === position.clip.assetId)?.originalPath;
		if (!video || !(await fileExists(video))) throw new ToolError(`The video for ${t}s is missing.`);
		const active = chosen
			.filter((f) => f.assetId === position.clip.assetId)
			.map((f) => ({ f, rects: f.segments.filter((s) => s.start <= position.sourceSec && position.sourceSec <= s.end).map((s) => s.rect) }))
			.filter((a) => a.rects.length > 0);
		const caption = `t=${t.toFixed(2)}s: ${active.length ? active.map((a) => `${a.f.id} ${a.f.label}`).join(", ") : "nothing blurred here"}`;
		const jpeg = await extractFrameWithBoxes(ffmpeg, video, position.sourceSec, active.flatMap((a) => a.rects));
		out.push({ at: t, caption, jpeg });
	}
	return out;
}

export async function applyCensor(ctx: ToolContext, ref: string, ids: string[], look: CensorLook) {
	const { scan } = await loadFreshScan(ctx, ref);
	const chosen = pick(scan, ids);
	return applyEdit(ctx, ref, (doc) => censorAnnotations(doc, chosen, look));
}
```

`pick` with an empty `ids` array returns every finding; `apply_censor` requires at least one id in its input schema, so that path is only used by the preview.

- [ ] **Step 5: Register the tools in `src/server.ts`.** Add imports:

```ts
import { CATEGORIES } from "./censor/config";
import { applyCensor, findText, previewCensor, scanProject } from "./censor/scan";
```

Append to `INSTRUCTIONS` (inside the template string, as a new last line):

```
Before posting publicly: scan_sensitive → show the user the numbered findings → preview_censor → find_text for anything they name → apply_censor with the ids they confirm. Never apply without the user's confirmation.
```

Register before `return server;`:

```ts
	server.registerTool(
		"scan_sensitive",
		{
			description:
				"Find sensitive text in the recording with on-device OCR (money columns and amounts, emails, name/description columns, API keys, UUIDs, URLs, browser chrome, plus the user's config). Returns numbered findings with masked examples. Slow the first time per recording, then cached. Show the list to the user and let them choose before apply_censor.",
			inputSchema: {
				project,
				categories: z.array(z.enum(CATEGORIES)).optional().describe("Only these categories; default all enabled in config."),
				force: z.boolean().default(false).describe("Re-run OCR instead of using the cache."),
			},
		},
		guarded(async (a) => json(await scanProject(ctx, a.project, { categories: a.categories, force: a.force }))),
	);

	server.registerTool(
		"find_text",
		{
			description:
				'Add a finding for text the scan missed, e.g. a person\'s or customer\'s name the user wants hidden. query is a case-insensitive substring, or "/regex/flags".',
			inputSchema: { project, query: z.string().min(1), label: z.string().optional() },
		},
		guarded(async (a) => json(await findText(ctx, a.project, a.query, a.label))),
	);

	server.registerTool(
		"preview_censor",
		{
			description:
				"Frames with red boxes around what would be blurred, so the user can check before applying. Default: one frame per finding.",
			inputSchema: {
				project,
				findings: z.array(z.string()).optional().describe("Finding ids; default all."),
				times: z.array(sec).optional().describe("Timeline seconds to show instead of the default picks."),
				max: z.number().int().min(1).max(8).default(6),
			},
		},
		guarded(async (a) => {
			const list = await previewCensor(ctx, a.project, { findings: a.findings, times: a.times, max: a.max });
			return {
				content: list.flatMap((f) => [
					{ type: "text" as const, text: f.caption },
					{ type: "image" as const, data: f.jpeg.toString("base64"), mimeType: "image/jpeg" },
				]),
			};
		}),
	);

	server.registerTool(
		"apply_censor",
		{
			description:
				"Blur the confirmed findings for their whole time on screen, in one edit (undo_last_edit reverts all of it). Requires OpenScreen to be closed. Only call after the user confirmed which findings to hide.",
			inputSchema: {
				project,
				findings: z.array(z.string()).min(1).describe("Finding ids from scan_sensitive / find_text."),
				style: z.enum(["mosaic", "blur"]).default("mosaic"),
				intensity: z.number().min(1).max(64).default(16),
			},
		},
		guarded(async (a) =>
			json(await applyCensor(ctx, a.project, a.findings, { style: a.style, intensity: a.intensity })),
		),
	);
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `rtk proxy npm test && rtk proxy npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add preview_censor and apply_censor, expose censor tools over MCP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Build, README, and acceptance on the real recording

**Files:**
- Modify: `README.md`
- Create: `docs/acceptance.md` (results)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `dist/index.js` rebuilt, no errors.

- [ ] **Step 2: Read-only scan of the real recording through the built server.** Run from the repo root (it only reads; OpenScreen may stay open):

```bash
node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "acceptance", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "ignore" }));
const t0 = Date.now();
const r = await c.callTool({ name: "scan_sensitive", arguments: { project: "proj_0dbaa405-6a72-41b9-a849-557b7b133df2" } });
console.log("first scan ms:", Date.now() - t0);
for (const f of JSON.parse(r.content[0].text).findings) console.log(f.id, f.category, f.label, f.time, f.blurs, f.examples.join(" "));
const t1 = Date.now();
await c.callTool({ name: "scan_sensitive", arguments: { project: "proj_0dbaa405-6a72-41b9-a849-557b7b133df2" } });
console.log("cached scan ms:", Date.now() - t1);
await c.close();'
```

Expected (success criteria 1 and 3 of the spec): findings include `Balance column`, `Mutasi column`, `Trans Description column`, `Address bar URL`, `Browser chrome (tabs, address bar, bookmarks)`; first scan roughly a minute or less; cached scan under 2 s. Record the output in `docs/acceptance.md`.

- [ ] **Step 3: Visual check.** Call `preview_censor` the same way for those findings and save the images (as in Step 2, writing each `image` part to the scratchpad), then look at them: every red box must cover its text and nothing important outside it. Note any overshoot in `docs/acceptance.md`.

- [ ] **Step 4: Update `README.md`.** Add a row to the tools table (`scan_sensitive`, `find_text`, `preview_censor` under "Understand"; `apply_censor` under "Edit") and this section after "Use":

````markdown
## Censor before posting

Ask Claude: "Scan my latest recording for anything sensitive before I post it."
Claude lists numbered findings (masked), shows red-box previews, adds anything you name
("also hide the customer name at the top"), and applies only what you confirm — as mosaic
blurs that follow zooms, undoable in one step. Tune it in `~/.openscreen-mcp/censor.json`:

```json
{
  "categories": { "money": true, "emails": true, "names": true, "secrets": true, "urls": true, "chrome": true },
  "alwaysHide": ["ADONAN", "/SEWU SEGAR/i"],
  "neverHide": ["neverhide"],
  "names": [],
  "moneyHeaders": [],
  "nameHeaders": []
}
```

The first scan compiles a small Swift OCR helper (needs Xcode command line tools).
````

- [ ] **Step 5: Apply with the user (OpenScreen closed).** Only after the user confirmed which findings to hide: call `apply_censor` with those ids, reopen OpenScreen, export an MP4, and scrub it at every scene change and at 1 s intervals (success criterion 2). Record pass/fail per finding in `docs/acceptance.md`; `undo_last_edit` if anything is wrong.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: auto-censor README section and acceptance results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
