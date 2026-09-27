# Auto-censor acceptance — 2026-09-25

Recording: `recording-1790049298542.mp4` (35.23 s, 3600×2122, neverhide transactions table), project
`proj_0dbaa405-…`. OpenScreen 1.12.2, macOS 15.8 arm64. Read-only scan + preview through the built
server (`dist/index.js`); nothing was applied to the project yet.

## Success criteria (spec)

| # | Criterion | Result |
|---|---|---|
| 1 | Proposes Balance column, Mutasi column, transaction descriptions, address-bar URL, browser chrome band | **Pass** — findings f1–f5 |
| 3 | First scan ≈ a minute or less; repeat instant | **Pass** — 29.1 s first (OCR of the changed frames), 0.1 s cached |
| 4 | At most four tool calls (scan → preview → find_text → apply) | **Pass** by construction (4 tools) |
| 2 | Every exported frame showing an item has it covered | **Pending** — needs `apply_censor` with OpenScreen closed, then scrub an exported MP4 |

## Defect found and fixed during acceptance

The first preview (frame at 5.8 s, an "Adjust column visibility" modal open over the table) showed the
**Trans Description column covered only down to row 1**: descriptions in later rows were visible and
unboxed. Cause: `columnCells` measured the allowed gap as 3 × the *previous OCR box's height*, and
Vision box heights for the same text vary 0.005–0.022 (one misread row had h = 0.007), so the chain broke.
Fixed by measuring gaps in row *pitch* (median spacing of cell tops); reproduced first with two failing
tests (`keeps the column whole when one OCR box is unusually short`, `bridges a row hidden behind an
overlay`). After the fix the same frame shows one full-height box per column. Long-number blurs dropped
from 135 to 55 because columns now absorb their values.

## Known limitations (unchanged by the fix)

- A modal that overlaps a censored column is partly pixelated: OCR lines that merge modal text widen the
  column box. It over-covers; it never under-covers.
- Header words inside UI chrome can look like column headers (`Search column name column`, f9).
  Harmless extra blurs; the user reviews the list before applying.
- `secrets:key` also fires on long identifiers such as `L1_TRANSACTION_ADONAN_V1` (spec rule: 24+ mixed
  alphanumerics).

## To finish criterion 2 (needs the user)

1. Quit OpenScreen (⌘Q).
2. Ask Claude to `apply_censor` the findings the user confirms.
3. Reopen, export an MP4, scrub at every scene change and at 1 s steps; record pass/fail here.
4. `undo_last_edit` reverts the whole batch if anything is wrong.

---

# Sound effects acceptance — 2026-09-25

Built server (`dist/index.js`), read-only calls against the real data dir; nothing was added to a project.

| Check | Result |
|---|---|
| 22 tools registered | **Pass** |
| `list_sounds` with no `~/sound-effects` | **Pass** — "No sound effects found. Create /Users/hadi/sound-effects/click/ …" |
| `find_typing` on the 35 s recording (cached OCR) | **Pass** as a hint tool — 0.1 s, 8 candidates |

`find_typing` output on `proj_0dbaa405-…`: real typing found at 8.00–9.00 s (`mutas` → `mutasi`) and a
label growing at 22.00–22.50 s (`nearClick = true`). Noise as predicted by the spec: avatar text
(`MS` → `MSIA` at 5.5 s and 29.5 s), the caret rendered by OCR as a letter (`Search column name` →
`…namel`), pagination (`1-` → `1-63`), a date (`2024-05-13` → `… 00:00:00`). The typing of "tran" in the
filter box (~23–25 s) was **not** detected. Claude must confirm each candidate with `get_frames`.

## Still to do with the user (criteria 1–4)

1. Create `~/sound-effects/click/` and `typing/` with a few mp3/wav files.
2. Quit OpenScreen (⌘Q); ask Claude to `add_sounds_on_clicks` and one confirmed `add_typing`.
3. Reopen OpenScreen: the sounds appear in the voiceover lane at the click times; reorder a clip and undo it
   in the app; confirm no sound moved; export and listen (background music still audible).
4. `undo_last_edit` reverts each call in one step.

## Sound effects — rehearsal with the user's real downloads (2026-09-25)

Files: `clicksoundeffect.mp3`, `meme-click.mp3`, `keyboard-typing-sound-effect.mp3` (downloaded from a sound site).

**Findings on real sounds** (all would have hurt in use):
- `meme-click.mp3` has **0.53 s of leading silence** — placed on a click it would play half a second late, and
  on clicks < 0.5 s apart it would never be heard (the placer trims each sound to the next event).
- `clicksoundeffect.mp3` is a 0.19 s double-click followed by **1.25 s of silent tail**, and is quiet
  (−44/−36 dB RMS windows).
- `keyboard-typing…mp3` has 0.27 s of leading silence.
- Fix applied by hand: trimmed copies saved as WAV (mp3 adds encoder delay), peak-normalised to −3 dB, into
  `~/sound-effects/{click,meme,typing}/`. **Follow-up worth building:** the importer should detect leading
  silence and set the track `offsetMs`, and trim the silent tail from the pill length, so any downloaded
  sound works without manual prep.

**Typing hint vs frames:** `find_typing` flagged 8–9 s (`mutas` → `mutasi`) — frames show the column
list *scrolling*, not typing (false positive). The real typing ("tran" in the filter search box) is
20.6–21.5 s and was **not** flagged; it was found by looking at frames.

**Rehearsal on a copy** (`~./openscreen-mcp-rehearsal/`, OpenScreen was open so the
real project was not touched): `add_sounds_on_clicks` placed 15 click sounds (the 16th, at 35.07 s, is
inside the cut "Tail: click on recorder stop button" and was correctly skipped) and `add_typing(20.6, 21.5)`
placed one looped typing sound; 0 overlaps, 2 audio assets, both files copied once. Mixed preview:
`preview-with-sfx.mp4` (peak −11 dB).
