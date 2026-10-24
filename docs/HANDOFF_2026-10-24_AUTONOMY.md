# KAI — Handoff & State of the Project

**Date:** 2026-10-24
**Branch:** `feat/goal-executive` (HEAD `548622c`, 69 modified + 24 untracked files uncommitted)
**Last live Core build:** `75136495bb1b92c4`
**Audience:** the next engineer/agent picking this up, and the owner.

This document is the single source of truth for *what exists, what works, what does not, and why*.
It is deliberately blunt. Every "PASS" below was observed on a running process or a test that
drives real code; anything else is marked otherwise.

---

## 1. What KAI is meant to be (the vision)

KAI is a **persistent personal AI control layer for Windows**. Not a chat wrapper, not a router in
front of someone else's agent. The intended shape:

```
            ┌───────────────────────────────────────────────┐
            │  KAI (owner of identity, state, policy)       │
            │                                               │
  owner ───►│  brain (own model provider)                   │
            │  tools / capabilities                         │
            │  missions + outcome gate                      │
            │  memory + skills                              │
            │  autonomy switches (DOER, Monster)            │
            └───────────────┬───────────────────────────────┘
                            │ delegates when policy allows
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
           Hermes       OpenCode        Codex
         (optional)    (optional)     (optional)
```

The non-negotiables the owner has stated, repeatedly and consistently:

1. **KAI answers from its own model.** It must not need Hermes or OpenCode online to hold a
   conversation.
2. **KAI is the supervisor.** Other agents are employees. KAI decides, delegates, verifies,
   and owns the outcome.
3. **A worker claim is not proof.** Completion is decided by evidence + acceptance criteria,
   never by a worker saying "done", never by a tool returning without throwing.
4. **Autonomy is not permission.** Monster Mode makes KAI *continue*, never *escalate*.
5. **The owner must be able to see what actually happened** — real tool calls, real commands,
   real sources, real failures. No simulated progress, ever.
6. **A delivered answer ≠ a generated answer.** Persisting text is not showing it.

---

## 2. The operating agreement (owner ↔ agent)

This is the working contract that emerged over many sessions. It is as important as the code.

### 2.1 Evidence discipline

- **PASS requires an observation.** A test that passes but never exercises the production path is
  not evidence. A build ID that changes is not evidence. A file that exists is not evidence.
- **Three verdicts only:** `PASS`, `FAIL`, `UNVERIFIED`. "Probably works" is banned. When
  something was not exercised, say `UNVERIFIED` and name the blocker.
- **Never fabricate.** No invented tool output, worker activity, search results, command logs, or
  test counts. If the provider is down, the answer is "the provider is down", not a plausible
  paragraph.
- **Errors are ground truth.** When the owner reports a symptom, it is real. Do not re-run a check
  to confirm it. Find the cause.

### 2.2 Preservation

- Never `git reset --hard`, `git clean -fd`, `git checkout -- .`, or `git restore .`.
- Never drop/rename/apply the unrelated `a1-wiring` stash.
- Never kill processes that are not provably KAI's.
- Never overwrite user data, sessions, memory, or credentials.
- Serve the user's real request; do not substitute an easier adjacent problem.

### 2.3 Honesty about scope

- Fix the demonstrated defect, not the imagined one.
- Do not weaken a test, a gate, or a security boundary to get green.
- When a phase is not done, say so plainly instead of shipping scaffolding labelled "MVP".

---

## 3. The repository and runtime map — READ THIS FIRST

This is the single biggest source of wasted time in the project. **There are three locations, and
only one of them is under version control.**

| # | Path | What it is | Under git? |
|---|---|---|---|
| 1 | `C:\tmp\kai-exec` | The KAI repo (`origin` = `github.com/azizharrabi07-byte/KAI`). Contains `core/` (TypeScript runtime), `app/` (Tauri shell), `docs/`, `scripts/`. | **YES** — branch `feat/goal-executive` |
| 2 | `C:\Users\DELL\source\kai2-desktop` | The **Electron desktop app the owner actually runs** (`dist\win-unpacked\KAI2.exe`), with `kai-bridge.js`, `chat.js`, `script.js`, `desktop/main.js`, `desktop/core-stream.js`. | **NO — not a git repository at all** |
| 3 | `C:\tmp\kai-exec\app\target\release\core` | The **Core that is actually executed** at runtime. A *copy* of `core/bundle`. | build output (ignored) |

