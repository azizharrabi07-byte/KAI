# KAI — development

## Prerequisites (verified on this machine)

| Tool | Version |
|---|---|
| Windows | 11 |
| Rust | 1.99.0 stable, `x86_64-pc-windows-msvc` |
| Node | v26.7.0 |
| npm | 11.19.0 |
| MSVC Build Tools 2022 | "Desktop development with C++" |
| WebView2 runtime | 154.x (ships with Windows 11) |

## The two packages

### `app/` — the desktop application

```bash
cd app
npm install
npm run dev            # front end only, in a browser (no Rust). Fastest inner loop.
npm run build          # tsc --noEmit && vite build   — type-check + bundle
npm run tauri dev      # full app, live-reloading front end
npm run tauri build    # target/release/kai.exe + the NSIS installer
npm run pack           # copy the installer into app/release/
npm run icons          # regenerate src-tauri/icons from scripts/gen-icons.mjs
npm test               # the app's own suites (57), scoped to app/tests
```

`predev` compiles `kai-hook` in release first, because the app stages that binary at
launch. `prebuild` also builds the shipped Core (`core/` → `npm run bundle`), so a
`tauri build` can never ship a stale control plane.

`npm test` passes Node a quoted glob (`"tests/*.test.ts"`) on purpose: `node --test
tests/` is rejected by Node 26 (it treats the directory as a module specifier) and
cmd.exe does not expand globs. Scoping it to `tests/` also keeps the suite the app's
own — an earlier revision ran everything under `app/`, which meant the Core's compiled
tests in the build output were reported as app failures.

**The app starts KAI Core itself.** `src-tauri/src/core_process.rs` adopts a Core
already listening on 8788, or starts `node <core>/dist|bundle/server.js` inside a
Windows job object carrying `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and restarts it if it
dies. The job object is what makes the Core die with KAI even when KAI is killed rather
than closed (an adopted Core is deliberately left alone: the app only ends what it
started). `core_status` reports which of the three states the app is in, and the Core's
own stdout/stderr is piped into `kai.log` with a `core:` prefix.


### `core/` — KAI Core, the control plane

A Node 26/TypeScript service with **no runtime dependencies**. It owns state, agents,
missions, memory, notifications, scheduling, policy and tool routing, and serves them
on `127.0.0.1:8788`. The desktop app is a client of it: the island can be closed or
restarted without losing anything, because it does not hold the state.

```bash
cd core
npm run typecheck      # tsc --noEmit — must be zero errors
npm test               # 229 tests, straight from TypeScript, no build needed
npm run build          # emits dist/ for npm start (tests included — test:dist runs them)
npm run bundle         # emits bundle/: the same code without tests, plus the
                       # package.json that makes it ESM where core/package.json is absent
npm start              # runs the Core and the API, and owns the SQLite database
```

The API is documented in `docs/api.md`; the test setup and why it is a script rather
than a glob are in `docs/testing.md`.

**Secrets.** The Hermes key is resolved in this order: what the caller passed (the app
will pass the key it holds in the Windows Credential Manager), then `KAI_HERMES_KEY`
or `API_SERVER_KEY`, then the Hermes install's own `~/.hermes/.env`. So a hand-started
Core works without exporting anything, and nothing has to be set to boot it. If no key
can be found the adapter reports `AGENT_AUTH_FAILED` and `/state` shows the agent as
errored — it never pretends to be connected.

`core/` is optional for everything except chat and the Core's own surface: with
nothing on 8788 the app falls back to its original direct-Claude path, and the two
control-layer pollers in the app never involve it.

## Pitfalls that cost real time here

**Import specifiers are `.ts`, not `.js`.** Node executes TypeScript directly but does
not map `./x.js` onto `./x.ts`, so a `.js` specifier fails with `ERR_MODULE_NOT_FOUND`
when running from source. `core/tsconfig.json` sets `rewriteRelativeImportExtensions`,
so tsc rewrites `.ts` back to `.js` on emit and both `npm test` and `npm start` work.
Do not "fix" a `.ts` import by changing it to `.js`.

**Only one Core may run at a time** — it binds a fixed port and owns the SQLite file.
Check who holds the port before starting one:

```bash
netstat -ano | grep ':8788.*LISTENING'     # this PID is the real owner
```

**Kill a process with node, not taskkill.** `taskkill //F //PID` and
`cmd //c "taskkill /F /PID"` both failed silently here, leaving a stale Core holding
the port; the replacement then died on `EADDRINUSE` with no visible error, because
background jobs do not report. What works:

```bash
node -e "process.kill(23684)"
```

The PID owning the port can differ from the one your shell reported (a wrapper vs the
real process) — trust `netstat`, and confirm the port is free before restarting.

**Never trust `tasklist | grep` from this shell — it lies by saying nothing.** Two
traps at once: `tasklist` writes UTF-16, so `grep` prints `Binary file (standard input)
matches` and no PID, and the MSYS layer rewrites a `//FI` filter into a path, so the
filter silently does not apply. A check that returns "nothing running" therefore looks
identical whether or not the process exists — and a running `kai.exe` is exactly what
makes `npm run tauri build` fail with `failed to remove file kai.exe: Access is denied`,
with no new artifact to show for the attempt. Use PowerShell and ask for the id:

```bash
powershell -NoProfile -Command "Get-Process kai -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"
```

Do not put `$_` in a PowerShell command passed through this shell — it is rewritten to
`/c/Users/DELL` and the command fails confusingly. `Get-Process <name>` needs no `$_`.

**Rebuild before restarting.** `npm start` runs `dist/server.js`; editing `src/` and
restarting without `npm run build` silently runs the old code.

**A stale Core answering 404 on a new route means the old code is still serving.**

## Working on the character

