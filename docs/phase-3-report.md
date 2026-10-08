# PHASE 3 — closing the gaps the Phase 2.5 report named

**Scope of this pass:** items A–D of the directive, then the whole chain (E), on this
machine, with the packaged build. Every claim below names the file under
`docs/evidence/` that carries the command and its real output. Where something could
not be reproduced or could not be finished here, it says so.

Revision: `c4f6670` + the commits of this pass (see `git log`). Every runtime run used
the packaged `app/target/release/kai.exe`; the final binary is the 11:21 build, which
adds two fixes found by the last runs themselves (the wake re-assert's placement, and
the once-per-adoption log line). Both are noted where they belong.

---

## A. The §8 "ensure Core" gap — **FIXED**

`app/src-tauri/src/core_process.rs` (new) is the supervisor. Three rules, in order:

1. **Adopt.** If something answers `GET /state` on `127.0.0.1:8788` with a Core-shaped
   body, use it and never start a second one. Only one Core may run — it binds a fixed
   port and owns the SQLite file.
2. **Spawn.** Otherwise `node <core>/dist|bundle/server.js`, console window suppressed,
   inside a Windows **job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**. That is
   what makes the Core die with KAI even when KAI is killed rather than closed, rather
   than a promise to clean up.
3. **Watch.** Every 4 s: a Core we started that died is started again; an adopted Core
   that disappears is treated as a cold start.

The Core's own stdout/stderr is piped into `%LOCALAPPDATA%\KAI\kai.log` with a `core:`
prefix, the Hermes key is handed to the child through its environment (never a file,
never a log), and `core_status` reports `adopted` / `owned` / `absent` with the pid and
the resolved node + entry point. The app's `prebuild` now also builds the shipped Core,
so a `tauri build` cannot ship a stale control plane.

**Evidence — `docs/evidence/push3-a-cold-start.txt`** (one run, start to finish):