### 3.1 Why this matters

- Editing `C:\tmp\kai-exec\core\src\...` changes **nothing** until you run `npm run bundle` **and**
  copy the result over `app\target\release\core`.
- Earlier sessions verified three separate times against a stale Core (`631435d43b7febc7`) that
  contained none of the work, and drew false conclusions from it.
- The desktop app is **untracked**. Every renderer fix made so far exists only on this machine.
  If that folder is lost, it is gone.

**Rule:** before claiming anything works, confirm
`curl http://127.0.0.1:8788/identity` matches the build you just produced, and confirm the renderer
asar contains the string you just added:

```bash
grep -ac "yourDistinctiveString" dist/win-unpacked/resources/app.asar
```

### 3.2 The current desktop app is not the Tauri app

`C:\tmp\kai-exec\app` is a Tauri project and is **not** what the owner launches. The live app is the
Electron one at location #2. Do not confuse them.

---

## 4. The real request path (as implemented, with the traps marked)

### 4.1 Chat turn

```
owner types
  → chat.js#loop
  → kai-bridge.js#Providers.stream          (provider "kai")
  → IPC  kai:stream:start
  → desktop/main.js                         (coreStream.handle)
  → desktop/core-stream.js                  POST /chat/stream  (SSE)
  → server.ts#/chat/stream
      → router.ts#answer()
          → answerInvocation()  ← explicit `@name` MUST win (see §7.1)
          → classify() → intent handlers
          → answerUnknown() → brain (KAI's own model)
      → brain.ts#runToolCalls   ← tools actually execute here
      → synthesis pass          ← final text
      → settleTurn()            ← persistence (session_turns)
  → SSE frames: {tool_event} | {delta} | {done, reply, ...}
  → core-stream.js → IPC kai:stream:frame → consumeFrame → onContent → chat.js → DOM
```

**Traps proven the hard way:**

- `done.reply` carries the authoritative text when the answer was **not** streamed. It was ignored
  for a long time; an empty UI on tool-heavy turns was the result.
- Core persists the turn **after** it closes the stream. Any reconciliation must retry.
- A trailing SSE frame without `\n\n` was dropped by the reader.
- `require("node:fs")` **silently fails inside the Core bundle**. Use static ESM imports for
  diagnostics, or they produce zero output and you will chase a phantom.

### 4.2 The browser / research path (two implementations, one is dead)

There are **two** browser implementations:

- `core/src/capabilities/browser/capability.ts` — full, well-tested, **`createBrowserCapability()`
  has ZERO production call sites. It is dead code.**
- `core/src/runtime.ts`, `if (capability.id === "browser")` — **this is the one that runs.**

Every edit to `capability.ts` between sessions achieved nothing. The URL normalisation that finally
worked was applied in `runtime.ts`.

### 4.3 Worker delegation

```
chat "@alice do X"
  → router.ts#answer → answerInvocation  (sees subagent registry, NOT raw workers)
  → runtime.ts#runAgentForChat
      → workforce.delegate({ capability:"run_task", role:"subagent:alice", input })
      → hermesAdapter#runTask → POST http://127.0.0.1:8642/v1/runs  (Bearer key) → poll
      → personaReply(spec, output)
```

`@hermes` is **not** an invocation target — `@` resolves *subagent personas*, not worker ids.
Personas on this machine: `alice` (researcher)→hermes, `bob` (engineer)→opencode (**offline**),
`probe`→hermes, `deleteme`→hermes, `kage` (generalist)→hermes.

### 4.4 Mission execution

