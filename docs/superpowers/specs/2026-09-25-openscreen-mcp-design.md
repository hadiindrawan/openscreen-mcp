# OpenScreen MCP — design

**Date:** 2026-09-25
**Status:** approved approach (A — semantic-tool TypeScript server), spec pending review

## Goal

Let Claude understand what happens in an OpenScreen recording and edit it through a local
MCP server, so the user can say things like "zoom in on every click in my last recording and
cut the dead time", then reopen the project in the OpenScreen app to preview, tweak and export.

## Decisions already made

| Question | Decision |
|---|---|
| Where is the result finished? | In the OpenScreen app. The server edits the app's own projects in place; the user reopens them in the editor. The server does **not** record or export. |
| How does Claude understand the video? | All three signals: key-frame screenshots, cursor clicks/pauses, voice transcript. |
| Approach | Semantic tools (A). Claude never writes raw JSON; the server converts, validates, backs up and writes. |
| Runtime | Node 22 + TypeScript, `@modelcontextprotocol/sdk`, `zod`, stdio transport, Vitest. |
| Location | `~/openscreen-mcp`, local only, not published. |

## Environment facts this design relies on (verified 2026-09-25)

- OpenScreen **1.12.2** at `/Applications/Openscreen.app`, macOS 15.8, arm64.
- App data dir: `~/Library/Application Support/openscreen/`
  - `projects/<projectId>.openscreen` — `AxcutDocument`, `schemaVersion: 7`, pretty JSON.
  - `recordings/recording-<ts>.mp4`, `recording-<ts>.mp4.cursor.json`, `recording-<ts>.session.json`.
  - `stt-models/whisper-ggml/ggml-small-q8_0.bin` — Whisper model already downloaded.
- `ffmpeg` / `ffprobe` at `/opt/homebrew/bin`. `whisper-cli` is **not** installed
  (`brew install whisper-cpp` provides it).
- Cursor file: `{ version: 2, provider, samples[], assets[] }`; each sample
  `{ timeMs, cx, cy, visible, interactionType: "move" | "click" | "mouseup", assetId }`,
  `cx`/`cy` are 0–1 frame fractions, `timeMs` is **asset source time**.
- Upstream schema source: `getopenscreen/openscreen` tag **`v1.12.2`** (matches the installed
  app; byte-identical to `main@d951e53` on 2026-09-25), `src/lib/ai-edition/schema/index.ts`,
  which depends on `zod ^4.1.12`.

## The document model we write (v7)

Only the parts the tools touch:

- `timeline.clips[]` — `{ id, assetId, sourceStartSec, sourceEndSec?, timelineStartSec, timelineEndSec, … }`.
- `timeline.trimRanges[]` — spans that are **cut**, in asset **source** seconds:
  `{ id, assetId, clipId, startSec, endSec, reason, origin }`.
- `zoomRanges[]` — `{ id, startMs, endMs, clipId, sourceStartSec, sourceEndSec, depth: 1..6, focus: {cx, cy}, focusMode?: "manual" | "auto", … }`.
- `annotations[]` — `{ id, startMs, endMs, clipId, sourceStartSec, sourceEndSec, type: "text" | "blur" | …, content, textContent?, position: {x, y} (0–100 %), size: {width, height} (%), style, zIndex, blurData? }`.
- `legacyEditor.speedRegions[]` — `{ id, startMs, endMs, speed, clipId, sourceStartSec, sourceEndSec }`
  (`legacyEditor` is a passthrough object; it may be `null`).

Rules from upstream `timeline-model.md` that the server must respect:

