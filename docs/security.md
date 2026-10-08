# KAI — security and privacy

KAI sits on top of everything you do and can answer permission prompts on your behalf, so its
defaults are deliberately conservative.

## Secrets

- **Every** API key lives in the **Windows Credential Manager**, under the service target
  `com.aziz.kai`. Nothing is written to disk, and no key is ever sent to the webview.
- The front end can only ask *whether* a key exists (`secret_present`). There is no command that
  reads a key back out. Only the Rust side that actually makes the request can retrieve one.
- `secrets.rs` holds an allow-list (`KNOWN_KEYS`). Any key name outside that list is refused, so a
  compromised or buggy front end cannot use KAI as a generic credential reader.
- Settings are stored as plain JSON in `%APPDATA%\KAI\settings.json` and contain **no** secrets.

## Network

- **Loopback only for the control layer.** `127.0.0.1:8642` (Hermes Agent) and `127.0.0.1:4096`
  (OpenCode). Nothing else is contacted to make KAI work.
- The third-party pollers (Stripe, GitHub, Vercel, n8n, Resend, Notion, Cal.com) make no request at
  all until their key exists in the Credential Manager — an unconfigured integration is
  indistinguishable from a switched-off one.
- **Pause means pause.** The tray's Pause switch is checked before every poll, so a paused KAI makes
  no network calls at all, not merely a hidden island.
- No telemetry, no analytics, no update ping.

## The permission relay

This is the part with real blast radius, so it is the most constrained:

- `kai-hook.exe` gets **300 ms** to reach KAI. If KAI is closed, paused or slow, the hook exits 0
  without printing anything and **Claude Code asks in the terminal as usual**. Claude Code is never
  blocked, never slowed down, and never left without an answer.
- KAI only starts its long wait *after* the island confirms the approval card is actually on
  screen. A hidden or crashed webview costs a few hundred milliseconds, not two minutes.
- The decision timeout (108 s) is deliberately shorter than the relay's own 110 s, so KAI always
  yields to the terminal rather than racing it.
- What travels on the pipe is a bare `allow` or `deny`. Turning that into Claude Code's
  `hookSpecificOutput` JSON happens in exactly one place, in the hook.
- `~/.claude/settings.json` is only ever written **after an explicit click**, and only if the file
  still matches the fingerprint of the diff the user was shown. A dated backup is taken first, and
  uninstall removes only KAI's own entries — never somebody else's hooks.

## The local webview

- The island window is `transparent`, `decorations: false`, `alwaysOnTop`, `skipTaskbar`,
  `focus: false`. It is click-through except where the island shape is, and Rust decides that from
  its own cursor poll so the flag is never a frame behind a click.
- CSP is `default-src 'self'`; `connect-src` is limited to `ipc:` and `http://ipc.localhost`. The
  page cannot make arbitrary network requests.
- `withGlobalTauri: false` — the `window.__TAURI__` global is not exposed.
- Capabilities are minimal: `core:default` plus `autostart:default`, for the `island` and `settings`
  windows only. Everything that touches the OS goes through KAI's own named commands, each of which
  validates its input.
- No shell command is built from user text. `open_url` and `open_in_vscode` pass arguments as
  separate process arguments, never through a shell.

## Files

- A dropped file is copied into `%LOCALAPPDATA%\KAI\inbox\` and its bytes stay in Rust; only the
  file's name, path and size ever reach the webview.
- Logs (`%LOCALAPPDATA%\KAI\kai.log`) hold hook event *names* and decisions — not tool arguments,
  not file contents, not keys. The file rotates by truncation past ~1 MB.

## What KAI deliberately does not do

- It does not start, stop or reconfigure the agent servers it watches.
- It does not read Hermes' or OpenCode's own credential files. The Hermes key is pasted in by the
  user.
- It does not write to any config file without showing the diff first and getting a click.
- It does not collect or transmit anything about this machine.

## Known exposure to keep in mind

- `opencode serve` prints `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` It is
  bound to `127.0.0.1` in KAI's setup instructions, so it is loopback-only — but any local process
  can drive it. Set `OPENCODE_SERVER_PASSWORD` if that matters to you; KAI already supports the
  Basic auth header through that env var.
- The Hermes api-server is a **terminal-capable** endpoint. Its own startup guard refuses to run
  with a missing or weak `API_SERVER_KEY`, which is why KAI treats that key as sensitive and stores
  it in the Credential Manager rather than in settings.
