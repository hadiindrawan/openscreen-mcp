# Auto-censor acceptance — 2026-09-25

Recording: `recording-1790049298542.mp4` (35.23 s, 3600×2122, Matchmade transactions table), project
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
