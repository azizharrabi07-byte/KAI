# KAI — UI RESET PLAN

The owner's correction: *"The current implementation is treating the island as though it is the main
KAI application and squeezing everything into tiny panels. That is wrong."* They are right.

---

## THE ROOT CAUSE — MEASURED, NOT GUESSED

`app/src-tauri/tauri.conf.json` declares **exactly one window**:

```json
{ "label": "island", "title": "KAI", "url": "index.html",
  "width": 240, "height": 6, "visible": true, "alwaysOnTop": true,
  "decorations": false, "resizable": false, "transparent": true }
```

And `app/src/main.ts` mounts the entire application into that one window:

```ts
const island = new Island(root);                      // line 25
const visual = mountVisual(root, island, coreLink.client);   // line 143
const workspace = startWorkspace({ client: coreLink.client }); // line 151
mountWorkspace(root, { workspace, visual });          // line 152  -> el.id = "kai-workspace"
```

So the "main KAI workspace" is a **panel inside a 240×6 undecorated always-on-top strip**. That is
not a styling problem to nudge — it is the architecture. No amount of CSS makes a real application
out of a 240-pixel always-on-top window, and that is why every feature reads as a squeezed panel.

## THE FIX

**Two windows, two jobs.** The island stays small; a real main window is where KAI lives.

1. **Declare a second window** in `tauri.conf.json` — the main application window: large
   (e.g. 1280×820, min 900×600), **`decorations: true`**, **`resizable: true`**,
   **`alwaysOnTop: false`**, not transparent, its own URL (`index.html#workspace` or a second entry),
   hidden at launch. Follow the existing pattern for how the Rust side creates/shows windows
   (`app/src-tauri/src/island.rs` already does `get_webview_window(label)` / `set_size`), and note
   `settings` already shares the `tauri.localhost` host — **match the label AND path exactly**.
2. **"Open KAI" opens/focuses that main window** — not another panel, not the island.
3. **The island becomes a companion only** (owner §2, §24): status, progress, approval, and
   open/focus actions. It must contain no tool management, no session list, no agent management, no
   MCP management, no large settings, no large chat.
4. **Closing the island must not kill Core** (owner §26) — this is already proven and must stay true.

## ISLAND CONTROLS — THE TWO BUTTONS (owner §3, §25, §26)

Today `Open KAI` and `Open` both exist, and `-` and `X` both effectively make the island disappear.
That is the complaint, and it is correct:

- **exactly one primary action**: `Open KAI` → the main workspace. If a second button remains it
  must do a *different* thing (open the current mission / session / agent), or be removed.
- **`X` → closes the island window.** **`-` → collapses to the defined compact state.** Visually and
  functionally distinct, driven by one coherent window state machine, reusing the already-proven
  hide FSM (`hidden/petit/home/greet`; the OS window goes 1034×459 ↔ 345×9) rather than inventing a
  second one.
- **Clicking the body** → focus/interaction. **Reopening** → reconnects to the existing Core.

---

## PRIORITY ORDER (owner §38) AND STREAM OWNERSHIP

No two streams edit the same files. A stream needing a shared file exports a mount/registration
function and hands the integrator the exact line — the integrator applies it. **This is not
optional cleanup: three times now work has been built, proven, and mounted nowhere.**

| # | Stream | Owns | Delivers |
|---|---|---|---|
| 1 | **A — window + shell/layout** | `app/src-tauri/tauri.conf.json`, `app/src-tauri/src/**` (window only), `app/src/shell/**` (new), `app/src/style.css` | the main window; sidebar navigation (Home, Chat, Sessions, Missions, Agents, Workers, Tools, MCP, Activity, Memory, Skills, Settings); routing; `Open KAI` wiring |
| 2 | **B — chat + sessions** | `app/src/views/chat.ts`, new `app/src/views/sessions.ts` | a real chat surface (message list, history, input, streaming, tool/worker activity, visuals, approvals, errors); sessions list with **meaningful derived titles**, rename/search/sort/archive/restore/delete/create/open/switch |
| 3 | **C — agents** | new `app/src/views/agents.ts`, `app/src/agentui/**` | agent list, agent page (identity/soul/personality/worker/capabilities/memory/appearance/sessions), creation flow, **agent chat on the real subagent session**, work assignment, per-agent settings |
| 4 | **D — tools + MCP + activity** | new `app/src/views/tools.ts`, `app/src/views/mcp.ts`, `app/src/views/activity.ts` | real tool pages at real dimensions (list, detail, schema, risk, recent executions), MCP page with true status (**Discord CONNECTED, Canva BLOCKED — never faked**), activity feed from real events |
| 5 | **E — island** | `app/src/island/**`, `app/src/character/**` | the island shrunk to a companion; the control state machine; single primary action |
| 6 | **F — branding** | audit-only, reports | every user-visible `OpenGhost` / `Ghost` / `Hermes Agent` / `Nous Research` / `default profile` occurrence, with file:line |

**Already clean (verified, do not redo):** `index.html` title `KAI`, `productName: "KAI"`, window
title `KAI`, `package.json` `kai-app`, identifier `com.aziz.kai`.

## NON-NEGOTIABLE ACCEPTANCE (owner §34)

A UI feature is **not** complete from a unit test. The chain is:
```
implemented → mounted → LAUNCHED → clicked → real Core request → real state change → real UI update
```
Only then: END-TO-END PROVEN. And **actually launch it and inspect screenshots with vision**
(owner §31) — text readable, buttons clickable, input usable, panels correctly sized, no overlap, no
clipping, no hidden content, correct branding, correct character, correct state. Fix what you find.

## WHAT MUST NOT HAPPEN

- Do **not** move the tab 10 pixels and call it fixed (owner §3).
- Do **not** compress a primary feature (sessions, agents, tools, MCP, missions, settings) into a
  one-centimetre strip so everything technically fits (owner §27).
- Do **not** create a frontend-only fake agent object — agents are created through the real
  Core/subagent system (owner §12), with a real soul the runtime loads (owner §13).
- Do **not** fake Canva as connected (owner §21).
- Do **not** write *"UI limitation noted"* — fix it (owner §37).
- Do **not** let a worker's or source project's branding leak into the product (owner §32).

## BASELINE

core tsc `0`; core suite **865 / 852 pass / 0 fail / 13 skipped**; app tsc `0`; app suite **210/210**.
Running artifact: buildId `d6b2cecea2f809d7`, Core on `127.0.0.1:8788`, `kai.exe` PID 10496.
Build with `cd app && npx tauri build`; kill the `kai.exe` **parent** via
`node -e "try{process.kill(PID)}catch(e){}"` — **never `taskkill //F //PID`** (silent failure from
MSYS bash). Launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'`.
Run commands in the **foreground** (a background runner injects `stdin is not a tty` and eats stdout).

## ALSO OPEN, NOT THIS MISSION

`docs/KAI_SECURITY_FINDINGS.md` — the adversarial findings (H1-H6, M1-M4) are recorded and
**unfixed**. The control-plane gate must land **with** the app-side token header or it 401s the
whole UI. Do not lose that file.
