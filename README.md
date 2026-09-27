# openscreen-mcp

Local MCP server that lets Claude understand and edit [OpenScreen](https://github.com/getopenscreen/openscreen) recordings.

## Setup

```bash
npm install && npm run build
claude mcp add --scope user openscreen -- node ~/openscreen-mcp/dist/index.js
brew install whisper-cpp   # optional, for transcripts
```

## Use

1. Record in OpenScreen, then **quit OpenScreen** (⌘Q) — edits are refused while it runs.
2. Ask Claude, e.g. "Look at my latest recording, zoom in on each click, cut the idle parts and add a title."
3. Reopen OpenScreen, open the project, preview and export.

Every edit is validated against OpenScreen's own schema (vendored from `v1.12.2`), backed up to
`~/Library/Application Support/openscreen/mcp-backups/`, and undoable with `undo_last_edit`.

## Tools

| Understand (read-only, work while the app is open) | Edit (app must be closed) |
|---|---|
| `list_projects`, `describe_project` | `add_zoom`, `cut_range`, `add_text`, `add_blur`, `set_speed` |
| `analyze_recording` — clicks, dwells, idle stretches, scene changes, speech | `update_region`, `remove_region` |
| `get_frames` — screenshots Claude can see | `undo_last_edit` |
| `transcribe` — on-device Whisper (needs `whisper-cpp`) | `apply_censor` — blur confirmed findings (one undo) |
| `scan_sensitive`, `find_text`, `preview_censor` — find and preview what to hide | `add_sound`, `add_sounds_on_clicks`, `add_typing` — sound effects |
| `list_sounds`, `find_typing` — your sound folder, typing hints | |

All times are timeline seconds as shown in the OpenScreen editor.

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

The first scan compiles a small Swift OCR helper (needs Xcode command line tools). Limits: macOS
only, text only (no faces/images), a moving item gets a chain of fixed blurs, and a dialog over a
censored column can be partly pixelated. See `docs/acceptance.md`.

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

## After updating OpenScreen

Re-vendor the schema for the new version and run the tests:

```bash
npm run vendor:schema -- v<new-version>
npm test
```

If `npm test` fails on the real-project fixture, the project format changed; update the fixture and the code before using the server.

## Development

```bash
npm test          # vitest (run through `rtk proxy` if an output filter hides results)
npm run typecheck
```
