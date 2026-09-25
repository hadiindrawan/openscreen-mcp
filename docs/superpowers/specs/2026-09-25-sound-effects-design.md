# Sound effects — design

**Date:** 2026-09-25
**Status:** approach A approved in conversation; spec pending review
**Builds on:** `2026-09-25-openscreen-mcp-design.md`, `2026-09-25-auto-censor-design.md` (OCR cache)

## Goal

Claude adds sound effects from the user's own sound folder to an OpenScreen recording — a click
sound on every click, typing sounds where the user typed, and one-off sounds (whoosh, pop) on
request — so a recording is ready to post without opening another editor.

## Agreed understanding

**The user said:**
- Sounds come from their own folder, `~/sound-effects`, as mp3/wav/m4a/aac, subfolders =
  categories. No sounds are bundled; licensing is the user's responsibility.
- They add **background music** in OpenScreen, so sound effects must not use the music lane.
- Typing: the server **detects candidates, Claude confirms** from frames; the user can also name
  a stretch ("typing at 8–9 s").
- Volume: **per-category defaults**, overridable in config; Claude may set one sound's volume.

**Assumed (stated to the user, not contradicted):**
- Folder and volumes live in `~/.openscreen-mcp/sounds.json`, beside `censor.json`.
- Known categories are `click`, `typing`, `whoosh`, `pop`; any other subfolder works by name.
- Every sound used is copied to a server-owned media folder, so moving or deleting the user's
  folder never breaks a project.

**Success criteria:**
1. "Add click sounds to my latest recording" puts one sound on every recorded click that is not
   inside a cut or inside an already-placed sound (e.g. a typing stretch — the lane is one row),
   cycling through the click variants; every skipped click is reported with its reason.
2. Confirmed typing stretches get a looped typing sound spanning exactly the stretch.
3. After reopening in OpenScreen and **reordering or trimming a clip, no sound moves** (the app's
   lane repair has nothing to repair).
4. The export plays the effects over the background music at their configured levels.

## Verified facts (OpenScreen v1.12.2 source, 2026-09-25)

- `audioTracks[]` (`audioTrackSchema`): `{ id, trackId?, startMs, endMs, clipId?, sourceStartSec?,
  sourceEndSec?, assetId, kind: "voiceover" | "music", durationSec, offsetMs, gainDb (−60…12), loop,
  fadeInMs, fadeOutMs, muted, label, origin }`. `startMs/endMs` are RAW timeline ms; tracks are
  clip-anchored like other regions (`anchorAudioTrackFragments`, `document/audioTracks.ts`).
- Across a clip boundary each fragment's `offsetMs` advances by the source time its predecessors
  consumed (unless `loop`), fades stay on the outer edges, fragments share `trackId`.
- **Only two lanes** exist — `voiceover` and `music` — and each must stay one row: on every
  structural clip edit the app runs `separateAudioLanes`, which **pushes any same-kind pill that
  overlaps its predecessor later**. Different kinds may overlap. The export mixer
  (`audio.rs::mix_external_tracks`) sums every track at its gain.
- `joinContiguousTakes` merges two pills only when they are the same file and the file's offset
  continues across the join.
- Audio assets: `{ id, kind: "audio", label, originalPath, sizeBytes?, durationSec?, audio?,
  cameraTrack: null }`; supported extensions `.mp3 .wav .m4a .aac`. An audio asset never claims
  `project.primaryAssetId`. Only asset ids starting with `ext:` are auto-deleted as unused
  generated media; ours use `asset_<uuid>`.
- Audio tracks play at 1× regardless of speed regions under them.
- Typing detection probe on the user's two recordings (cached OCR, 2 fps + mpdecimate): plain
  "line grew" finds the real typing (`mutas`→`mutasi`) but also carets, avatars and truncated
  labels; "near the last click" finds `Q 00`→`Q 007` but also date pickers and misses `mutasi`.
  **OCR growth is a hint, not a detector.**

## Architecture