```
POST /missions/auto   (owner-only)        ← Monster Mode entry point
  → createPlan(goal)                       ← model plans, validated against live registries
  → metadata.autonomous = true
  → invokeGate(mission.start)              ← policy boundary
  → missions/executor.ts#start()
      → DOER gate      (autonomous && doer !== ON → refuse, stay DRAFT)
      → runSteps()
          → per-step policy check
          → WAITING_APPROVAL handling
          → Monster budget check (steps / wall-clock)
          → runner (real tool or worker)
      → outcome verification
```

The executor is real and substantial (745 lines): per-step policy, approvals, cancellation,
recovery, evidence gate. It is **connected**, not decorative.

---

## 5. What has been done — chronological detail

### 5.1 Supervisor trust repair (earlier sessions)

- Work-item contracts gained acceptance criteria, constraints, forbidden outcomes, required
  evidence, budgets, working dirs, evidence records, skill receipts, next action.
- Additive SQLite migration.
- Strict Outcome Gate: permissive text matching removed; evidence must be KAI-observed and linked
  to exact criterion labels.
- Truthful dispatch: `delegated:false / planned:true` until a worker really starts.
- Corrective actions (`INSPECT`, `VERIFY`, `RUN_TESTS`, `RETRY`, `REPLAN`, `CHANGE_WORKER`, `ASK_USER`).
- Approval idempotency; retry budget moved into the orchestration boundary.
- Skill selection receipts; external report audit (`auditExternalReport`, `POST /work-items/audit`).
- Daily work-summary skeleton.

### 5.2 Delivery repair (the "empty answer" saga)

Symptoms reported by the owner: KAI prints a tool name and stops; research returns nothing usable;
OpenCode "offline" was answered by searching local folders.

Root causes found, in order:

1. **`done.reply` ignored** — Core emitted the turn's real text in the terminal frame; the renderer
   never read it. Proven with a captured frame:
   ```json
   {"done":true,"error":"brain_unavailable","reason":"…timeout",
    "reply":"My own model provider isn't answering that right now — …"}
   ```
2. **Empty turn returned as success** — `if (content.length === 0 && done === null)` threw only when
   the terminal frame was missing, so a turn ending `{done:true}` with no text returned `''`
   silently.
3. **Trailing SSE frame dropped** — `desktop/core-stream.js` never drained `buffer` after the
   reader finished.
4. **Unbounded tool results** — `chat/brain.ts` pushed `JSON.stringify(executed.value)` into the
   continuation with no cap. Ten page reads blew past the 120 s provider timeout.
   Measured: **144.18 s → timeout, 18 chars** became **19.76 s → stop, 152 chars** after capping
   at 12 000 chars.
5. **Recovery raced persistence** — `recoverAnswer` read once, immediately after the stream closed,
   before Core had written the turn. Observed: answer persisted (540 chars), element empty.

Fixes: terminal-frame rendering, honest empty-turn failure, buffer flush, tool-result cap,
bounded re-read (3×700 ms) for recovery, `kai:session:turns` IPC.

### 5.3 Research (the CAPTCHA discovery)

The owner's research requests produced canned apologies. The chain of evidence:

- Direct provider call with the same question → a correct, sourced answer. So **not the model**.
- KAI's exact 11 399-char composed prompt, no tools → correct answer. So **not the prompt**.
- Stored tool result → `https://www.google.com/sorry/index` with 392 characters of French
  anti-bot text. **Google was blocking the machine.**

Measured engine availability from this host:

| Engine | Result | Usable |
|---|---|---|
| `google.com/search` | `/sorry/index` CAPTCHA | no |
| `html.duckduckgo.com` | "Select all squares containing a duck" | no |
| `lite.duckduckgo.com` | challenge | no |
| `bing.com/search` | 200, 118 KB, 10 results — **all `bing.com/ck/a` click-trackers, unrelated content** | no |
| **GitHub API** `/search/repositories` | 200, 70 456 repos with licence + stars | **yes** |
| **HN Algolia** | 200, real stories with URLs | **yes** |
| **Wikipedia API** | 200, summaries | **yes** |

**An HTTP 200 is not a successful search.** Replaced SERP scraping with three documented no-key JSON
APIs, plus keyword extraction (the whole sentence as a query returned **zero** repositories) and
GitHub-first ordering. Coverage is stated honestly in the result payload.

