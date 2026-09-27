# Auto-censor — design

**Date:** 2026-09-25
**Status:** approach A approved in conversation; spec pending review
**Builds on:** `2026-09-25-openscreen-mcp-design.md` (the existing openscreen-mcp server)

## Goal

Before a recording is posted publicly, Claude finds everything sensitive in it and hides it
reliably, with minimal effort from the user. Later the same scan should be able to run as part
of an automated pipeline.

## Agreed understanding

**The user said:**
- Claude **proposes, the user confirms**: the server detects, Claude reviews and presents a
  numbered list, the user picks (and may add targets in plain words), then Claude applies.
- Categories that matter: **money & account data**, **emails & names**, **secrets & URLs**,
  **browser chrome** (tabs, address bar, bookmarks, profile) — and it must be **configurable**.
- Sound effects will come later from the user's own folder (separate mini-project, not here).

**Assumed (stated to the user, not contradicted):**
- "Configurable" = per-category on/off plus the user's own always-hide / never-hide terms.
- Moving or scrolling content is handled by a chain of static blurs, one per position.
- macOS only (Apple Vision OCR).
- Edits go through the existing store: app must be closed, validated, backed up, undoable.

**Success criteria:**
1. On the user's test recording the scan proposes, at minimum: the Balance column, the
   Mutasi column, the transaction descriptions, the address-bar URL, and the browser chrome band.
2. After applying, every frame of the export that shows one of those items has it covered.
3. A full scan of a 35 s recording finishes in about a minute the first time and is instant
   when repeated.
4. The whole flow is at most four tool calls: scan → preview → (optional find_text) → apply.

## Verified facts (2026-09-25, on the user's machine and OpenScreen v1.12.2 source)

- **Apple Vision** (`VNRecognizeTextRequest`, `.accurate`, language correction off) via a
  compiled Swift helper: 201 text lines in 1.63 s on a 3600×2122 frame of the test recording;
  **0.91 s with the same 201 lines** after downscaling to 1920 px wide. It read the full
  address-bar URL, bookmarks, the `Balance` header and every balance value
  (`1208639943`…), all transaction descriptions. Boxes are normalized 0–1 (origin bottom-left;
  the helper flips to top-left).
- `swiftc` 6.2.3 is installed (Command Line Tools); `tesseract` also exists but is not used.
- **Blur coordinates:** `annotation.x|y|w|h` are percentages **of the screen rect** — the
  displayed recording, not the output canvas with its padding/background
  (`technical-documentation/architecture/native-compositor.md`). A clip's `cropRegion`
  narrows what that rect shows.
- **Blur follows zoom:** `FrameGeometry::privacy_mask` places blur/mosaic on the zoomed
  content box, so a blur keeps covering its text through zooms and 3D tilt.
- **Overlapping annotations are normal:** the app's own `addAnnotation`
  (`src/lib/ai-edition/store/useTimeline.ts:420`) adds at the playhead without clamping against
  other annotations.

## Required change to existing behaviour

The existing server rejects a blur that overlaps another blur in time (repel rule, spec §Tools).
A table column needs many simultaneous blurs, and the app itself allows overlap, so:
**blur↔blur overlap is allowed from now on** (text↔text, zoom↔zoom and speed↔speed stay
repelled). `add_blur` and `update_region` change accordingly; their tests are updated.

## Architecture

```
scan_sensitive ─▶ frames.sample  ─▶ ocr.run (Swift helper) ─▶ cache (per asset)
                                         │
                                         ▼
                     censor/classify ─▶ censor/track ─▶ findings (cached per project)
                                                           │
preview_censor ─▶ draw boxes on frames ◀───────────────────┤
find_text      ─▶ search OCR text, add a finding ◀─────────┤
apply_censor   ─▶ findings → blur annotations ─▶ store.save (one write, one undo)
```

