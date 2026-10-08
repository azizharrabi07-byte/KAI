# KAI's appearance — live evidence

Owner complaints #7 (characters not fully exposed) and #8 (subagents need their
own outfit/colour/identity), plus "the owner must be able to change KAI's
appearance and have it persist across a restart".

Everything here was produced against the **real packaged product**:
`app/target/release/kai.exe` (rebuilt 2026-10-03 via `npx tauri build`, mtime
20:02), Core on `http://127.0.0.1:8788` (unauthenticated `/identity`), island
`http://tauri.localhost/`, WebView2 debug port 9222.

## Files

| file | what it is |
| --- | --- |
| `appearance-01-before-orb.png` | KAI baseline: **blue** body, **no** accessory |
| `appearance-01-before-island.png` | the same KAI in the island |
| `appearance-02-after-orb.png` | after the UI change: **yellow** body + **cap** outfit |
| `appearance-02-after-island.png` | the same KAI-Coder in the island |
| `appearance-03-after-restart-orb.png` | after killing and relaunching kai.exe: still **yellow** + **cap** |
| `appearance-test.mjs` | the CDP harness (`change` / `verify` phases) |
| `appearance-test-results.json` | machine-readable results |
| `appearance-test-run.txt` | the run log |

## What the harness did

**change phase** (`node appearance-test.mjs change`):

1. Read the baseline from the island's own hook `window.__kaiAppearance()` →
   `{id:"kai", skin:"blue", theme:"aqua", accessory:"none"}`; saved the orb PNG.
2. Opened the settings window with the app's own command
   (`invoke('open_settings_window')`) and drove the **real controls**: clicked the
   `[data-preset="kai-coder"]` button, then set the
   `[data-role="appearance-skin"]` select to `yellow` and the
   `[data-role="appearance-accessory"]` select to `cap`, each dispatching a real
   `change` event.
3. Re-read the island **without a restart**: it had become
   `{id:"kai-coder", skin:"yellow", theme:"sun", accessory:"cap"}` and the orb
   canvas PNG differs from the baseline.

**verify phase** (`node appearance-test.mjs verify`), after
`Stop-Process kai` + relaunch:

4. The freshly-launched island reports
   `{id:"kai-coder", skin:"yellow", theme:"sun", accessory:"cap"}` and
   `localStorage["kai.appearance.v1"]` holds the same JSON → the choice survived
   a real restart.

## Visual inspection (`vision_analyze`)

- `appearance-01-before-orb.png` → "bright sky-blue" orb, "does **not** wear any
  hat, halo, headphones, or hair"; eyes white.
- `appearance-02-after-orb.png` → "golden-yellow" body with a "silver, metallic,
  wireframe dome ... on top of its head"; eyes cyan glow.
- `appearance-03-after-restart-orb.png` → "bright yellow" body wearing a
  "dome-shaped hat" — i.e. the cap survived the restart.
- `appearance-02-after-island.png` → the island shows "KAI your agent", "KAI is
  idle", with a "glowing yellow-orange sphere ... wearing a white, wireframe ...
  cap".

## Checks

```
settingsControlsFound      true
changedWithoutRestart     true
appliedSelection          true
orbPngsDiffer             true
persistedAcrossRestart    true
```
