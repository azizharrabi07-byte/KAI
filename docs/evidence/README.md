# KAI evidence

Everything in this directory was produced by running a command on this machine.
Nothing here is a mock, and no file here is presented as proof of something it
does not show.

Convention: each file's first lines name the command that produced it and the
date. If a claim in the report cannot be traced to a file in this directory, the
claim is not evidence.

---

## 1. Build and test logs

| File | What it is | How to reproduce |
|---|---|---|
| `upstream-build.log` | The untouched upstream Coucou Windows tree building before any edit (the control for the migration). | see `docs/migration.md` §1 |
| `kai-app-build.log` | First KAI `tauri build` (previous pass). | `cd app && npm run tauri build` |
| `kai-app-build-2.log` | The current `tauri build` — front end + Rust + NSIS bundle, after the chat-through-core change and the `hooks.ts` rebrand fix. Ends with the three artifact sizes. | `cd app && npm run tauri build` |
| `core-npm-test.txt` | `core/` test suite: **31/31 pass**, including two real model turns through `POST /chat`. | `cd core && API_SERVER_KEY=… npm test` |
| `core-live-routes.txt` | KAI Core's live HTTP surface, curl by curl, against the running service on 127.0.0.1:8788. | see the header of the file |
| `rebrand-audit.txt` | `bash scripts/rebrand-audit.sh` → **AUDIT CLEAN** (0 files, 0 hits on every upstream token, in the sources *and* in `app/dist`). | `bash scripts/rebrand-audit.sh` |

> Files in this directory that are **not** listed here — `agent-interfaces-verified.md`,
> `dpi-check.ps1`, `launch-upstream-cdp.cmd`, `launch-cdp-pinned.cmd`,
> `kai-prod-*.png` — were produced by a parallel session working on the same machine,
> not by this one. They are left in place, untouched, and nothing in this report rests
> on them.

## 2. Model / provider reality on this host

| File | What it is |
|---|---|
| `probe_models.py`, `probe_models2.py` | Drivers that ask OpenCode's own API to run a one-line prompt on a named provider/model and report the server's answer. |
| `provider-probe.txt` | The output of `probe_models2.py`: **20 provider/model pairs tried across the two probes, 0 usable**, each with the provider's own error text. |

**What this means.** No model configured in OpenCode on this machine currently
answers, so *no* agent-driven tool call — and therefore no agent-raised OpenCode
permission request — can be provoked here. That is a fact about the machine's
provider configuration, not about KAI. The one model path that does answer is
Hermes Agent's, which is why the chat relay goes through Hermes.

## 3. Chat turn, end to end

| File | What it is |
|---|---|
| `driver_hermes_chat.py` / `hermes-chat-turn.txt` / `hermes-chat-turn.json` | The raw baseline: one real turn straight to the Hermes api-server. Reply was exactly `KAI-CONTROL-LAYER-OK`, 11.6 s, provider `opencode-go`, model `deepseek-v4.1-flash`. |
| `core-live-routes.txt` (`POST /chat` sections) | The same turn going through KAI Core: `{"agent":"hermes","session_id":"api_…","reply":"KAI-CORE-LIVE-OK","usage":{…}}`, plus a **second turn on the same session id** that correctly repeats the token from the first turn — i.e. the conversation really is one conversation. |
| `island-chat-turn.txt` | The two island runs side by side, including the negative control, and the command that proves KAI holds no Anthropic key. |
| `kai-ui-04-chat.png` | The island's own chat view showing the real reply, typed and submitted through the running app. |
| `kai-ui-05-core-down.png` | The same view with KAI Core stopped: `API key missing. Open settings.` — the fallback path, and the control that proves the successful reply came through Core. |
| `kai-core-chat-turn.json` | An early attempt where the OpenCode session's agent overrode the model with a dead provider (`atessa`, HTTP 503 "No providers available"). Kept because it documents the attempt, not as a success. |

## 4. Permission / approval round trip

| File | What it is |
|---|---|
| `approval-request.json` | The `PermissionRequest` payload handed to the relay. |
| `approval-response.txt` | **kai-hook's own stdout**: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` — the exact shape Claude Code expects. |
| `kai-ui-03-approval-card.png` | The island's approval card, on screen, showing the command being authorised. |
| `kai-approval-roundtrip.txt` | `kai.log` lines for both runs of the round trip, plus the live OpenCode `GET /permission` checks. |
| `pipe-probe.py` | Lists `\\.\pipe\` and opens `\\.\pipe\kai-<sid>` — proves the relay's server exists and accepts a client. |

**The round trip, in order** (from `kai-approval-roundtrip.txt`):

```
hook PermissionRequest id=10520-1     <- relay received the ask from Claude Code
ui  decide allow req=10520-1          <- the island's Allow button was clicked
decision id=10520-1 allow             <- the pipe server forwarded the decision
hook id=10520-1 answered allow        <- the relay wrote it back; kai-hook exited 0
```

## 5. Island UI, driven for real

| File | What it is |
|---|---|
| `cdp.mjs` | A dependency-free Chrome DevTools Protocol client (Node 22+ has a global `WebSocket`). Drives the app's two WebView2 windows. |
| `win-input.ps1` | Real OS mouse input (`SetCursorPos` + `mouse_event`) and window/HWND geometry, because the island reads the cursor from the Win32 poll in `island.rs`, not from DOM mousemove. |
| `ui-click.mjs` | Converts a point inside a KAI page into screen coordinates using measured window/viewport values, moves the real cursor there and optionally clicks. |
| `launch-cdp.ps1` | Launches `kai.exe` with `--remote-debugging-port=9222`. The port is injected by environment variable, so no shipped build carries it. |
| `kai-ui-01-overview.png` | Expanded island, Hermes card (`Control layer connected`, `status ok`), pill grid. |
| `kai-ui-02-opencode-card.png` | OpenCode card after clicking the OpenCode pill: `server 1.18.33`, `3 recent sessions`. |
| `dpi-probe.ps1` | Ground-truth DPI/coordinate report (process DPI awareness before and after becoming per-monitor-v2 aware). |

## 6. Claude Code hooks

| File | What it is |
|---|---|
| `hooks-install-diff.txt` | The diff the app itself showed before writing: every line is an addition, nothing is removed. |
| `hooks-install-verify.txt` | `verify_hooks_install.py`: on-disk proof that the write was additive and reversible — only `hooks` changed, 0 pre-existing hook entries lost, KAI's 12 events each have exactly one entry, and removing KAI's entries reproduces the pre-install file **byte for byte** → `RESULT: PASS`. |
| `relay-selftest.json` | A well-formed `PreToolUse` payload for the relay self-test. |

## 6b. File drop

| File | What it is |
|---|---|
| `file-drop-drive-attempt.txt` | Both attempts to drive a drop headlessly (CDP synthetic drag, plain DOM drag events) and the result: neither reaches the app, because Tauri delivers drops over OLE. Plus the half that *was* driven: `ingest_file` copied `droptest.txt` into `%LOCALAPPDATA%\KAI\inbox\`. |
| `droptest.txt` | The 20-byte file that landed in the inbox — the artifact the evidence above points at. |

## 7. Runtime findings

| File | What it is |
|---|---|
| `runtime-findings.md` | The defects found while driving the app for real, each with the measurement behind it: the WebView/DPI mismatch and its two consequences (clipped expanded island, a click dead zone over the header buttons), the settings window that never becomes visible, and the invalid JSON in the documented relay self-test. |