Also fixed: `read` with a URL in `targetId` (the model does this constantly) now fetches the page
instead of failing `no browser target "https://…" is open`. `httpFetchPage` verified live:
8 000 chars from `github.com/plandex-ai/plandex` with correct title.

### 5.4 Worker dispatch

- Hermes is genuinely reachable (`:8642`, `/health` 200, needs `API_SERVER_KEY`).
- Key resolution: `agents/hermes-key.ts` (`KAI_HERMES_KEY` / `API_SERVER_KEY` / profile file).
  Resolves to a 32-char key on this machine.
- Real delegation verified: `{ok:true, employeeId:"kai:alice", instanceId:"kai:alice#1",
  result:{state:"completed", usage:{inputTokens:17874, outputTokens:121}}}`.
- **Defect fixed:** `@hermes <task>` was classified as `agent.status` because `classify()` ran
  before `answerInvocation()`. Any message naming an agent was swallowed by the status intent and
  the task was never dispatched. `answer()` now gives an explicit `@name` precedence.
- OpenCode: `INTERNAL: transport failure at 127.0.0.1:4096` — genuinely offline.
- Codex: `not on PATH` — genuinely not installed.

### 5.5 Activity inspector

`window.KAI2.activity()` returns real records and was observed showing:

```json
{"key":"95NEbC67e","toolId":"capability.browser","name":"capability_browser","phase":"tool_done",
 "status":"EXECUTED","arguments":"{\"action\":\"navigate\",\"input\":{\"url\":\"https://github.com/topics/ai-coding-agent\"}}",
 "startedAt":"…","completedAt":"…","resultPreview":"{…\"url\":\"https://github.com/topics/ai-coding-agent\",\"title\":\"ai-coding-agent · GitHub Topics\"…}"}
```

The inspector exists and is backed by real data. It does **not** yet surface mission/handoff/trigger
events.

### 5.6 Monster Mode (this session's main build)

Implemented from nothing, end to end.

**Core:**

| Piece | Location |
|---|---|
| Persisted pref + three budgets | `orchestration/prefs.ts` — `orchestration.monster`, `.monsterMinutes` (1–240), `.monsterSteps` (1–100), `.monsterParallel` (1–8); defaults OFF / 30 / 24 / 3 |
| Read API | `GET /monster` → state, doer, guard, effective limits |
| Write API | `POST /monster` (`requiresOwner`) — OFF applies at once, ON goes through the settings gate |
| Autonomous entry | `POST /missions/auto` (`requiresOwner`) — plan → mark `autonomous` → gate → start |
| DOER enforcement | `missions/executor.ts#start()` — autonomous mission + DOER ≠ ON → stay `DRAFT`, record `blockedBy:"DOER_OFF"`, emit `mission.blocked` |
| Budget enforcement | `missions/executor.ts#runSteps()` — reads steps/minutes once per run; on exhaustion parks as `WAITING` with `blockedBy:"MONSTER_BUDGET"`, remaining steps untouched |
| Live switches | `runtime.ts` passes `autonomy: () => readOrchestrationPrefs(stores.settings)` — read per start, never cached |

**Renderer:** `composer-monster` button, `kai:monster` / `kai:monster:set` IPC, `monsterBridge`,
styles. The label is painted from Core's answer, never optimistically.

**Proven in the packaged app:**

```
click  → button "Monster on", aria-pressed="true"
GET /monster → {"state":"ON","doer":"ON","guard":"ON","limits":{"minutes":30,"steps":24,"parallel":3}}
```

**Behavioural tests** (`core/tests/autonomy-switches.test.ts`, 5/5, driving the real executor):

```
✔ DOER OFF blocks an autonomous mission before any step runs
✔ DOER OFF does NOT freeze a mission the owner started
✔ Monster's step budget stops the run and keeps the rest
✔ a budget that is not exhausted lets the whole mission finish
✔ the switches are read per start, so flipping DOER takes effect on the next mission
```

