# openscreen-mcp

Local MCP server that lets Claude understand and edit [OpenScreen](https://github.com/getopenscreen/openscreen) recordings.

## Setup

```bash
npm install && npm run build
claude mcp add --scope user openscreen -- node ~/Documents/Hadi/Research/openscreen-mcp/dist/index.js
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
| `transcribe` — on-device Whisper (needs `whisper-cpp`) | |

All times are timeline seconds as shown in the OpenScreen editor.

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