* before: `netstat` shows nothing on 8788 and `curl /state` answers nothing;
* launch the packaged app: `core: started ... core\server.js (pid 11548, tied to KAI's
  lifetime)`, then the Core's own `[kai-core] listening on http://127.0.0.1:8788
  config={... "apiKeyPresent":true ...}` — the key came from the Credential Manager;
* `Get-CimInstance` on the port owner: `ParentProcessId 6680` = **kai.exe**;
* `GET /state` → `ok:true`, and `POST /chat {"text":"what is happening?"}` →
  `{agent:"core", from_state:true, intent:"status.summary", reply:"KAI status: 2
  agent(s) — hermes (idle), opencode (offline); ..."}`;
* `core_status` → `{"origin":"owned","pid":11548,"restarts":0,...}`;
* **restart:** the Core is killed under the running app → `core: the Core we started
  exited (1) — starting it again` → pid 14940 listening within one watch interval, and
  `/state` answers again;
* **no orphan:** the app is killed with `TerminateProcess` → `kai.exe: none` and
  *nothing on 8788*. The job object did it.

**Evidence — `docs/evidence/push3-a2-adoption.txt`**: with a Core already listening,
the app logs adoption once and starts nothing (`^ unchanged: the app did not start a
second Core`), exactly one process runs `core/server.js`, `core_status` reports
`{"origin":"adopted","pid":null}`, and when the app is killed the adopted Core
**survives** — the app only ends what it started.

**Two defects my own evidence caught, both fixed:**

* Tauri's resource lookup returns a Windows *verbatim* path (`\\?\C:\...`). Node reads
  that as a module specifier and dies instantly with `EISDIR: illegal operation on a
  directory, lstat 'C:'` — the first cold start produced a running app with no Core and
  a retry loop. `usable_path()` takes the prefix off (also for UNC), and the spawn
  sets the child's working directory to the Core's own folder.
* `core/dist` was being staged into the app's build output as a resource, compiled test
  files included — and `node --test` in `app/` then discovered them and reported the
  *Core's* live tests as app failures (this is how it was noticed). The shipped Core is
  now built by `npm run bundle` into `core/bundle`: no test files, plus the
  `package.json` that makes it ESM where no `core/package.json` exists (an installed
  app). `app/`'s test script is scoped to `tests/*.test.ts` for the same reason.
  Verified: `core/bundle` contains 0 test files, and running `node bundle/server.js`
  standalone (scratch DB, port 8899) answers `GET /state` with `ok:true`.

---

## B. The wake-strip defect — **FIXED**

Two independent causes, both real:

* the collapsed window carried `WS_EX_TRANSPARENT|WS_EX_LAYERED` (the poll thread's
  last in-flight tick re-applied click-through after `set_collapsed` had cleared it), so
  the OS delivered the webview **no mouse messages** and the strip's `mouseenter` could
  never fire;
* the DOM `mouseenter` was the *only* wake path, so anything that made the strip
  unhittable made the island permanently unreachable.

Fixes: the collapsed window's style is cleared after the poll parks *and* on every
collapse; the click-through decision never turns the flag on while collapsed; a
**cursor-position wake monitor** in Rust (`GetCursorPos` against the live window rect,
24 Hz, only while hidden, firing on *entry* so a parked pointer does not re-open it)
emits a `wake` event the island acts on; and the visible island re-asserts its own
style once a second so an externally-changed flag self-heals.

**Evidence — `docs/evidence/push3-b-wake-strip.txt`**, real cursor only:

* PART 1 — hidden window (787,0 345x9) reads `exstyle 0x00040118`, `exflags
  WS_EX_TOPMOST`, `layered none`: the transparent/click-through state is gone. Moving
  the real cursor away and then into the strip delivers **real mouse events** to the
  page (`stripEnter 4`, `docMove 12`) and the island comes back (`288x32` compact, the
  window back to `1034x459`).
* PART 2 — the worst case, forced: `LAYERED|TRANSPARENT` put back on the hidden window
  (`0x00040118 -> 0x000C0138`), so the webview provably sees nothing (`docMove 0`,
  `stripEnter 0`). The real cursor moves in and the island still returns, with the
  monitor's own line in `kai.log`: `ui [island] wake strip entered at 959,4 (window
  787,0 PhysicalSize { width: 345, height: 9 }) — waking`.
* PART 3 — with the window visible again, a real click on the revealed island expands
  it (`640x210`). The forced `TRANSPARENT` bit is shed automatically first: 5 s after
  the wake the style reads `0x000C0118` (`WS_EX_LAYERED|WS_EX_TOPMOST`, no
  `WS_EX_TRANSPARENT`), and the click lands.

The re-assert that sheds it was first written *below* the poll's "cursor has not moved"
early-continue, so a pointer standing still — exactly the case it exists for — never
reached it; PART 3 in an earlier run failed for that reason, and the block was moved
above the early-continue. That is the one behavioural change between the revision that
produced the A/C/D/E transcripts and the final binary; no other item is affected.

**Honest note:** hidden means hidden by *design* after `fsm.petitToHiddenDelay` (60 s)
once the pointer has left; the fix is that the wake path is now independent of the
window being hittable. The `WAKE_SLACK` of 6 physical px exists because a 9 px band is
not a target a person can hit.

---

## C. The settings window — **the reported symptom did NOT reproduce; a different, real defect was found and FIXED**

What was measured, on this build:

* at launch the settings window exists, is built hidden on purpose, and the page is
  live: `style 0x04CF0000`, `IsWindowVisible false`, `document.visibilityState
  "visible"`, URL `settings.html`;
* after `open_settings_window`: `style 0x14CF0000` — **`WS_VISIBLE` set,
  `IsWindowVisible true`** — and it *stays* true (re-checked at 0 s / 0.3 s / 1 s / 3 s);
* closing it (a real `WM_CLOSE`, the user's X) hides it and re-opening shows it again;
* a screen capture shows the window rendered with real content.

So "IsWindowVisible stays false although the page is live" was **not reproducible here**.
What *is* reproducible is a defect that makes the same complaint reasonable: the island
is always-on-top and horizontally centred exactly where the settings window opens, so an
open island covers the settings window's title bar and its first rows of content.
Measured before the fix: island window `443,0 1034x459`, settings window `643,148
634x792` → a 634 x 153 px region of the settings window sat behind the island's opaque
shape.

Fix: `show_settings_window` emits `settings-opening` to the island, and the island
retracts (`fsm.forceHidden`) before the window is shown — from the tray or from the
island's own button, one path. `show_settings_window` also no longer trusts Tauri's
`show()` alone: if `WS_VISIBLE` is still clear it sets the style and calls
`ShowWindow`, because the page being alive says nothing about the window being on screen.

**Evidence — `docs/evidence/push3-c-settings-window.txt`** (real mouse and real
keyboard only):

* real click chain: park → wake at the strip → click (island expands `640x160`) → real
  click on the gear at page `629.5,25` → `settings view ... .view.on = true` → real
  click on `Settings…` at page `628.0,125.3`;
* after it: `kai.log` → `settings window shown`; the settings window reads `style
  0x14CF0000`, `visible true`; the island has retracted to `184px` and its window back
  to the strip `787,0 345x9` — it is no longer in the way;
* **interactivity on screen:** a real OS click at screen `801,557` (the page's
  `Reinstall hooks…` button, coordinates computed from the page rect + `ClientToScreen`
  + the real `devicePixelRatio` 1.4354) changed the page: `This is exactly what will
  change in your settings.json... Backup → ...settings.json.bak-20261002-105500 | Back
  up and write | Cancel`. The click was received and acted on by the window.
* the preview was then cancelled and `~/.claude/settings.json` is untouched (mtime
  2026-10-01 18:28, no new backup file) — nothing was written.

`docs/evidence/push3-c-settings-visible.png` is the capture: the settings window is
fully visible with its title bar unobstructed and no island panel over it. (The capture
shows the top of the page; the new "KAI control layer" section is below the fold in it
and is read from the page's own DOM in item D instead.)

---

## D. Where the Hermes api-server key is stored — **FIXED**

* The settings window gained a **KAI control layer** section: a `hermes-api-key` field
  in the same Windows Credential Manager store the other keys use, with Save/Remove.
  It only ever learns *whether* a key is stored — `secrets.rs` exposes
  `secret_present` / `secret_set` / `secret_clear` and there is no command that can read
  a value back, so the page cannot echo one.
* The island's Hermes card and the in-island settings badge now distinguish the three
  real states — **no key stored**, **key stored but not accepted**, **accepted** —
  instead of collapsing them into "key not stored", and the card offers
  "Store the key in Settings…" when there is none.
* The app also passes the stored key to the Core it starts (`KAI_HERMES_KEY`), so a Core
  the app started can use Hermes' authenticated routes; the log records only
  `"apiKeyPresent":true`.

**Evidence — `docs/evidence/push3-d-hermes-key.txt`:**

* `KNOWN_KEYS` in `secrets.rs` includes `hermes-api-key` (with its comment), and
  `grep -n 'fn secret_' lib.rs` shows only `secret_present` / `secret_set` /
  `secret_clear`;
* the settings page renders the section as
  `{"heading":"KAI control layer","text":"KAI control layer | api-server key saved in
  the Windows Credential Manager. | Hermes api-server key | Save key","inputType":
  "password","placeholder":"••••••••••••  (stored)","buttons":["Save key","Remove"]}`
  — the placeholder and the Remove button are driven by the live credential state;
* `invoke('secret_present', {key:'hermes-api-key'})` → `true`; an unknown key → `false`;
* the island card now reads `Hermes | Agent | Control layer connected | ... | status ok
  | api unknown | 3 sessions | Refresh | Settings…` — the key is stored *and* accepted,
  and the card says so.

No credential was written by this pass: the stored key is the user's and overwriting it
to prove a text field works would have broken a working setup. The write path is the
same `secret_set` the other keys already use and is exercised through the settings page.

---

## E. The chain after the changes — **run, with the real numbers**

`docs/evidence/push3-e-chain.txt` (full core output in `push3-core-npm-test.txt`):

| Step | Result |
|---|---|
| `app`: `npx tsc --noEmit` | exit 0, no diagnostics |
| `core`: `npm run typecheck` | exit 0, no diagnostics |
| `app`: `npm test` | **57 / 57 pass**, 0 fail, 0 skipped |
| `core`: `npm test` | 229 tests — **227 pass, 2 fail, 0 skipped** (see below) |
| `app`: `npm run tauri build` | `kai.exe` + `KAI_0.1.1_x64-setup.exe` (1.96 MiB) + `core/server.js` staged |
| relaunch | pid, title `KAI`, `Responding True`, relay pipe `\\.\pipe\kai-<sid>` present, Core on 8788 with **ParentProcessId = kai.exe**, `kai.log` control-layer lines |
| island functional | real mouse wake + expand, real click on the Ask tab, **real keystrokes**, real agent reply |

The two core failures are *not* from this work: I started
`opencode serve --port 4096` myself for this pass (as the directive allows), its
`GET /session` is empty, and two live tests assert a non-empty session list to assert
on — `opencode: listSessions() returns an array whose entries carry an id` and
`kai core: GET /agents/opencode/sessions proxies the live session list`. With OpenCode
not running the same suite is **216 pass / 0 fail / 13 skipped** (all 13 skipped for the
same stated reason: `OpenCode is not running at http://127.0.0.1:4096`). Both are real
measurements; the honest reading is that the OpenCode failures are a precondition
problem in the suite (data has to exist), not a regression.