The second case is load-bearing: DOER must govern *KAI acting alone*, not strand a plan the owner
hand-approved.

### 5.7 Two more real defects fixed this session

- **Stop never reached Core.** `desktop/core-stream.js` had no `signal` handling at all — a stopped
  turn kept spending the model while the UI said "stopped". Now the signal is forwarded to `fetch`,
  a pre-aborted turn issues no request, and an abort returns `state:'aborted'` (not an error).
- **A test hardcoded the settings-key count** (`assert.equal(ORCHESTRATION_KEYS.length, 15)`), so
  adding Monster silently stopped covering anything. It now derives from the array and asserts the
  cases name *exactly* the declared keys.

### 5.8 The named-pipe test

`probeNamedPipe` failures were **not** Hermes and **not** flakiness-by-luck: it is the **CUA driver**
pipe. The driver is installed and two processes run; `node --test` runs suites in parallel and the
other driver tests hold the single `\\.\pipe\cua-driver`. Measured: connects in 1.5 ms alone, times
out at 2 s under load. Bounded retry added, assertion (`reachable === true`) unchanged.

---

## 6. Current verified state

### 6.1 Tests / build

```
Core    1893 tests · 1858 pass · 0 fail · 35 skipped
KAI2      96 tests ·   96 pass · 0 fail
tsc       0 errors (core)
Core build 75136495bb1b92c4 deployed and confirmed via /identity
```

### 6.2 Capability matrix

| Capability | Verdict | Evidence |
|---|---|---|
| Own-model chat | **PASS** | answers without any worker; `normal_chat_calls_to_hermes: 0` |
| Research (structured) | **PASS** | GitHub/HN/Wikipedia; real projects + URLs rendered in the packaged UI |
| Source page fetch | **PASS** | 8 000 chars from GitHub, correct title |
| Answer rendering | **PASS** | rendered 741 chars in the packaged app |
| Answer persistence | **PASS** | 971-char assistant turn in `session_turns` |
| Activity inspector | **PASS (tools)** | real tool records with args/status/timing/result |
| Hermes dispatch | **PASS** | `instanceId:"kai:alice#1"`, `state:"completed"`, token usage |
| OpenCode / Codex | **PASS (honest offline)** | transport failure / not on PATH |
| DOER switch | **PASS** | 5 behavioural tests on the real executor |
| Monster Mode | **PASS** | UI toggle → Core state; budgets enforced in `runSteps` |
| Autonomous mission | **PASS (Core)** | `POST /missions/auto`, executor gates, resume-safe parking |
| **Worker→worker handoff** | **FAIL** | not built |
| **Trigger registry** | **FAIL** | not built |
| **Build provenance manifest** | **FAIL** | build stamp + path check only |
| **Inspector: mission/handoff events** | **FAIL** | not surfaced |
| **Desktop app under version control** | **FAIL** | not a git repo |

---

## 7. Traps, gotchas and hard-won knowledge

1. **`@name` must beat `classify()`.** The explicit invocation check lives at the top of
   `router.ts#answer()` for exactly this reason. Do not move it back inside `answerUnknown`.
2. **`capabilities/browser/capability.ts` is dead.** Edit `runtime.ts` for browser work.
3. **`require()` fails silently in the Core bundle.** Static ESM import or nothing.
4. **The build stamp does not change unless you bundle.** `build-info.json` is regenerated by
   `npm run bundle`; copying an old `bundle/` propagates a lie.
5. **Core writes the turn after closing the stream.** Any read-back needs a retry.
6. **The CUA driver pipe is single-tenant.** Parallel tests contend for it.
7. **`grep` on a `.asar` works** and is the fastest way to prove a renderer change shipped.
8. **The owner's stop must reach the model.** Check `signal` plumbing when a "stopped" turn
   keeps producing activity.
9. **Do not trust the handoff report over the working tree.** It has been wrong twice.

---

## 8. Where we are going — prioritized roadmap

### P0 — Version the desktop app (blocking everything else)

