# Runtime findings — KAI 0.1.1 on this machine

Everything below was observed while driving the running application, and each
finding carries the measurement behind it. Measured 2026-10-01 on this host.

Host: Windows 11, one display, 1920×1080, primary.

```
GetDpiForWindow(kai.exe)                              = 106    -> display scale 1.1042
HKCU\Software\Microsoft\Accessibility\TextScaleFactor = 130    -> text scale 1.3
win.devicePixelRatio (KAI and upstream Coucou)        = 1.435416579246521
                                    1.1042 x 1.3       = 1.4355
```

---

## 1. Windows text scaling lands in devicePixelRatio, not in the window scale factor

Chromium folds the Windows **text scale** into `devicePixelRatio`, while the window's
own scale factor stays on the display scale. With text size at 130 % on this machine
the two are exactly 1.3 apart, and everything that mixes page coordinates with the
app's logical coordinates inherits a 1.3 error.

`app/src/core/layout.ts` does exactly that: `PANEL_W = 720` and `EXPANDED_W = 640`
are used as though a CSS pixel and a logical pixel were the same thing. At 100 % text
scale they are. Here they are not.

### Both states were measured — and they are the before/after of a fix

| | window (physical) | viewport (CSS px) | dpr | island vs viewport |
|---|---|---|---|---|
| launch A (17:28–18:40) | 795 × 353 | **554 × 246** | 1.4354 | 640 > 554 → **clipped, 43 px each side** |
| launch B (19:16–19:3x) | 1034 × 459 | **721 × 320** | 1.4354 | 640 < 721 → fits |

In launch A the app sized the window from the monitor scale alone (720 × 1.1042 = 795)
while the WebView rendered at 1.4354, so the page's coordinate space was 554 px wide.
In launch B it sized from 1.4354 (720 × 1.4354 = 1034) and the two agree.

**The change between them is in the working tree, and it is not mine.**
`app/src-tauri/src/island.rs` (modified 18:40, `apply_geometry` and
`spawn_cursor_poll`) now multiplies the monitor scale by the Windows accessibility
text scale — `win_text_scale()`, read from
`HKCU\Software\Microsoft\Accessibility\TextScaleFactor` — because WebView2 folds that
text scale into the webview's device scale factor. `Cargo.toml` gained the
`Win32_System_Registry` feature for it. That change came in with the same-parallel
session working on the parity audit, and my 19:15 build contains it.

So the numbers above are the measurement of that fix: the monitor scale alone is what
produced 554 CSS px of viewport, and monitor × text scale is what produces 721. Both
rows were taken with the same probes on the same machine, before and after.

What is **still** worth keeping from this finding: the front end's layout
(`PANEL_W = 720`, `EXPANDED_W = 640` in `src/core/layout.ts`) still assumes that a CSS
pixel and the app's logical pixel are the same thing. On this machine they now are,
because `island.rs` compensates. Any future divergence — a different text scale
applied between polls, a DPI change mid-session — puts the two out of step again, and
the symptoms below are exactly what that looks like.

**Screenshots.** `kai-ui-01-overview.png` and `kai-ui-02-opencode-card.png` were
retaken from the current build in launch B, so they show the island **fitting** its
viewport. The clipped rendering of launch A was measured (`island x -43, w 640` inside
a `554 × 246` viewport); its captures were overwritten when the same files were
re-shot in state B, so no screenshot here shows the clipped state, and none is claimed
to.

### The same mismatch, reproduced in the upstream build, in the same session

The upstream `coucou.exe` from the pinned source tree was launched beside KAI and
measured with the same probes:

```
$ curl -s http://127.0.0.1:9224/json     # upstream, launched with --remote-debugging-port=9224
  dpr 1.435416579246521   screen.width 1338   innerWidth 554   innerHeight 246   island 288x32 at x=133
$ powershell -File win-input.ps1 -Action rect -ProcessName coucou
  -> 562,0 795x353  dpi=106 scale=1.1042
```

Identical numbers to KAI's launch A. **This is inherited from upstream, not introduced
by the migration** — which matters, because it decides who has to fix it.

### What it cost when the two disagreed

Measured in launch A, before the `island.rs` text-scale fix:

* The expanded island (640 CSS px) was wider than the viewport (554), so 43 px were
  clipped on each side; in the launch-A captures the right column of pills ran off the
  window edge.
* `island.rs` decides click-through from the island rect the page pushed, in the app's
  logical coordinates: x 40 … 680 logical → physical 606 … 1313. The rendered island
  covered 500 … 1419, so the physical strip **1313 … 1419** looked like part of the
  island and passed clicks through to whatever was behind the window. The header's gear
  (`title="Settings"`, CSS x 539–553 → physical 1335–1355) is inside that strip, and a
  real click there did nothing. In launch B, after the fix, the same click on the same
  button lands — it opens the in-island settings view — which is the control for this
  finding: the dead zone existed exactly while the two scales disagreed.
* The same disagreement made `onCursor()` in `island.ts` conclude the mouse had left
  the island while the cursor was still drawn over it, starting the auto-collapse timer
  early.

**Status:** the geometry half is **fixed in the working tree** by the `island.rs`
change described above — and the two rows of the table are its verification. The
structural half (the front end assuming CSS px = logical px) is not fixed and is
tracked here so the next divergence is recognised quickly.

---

## 2. The settings window never becomes visible

`open_settings_window` runs and reports success (invoked directly through
`window.__TAURI_INTERNALS__.invoke('open_settings_window')`, which resolves), and
the settings **page** reports `document.visibilityState === "visible"`. The OS
window does not:

```
hwnd 329652  "Settings — KAI"  IsWindowVisible = False  rect 643,148 634×792
```

It is the window Tauri created at launch with `.visible(false)` and the size it
was built with (560×680 logical → 634×792 physical with borders). Every attempt
to show it — the card's `Settings…` link, the command invoked by hand — leaves
`IsWindowVisible` false.

**Workaround used for this pass:** the settings page is alive and its JavaScript
runs, so the hooks install was driven through the page's own buttons over CDP.
That is the same code path the window's UI calls (`hooks_preview` → `hooks_apply`),
with the same fingerprint check and the same dated backup — but it is not a
mouse click on a visible window, and it is reported as such.

**Status:** not fixed. This needs a Windows-side look (window creation order,
`WS_EX_NOACTIVATE`, or the `WebView2` environment being created before the second
window — `lib.rs` already documents that a later WebView2 window comes up blank).

---

## 3. Once hidden, the island cannot be woken with the mouse

Reproduced twice, deterministically. With the island hidden the window is the 345×9
wake strip at (787,0), the page viewport is 241×8 CSS px and `#wake-strip` is a
240×6 element inside it:

```
$ powershell -File win-input.ps1 -Action rect   -> 787,0 345x9     (the strip)
$ powershell -File win-input.ps1 -Action move -X 959 -Y 3          (real cursor, inside the strip)
$ powershell -File win-input.ps1 -Action rect   -> 787,0 345x9     (unchanged)
   island element: 184x0, content opacity 0
```

The wake path is the strip's DOM `mouseenter`, so the question is whether the page
sees the mouse at all. It does not. With listeners installed in the page and the real
cursor swept to six points inside the strip, **zero events arrived** (the event log
did not grow), while the same listeners in the expanded state recorded `mouseenter`
and `mousemove` normally.

The reason is in the window flags, read straight off the HWND:

```
exstyle = 0x000C0138  ->  WS_EX_LAYERED, WS_EX_TRANSPARENT
GetLayeredWindowAttributes -> ok=True alpha=255 flags=2 (LWA_COLORKEY)
```

`WS_EX_TRANSPARENT` is what Windows uses for click-through, and it is what Tauri's
`set_ignore_cursor_events(true)` sets. While the island is collapsed the whole window
has it, so the OS never delivers a mouse message to the WebView — and the strip is
transparent on top of that (`background: transparent` in `style.css`), which a layered
window hit-tests per pixel. The island therefore has no mouse path back.

`set_collapsed(true)` does clear click-through and then parks the cursor poll
(`gate.set_active(false)`; see `lib.rs` / `island.rs`). The flag being set anyway is
consistent with the poll's last in-flight tick re-applying it (its last evaluation was
"cursor is not on the island") before the thread parks — that part is inference from
the code, not a measurement; what is measured is the flag state above and the absence
of input.

Injecting the same move at renderer level (CDP `Input.dispatchMouseEvent`) bypasses the
OS and wakes the island immediately. That is how the UI evidence in this directory was
produced — a workaround, not a fix.

**Status:** not fixed, and this is the finding most likely to matter to the user: with
`autoCloseInterval` at 15 s, an island that hides is an island with no way back by
mouse.

---

## 4. The documented relay self-test used invalid JSON

`docs/development.md` showed:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"selftest"}' \
  | ./target/release/kai-hook.exe PreToolUse
```

Single quotes are literal in sh, so `"C:\Users\..."`-style backslashes (and any
`\U`) stay unescaped and the payload is not valid JSON. The relay parses before it
logs, so the command printed nothing, exited 0, and left no trace — it looks like
a pass and proves nothing. With a well-formed payload on stdin the same command
writes `hook PreToolUse` to `%LOCALAPPDATA%\KAI\kai.log`.

Fixed in `docs/development.md`, and the working payload is checked in at
`relay-selftest.json`.

---

## 5. Two bugs in `core/`'s Hermes client, found by using it

Neither was reachable before this pass, because nothing called `POST /chat`.

1. **The session object was read from the wrong key.** `POST /api/sessions`
   answers `{"object":"hermes.session","session":{"id":"api_…"}}`. The client
   looked under `data` and then at the top level, so `id` came back as `""` and
   every turn would have been posted to `/api/sessions//chat`.
2. **A fixed session title only works once.** Hermes refuses a duplicate:
   `400 invalid_title — "Title already in use by session api_…"`. The relay now
   stamps the title with an ISO timestamp.

Both are fixed and covered by the live `/chat` test, which is what exposed them.

---

## 6. Not a defect: what could not be provoked

`GET /permission` on the OpenCode server stayed `[]` throughout. Two independent
reasons, both measured:

* No provider answers (see `provider-probe.txt`), so no agent can issue a tool
  call, so nothing can ask for approval.
* The server's own `POST /api/session/{id}/permission` ("Create permission
  request") auto-resolves: it answered
  `{"data":{"id":"per_…","effect":"allow"}}` and the queue stayed empty, because
  this OpenCode configuration has no `ask` rule for `bash` and the default is
  allow. Adding one would mean `PATCH /config`, which rewrites the user's own
  OpenCode configuration and cannot be restored byte-for-byte — not done.

What *was* proven instead is KAI's own approval loop, which is the part KAI owns:
relay → island card → click → decision → back to Claude Code (§4 of
`README.md`). The OpenCode queue half is documented as unexercised rather than
claimed.
