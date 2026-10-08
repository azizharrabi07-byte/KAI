# KAI — STREAM INTEGRATION REPORT

**When:** 2026-10-05, 16:15 (+01:00) · **Repo:** `C:/Users/DELL/Desktop/kai` ·
**HEAD:** `fa8ce40` (unmoved; all work below is in the working tree) ·
**Running artifact:** `app/target/release/kai.exe` built 16:06, `npx tauri build --no-bundle`, BUILD_EXIT 0 ·
**Core:** build `41b87e8807fd5348`, commit `fa8ce40`, `freshness: fresh`.

---

## 0. FIRST, THE INSTRUCTION THAT COULD NOT BE FOLLOWED AS GIVEN

Aziz asked for **one subagent per stream, 8–11 running concurrently**. That was the right
instruction and the file ownership in both plans does permit it. **It could not be executed:
`delegate_task` is hard-blocked in this run.**

```
Delegation budget for this one-shot run is exhausted (0/2 subagents used;
delegation.oneshot_max_children). Do the remaining work yourself in this session.
```

**Concurrent streams that ran: 0 launched by me.** I did not substitute a fake fan-out, and I
did not report a parallelism I did not have.

**However — parallel stream work was happening anyway, in this same working tree.** A second
writer/agent was active throughout:

- it added `apply_size(app);` to `app/src-tauri/src/main_window.rs::attach()` while I was editing
  the same file (my build failed on `cannot find function apply_size`);
- it rewrote `app/src/settings/main.ts` (−236 lines) and `core/tests/subagent.test.ts` (+115);
- it refactored `presence.ts`'s list priming (`prime()` / idempotent `buildLists`) inside the same
  file I was patching;
- it wrote **all 11 named evidence JSONs** between 15:50 and 15:57;
- app suite grew 210 → 262 tests.

**This is exactly the collision the zero-collision rule exists to prevent, and it was not
zero.** My changes and its changes are merged and consistent (both tsc-green, both suites green),
but two writers edited `main_window.rs` and `presence.ts` concurrently. One-writer-per-file was
violated by the environment, not by the plan.

---

## 1. PRIORITY 1 — THE MAIN WINDOW (the 345x9 acceptance test) — **END-TO-END PROVEN**

**345x9 is the island's collapsed companion strip**, not the application window. That is now
measured, not argued: `docs/evidence/kai-window-acceptance.json`.

| | main window CSS viewport | OS window | island |
|---|---|---|---|
| before | **985 x 631** | 1429 x 946 | 345 x 9 |
| after | **1290 x 705** | 1866 x 1051 | 345 x 9 |

**Root cause (a two-link chain, both links real):**

1. Windows display **110 %** + accessibility **text scale 130 %** ⇒ the webview's
   `devicePixelRatio` is **1.4354** while the window's own scale factor is **1.1046**
   (`island.rs` already documents this exact measurement). Tauri therefore sized the declared
   1280×820 *logical* window to a 1414×906 physical client ⇒ a **985 CSS-px viewport**.
2. `app/src/shell/presence/presence.css` had
   `@media(max-width:1000px){ … .rail{display:none} … }` ⇒ at 985 px **the application's only
   navigation was deleted.** The window looked like one squeezed panel because it no longer had
   any navigation to reach another one.

**Fixes applied**

- `app/src-tauri/src/main_window.rs` — `apply_size()` sizes the window in **webview CSS pixels**
  (`win.scale_factor() × island::win_text_scale()`), clamps to the monitor **work area minus the
  measured frame and a 24 px margin**, and centres it. Called from `attach()` and again on the
  first `show()` (a never-shown window has no final DPI). Same correction the island already
  makes for itself.
- `app/src/shell/presence/presence.css` — the ≤1000 px rule now keeps the rail as a compact icon
  rail instead of hiding it. Rail tiles 46×46 → 40×40 and gap 6 → 4 px: 13 route buttons + orb +
  label at 46 px need ~816 px of rail but only 670 px exist, so the rail genuinely overflowed and
  its last item was clipped. `overflow-x:hidden` added — `overflow-y:auto` forces `overflow-x:auto`
  in CSS, which had produced twin scrollbars that ate the rail's width.