The character is drawn, not loaded. `src/character/engine.ts` is the whole thing; there are no image
or audio files anywhere in the repository.

- `src/character/types.ts` — the contract (states, emotes, eye shapes, palette, `BOT_STATES`)
- `src/character/engine.ts` — `KaiEngine`: tweens, springs, particles, and the `draw()` method
- `src/character/greeting.ts` — the launch sequence, in a 640×150 space
- `src/core/sound.ts` — the sound recipe table

To iterate on the look, run `npm run dev` and open `dev/upload-preview.html`, which replays the
file-drop choreography on a loop. Neither dev page ships in the app.

Two rules that will otherwise bite you:

1. **The body is drawn at 60 % of the canvas.** Callers size the canvas to `bodyDiameter / 0.6` and
   pass the same numbers to `draw(ctx, W, H)`. Sizing the canvas to the diameter shrinks the whole
   drawing to 60 %.
2. **Extra height is particle room.** `H` is `W + particleOverhang`; the character centres itself
   accounting for that, so hearts and shards are not clipped.

## Verifying a change

There is no unit-test suite for the front end; verification is by building and running for real.

```bash
# 1. types
cd app && npx tsc --noEmit

# 2. full build (Rust + bundle) — must exit 0
npm run tauri build

# 3. rebrand audit — must print AUDIT CLEAN
bash scripts/rebrand-audit.sh

# 4. no reserved assets
find app/dist app/src-tauri/target/release -iname '*.wav' | wc -l          # 0

# 5. run it and read the log
./target/release/kai.exe
cat "$LOCALAPPDATA/KAI/kai.log"
```

A healthy `kai.log` from a machine with both agents running:

```
--- KAI 0.1.1 started ---
control layer: Hermes api-server reachable on http://127.0.0.1:8642 (status ok)
control layer: OpenCode reachable on http://127.0.0.1:4096 (server 1.18.33, healthy true, 3 recent session(s) listed)
hook PreToolUse
```

The last line is the relay working: send one yourself with

```bash
./target/release/kai-hook.exe PreToolUse < docs/evidence/relay-selftest.json
```

It must exit 0 whether or not KAI is running.

Two things about that command, both learned the hard way:

* **The payload has to be real JSON.** It was previously written inline in single
  quotes with Windows paths in it, so the backslashes were never escaped, the JSON
  did not parse, and the relay exited 0 having logged nothing — a test that always
  passes and proves nothing. `docs/evidence/relay-selftest.json` is a payload that
  actually parses.
* **A run with no `hook …` line in `kai.log` is a failed run**, not a quiet pass.


## Driving the running app (evidence harness)

The island is not a normal window: it reads the cursor from a Win32 poll
(`island.rs`), not from DOM `mousemove`, and it toggles its own click-through
based on where the cursor is. Consequences worth knowing before writing a test:

* A DOM `mousemove` reaches nothing — the hover state comes from `GetCursorPos`.
* The window refuses mouse input outside the island rect it was last given, so a
  synthetic click at the wrong point goes to whatever is behind the window.
* The app is single-instance, so a second `kai.exe` exits immediately (exit 0).

`docs/evidence/` carries a small harness that works with all of that:

```bash
# 1. run the app with the WebView2 debug port open (env var, not in the build)
powershell -File docs/evidence/launch-cdp.ps1
curl -s http://127.0.0.1:9222/json        # -> the island and settings pages

# 2. read the page, screenshot it, or click an element by CSS selector
node docs/evidence/cdp.mjs eval "document.title"
node docs/evidence/cdp.mjs shot /tmp/island.png
node docs/evidence/ui-click.mjs "#views .view.on .pill" --click --shot /tmp/after.png

# 3. real OS-level cursor moves and clicks, and window geometry
powershell -File docs/evidence/win-input.ps1 -Action rect
powershell -File docs/evidence/win-input.ps1 -Action windows
powershell -File docs/evidence/win-input.ps1 -Action click -X 920 -Y 25
```

`ui-click.mjs` converts a point in the page to screen coordinates from measured
values at run time (`window rect` ÷ `viewport width`), so it stays correct
whatever the display scaling does. The measurements that conversion depends on,
and what goes wrong without it, are written up in
`docs/evidence/runtime-findings.md`.

## Layout of the Rust side

`lib.rs` is the wiring: app setup, the `Shared` state, and every `#[tauri::command]`. The pollers
live in `integrations.rs`; the control-layer ones are grouped at the bottom of that file under a
banner comment, below the third-party ones.

When adding a command:

1. Write it in the relevant module.
2. Add `#[tauri::command]` in `lib.rs`.
3. Register it in `generate_handler!`.
4. Add a method to `src/core/bridge.ts` — that file is the only place the front end may call into
   Rust, and it degrades to a no-op in a browser.

## Adding a control-layer probe

1. Confirm the route against the live server first. For OpenCode, read `GET /doc` (its own OpenAPI
   document) — do not guess a path; a wrong path can silently return the web-UI SPA with HTTP 200.
2. Add it to the relevant poller's `data` payload.
3. Add a `log_once` line if it is worth seeing in `kai.log`.
4. Render it in `src/views/integrations.ts`.
5. Document it in `docs/integrations.md`, marked with how it was verified.

## Packaging

`npm run tauri build` produces:

- `target/release/kai.exe` — runs on its own, no installer needed
- `target/release/kai-hook.exe` — staged into `%LOCALAPPDATA%\KAI\bin` at launch
- `target/release/bundle/nsis/KAI_0.1.1_x64-setup.exe` — per-user install, no admin prompt

The installer's uninstall hooks (`src-tauri/nsis/hooks.nsh`) remove the staged relay, the inbox and
the log. `~/.claude/settings.json` is deliberately left alone.

The installer is **unsigned**, so Windows SmartScreen will warn on first run.