1. **Three time frames.** RAW ruler (what the user sees; trims still occupy space), SOURCE
   (a clip's media time), COMPRESSED (trims removed). Inside one clip, RAW ↔ SOURCE is a plain
   shift: `raw = clip.timelineStartSec + (src − clip.sourceStartSec)`.
2. **The anchor is the truth.** `clipId + sourceStartSec + sourceEndSec` decide where a region
   plays; `startMs`/`endMs` are a cache of the RAW span and must be written consistently.
3. **A region spanning several clips is stored as one fragment per covered clip.**
4. **Repel:** two regions of the same kind with different properties may not overlap.
5. IDs are `${prefix}_${uuid}` (`zoom_`, `trim_`, `annotation_`, `speed_`).

## Architecture

```
Claude ──stdio──▶ server.ts (tool registry)
                    │
      ┌─────────────┼──────────────────────────┐
      ▼             ▼                          ▼
  project/       analysis/                  edit/
  store.ts       cursor.ts                  timemap.ts
  guard.ts       scenes.ts                  zoom.ts
  paths.ts       frames.ts                  cut.ts
  vendor/        transcript.ts              annotate.ts
   schema.ts     cache.ts                   speed.ts
                                            regions.ts (overlap/remove)
```

Each unit has one job and can be tested on its own:

| Unit | Responsibility | Depends on |
|---|---|---|
| `paths.ts` | Resolve the data dir (`OPENSCREEN_DATA_DIR` env override for tests), projects dir, backup dir, cache dir, whisper model path. | — |
| `vendor/schema.ts` | Upstream `documentSchema`, copied verbatim at the pinned tag, with 3 local shims (below). | `zod` |
| `project/store.ts` | `listProjects`, `loadProject(id \| "latest")`, `saveProject(doc)` (validate → backup → atomic write), `undo(id)`. | paths, schema, guard |
| `project/guard.ts` | `assertAppNotRunning()`; injectable process check for tests. | — |
| `edit/timemap.ts` | RAW span → per-clip anchored fragments; SOURCE time → RAW time(s); RAW time → `{clip, sourceSec}`. Pure functions. | — |
| `edit/*.ts` | Pure `(doc, input) → newDoc` transforms, one file per edit kind. | timemap |
| `analysis/cursor.ts` | Parse cursor file → clicks, dwells, idle stretches, median position in a span. | — |
| `analysis/scenes.ts` | ffmpeg scene-change detection → timestamps. | ffmpeg |
| `analysis/frames.ts` | Extract JPEG frames at source times. | ffmpeg |
| `analysis/transcript.ts` | ffmpeg → 16 kHz mono WAV → `whisper-cli` → timestamped sentence segments (`-oj` JSON). | ffmpeg, whisper-cli |
| `analysis/cache.ts` | Per-asset cache in `<dataDir>/mcp-cache/<assetId>/` keyed by the video's size + mtime. | paths |

### Vendored schema shims

The upstream file imports three helpers. The server only ever parses **v7** documents
(the loader rejects any other `schemaVersion` before parsing), so the migration upgraders
that use them never run:

- `createId(prefix)` → `${prefix}_${crypto.randomUUID()}` (identical to upstream).
- `toAspectRatioToken` → copied from upstream `src/utils/aspectRatioUtils.ts` at the same tag.
- `anchorRegionsWithDerivedMs` → throws `"pre-v7 documents are not supported"`.

The zod major version must match upstream's `package.json` at the pinned tag (zod 4).

## Time convention for every tool

All tool inputs and outputs use **timeline seconds** — the RAW ruler the user sees in the
editor, where cut sections still take up space. A number Claude reads from
`analyze_recording` can be passed straight into an edit tool. For the common single-clip
project (clip at 0, covering the whole recording) timeline seconds equal recording seconds.

- **RAW span → anchors:** for every clip overlapping `[a, b]`, emit a fragment with
  `sourceStartSec = clip.sourceStartSec + (max(a, ts) − ts)`,
  `sourceEndSec = clip.sourceStartSec + (min(b, te) − ts)`,
  `startMs = max(a, ts) · 1000`, `endMs = min(b, te) · 1000`. Drop zero-length fragments.
  No overlapping clip → error `"range X–Y is outside the timeline (0–Z)"`.
- **SOURCE time → RAW:** a telemetry/scene/transcript time maps onto every clip whose source
  window contains it (a duplicated clip shows the event twice).
- **RAW time → SOURCE:** the clip containing it (inclusive end for the last clip), for frame
  extraction.

## Tools

`project` accepts a project ID or `"latest"` (most recently updated) in every tool.

### Understand (read-only; allowed while the app is running)

| Tool | Input | Output |
|---|---|---|
| `list_projects` | — | ID, title, duration, updated time, counts of zooms/cuts/texts/speed changes; newest first. |
| `describe_project` | `project` | Clips; every cut, zoom, text, blur and speed region with its ID and timeline span; kept duration after cuts. |
| `analyze_recording` | `project`, `include?: ("cursor" \| "scenes" \| "transcript")[]` (default all available) | One chronological event list in timeline seconds: clicks (with position), dwells (cursor still ≥ 1.5 s, with position), idle stretches (no movement and no click ≥ 2 s — candidate cuts), scene changes, transcript lines. Transcript only if already cached (see `transcribe`). |
| `get_frames` | `project`, `times?: number[]` **or** `at?: "clicks" \| "scenes" \| "evenly"`, `max?` (default 8, cap 12) | MCP `image` content (JPEG, 1280 px wide) with a text caption per frame: time plus events within ±0.5 s. |
| `transcribe` | `project` | Runs Whisper (slow, cached). Returns segment count and language, or a clear "no audio stream" / "whisper-cli not installed — run `brew install whisper-cpp`" message. |

Cursor dwell/idle thresholds: "still" means moved less than 0.5 % of the frame's width.

### Edit (refused while the app is running)

| Tool | Input | Effect |
|---|---|---|
| `add_zoom` | `project`, `start`, `end`, `depth` 1–6 (1.25×–5×), `focus?: {cx, cy} \| "cursor"` (default `"cursor"`) | Adds a zoom anchored per clip. `"cursor"` → `focusMode: "auto"` and `focus` = median cursor position in the span (0.5, 0.5 when there are no samples). An explicit point → `focusMode: "manual"`. |
| `cut_range` | `project`, `start`, `end`, `reason` | Adds one trim per covered clip, `origin: "agent"`. |
| `add_text` | `project`, `start`, `end`, `text`, `placement?: "top" \| "center" \| "bottom" \| {x, y}` (default `"bottom"`), `fontSize?` (default 32), `color?`, `background?`, `animation?` | Adds a `type: "text"` annotation; `zIndex` = current max + 1. |
| `add_blur` | `project`, `start`, `end`, `rect: {x, y, width, height}` (percent of frame), `style?: "blur" \| "mosaic"` (default `"blur"`), `shape?: "rectangle" \| "oval"` | Adds a `type: "blur"` annotation. |
| `set_speed` | `project`, `start`, `end`, `speed` (0.1–16, rounded to 2 dp) | Adds speed fragments to `legacyEditor.speedRegions`, creating `legacyEditor` if it is `null`. |
| `update_region` | `project`, `id`, fields the region's add tool accepts | Replaces the region's fragments (re-anchored) keeping its ID on the first fragment. |
| `remove_region` | `project`, `id` | Removes a zoom, cut, annotation or speed region by ID. Removing a cut restores that footage. |
| `undo_last_edit` | `project` | Restores the backup taken before the server's most recent write to that project. |

**Overlap rule (repel):** `add_zoom` rejects overlap with another zoom, `set_speed` with
another speed region, `add_text` with another text, `add_blur` with another blur (text and
blur may overlap each other). The error names the conflicting ID and span so Claude can
`update_region` or `remove_region` first. Cuts may overlap; the app merges them.

Every edit returns the changed region IDs plus the full updated `describe_project` summary,
so Claude sees the result without another call. A region that spans several clips gets one
ID per clip fragment; `update_region` works on a single fragment and refuses to move it
across a clip boundary (remove and re-add instead).

## Write path

`saveProject(projectId, nextDoc)`:

1. `assertAppNotRunning()` — if a process named `Openscreen` is running, fail with:
   "OpenScreen is open. It keeps the project in memory and would overwrite this edit on its
   next save. Quit OpenScreen (⌘Q), then retry." Reads never check this.
2. Stale-read check — the file's SHA-256 must equal the hash recorded when this edit loaded
   it; otherwise fail "project changed on disk since it was read; retry".
3. Set `project.updatedAt` to now; run `documentSchema.safeParse` as a **gate only**. A
   validation failure is a server bug: return the zod issues and write nothing.
4. Copy the current file to `<dataDir>/mcp-backups/<projectId>/<ISO-timestamp>.openscreen`;
   append `{ backup, writtenSha256 }` to `journal.json` in that folder; keep the newest 20.
5. Write `JSON.stringify(nextDoc, null, 2)` — the edited **raw** document, not the parse
   output — to a temp file in `projects/`, then `rename`. Zod strips keys it does not know,
   so writing the parse output would silently delete fields a newer app build added. Every
   region the server creates therefore spells out all of its fields instead of relying on
   schema defaults.

`undo_last_edit`: the file's current SHA-256 must equal the journal's last `writtenSha256`
(otherwise the user has edited in the app since, and undo refuses with that explanation);
restore that backup atomically and pop the journal entry. Undo also requires the app to be
closed.

## Error handling

- Tool inputs are validated by zod; bad input returns an MCP error result, not a crash.
- Domain errors (app open, out-of-range time, overlap, unknown ID, missing video, missing
  whisper-cli, no audio) return `isError: true` with one actionable sentence.
- A missing cursor file or video degrades `analyze_recording` / `get_frames` to what is
  available and says what is missing.
- Unexpected exceptions are logged to stderr (never stdout, which is the MCP channel).

## Testing

- **Unit (Vitest, no ffmpeg):** `timemap` (single clip, two clips, duplicated asset, spans
  touching clip edges, out-of-range); each `edit/*` transform produces a document that
  passes the vendored `documentSchema` and has consistent `startMs/endMs` ↔ anchor; overlap
  rejection; `cursor` click/dwell/idle detection on a trimmed copy of the real cursor file.
- **Store:** against a temp `OPENSCREEN_DATA_DIR` holding a copy of a real project — backup
  written, journal appended and pruned, atomic write, stale-read refusal, app-running
  refusal (injected process check), undo restores exact bytes, undo refuses after an
  external edit.
- **ffmpeg-backed:** a 6-second synthetic video (`ffmpeg -f lavfi testsrc` with a hard cut at
  3 s) generated in test setup; scenes detects the cut; frames returns valid JPEGs.
- **MCP integration:** SDK in-memory client ↔ server; list tools, call
  `describe_project`, `add_zoom`, `undo_last_edit` end to end.
- **Manual acceptance (real app):** quit OpenScreen → ask Claude to zoom on each click, cut
  idle stretches, add a title and speed up one section in the latest project → reopen
  OpenScreen → every edit is visible on the timeline, preview plays them, export succeeds.

## Setup

```bash
npm install && npm run build
claude mcp add --scope user openscreen -- node ~/openscreen-mcp/dist/index.js
brew install whisper-cpp   # only for transcripts
```

## Out of scope

Recording, exporting, importing media, webcam layout, cursor styling, wallpaper, writing
transcripts or captions into the project, pre-v7 projects, Windows/Linux paths, and
editing while the app is open.

## Risks

- **Format drift.** OpenScreen says the project format may change. Mitigation: the pinned,
  vendored schema rejects anything it doesn't recognise, so a future format fails loudly
  instead of being corrupted. Re-vendor when OpenScreen updates.
- **`legacyEditor: null` projects.** Creating `legacyEditor` with only `speedRegions` is
  unverified against the app; the manual acceptance test covers it.
- **Annotation overlap.** Rejecting overlapping text/blur is conservative (the repel rule
  applies to every kind); relax it if the app allows stacked overlays.