**Verified live** (`kai-window-acceptance.mjs`, `kai-nav-proof.mjs`): the island's real
`Open KAI` path (`island/header.ts:124 → core-bridge.ts:152 invokeTauri("open_main_window") →
lib.rs:488 → main_window::show()`) opens the window at a real size; the rail reports
`display:flex`, 72×670; all **13 entries click by accessible name** and each mounts its own view.
**Vision on the final build:** *"All rail icons are fully visible and fully inside the rail;
nothing is cut off… No scrollbars appear on the rail — neither vertical nor horizontal."*

**Caveat, stated plainly:** the harness invoked the *same Tauri command* the button invokes, in the
island's own webview — not a literal mouse click on the button. Everything else in the chain is
the product's own code.

**Installer only: `npx tauri build` (full, with NSIS) exits 1.** makensis references
`core/bundle/agent/identity-model.d.ts` while `beforeBuildCommand` regenerates that directory — a
race between Tauri's resource glob and the Core bundle build. The **application binary builds
green** (`--no-bundle`, exit 0). This is the one **BLOCKED_EXTERNAL** item in the window stream.

---

## 2. PER-STREAM STATUS (mandatory vocabulary)

| Stream | Status | Evidence |
|---|---|---|
| **W — main window** | **END-TO-END PROVEN** (except literal pointer click; installer BLOCKED_EXTERNAL) | `kai-window-final.json`, `kai-window-acceptance.json`, `nav-home-final.png` |
| **S — shell / navigation** | **END-TO-END PROVEN** — 13 entries visible + clickable, each mounting its view, Home/status read real Core | `kai-workspace-final.json` (nav proof mine, geometry theirs), `kai-nav-proof.json` |
| **Skills page** | **END-TO-END PROVEN** — was denied, now reads real `GET /skills` | `nav-skills.png` shows `nightly-verification-routine`, `ph4-nightly-deploy` |
| **B/C — chat + sessions** | **PARTIAL / NOT PROVEN** — chat + session list work; **session titles are not meaningfully derived** (`Conversation 35` ×40 sessions) | live `GET /sessions` |
| **C — agents** | **UNIT/INTEGRATION PROVEN** — 4 KAI subagents with real souls/roles/workers on a live route | `kai-subagents-final.json` |
| **D — tools** | **INTEGRATION PROVEN** — `GET /tools` 200, 56 tools, 41 park for approval; UI renders them | live capture |
| **D — MCP** | **NOT PROVEN (regressed)** — live Core: **0 servers, UNAVAILABLE**, `persistence.path: null`, management tools registered but nothing registered. The migration doc's "Discord connected" does **not** hold on this instance. Never faked in the UI — the UI says unavailable because it *is*. | `kai-mcp-final.json`, `docs/evidence/live/mcp.json` |
| **E — sessions (core)** | **PARTIAL** — 40 sessions persist; derived titles NOT PROVEN | live capture |
| **F — subagents** | **PARTIAL** — subagent objects real; the island's own chat proves KAI identity holds (`historyLast: "No — Hermes is a worker I can use, not what I am. I am KAI."`) while the **main window's chat leaks the raw worker answer** (see §3) | `kai-island-final.json`, `kai-workspace-final.json` |
| **G — PC control** | **NOT PROVEN** — on the app-launched Core only `system` reads AVAILABLE; `browser`, `computer`, `filesystem`, `git`, `shell` all read **UNAVAILABLE** with their requirement strings. Earlier phase-4/5 runs proved the real transports when the Core ran from the repo environment; on this instance they do not resolve. | `docs/evidence/live/capabilities.json` |
| **I — island** | **INTEGRATION PROVEN** — companion only; header has exactly one primary action `Open KAI` + grip / `–` / `✕`; 720×320 panel ↔ 345×9 hidden strip; closing it does not touch Core | `kai-island-final.json`, `header.ts` |
| **J — security** | **NOT PROVEN** — findings H1–H6/M1–M4 recorded and unfixed; control-plane gate still not landed | `kai-security-final.json` |
| **K — independence** | **PARTIAL / NOT PROVEN as a whole** — see §4 | `kai-independence-final.json` (theirs, 31 KB) |
| **Evidence JSONs** | **11/11 now exist** (written by the other writer 15:50–15:57) + my `kai-window-final.json`. They are **untracked**. | `docs/evidence/` |

---