**Island functional — `docs/evidence/push3-e-island-functional.txt`:**

* real mouse: park, wake at the strip, click → island `640x210`;
* real click on the Ask tab → `chat input present; its view is .on: true`, and the
  **OS foreground window is `KAI`** — the island really holds the keyboard;
* real keystrokes (`SendInput`, 38 events): the chat log shows
  `YOU: what is happening?`;
* the reply is a real agent turn from the Hermes gateway (the island's first path,
  `claude.rs → hermes_chat`), not a stub — it reports this machine's own state and names
  `kai.exe (KAI app, started 10:33)` and the `opencode serve` I started.

---

## Handoff — what is deliberately *not* done here

* **The installer is unsigned.** It builds and runs; it needs a certificate to be
  distributed without a SmartScreen warning. Unchanged from Phase 2.5.
* **Hermes dashboard on 9119 is not listening** — Hermes-side, untouched.
* **OpenCode `POST /permission/{id}/reply` is still unexercised.** The route is in the
  server's published OpenAPI document, but `GET /permission` has been empty every time
  this machine has been observed, so there is still no live request to answer. Not
  staged, not faked.
* **Two OpenCode live tests fail on an empty session store** (above). A live test that
  requires data to exist is fragile; I did not "fix" it by weakening the assertion, and
  I did not seed a session to make it green.
* **`opencode serve --port 4096` is running because I started it** for this pass. Stop
  it if you do not want it up.
* **Something is hitting the Hermes api-server with an invalid key.** The agent turn
  above reported rejections on `/v1/models` and `/api/sessions` from a `node` user-agent
  ("Same stale-key issue we hit before with KAI Core"). KAI's own poller is *accepting*
  (`control layer: Hermes key accepted — 1 model(s), 3 session(s)`), and this pass's
  own `core npm test` runs hit those routes deliberately, so I am not claiming a culprit
  in either direction — it is worth a look from the Hermes side.
* **Fixed in the final build, and verified:** the adoption line was written on every
  watch tick (every 4 s) for as long as an adopted Core ran. It is now written once per
  adoption — the second adoption run in `docs/evidence/push3-a2-adoption.txt` shows the
  single new line next to the earlier run's repeated ones.
