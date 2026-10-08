# KAI — Windows parity audit

Comparison basis, not memory:

| Side | Path | Revision |
|---|---|---|
| Upstream Windows implementation | `C:\Users\DELL\Desktop\coucou-source\windows` | `8e12bed` (Louis-CFM/coucou, MIT) |
| KAI Windows app | `C:\Users\DELL\Desktop\kai\app` | working tree, uncommitted |

Method: branding-normalised diff of every upstream source file against its KAI
counterpart, then live measurement of the running app over the WebView2 DevTools
Protocol. Every claim below is either a file:line, a command output, or a measured
number.

---

## 1. Current KAI architecture

- `app/` — Tauri 2 shell. Rust backend in `src-tauri/src` (`island.rs`, `pipe.rs`,
  `tray.rs`, `hooks.rs`, `secrets.rs`, `integrations.rs`, `claude.rs`), TypeScript
  front end in `src/` (`island/`, `core/`, `views/`, `character/`, `settings/`),
  Vite on `127.0.0.1:1420` in dev.
- `app/hook/` — `kai-hook.exe`, the Claude Code relay (262 lines, Rust).
- `core/` — KAI Core, the Node control plane (9 source files, own tests). Talks to the
  Hermes api-server and the OpenCode server. Since the chat-through-core change the
  app's chat calls it (`POST /chat`), and falls back to its direct-Claude path when
  nothing is listening on 8788; the two control-layer pollers still talk to the agent
  servers directly. *(Corrected by the evidence pass: this line previously read "not a
  runtime dependency of the app".)*
- Data: `%LOCALAPPDATA%\KAI\kai.log`, WebView2 profile `%LOCALAPPDATA%\com.aziz.kai\`,
  secrets in the Windows Credential Manager under `com.aziz.kai`.

## 2. Upstream Windows architecture

Same Shape: transparent, borderless, always-on-top, `skipTaskbar`, `focus:false`
window at the top centre of the monitor; two window sizes — an invisible 240×6 wake
strip when hidden and a 720×320 panel when open (`island.rs:27-31`); a cursor poll
thread that owns click-through (`island.rs:275+`); a named pipe for the Claude Code
relay; tray; autostart; single instance; secrets in the Credential Manager.

## 3. Missing upstream functionality

None found. Every upstream feature is present: island expand/retract, greeting,
FSM (`hidden`/`petit`/`home`/`greet`), ticker, chat, file drop (canvas + sequence),
settings window, hooks install/preview/apply with diff + backup, named pipe, tray
menu, autostart, single instance, multi-monitor repositioning, integrations ticker.

## 4. Broken functionality

| # | Symptom | Cause | Status |
|---|---|---|---|
| 1 | Panel clipped right and bottom; "incorrectly sized" | accessibility text scale not modelled in window geometry | **fixed, verified** |
| 2 | Controls/keys sometimes do nothing | same defect corrupted cursor→CSS coordinates, so click-through and hit-testing were ~30 % out | **fixed, verified** |
| 3 | No working LLM path | the configured provider was dead | **open — see §10** |
| 4 | Bottom row of the Hermes card clipped by a few pixels | KAI's added card needs ~111 px in a 105 px `.card { height:100%; overflow:hidden }` | **open — see §5a** |
| 5 | Settings gear does not open the Settings window from a click | backend command works when invoked directly; the click path did not fire | **open, not yet isolated — see §8a** |

### Byte-identical files (19)

`src-tauri/src/{files,hooks,island,log,pipe,tray,win_user}.rs`, workspace
`Cargo.toml`, `index.html`, `settings.html`, `src/main.ts`, `src/core/anim.ts`,
`src/views/{chat,dom,icons,ticker,upload,views}.ts`, `src/settings/settings.css`.

### Divergence, by cause

| Cause | Files |
|---|---|
| Branding rename only | `tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml`, `main.rs`, `claude.rs`, `secrets.rs`, `settings/main.ts`, `style.css`, `upload/sequence.ts`, `upload/canvas.ts` |
| FSM state renamed `coucou` → `greet` | `island/fsm.ts`, `island/island.ts` |
| KAI-specific additions | `integrations.rs` (+380), `views/integrations.ts` (+190), `lib.rs` (+11), `island/integrations.ts`, `core/state.ts`, `core/bridge.ts` |
| Original character replaces Mochi | `character/{engine,greeting,minibots}.ts` |
| Synthesised audio replaces upstream WAVs | `core/sound.ts`, `vite.config.ts` (the `sharedSounds` plugin was removed — upstream ships no audio in `windows/`) |
| Project colour map | `core/layout.ts` (colours only; all layout maths unchanged) |

## 5. UI sizing cause

`island::apply_geometry` sized the window as `logical × monitor.scale_factor()`.
Windows accessibility **Text size was set to 130 %** (`HKCU\Software\Microsoft\Accessibility\TextScaleFactor = 0x82`).
WebView2 folds that into the webview's device scale factor — Chromium's own
`GetScaleFactorsForDPI(dpi, include_accessibility)` multiplies the monitor DPI scale
by the text scale, and the WebView2 API documents rasterization scale as "the
combination of the monitor DPI scale and text scaling set by the user".

Measured on this machine (110 % display + 130 % text):

| Quantity | Value |
|---|---|
| window DPI scale (`GetDpiForWindow`) | 1.1042 |
| webview `devicePixelRatio` | **1.4354** (= 1.1042 × 1.3) |
| 240 px wake strip given | **185 px** of CSS width |
| 720 px panel given | **554 px** of CSS width |

So the island's CSS — a fixed 240/720 px design, unchanged from upstream — was
rendered into a viewport 1.3× too small and overflowed its window. `style.css`
has `overflow: hidden` on `html, body`, so the overflow was clipped rather than
scrollable: exactly the screenshot.

## 6. Clipping cause

Same as §5. Measured before the fix: `#wake-strip` right edge 213 px against a
185 px viewport; overview content 312 px wide inside 185 px. After the fix:
window 1034×459 physical ÷ 1.4354 = **720×320 CSS**, `clippedCount` 0.

## 7. Broken keyboard behaviour cause

**Not a keyboard defect.** The handlers are byte-identical to upstream —
`island.ts:548` (`Escape` → collapse when expanded and not pinned) and
`chat.ts:96` (`Enter` → send). The island is `WS_EX_NOACTIVATE` and only takes
keyboard focus through `focus_window(true)`, which the front end calls when the
chat field opens. Because cursor coordinates were ~30 % out (§8), the click that
should have opened that field landed elsewhere, so focus was never granted and
keystrokes went to the previous foreground app. Fixing the scale fixes the path.

## 8. Broken button/event cause

**Not a wiring defect.** Every visible control calls a real command:
`Bridge.openInVSCode` (`views/integrations.ts:73`), `Bridge.openN8n` (`:82`),
`Bridge.openUrl` (`:91`, `:158`, `:277`), `Bridge.refreshIntegration` (`:101`,
`:409`, `:452`, `:502`), `Bridge.opencodeReplyPermission` (`:486`). The cause was
the coordinate error above: `spawn_cursor_poll` converted physical cursor pixels
to CSS pixels with `win.scale_factor()` alone, so every emitted `cursor` event was
1.3× too far from the origin, and the click-through decision
(`HIT_MARGIN`, `on_island`) was wrong by the same factor — the island ignored
clicks that were visually on it.

## 9. Missing integration wiring

None. Integrations are real, and the app's own log proves it:

```
2026-10-01 19:03:06 control layer: Hermes api-server reachable on http://127.0.0.1:8642 (status ok)
2026-10-01 19:03:08 control layer: OpenCode reachable on http://127.0.0.1:4096 (server 1.18.33, healthy true, 3 recent session(s) listed)
```

`reachable` is derived from a real HTTP health probe (`integrations.rs:846`,
`:982` — `let reachable = health.is_some()`), never hardcoded. A search for
`mock|fake|placeholder|dummy|hardcoded` across the shipped app and core source
found **no** mock state; the only "placeholder" hits are upstream's own UI copy
(`views.ts:474 buildPlaceholder`, "Sending by email isn't in this version").

## 10. LLM wiring — the working path is now proven

Evidence from this repo's own probes (both failed):

- `docs/evidence/kai-core-chat-turn.json`: session created, prompt sent, model call
  failed — `405 Method Not Allowed: This is a static site` from
  `https://crof.ai/v1/chat/completions`; `assistant_text` empty.
- `docs/evidence/provider-probe.txt`: every probed model failed; **`USABLE: []`**.

So chat was wired end to end (UI → Rust → provider) but the configured provider was
dead — that is the whole of the defect.

**The fix is verified, not speculative.** The Hermes gateway api-server on
`127.0.0.1:8642` exposes a real task API, and a live test returned a real model
response:

```
POST http://127.0.0.1:8642/v1/runs {"input": "Reply with exactly: KAI-LLM-PATH-OK"}
  -> 202 {"run_id": "run_b6215be3c1c646dc9a90d0f59f06f685", "status": "started"}
GET  /v1/runs/run_b6215be3c1c646dc9a90d0f59f06f685
  -> 200 {"status": "completed", "output": "KAI-LLM-PATH-OK",
          "runtime": {"provider": "opencode-go", "model": "deepseek-v4.1-flash"}}
```

Auth is `Authorization: Bearer <API_SERVER_KEY>` — the same value KAI already has a
Credential Manager slot for (`hermes-api-key`), and `GET /health` needs no key at
all. Live streaming is `GET /v1/runs/{id}/events` (SSE); cancel is
`POST /v1/runs/{id}/stop`.

Full verified interface reference: `docs/evidence/agent-interfaces-verified.md`.

Status: **mechanism verified working; wiring KAI's chat through it is the remaining
step.** The provider that is currently configured in the app must not be used.

## 11. Files that must change

- `app/src-tauri/src/island.rs` — model the text scale in geometry + cursor
  conversion (done).
- `app/src-tauri/Cargo.toml` — `Win32_System_Registry` feature (done).
- Whatever configures the chat provider (settings/`claude.rs`/core relay) plus a
  stored key — §10, still open.

## 12. Files that should NOT change

- `island.rs` layout maths, `layout.ts`, `island.ts`, `views/*`, `fsm.ts`,
  `style.css`: unchanged from upstream and correct.
- `pipe.rs`, `hooks.rs`, `tray.rs`, `files.rs`, `win_user.rs`: byte-identical to
  upstream; do not touch.
- The upstream sound/character assets: never present in `windows/`; KAI already
  synthesises audio and draws its own character.

## 5a. Residual clipping in the Hermes card (open)

After the scale fix the viewport is correct (721×320 CSS) and the page no longer
overflows, but a pixel-level crop of the shipping build still shows the bottom row
of the **Hermes card** cut off: the descenders of "Refresh"/"Settings…" are missing.

Measured geometry of the expanded overview:

| Element | Box (CSS px) |
|---|---|
| `#island` (painted surface) | y 0→160, 640×160 |
| `#views` | y 42→150 |
| `.card` | y 44→148, height **105**, `overflow: hidden` |
| `.int-card` (card content) | y 43→**155** |
| "Refresh" / "Settings…" links | y 141→**155** |

The card's content needs **111 px** (43→155) inside a **105 px** card, and
`.card` sets `overflow: hidden` (`style.css:276-283`), so the bottom 7 px is
clipped. `.card`'s height comes from upstream CSS (`height: 100%`); the extra
height is in KAI's added Hermes/OpenCode card markup
(`src/views/integrations.ts`, +190 lines vs upstream). Fix by tightening that
card's vertical rhythm to fit the inherited 105 px, or by growing `#island`'s
160 px surface and the card with it — not by hiding the overflow.

## 5b. What the fix changed, and the before/after

`island::apply_geometry` and `spawn_cursor_poll` now size and convert using
`monitor.scale_factor() × win_text_scale()`, where `win_text_scale()` reads
`HKCU\Software\Microsoft\Accessibility\TextScaleFactor`.

| Measurement | Before | After |
|---|---|---|
| webview `devicePixelRatio` | 1.4354 | 1.4354 (unchanged — it is correct) |
| window size, expanded | 795×353 physical | **1034×459 physical** |
| CSS viewport, expanded | 554×246 | **721×320** (= the 720×320 design) |
| CSS viewport, collapsed | 185×5 | **240×6** (= the design) |
| document overflow | yes (`scrollHeight` 537 vs 305) | none (`scrollHeight` 320) |
| cursor→CSS factor | 1.1042 (wrong) | **1.4341** (matches the webview) |

## 8a. Settings gear (open, not yet isolated)

Clicking the header's `title="Settings"` button did **not** make the Settings
window visible (`visible: false` before and after). Invoking the backend command
directly through the webview's own bridge —

```
window.__TAURI_INTERNALS__.invoke("open_settings_window")
```

— returned success and the window became `visible: true`. So `lib.rs`'s
`open_settings_window` → `show_settings_window` path works; the fault is between
the physical click and the button's handler. Retries and the DOM-click test could
not be completed because the running instance was terminated mid-test (see the
concurrency warning). Two other physical clicks in the same session *did* work
(clicking the island body expanded it; clicking "Refresh" fired a poll), so this
is specific to the header icon buttons and needs one clean session to isolate.

## 13. Repair plan

1. ✅ Model the accessibility text scale in `apply_geometry` and in the cursor
   poll's physical→CSS conversion.
2. ✅ Rebuild and measure: window = design size ÷ dpr; no document overflow.
3. ✅ Make a production build (`npm run tauri build`) and re-verify on the shipping
   binary. Note: a bare `cargo build --release` produces an exe that still points
   at the Vite dev URL (`localhost:1420`) and shows `ERR_CONNECTION_REFUSED`
   without a dev server running — the release path must go through `tauri build`.
4. ⬜ Fix the Hermes card's 6 px overflow (§5a).
5. ⬜ Isolate the Settings-gear click path in a clean session (§8a), then walk the
   full interaction inventory on the production build.
6. ⬜ Point the chat path at a provider that answers, then capture a real turn
   through the UI.
7. ⬜ Keep `docs/evidence/dpi-check.ps1` as the regression test for §5 — it is the
   one probe that reported the true scale factors.

## Concurrency warning

This working tree was being edited by more than one agent while this audit ran:
`claude.rs` changed at 18:51:24 during a build (producing a transient
`cannot find function core_chat` compile error), `dist/` was rebuilt at 19:01:58,
and a dev-mode instance was started at 19:03:04. Two writers on one Rust crate will
keep producing torn builds and clashing single-instance launches; the fix is one
writer at a time.