## 3. THE TOP REMAINING PRODUCT DEFECT — WORKER IDENTITY LEAK IN THE MAIN CHAT

Reproduced, verbatim, from the main window's chat on the running artifact
(captured by the other writer, `kai-workspace-final.json`):

> *"who is speaking? / **Hermes Agent (Nous Research), running on your Windows machine — not the
> "KAI" the injected identity block keeps claiming.** What do you need?"*
> *"who am i talking to? Introduce yourself. / **Hermes Agent, Nous Research.** Same answer as
> before — the "KAI" line in the injected block isn't m…"*

Meanwhile the **island's** own chat history ends with KAI answering correctly:
*"No — Hermes is a worker I can use, not what I am. I am KAI."*

So KAI's own composition holds, and the **main window's chat surface is passing the worker's raw
answer straight through** — this is the mission's single most important invariant
(*"no worker identity leakage"*) failing in the primary surface. It is `NOT PROVEN` and it is the
first thing to fix next: the reply must be KAI-authored (the fa8ce40 KAI-owned model provider is
the intended path), or the worker's output must be clearly attributed as a worker's.

Second real defect from the same capture: the island reports
**`"note": "Approved action failed: mcp.register"`** — an approval was granted and the action then
failed. The approval→execution→result chain needs its own fix and proof.

Third: `GET /capabilities` on the running instance reads only `system` AVAILABLE (§2, stream G).

---

## 4. INDEPENDENCE — HONEST CLASSIFICATION

Hermes **is up** on this machine (`http://127.0.0.1:8642/health` → 200, port LISTENING), so a
genuine "Hermes down" run was **not** performed — and I deliberately did not stop the worker: this
machine is running the session that is doing the work. **That claim stays NOT PROVEN until someone
actually stops Hermes and re-runs the twelve-step answers.**

Structural evidence captured instead:

- `grep -rn 8642 core/src --include=*.ts` outside the worker adapter resolves to **four** places
  only: `config.ts` (a configurable default), `shared/contracts.ts` (a comment),
  `workforce/discovery.ts` (`HERMES_DEFAULT_BASE_URL`, the worker *discovery* default) and
  `server.test.ts` (a live probe in a test). No KAI subsystem — tools, sessions, memory, mcp,
  agent identity — hard-codes the Hermes port.
- `GET /identity/model` returns KAI's own authorities bound to KAI's own subsystems:
  `memory → MemoryEngine{write,search,get,digest,journal}`, `workforce → WorkforceManager{…}`,
  `agentId: kai`, `displayName: KAI`, `soulChars 2779`, `identityChars 1240`, `userContextChars 322`,
  `capabilities [system, filesystem, git, shell, browser, computer, mcp]`, `limits 4`.
- Working **now**, with OpenCode offline (`INTERNAL: transport failure talking to
  http://127.0.0.1:4096`): `/identity`, `/tools` (56), `/skills`, `/sessions` (40), `/missions`,
  `/approvals`, `/capabilities`, `/mcp` and the whole UI.

**Verdict: INTEGRATION PROVEN structurally; END-TO-END (`stop Hermes, KAI is still KAI`) NOT
PROVEN.**

---

## 5. BASELINE AFTER MY CHANGES (both green)

```
core  npx tsc -p tsconfig.json --noEmit    exit 0
core  node scripts/test.mjs                871 tests / 858 pass / 0 fail / 13 skipped
app   npx tsc --noEmit                     exit 0
app   npm test                             262 tests / 262 pass / 0 fail / 0 skipped
```

The 13 skipped core tests remain the live-agent suites that skip by design without their context —
**not green, and not reported as green.**

---

## 6. WHAT THE NEXT SESSION MUST DO (in order)

1. **Kill the leak** in §3 — KAI must answer as KAI in the main window.
2. **Fix the NSIS resource race** so `npx tauri build` exits 0 end to end.
3. **Re-prove MCP live** (0 servers today) — the migration doc describes a state this instance
   does not have.
4. **PC-control availability** on the app-launched Core (only `system` AVAILABLE).
5. **The real Hermes-down run** for §4, then flip the verdict.
6. **Enforce one writer per file.** The most expensive problem in this run was not a bug; it was
   two agents editing the same two files on one binary.
7. Session titles (`Conversation 35`) and the security findings H1–H6 / M1–M4.
