# KAI — architecture

## The shape of it

```
KAI desktop app  (Tauri 2 · Rust · TypeScript · WebView2)
      │
      │  Rust owns every OS-level capability; the webview owns pixels only
      │
      ├─ island window        always-on-top, transparent, click-through by default
      ├─ named pipe           \\.\pipe\kai-<sid>  ← kai-hook.exe (Claude Code relay)
      ├─ Credential Manager   secrets, target com.aziz.kai
      ├─ control-layer pollers ──► loopback HTTP ──► Hermes Agent  (127.0.0.1:8642)
      │                                          └─► OpenCode      (127.0.0.1:4096)
      └─ chat turn ───────────► KAI Core (127.0.0.1:8788) ──► Hermes Agent ──► model
                                 └─ if nothing is listening: the original direct
                                    Claude path, unchanged
```

The island is the face. It is not the brain, and it is not the source of truth: if the window is
hidden, minimised or restarted, the agents keep running and KAI picks the state back up on the next
poll.

**Two paths to an agent, on purpose.** The pollers read the agent servers directly — they must work
with nothing else running. Chat goes through KAI Core, because a chat turn is a relay with a session
to keep, and keeping it in one place means the island's chat is not tied to an Anthropic account.
KAI Core is optional for everything else: with nothing on 8788, chat silently uses the direct Claude
path it always had, and nothing else changes.

## Front end

No framework. Small hand-written modules, one canvas each.

| Module | Responsibility |
|---|---|
| `src/character/types.ts` | **the character replacement interface** — the vocabulary everything else programs against |
| `src/character/engine.ts` | `KaiEngine`: KAI drawn procedurally with Canvas 2D, all states and emotes |
| `src/character/minibots.ts` | one `KaiEngine` per pill/grid canvas, ticked by the island's frame loop |
| `src/character/greeting.ts` | the launch boot sequence, in the 640×150 greeting space |
| `src/core/state.ts` | the observable app state (mode, view, tasks, integrations, settings) |
| `src/core/bridge.ts` | the only place that calls into Rust; every call is a no-op in a plain browser |
| `src/core/layout.ts` | island geometry, per-view layout table, state → glow colour |
| `src/core/sound.ts` | the sound engine — WebAudio synthesis, no files |
| `src/core/anim.ts` | easing, springs, the `Tracked` grow/shrink value |
| `src/island/fsm.ts` | `hidden → greet → petit → home` state machine |
| `src/island/island.ts` | the frame loop, hit-testing, drag/drop, geometry animation |
| `src/island/hooks.ts` | Claude Code hook events → island state |
| `src/island/integrations.ts` | poller updates → island state, incl. the control-layer approvals |
| `src/views/*` | every expanded view (overview, approval, question, chat, upload, settings…) |
| `src/upload/*` | the file-drop choreography |
| `src/settings/*` | the settings window |

### The character replacement interface

`src/character/types.ts` + `KaiEngine` are the seam. The island needs exactly this much from a
character:

- fields: `isMini`, `bodyColor`, `lookX`, `lookY`, `morph`, `slotH`, `slotHTarget`, `slotHVel`,
  `tgEs`, `particleOverhang`, `eyeOverride`, `eyeOverrideUntil`, `permanentEye`, `onDizzy`
- methods: `setState(name, force?)`, `setBadge`, `blink`, `squash`, `gulp`, `slap`, `doRoll`,
  `greet`, `interruptGreet`, `setPermanentEmote`, `triggerEmote`, `emit`, `animateMorph`,
  `resetMorph`, `anim`, `update(dt)`, `draw(ctx, W, H)`
- one getter: `busy` — true while anything is still moving, so the island can stop its RAF loop

`EyeShape` is part of the contract because an `AgentTask` can carry a `miniEye`, which is how a pill
pins an expression. A replacement character that exposes this surface swaps in without touching the
island, the views or the mini-bot grid.

## Back end (Rust, `src-tauri/`)

| Module | Responsibility |
|---|---|
| `lib.rs` | app wiring, the `Shared` state, every `#[tauri::command]` the island calls |
| `island.rs` | window geometry, the cursor poll, click-through (`PollGate`) |
| `pipe.rs` | the named-pipe relay server; permission requests stay connected until answered |
| `hooks.rs` | preview/apply/remove KAI's entries in `~/.claude/settings.json`, with a fingerprint |
| `integrations.rs` | every poller: the two control-layer ones, then the third-party ones |
| `claude.rs` | the chat turn: KAI Core first, then the direct Claude path (the API key and file bytes never leave Rust) |
| `secrets.rs` | the Credential Manager wrapper and the allow-list of keys |
| `settings.rs` | `%APPDATA%\KAI\settings.json`, `%LOCALAPPDATA%\KAI` paths |
| `files.rs` | the drop inbox |
| `log.rs` | the append-only `%LOCALAPPDATA%\KAI\kai.log` |
| `tray.rs` | the notification-area menu |
| `win_user.rs` | the current SID, used to name the pipe per user |

`hook/` is a separate tiny binary (`kai-hook.exe`): Claude Code spawns it on every event, it hands
the payload over the pipe and exits. It has its own 300 ms budget so Claude Code is never blocked.

## Control layer

Design rules:

1. **Loopback only.** `127.0.0.1`, two fixed ports, no configuration needed to make it work.
2. **No invented routes.** Every request is a route that was verified against the running server.
   See `integrations.md`.
3. **Failure is a first-class state.** "Not running" is displayed, not papered over.
4. **Always on.** The two control-layer pollers ignore the per-integration opt-in and the stale
   settings file — they hold no credentials and contact nothing but the local machine.

## Data on disk

| Path | Contents |
|---|---|
| `%APPDATA%\KAI\settings.json` | preferences. No secrets, ever. |
| `%LOCALAPPDATA%\KAI\kai.log` | hook events, decisions, poller problems (rotates at ~1 MB) |
| `%LOCALAPPDATA%\KAI\bin\kai-hook.exe` | the relay, staged at launch |
| `%LOCALAPPDATA%\KAI\inbox\` | files dropped onto the island |
| Windows Credential Manager | every API key, target `com.aziz.kai` |