`C:\Users\DELL\source\kai2-desktop` is the app the owner runs and it is **not in git**. Every
renderer fix — `done.reply` rendering, SSE flush, recovery retry, Monster button, abort support —
exists only on one machine.

**Action:** `git init` there, add a `.gitignore` (`node_modules/`, `dist/`, `*.log`), commit, and
either push to a new repo or vendor it into `KAI` under `desktop-electron/`. Do this before any
further renderer work.

### P1 — Worker-to-worker handoff

The contract, concretely:

```ts
interface Handoff {
  id: string;              // h_…
  missionId: string;
  parentTaskId: string;
  childTaskId: string;
  fromWorker: string;      // "core" | "hermes" | …
  toWorker: string;
  attempt: number;
  goal: string;
  context: string[];       // artifact refs, not full transcripts
  constraints: string[];
  acceptance: string[];
  expectedFormat: string;
  status: "QUEUED"|"RUNNING"|"COMPLETED"|"FAILED"|"TIMEOUT"|"CANCELLED";
  output?: string;
  artifacts: { path: string; sha256: string; producer: string }[];
  error?: KaiError;
  startedAt: string; completedAt?: string;
  verifiedBy?: { at: string; accepted: boolean; reason: string };
}
```

Route creation through the same `POST /missions/auto` path so DOER/Monster/budgets apply uniformly.
Persist each handoff; correlate by `missionId` + `childTaskId`; make result delivery idempotent.

Live demo available today: `alice` (hermes) produces a report → persist as artifact → `kage`
(hermes) reviews it against explicit criteria → parent verifies. Two distinct personas, one real
worker. That is a legitimate live chain, and it must be labelled as such (not "multi-worker").

### P2 — Trigger registry

Table + route + executor hook:

- `triggers(id, type, enabled, action_json, policy_scope, budgets_json, created_at)`
- `trigger_runs(id, trigger_id, event_key, mission_id, state, created_at)` with `UNIQUE(event_key)`
  for idempotency.
- Entry points that genuinely exist here: `schedule` (the scheduler already runs), and an
  authenticated local `POST /triggers/:id/fire`. Anything else needs a real upstream event API —
  do not invent webhooks Hermes does not emit.
- Every fire must pass the same DOER/Monster/policy gates.

### P3 — Build provenance

Separate manifest, **not** inside the hashed artifact:

```json
{
  "builtAt": "…", "buildId": "…", "gitCommit": "…",
  "sourceFingerprint": "sha256 of tracked sources + sorted dirty-file hashes",
  "bundleSha256": "…", "releaseSha256": "…", "rendererAsarSha256": "…",
  "corePathStarted": "C:\\tmp\\kai-exec\\app\\target\\release\\core\\server.js"
}
```

Verification script: build → hash → copy → hash → compare → launch → `GET /identity` → compare.
Fail loudly on mismatch. This is what would have saved three sessions.

### P4 — Inspector: missions and handoffs

Extend the existing activity path (do **not** add a second store) to surface mission state, step
status, worker dispatch, handoff artifacts, retries, verification verdicts, and trigger source.

### P5 — Research depth

The honest gap: search returns *listings*, not page content. The next step is an
evidence structure mapping claim → source URL → retrieved excerpt, so a citation cannot be copied
from a search result without the page having been read.

---

## 9. How to build, run, verify

```bash
# ── Core ──────────────────────────────────────────────────────────────
cd /c/tmp/kai-exec/core
npx tsc --noEmit -p .          # must print nothing
npm test                       # ~400s; expect 0 fail
npm run bundle                 # regenerates core/bundle + build-info.json
cp -r bundle/* /c/tmp/kai-exec/app/target/release/core/    # ← REQUIRED

# ── Desktop (untracked) ───────────────────────────────────────────────
cd /c/Users/DELL/source/kai2-desktop
npm test                       # expect 0 fail
npm run dist:portable          # ~210s → dist/win-unpacked/

# ── Launch ────────────────────────────────────────────────────────────
powershell -NoProfile -Command "\$env:KAI_WORKSPACE_ROOT='C:\tmp\kai-exec\core';
  Start-Process -FilePath 'C:\Users\DELL\source\kai2-desktop\dist\win-unpacked\KAI2.exe' \
    -ArgumentList '--remote-debugging-port=9222' \
    -WorkingDirectory 'C:\Users\DELL\source\kai2-desktop\dist\win-unpacked'"

# ── Verify identity BEFORE trusting any result ────────────────────────
curl -s http://127.0.0.1:8788/identity     # buildId must equal bundle/build-info.json
grep -ac "yourNewString" dist/win-unpacked/resources/app.asar
```