| Unit | Responsibility | Depends on |
|---|---|---|
| `native/ocr.swift` | Read image paths from argv; print one JSON line per image: `{ path, lines: [{ text, conf, x, y, w, h }] }`, top-left origin, 0–1. | Vision, AppKit |
| `analysis/ocr.ts` | Compile the helper on first use to `~/.openscreen-mcp/bin/ocr-<sha8 of source>` (recompiles when the source changes); run it in batches of 50 paths; parse output. | swiftc |
| `analysis/sample.ts` | One ffmpeg pass per asset: `fps=2,mpdecimate,scale=1920:-2,showinfo` → JPEGs + the source time of each kept frame. `mpdecimate` drops near-identical frames, so static screens cost one OCR. | ffmpeg |
| `censor/config.ts` | Load `~/.openscreen-mcp/censor.json`; defaults when absent. | — |
| `censor/classify.ts` | Pure: one frame's OCR lines → detections `{ category, key, label, rect }`. | config |
| `censor/track.ts` | Pure: per-frame detections over time → findings with time segments and static rects. | — |
| `censor/findings.ts` | Findings store (cache file per project, tied to the project's SHA-256), ids `f1…fn`. | cache |
| `censor/apply.ts` | Pure: findings → blur annotations (timeline mapping, crop mapping, padding). | edit/timemap, edit/annotate |
| `tools/censor.ts` | The four tool handlers. | all above |

## Detection rules (`censor/classify.ts`)

Each OCR line is tested in this order; a line can yield several detections (e.g. an email
inside a URL). `rect` is the line's box; `key` groups the same item across frames.

| Category | Rule | Key |
|---|---|---|
| `emails` | `[\w.+-]+@[\w-]+(\.[\w-]+)+` | the address |
| `secrets` | known prefixes (`sk-`, `sk_live_`, `ghp_`, `gho_`, `xox[abp]-`, `AKIA`, `AIza`, `eyJ…` JWT); UUIDs; any token ≥ 24 chars mixing letters and digits (hex/base64-ish) | the token |
| `urls` | the **address-bar line**: the topmost URL-like line (`domain.tld/…` or `://`) whose top is in the upper 12 % of the frame; any other line containing a URL with a query string | `addressbar` / the URL |
| `money` | currency-marked amounts (`Rp`, `IDR`, `$`, `USD`, `€`, `£`, `¥` + number); **columns**: a header whose text matches a money word (`Balance`, `Saldo`, `Amount`, `Mutasi`, `Total`, `Price`, `Debit`, `Credit`, `Account`, `Rekening`, `Cheque`, `No. Rek` + config `moneyHeaders`) and the cells below it — lines whose horizontal centre lies within the header's x-range ± 1 % and whose top is below the header, down to the first gap taller than 3 row heights. One detection for the whole column, rect = union of header and cells. Standalone numbers of ≥ 7 digits not in a detected column | `column:<header text>` / the number |
| `names` | **columns** whose header matches a party word (`Name`, `Customer`, `Client`, `Merchant`, `Payee`, `Description`, `Trans Description`, `Keterangan`, `Remark` + config `nameHeaders`), detected exactly like money columns; plus config `names` terms. Free-standing names elsewhere cannot be told apart from other words reliably, so Claude proposes them after looking at frames and adds them with `find_text` | `column:<header text>` / the term |
| `chrome` | a full-width band from the top of the frame to the bottom of the **row below the address-bar line** when that row starts within 3.5 % of frame height below it (the bookmarks bar; 6 % would swallow the page's own nav row on the test recording, which sits 5.9 % below), else to the bottom of the address-bar line, plus 0.5 % padding. Only on frames where an address bar was found | `chrome` |
| `custom` | config `alwaysHide` entries: plain strings match case-insensitively as substrings; `/…/flags` are regexes | the entry |

Config `neverHide` entries (same syntax) remove matching detections after all rules ran.

### Config file — `~/.openscreen-mcp/censor.json`

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

Absent file = all categories on, empty lists. A malformed file is a `ToolError` naming the
file and the JSON error. The scan result echoes the active config and its path.

## Tracking (`censor/track.ts`)

Input: frames in source order `{ t, detections[] }` plus each frame's validity window
`[t, next kept frame's t)` (`mpdecimate` means a kept frame stands for every dropped frame after
it). For each `key`:

1. Walk frames in order. A detection **continues** the open segment when its rect's IoU with the
   segment's first rect is ≥ 0.6 and no frame without that key came in between; otherwise the
   open segment closes and a new one opens.
2. A segment's rect is the union of its rects, padded by 0.4 % of the frame on every side and
   clamped to 0–1.
3. A segment's time span is `[first frame t − 0.25 s, last frame's validity end + 0.25 s]`,
   clamped to the asset. Over-cover on purpose: a privacy mask that starts early is fine, one
   that starts late is not.
4. Segments shorter than 0.3 s are extended to 0.3 s.

Tracking runs per key, but a **finding groups every key of one rule** (e.g. all UUIDs, all emails, one column), so a table of 20 IDs is one finding, not 20. A finding = its keys' segments, with `label` (e.g. "Balance column", "Address bar URL",
"Email a•••@neverhide.io"), `category`, `examples` (up to 3 masked samples: first 2 characters
then `•••`, never the full value), `timeSpan` (first–last, timeline seconds) and `blurCount`.

## Tools

| Tool | Input | Output |
|---|---|---|
| `scan_sensitive` | `project`, `categories?` (subset), `force?` (ignore cache) | Numbered findings `f1…`, grouped by category, each with label, masked examples, time span, blur count; config path + active settings; note of anything skipped (missing video, no ffmpeg/swiftc). |
| `find_text` | `project`, `query` (string or `/regex/`), `label?` | Searches the cached OCR text (scans first if needed) and adds a `custom` finding for every match, tracked like the rest. Returns the new finding(s). For names, and for anything the user names in plain words ("the customer name at the top"). |
| `preview_censor` | `project`, `findings?` (default all), `times?` (default: 1 frame per finding, at its busiest moment), `max?` (≤ 8) | Frames (JPEG) with every rect that would be blurred at that time drawn as a red outline plus its finding id; caption lists the ids. |
| `apply_censor` | `project`, `findings` (ids, required), `style?` `"blur" \| "mosaic"` (default `"mosaic"` — solid-looking, harder to reverse than a light blur), `intensity?` | Adds one blur annotation per segment × clip it touches, in **one** save (one `undo_last_edit` reverts the whole batch). Returns changed ids + updated project summary. |

### Applying (`censor/apply.ts`)

For each segment: map its source span onto every clip that plays it
(`sourceSpanToTimeline`); map its rect into the clip's screen rect — identity without a
`cropRegion`, otherwise `(v − crop.x) / crop.width` etc., clipped to the crop and dropped if
nothing remains; convert to percent; create a blur annotation spelling out every field
(same shape as `add_blur` output) with `blurData.type = style`, `shape = "rectangle"`,
`intensity`/`blockSize` = `intensity ?? 16`. Nothing is written if any annotation fails
validation.

## Caching

- OCR: `mcp-cache/<assetId>/ocr-v1.json`, keyed by video size+mtime (existing cache) — the
  expensive part, reused by every later scan and `find_text`.
- Findings: `mcp-cache/scans/<projectId>.json` `{ projectSha256, config, findings }`; reused
  when both the project and the config are unchanged; `apply_censor` refuses stale ids with
  "project changed since the scan; run scan_sensitive again".

## Error handling

`ToolError` with one actionable sentence for: `swiftc` missing ("run
`xcode-select --install`"), helper compile failure (with the compiler's last line), ffmpeg
missing, video missing, unknown finding id, stale scan, malformed config, app running (apply
only). OCR of a single unreadable frame is skipped and counted in the scan's notes.

## Testing

- **Unit (no OCR):** `classify` on hand-written OCR line fixtures modelled on the test
  recording's layout (address bar, bookmarks row, a table with `Balance` and `Mutasi`
  headers, an email, an `sk-` key, a JWT) with **synthetic values** — no real financial data
  in the repo; `track` on synthetic detections (static item, scrolling item → chained segments,
  item that disappears and returns → two segments, IoU boundary, padding, span extension);
  config parsing (defaults, regex entries, malformed file); `apply` (timeline mapping across two
  clips, crop mapping and dropping, one save / one undo); relaxed blur overlap.
- **Integration (skipped without `swiftc`/ffmpeg):** a generated 6 s video with `drawtext`:
  a static email, an `sk-` key, and a "Balance" column that scrolls up at 3 s. The scan must
  find all three, the column as two segments, and `apply_censor` must write annotations that
  pass the vendored schema.
- **Manual acceptance (user's test recording):** success criteria 1–3; then export and
  scrub the MP4 at every scene change to confirm coverage (criterion 2).

## Out of scope

Faces and images (no text), true motion tracking (continuous moving masks), audio bleeping,
Windows/Linux OCR, detecting names without a hint, auto-apply without confirmation (the
`scan_sensitive` + `apply_censor` pair is already scriptable for the later automation step).

## Risks

- **Missed text between samples.** Sampling at 2 fps can miss something visible for < 0.5 s;
  `mpdecimate` keeps every frame that *changes*, which reduces this, and spans are padded.
- **OCR misreads** (e.g. `b2od20e` for `b20d20e` in the probe) only affect the masked label,
  not the box, so coverage is unaffected.
- **Column bounds** can overshoot into a neighbour column when headers are tight; the
  preview step exists so the user sees that before applying.
- **Scan time on long recordings.** ~1 s per changed frame; a 5-minute recording with constant
  scrolling could take several minutes the first time. Cached afterwards.
