<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="KAI icon">

# KAI for Windows

**A persistent personal AI companion and control layer that lives at the top of your screen.**

KAI watches the agents installed on your machine — Hermes Agent and OpenCode — shows what they
are doing, and lets you approve, answer, chat and drop files without leaving what you are doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

---

## What KAI is

KAI is two pieces:

- **This desktop app** — a Tauri 2 / Rust / TypeScript shell that draws KAI at the top of the
  screen and owns every OS-level capability (named pipe, Credential Manager, hooks, tray, window
  geometry). The UI is the face.
- **The control layer** — pollers in the Rust backend that read the *real* local agent servers and
  hand what they find to the island. The intelligence stays in the agents; KAI orchestrates.

KAI's own character, icon and sounds are original. See `NOTICE.md` in the repository root.

## Install

The downloadable installer is **not published yet**. Build it yourself — it takes a few minutes
and installs for the current user only, so there is no admin prompt.

## Using it

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | KAI peeks out |
| Click the small island | It opens |
| Click KAI | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on KAI for two seconds | Hearts |
| Drag a file onto the island | KAI opens its intake aperture, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a pending agent approval opens the island with **Allow /
Reject**, a finished run shows what it did, and your agents sit in the coloured pills next to KAI.

## The control layer

Two pollers run in the Rust backend. They talk to **loopback only**, and only to routes that were
verified against the live servers on this machine.

### Hermes Agent — `http://127.0.0.1:8642`

| Route | Auth | Used for |
|---|---|---|
| `GET /health` | none | liveness + `status` |
| `GET /v1/models` | `Bearer` | confirms the stored key works, lists advertised models |
| `GET /api/sessions` | `Bearer` | the recent session list shown on the card |

The key is optional. Without it the card still reports that Hermes is up — it just cannot list
sessions. Store it in **Settings… → Hermes Agent**; it goes to the Windows Credential Manager under
the target `com.aziz.kai`, key `hermes-api-key`.

### OpenCode — `http://127.0.0.1:4096`

| Route | Used for |
|---|---|
| `GET /global/health` | liveness + the server's own version string |
| `GET /session` | recent sessions |
| `GET /permission` | **pending approval requests** |
| `GET /question` | pending questions |
| `POST /permission/{requestID}/reply` | answering an approval from the island |

OpenCode's server publishes its own OpenAPI 3.1 document at `GET /doc`; every route above was read
from it and the four `GET`s were confirmed live. Start it with:

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

> **Honest status of the reply path.** `POST /permission/{requestID}/reply` is present in
> OpenCode's published spec, but no live approval request has been exercised on this machine yet
> (`GET /permission` has always returned an empty list here), so the reply round-trip is
> *spec-verified but not yet exercised*. The polling path is fully verified.

**If either server is not running, KAI says so** — the card reads "Not running · nothing on
127.0.0.1:…" rather than showing a guess.

## Keys

**Settings…** takes your Anthropic API key and the optional Hermes key. Keys live in the
**Windows Credential Manager**, never on disk and never in the interface — the island can only ask
whether a key exists.

No telemetry. The only network requests KAI makes are loopback agent probes plus the third-party
services you configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the **MSVC build tools**
(Visual Studio Build Tools with "Desktop development with C++"). WebView2 ships with Windows 10/11.

```bash
npm install
npm run tauri dev      # live-reloading development build
npm run tauri build    # produces target/release/kai.exe and the NSIS installer
npm run pack           # copies the installer into release/
```

`npm run build` (type-check + bundle only) is the fast inner loop. `npm run dev` alone serves the
front end in an ordinary browser, which is enough to work on the island's looks.

Regenerate the app and tray icons — drawn in code, like the character itself:

```bash
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Layout

```
src/                   island front end (TypeScript, no framework)
  character/           KAI itself: types (the swap contract), engine, minibots, greeting
  core/                state, bridge to Rust, geometry, sound synthesis
  island/              state machine, Claude Code hooks, integration handling
  views/               every island view
  settings/            the settings window
src-tauri/             Rust backend: window, named pipe, chat, hooks, control-layer pollers
hook/                  kai-hook.exe, the Claude Code relay
scripts/               icon generator, packer
```

### No audio, no image assets

KAI ships **no** sound files and **no** character images. The character is drawn procedurally with
Canvas 2D in `src/character/engine.ts`; every sound is synthesised at runtime from the recipe table
in `src/core/sound.ts`; the icons are rasterised from code by `scripts/gen-icons.mjs`.

### Replacing the character

`src/character/types.ts` is the character replacement interface: it fixes the vocabulary
(`BotStateName`, `BotEmoteName`, `EyeShape`, `Badge`, `RGB`, `BOT_STATES`, `STATE_SOUND`) and
`KaiEngine` implements it. A different character only has to expose the same surface — the island,
the mini bots and the greeting program against that contract and nothing else.

### Log

`%LOCALAPPDATA%\KAI\kai.log` — hook events, permission decisions, poller problems. It stays on your
machine. Settings: `%APPDATA%\KAI\settings.json`.

## Claude Code

**Settings… → Claude Code → Install hooks…** gives you the exact diff of what will change in
`%USERPROFILE%\.claude\settings.json`, the path of the dated backup that will be taken, and nothing
is written until you click. Your own hooks are never touched, and uninstalling removes only KAI's
entries.

The relay is a tiny executable, `kai-hook.exe`, copied to `%LOCALAPPDATA%\KAI\bin\` at launch. It is
given 300 ms to reach KAI and exits cleanly if the app is closed, slow or crashed — **a Claude Code
session is never blocked or slowed down by KAI.** If nobody answers in time, KAI stays quiet and
Claude Code asks in the terminal as usual. It works from any terminal.