Owner-only surfaces (`POST /doer`, `POST /monster`, `POST /missions/auto`,
`POST /agents/:id/action`) reject plain HTTP with `OWNER_AUTH_REQUIRED`. Drive them from the app
(CDP on `:9222`), not curl.

---

## 10. Critical assessment — my honest opinion

I was asked for a critical read, so here it is.

### What is genuinely good

- **The core runtime is real.** The mission executor, policy gate, approvals, outcome verification,
  event bus and persistence are not scaffolding. They enforce things. That is rarer than it sounds.
- **The security posture is sound.** Owner-only routes, per-step policy, approval parking, no
  permission escalation under autonomy. Monster Mode explicitly does *not* widen authority, and the
  tests prove it.
- **The evidence trail is strong.** Every defect in §5 has a measurement behind it, not a guess.

### What is genuinely at risk

1. **The desktop app is unversioned.** This is the single largest risk in the project. Months of
   renderer work — the entire delivery pipeline — exists in one folder on one machine. One bad
   `rm`, one disk failure, and it is gone. **Fix this before anything else.**

2. **Three copies of "the truth" (source / bundle / release) with no provenance.** We burned three
   sessions verifying a build that contained none of the work. A build-ID check is not identity.
   Until P3 exists, every future claim about "it works" is suspect.

3. **Dead code that looks alive.** `capabilities/browser/capability.ts` is a fully-tested module with
   no production caller. A new engineer will read it, patch it, and watch nothing change — exactly
   what happened. Either wire it in or delete it. Do not leave both.

4. **Feature breadth is outrunning verification depth.** The repo now has 93 changed files and
   subsystems for learning, evaluation, worker tokens, policy state, mission verification,
   integrations. Several are untracked and several are unproven in the packaged app. Breadth without
   an end-to-end proof is how the "prints a tool name and stops" class of bug survives a green suite.

5. **Autonomy is proven at the executor, not yet at the product.** `POST /missions/auto` works and
   the gates hold, but I have not watched a *real multi-step mission* run end to end in the packaged
   app with a verifiable final artifact. Until that happens, "Monster Mode works" is true of the
   mechanism and unproven of the experience.

6. **The model is a weak link.** Codestral produced a canned apology for a benign research question
   when handed a CAPTCHA page, and returned an empty completion on another run. The harness is now
   resilient to both, but a single small model is a thin foundation for a "persistent control layer".
   Provider fallback and completion sanity-checking deserve attention.

7. **Scope discipline.** Each mission has asked for five phases; each session has delivered one or
   two properly. That is the right trade — but the backlog of "asked for, not built" (handoff,
   triggers, provenance, inspector) has not shrunk in three rounds. It needs a dedicated, narrow
   session each, not another omnibus brief.

### What I would do next, in order

1. **Version the desktop app.** Today. Non-negotiable.
2. **Build provenance (P3).** It is ~150 lines of script and it protects every future claim.
3. **One real autonomous mission, end to end, in the packaged app.** Research → source reads →
   artifact → verification → final report, with the trace visible. Record it. This is the product
   proof and it is closer than it looks.
4. **Handoff (P1)**, using the alice→kage chain as the live demonstration.
5. **Delete or wire `capability.ts`.** Reduce the surface that lies.
6. Only then triggers and the inspector extension.

### The one-sentence summary

> KAI's engine is real and its evidence discipline is now good; what is missing is version control
> of its face, provenance of its build, and one demonstrated autonomous mission — and those three
> are worth more than any new subsystem.

---

*End of handoff. Update this file whenever a §6 verdict changes.*