```
list_sounds ─▶ sounds/library ─▶ sounds/config
add_sound / add_sounds_on_clicks / add_typing
      │  pick file (library) → import (media: hash-copy + ffprobe) → place (pure) → store.save
      ▼
sounds/place.ts  (pure: events → non-overlapping voiceover-lane tracks, clip-anchored)
find_typing ─▶ censor/scan.ocrAsset (cached OCR) ─▶ sounds/typing.ts (pure candidates)
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `sounds/config.ts` | Load `~/.openscreen-mcp/sounds.json` (`folder`, `volumeDb` per category); defaults; `~` expansion. | zod |
| `sounds/library.ts` | Scan the folder: categories = subfolders (plus `(root)` for loose files), files with supported extensions, durations via ffprobe (cached by size+mtime). Resolve a `sound` argument (category name or `category/file`) to a list of files. | media.ts |
| `sounds/media.ts` | Import a file: SHA-256 of its bytes → copy to `<dataDir>/mcp-media/<sha8>-<basename>` once; return (or reuse) the project's `audio` asset for that path. | fs |
| `sounds/place.ts` | Pure: sound events → voiceover-lane `audioTracks` that never overlap each other or existing voiceover pills, skipping events inside cuts. | edit/timemap, regions |
| `sounds/typing.ts` | Pure: OCR frames + clicks → typing candidates. | censor types |
| `tools/sounds.ts` | Tool handlers. | all above |
| changes | `edit/regions.ts` gains a `sound` kind (find/remove whole track by `trackId`); `describe.ts` gains `sounds[]`; `update_region` accepts `volume` for sounds. | — |

## Config — `~/.openscreen-mcp/sounds.json`

```json
{
  "folder": "~/sound-effects",
  "volumeDb": { "click": -8, "typing": -12, "whoosh": -4, "pop": -6 }
}
```

Absent file = these values; any other category defaults to −6 dB. `volumeDb` values are clamped
to −60…12 (the schema's range). Malformed file → `ToolError` naming the file.

## Placement rules (`sounds/place.ts`)

Input: a list of `{ at: timeline seconds, file asset, durationSec, loopUntil?: timeline seconds,
gainDb, label }`, the document.

1. **Skip inside cuts.** An event whose `at` falls inside a cut's timeline span is dropped and
   reported ("click at 14.8 s is inside a cut").
2. **Lane obstacles.** Existing `voiceover` pills (fragments collapsed by `trackId ?? id`) are
   obstacles. The music lane is never read or written.
3. **Order and trim.** Events are sorted by `at`. Each new sound ends at
   `min(at + duration, next new event's at, start of the next obstacle)`; with `loopUntil` the
   natural end is `loopUntil` and `loop: true`. An event starting inside an obstacle is dropped
   and reported. A sound whose trimmed length is < 60 ms is dropped and reported. A trimmed sound
   gets `fadeOutMs: 20` to avoid a click artefact; untrimmed sounds get `0`.
4. **End of timeline.** A sound is clamped to the timeline end.
5. **Anchoring.** Each sound becomes one pill: `kind: "voiceover"`, `offsetMs: 0`, `gainDb`,
   `loop`, `muted: false`, `label` (e.g. `SFX click · soft-click.wav`), `origin: "agent"`,
   `durationSec` = file duration, `fadeInMs: 0`. It is anchored per clip with the timemap
   (`anchorSpan`); fragments share `trackId` = the first fragment's id, `offsetMs` advances by the
   elapsed span on every fragment after the first unless `loop`, `fadeOutMs` only on the last.
6. **Variants.** For a category with n files, event k (in time order) uses file `k mod n` of the
   files sorted by name — every click differs from its neighbour when n ≥ 2, and results are
   deterministic.

These rules make the written lane already satisfy the app's one-row invariant, so
`separateAudioLanes` is a no-op on it (success criterion 3).

## Typing candidates (`sounds/typing.ts`)

For consecutive OCR frames (from the censor OCR cache; OCR runs if not cached), a line at the
same place (|Δx|, |Δy| < 0.01) whose text, after stripping trailing caret-like characters
(`| * • ·` and spaces), starts with the previous text and has ≥ 1 more letter or digit, is a
**growth**. Growths in the top 12 % of the frame (browser chrome) and lines containing `…` or
`...` are ignored. Growths less than 1.5 s apart at the same place merge into one candidate
`{ start, end, before, after, nearClick: boolean }` — `nearClick` is true when the most recent
click within 8 s lies on that line (±0.06 vertically). Times are timeline seconds; candidates
inside cuts are dropped. The tool output states plainly that candidates are hints to verify
with `get_frames` before `add_typing`.

## Tools

| Tool | Input | Effect |
|---|---|---|
| `list_sounds` | — | Folder path, categories with file names, durations and default volume; or a setup message when the folder is missing/empty ("create `~/sound-effects/click/` and drop .wav/.mp3 files in"). |
| `add_sound` | `project`, `sound` (category or `category/file`), `at`, `volume?` (dB) | One sound at `at`. |
| `add_sounds_on_clicks` | `project`, `category?` (default `click`), `volume?` | One sound per recorded click not inside a cut; returns placed/skipped counts with reasons. |
| `find_typing` | `project` | Typing candidates (hints) — read-only. |
| `add_typing` | `project`, `start`, `end`, `sound?` (default `typing`), `volume?` | One looped typing sound over the stretch. |
| existing `remove_region` | sound id | Removes every fragment of that sound (`trackId`). Media file and asset stay (harmless; reused next time). |
| existing `update_region` | sound id + `volume` | Sets `gainDb` on every fragment. Moving a sound = remove + add. |
| existing `describe_project` | — | Gains `sounds: [{ id, start, end, label, volumeDb, loop }]`. |

All edits go through the existing store: app must be closed, validated against the vendored
schema, backed up, one save per tool call (so one `undo_last_edit` reverts a whole
`add_sounds_on_clicks`).

## Media import (`sounds/media.ts`)

- Destination `<dataDir>/mcp-media/<sha8>-<basename>`; copied once, reused by every project.
- The project gets one `audio` asset per destination path, reused if present:
  `{ id: asset_<uuid>, kind: "audio", label: basename, originalPath, sizeBytes, durationSec,
  cameraTrack: null }`. `project.primaryAssetId` is never touched.

## Error handling

`ToolError` for: folder missing/empty (with setup hint), unknown category or file (listing what
exists), unsupported extension, ffprobe missing (`brew install ffmpeg`), unreadable audio, event
time outside the timeline, nothing placed (every event skipped — the reasons are listed), app
running (existing guard), malformed `sounds.json`.

## Testing

- **Unit:** config (defaults, overrides, clamping, `~`), placement (no overlaps; trim to next event;
  trim to existing voiceover pill; skip inside cut; drop < 60 ms; clamp to end; loop; variants
  rotate; two-clip anchoring with offset advance; music-lane pills ignored as obstacles),
  typing candidates (synthetic frames: real growth, caret jitter ignored, chrome ignored, merge,
  nearClick), a document with placed sounds passes the vendored schema **and** is unchanged by a
  local port of `separateAudioLanes` (criterion 3 as a test).
- **Integration:** a temp sound folder with ffmpeg-generated tones (`sine`, 0.2 s and 1 s) →
  `add_sounds_on_clicks` on the test project → assets, copies and tracks written; one undo removes
  them all.
- **Manual (user):** add clicks + one typing stretch to the real recording, reopen OpenScreen,
  reorder a clip and undo it in the app, confirm sounds stay put, export and listen.

## Out of scope

Bundled sounds, downloading sounds, music-lane effects, automatic typing without confirmation,
moving a sound via `update_region`, deleting unused media files, per-sound pitch/randomisation.

## Risks

- **Typing detection is weak** (measured); mitigated by making it a hint and relying on Claude's
  frame check and the user's words.
- **User later records a voiceover in OpenScreen**: it lands in the same lane; the app will queue
  a new take behind existing pills. Documented; sounds can be removed in one undo.
- **Very dense clicks** (< 60 ms apart) lose some sounds; reported per event.
