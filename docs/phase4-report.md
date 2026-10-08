# KAI Phase 4 — final report (continuation pass)

**This is the report the directive asks for.** Every number here came from running
the command on this machine; the raw output is under `docs/evidence/`. It names what
is still missing rather than hiding it.

This pass closed the five actionable gaps the previous report left open. Sections
marked *(this pass)* are new.

---

## 1. Current HEAD and the identity of the Core that answered

| | |
|---|---|
| **HEAD (code under acceptance)** | `81479bca32b5fdc55a8784447e1e777f880c5471` (`81479bc`) — the only commits above it are docs-only, so the accepted artifact is unchanged |
| Working tree | clean at the time of the packaged run (all work committed; docs committed after) |
| **Core build id** | `f17cf4e30a393a55` — SHA-256 over `core/src/**` + configs, source-derived (not a timestamp) |
| Core gitCommit | `81479bca32b5fdc55a8784447e1e777f880c5471` — matches the code HEAD (only docs-only commits sit above it) |
| Protocol version | 1 |
| Runtime proof | the packaged `kai.exe` (pid 56056) cold-started the bundled `core/server.js` (pid 38124); `netstat` shows **pid 38124 owns `127.0.0.1:8788`**; `GET /identity` reports pid 38124, build `f17cf4e30a393a55`, commit `81479bc`. `core/bundle/build-info.json` holds the same buildId/commit, so the running binary is the build stamped on disk. `GET /maintenance/status` independently confirms `identity.current == true`. |

Artifacts (rebuilt this pass): `app/target/release/kai.exe` (4,968,448 bytes) and
`app/target/release/bundle/nsis/KAI_0.1.1_x64-setup.exe` (2,389,359 bytes ≈ 2.28 MiB).
The installer remains **unsigned** (SmartScreen will warn) — an external blocker (a
code-signing certificate), not an engineering gap.

## 2. Test results *(this pass)*

| Suite | Result | Evidence |
|---|---|---|
| `core/` `npx tsc -p tsconfig.json --noEmit` | exit 0, no diagnostics | |
| `core/` `node scripts/test.mjs` | **664 / 664 pass, 0 fail, 0 skipped** | final run, all suites |
| `app/` `npx tsc --noEmit` | exit 0, no diagnostics | |
| `app/` `npm test` | **80 / 80 pass, 0 fail, 0 skipped** | was 59; +21 session tests |
| `app/` `npm run tauri build` | exit 0 → `kai.exe` + installer (2.28 MiB) | clean from a stopped app |
| **Live acceptance, rebuilt Core at HEAD** | **82 / 82 PASS** | `docs/evidence/phase4-recheck-live.txt` |
| **Live acceptance, PACKAGED product** | **79 / 79 PASS, 0 FAIL** | `docs/evidence/phase4-recheck-packaged-live.txt` |
| **Sessions view, live in the PACKAGED app (DOM over CDP)** | **create / switch / archive all confirmed against Core** | `docs/evidence/phase4-sessions-live.txt` |
| **Real-browser test determinism** | **6 / 6 runs × 5 / 5 pass** (this pass) + 8 sequential and 16 concurrent stress runs with zero failures | §3.5 |

The live harness (`docs/evidence/phase4-live.mjs`) drives a real Core over loopback
HTTP and prints the raw status and body it decided on. Two runs were made: against the
rebuilt Core at HEAD (`dist/server.js`, port 8789, with a host token so the
host-attested learning path is exercisable) and against the packaged product (port
8788). In the packaged run the harness holds no host token, so the `l2` section
**skips** rather than failing closed — the same host-attested limitation the previous
report accepted.

## 3. The five gaps, closed *(this pass)*

### 3.1 Shell / Git / Filesystem capabilities are REAL — gap 1

`filesystem`, `git` and `shell` are no longer honest UNAVAILABLE stubs. Real tools
(`core/src/tools/workspace.ts`) are registered on the **one** tool registry and reach
the machine only through the same boundary as every other action:
`validate → risk classification → policy → (approval) → execute`.

- `filesystem.read` / `filesystem.list` — **READ** (allowed unattended).
- `filesystem.write` — **WRITE**, `effectful` (parks for a human; the acceptance
  boundary records it so a crash cannot replay it blindly).
- `git.status` / `git.log` / `git.diff` — **READ**.
- `shell.run` — **DESTRUCTIVE**, `effectful` (parks for a human). It runs a program
  with an **explicit argument list** (`execFile`, `shell:false`), so there is no shell
  to interpolate metacharacters into; a caller that wants a shell asks for one
  explicitly, and that request parks like any other DESTRUCTIVE action.

Availability is **probed, not declared**: `git` runs `git --version`, `shell` spawns
the very Node binary running the Core. The capability tools (`capability.filesystem`,
`capability.git`, `capability.shell`) dispatch to the same ops **inside the
boundary**, so a capability action needs exactly one policy decision and one approval.

Live: `workspace.*` (11 checks) pass in both harness runs — including a real 409 park,
a real approved write, the approval **re-issuing** the parked call, a real approved
`shell.run` returning `live-shell-ok`, and a READ tool step completing a mission
unattended.

### 3.2 A non-mission approval now RE-ISSUES the parked request — gap 2

The reported defect was real: for a request with no mission behind it (a capability
test, an agent action), the verdict was recorded and **nothing ran**. Now:

- when the registry parks a request with **no mission**, it hands the runtime the
  exact validated call (`toolId` + input + correlation);
- the runtime records it **durably** in its own SQLite file
  (`core/src/approvals/parked.ts`, `parked-requests.db` beside the Core database);
- `decideApproval` re-issues that exact call with the approval id in hand on
  **APPROVED**, drops it on **REJECTED**, and announces the outcome as a
  notification — so the island's **Allow** button completes the whole loop;
- the record is **crash-safe**: `tests/workspace-approval.test.ts` (c) parks a
  request, restarts the Core over the same files, and re-issues it successfully. The
  startup sweep drops only requests whose approval is no longer PENDING.

`POST /approvals/:id/decide` now returns `reissued` and the re-issued action's
`result`. `tests/api-enforcement.test.ts` was updated to the new contract (it had
encoded the old "deciding alone performs nothing" behaviour that the directive
replaces).

### 3.3 Sessions UI in the island — gap 3

The Core and API already supported create / switch / rename / archive; the island had
no view. Added (all in `app/`): defensive `CoreClient` session methods, a session
slice in the Core snapshot + reducer, a `core-boot` refresh fetch, a bridge hook, a
`sessions` `IslandViewName` + layout entry, and a restrained card view reached from a
new header tab. **Verified live in the running packaged app** (§2 and
`docs/evidence/phase4-sessions-live.txt`): clicking **New** created `Conversation 6`
in Core; **Use** moved the Core's active pointer to `Conversation 5`; **Archive**
moved the first row to ARCHIVED in Core. The DOM re-rendered after each, so the loop
is UI → Core → UI, not unit tests alone.

### 3.4 L2 behaviour change now has a TRACE — gap 4

Previously PARTIAL because a changed-behaviour **action trace** was not produced. It
is now, as one correlated chain on the real runtime:

1. the learning pipeline threads the memory entry id it wrote into its outcome;
2. the registry's `learning.propose` action record therefore carries `memoryId`,
   naming the exact memory the lesson produced;
3. `GET /actions` exposes that record;
4. `POST /prompts/compose` returns the exact prompt a later turn would send, and its
   recalled-memory section contains the lesson — which an identically-composed prompt
   did **not** contain before the lesson existed.

`core/tests/learning-trace.test.ts` proves all four against a real runtime, and the
`l2` live section reproduces it over HTTP (a `learning.propose` record with
`memoryId=mem_…`, then the lesson present in the composed prompt). The trace was
genuinely unproducible before because the memory artifact was never surfaced; it is
producible now because it is.

### 3.5 The flaky real-browser test is fixed — gap 5

Root cause: `Target.createTarget({url})` resolves when the target **exists**, before
the requested document commits; `openTarget()` then read `pageInfo()` exactly **once**
and could sample the initial `about:blank` document (empty title, empty accessibility
tree). Load-dependent, which is why it failed once in a busy run and passed in
isolation.

Fix (`core/src/capabilities/browser/cdp-transport.ts`): a bounded `waitForDocument`
waits on the **real** signal — the committed URL leaving `about:blank` and
`readyState === 'complete'` (note: `about:blank` is already `complete`, so the URL is
the load-bearing signal) — and `observe()` never snapshots a pre-commit document. No
fixed sleeps, no weakening of the test.

Determinism: 6/6 sequential runs of the file this pass (5/5 each); 8/8 sequential and
16/16 concurrent stress runs with the fix, versus **5/8 failures** on the original
file under the same load.

### 3.6 An adversarial finding resolved: a deduped memory.write mislinked its trace

The supervisor's own adversarial pass committed a test that reproduced a real
mislink: a **deduped** `memory.write` returns the entry that *already existed*, and
`artifactIdsOf` named it, so two `action.executed` records claimed the same
`memoryId` and `traceArtifact` (reading the newest-first store) resolved to the later,
non-creating action. The finding deferred the fix as an owner decision.

Resolved the honest way (**report the dedup honestly**, not invent an id): only a
write that actually CREATED the entry now names it, so exactly one action claims the
memory and the trace is unambiguous. `core/tests/adversarial-observability.test.ts`
now asserts the resolution (one claimer; the trace resolves to the creating action)
rather than the defect. This matters directly to §3.4: a trace is only evidence if it
names the action that produced the artifact.

## 4. The feature / phase matrix

Legend: **PASS** (live-verified) · **IMPLEMENTED** (code + tests) · **PARTIAL** ·
**BLOCKED** (external).

### Phase 1 — Part U (T1–T10), re-run at HEAD

| Item | State | Note |
|---|---|---|
| T1 workers available | PASS | hermes=READY opencode=READY codex=UNAVAILABLE |
| T2 disable Hermes | PASS | DISABLED, Core still healthy |
| T3 restore Hermes | PASS | READY |
| T4 register mock employee | PASS | 201, DISCOVERED |
| T5 unauthorized action gated | PASS | 409, `executed=false`, parked with an approval id |
| T6 approve + real worker execution | PASS | approved → a **real model turn** → `PARTU-WORKER-OK` |
| T7 real CUA interaction | PASS | real `cua-driver` windows returned |
| T8 real browser transport | PASS | a real CDP target |
| T9 semantic browser observe | PASS | roles/names/refs, no coordinates |
| T10 KAI direct capability | PASS | `system.get_status`, no approval, `executor=kai` |

### Phase 2 acceptance matrix

| Item | State | Note |
|---|---|---|
| C1 checkpoint create | PASS | |
| C2 checkpoint restore | PASS | verified sha256 restore; the user's git untouched |
| C3 checkpoint failure honesty | PASS | 409 on a missing target |
| C4 before-accept recovery | PASS | parked side-effecting step classifies BEFORE_ACCEPT / replaySafe:true |
| C5 after-accept recovery | PASS | executed write is AFTER_ACCEPT, replaySafe:false, count 1 |
| C6 unknown is unsafe | PASS | UNKNOWN → replaySafe:false |
| R1 one-time schedule fires once | PASS | exactly 1 mission carrying the scheduleId |
| R2 restart survival | PASS | |
| R3 no double fire | PASS | 1 mission across the run |
| R4 current policy at fire | PASS | policy tightened after the schedule → POLICY_DENIED at fire time |
| L1 correction → artifact | PASS | |
| **L2 behaviour change** | **PASS** *(this pass)* | action trace + composed-prompt evidence; see §3.4 |
| M1–M5 memory | PASS | write / search / dedup / read-back / journal; composed-turn recall |
| S1–S4 skills | PASS | staged → approval → install → discover → load |
| provenance security (FALSIFIED 1) | PASS | unauthenticated `/chat` learns nothing; claimed `source:user` → 400 |
| side-effect derivation (FALSIFIED 2) | PASS | a step whose tool WRITES is classified by its EFFECT |
| A1 OpenCode real task | **BLOCKED** | upstream provider configuration (§5) |

### The 17 directive areas

| # | Area | State | Where |
|---|---|---|---|
| 1 | Identity / personality | IMPLEMENTED | `agent/soul.ts`, `agent/kai-home.ts`, `prompts/compose.ts` |
| 2 | Chat / conversations | PASS (live) | `server.ts /chat`, `chat/router.ts` |
| 3 | Persistent sessions | PASS (live) | `sessions/{store,service}.ts`, `/sessions*` |
| 4 | **Session switching (UI)** | **PASS** *(this pass)* | island sessions view; live DOM proof `phase4-sessions-live.txt` |
| 5 | Memory | PASS (live) | `memory/**` incl. a wired `session` scope |
| 6 | Skills + learning | PASS (live) | `skills/**`, `learning/**` (L1 + L2) |
| 7 | Missions / planning | IMPLEMENTED | `missions/**`, `autonomy/**` |
| 8 | Approvals / policy | PASS (live) | `approvals/**`, `policies/**`, **durable parked-request resume** |
| 9 | Workforce / employees | PASS (live) | `workforce/**`, capabilities manager |
| 10 | **Browser / CUA / MCP / Shell / Git / Filesystem** | **PASS** *(this pass)* | Browser + CUA + MCP real; **Shell/Git/Filesystem now real tools behind the boundary** (§3.1) |
| 11 | Scheduler | PASS (live) | `scheduler/**` incl. the durable lease |
| 12 | Checkpoints | PASS (live) | `checkpoints/**` |
| 13 | Recovery | PASS (live) | `recovery/{ledger,boundary}.ts` |
| 14 | Observability | **PASS** *(this pass)* | `observability/action-record.ts` + readable `GET /actions` |
| 15 | Autonomous loop | IMPLEMENTED + live | `autonomy/supervisor.ts` |
| 16 | Self-maintenance / upgrading | IMPLEMENTED + live | `maintenance/index.ts` |
| 17 | UI | PARTIAL | the island consumes Core state/events and now has a sessions view; other views are the macOS port |

## 5. Remaining blockers and gaps (no PASS is claimed for these)

- **A1 / OpenCode real worker task — EXTERNALLY BLOCKED.** The OpenCode server is up
  (`{"healthy":true,"version":"1.18.33"}`) but the configured providers do not answer
  (their own error text is in `docs/evidence/phase2-opencode-verdict.txt`). A
  provider/credential problem on the machine, not a KAI defect.
- **The installer is unsigned** — a code-signing certificate is an external
  dependency. SmartScreen will warn.
- **UI is PARTIAL, honestly.** The island has a sessions view and consumes Core state;
  it is still a port of the macOS panel and several views (mail, searching, result)
  are placeholders. Nothing in this pass claims a finished product UI.

> **Superseded (Phase 5, `5519768`).** Those three views are gone: they were registered
> placeholders that no code path could reach, and they were removed with the capability
> reported as unavailable, alongside fixes to the dead controls in the error/finished/empty
> cards and to the `question` view, which was real but unreachable. Every remaining view is
> driven live in the packaged app (19/19 expected states). See `docs/phase5-report.md` §3.

### Findings recorded, not rounded up

- **Two Hermes credentials on this machine (environment, not code).** The packaged
  app passes the real api-server key to the Core it spawns (`GET /health` →
  `authorized: true`), while a Core started by hand reads `~/.hermes/.env`, whose
  `API_SERVER_KEY` the live api-server currently rejects (`authorized: false`). In the
  rebuilt-Core live run T6 (`agents.run_task`) still completed with a real turn, and
  the L2 learning is fire-and-forget, so no live check depends on that key. It is a
  local credential split worth knowing about, not a defect this pass introduced.
- **`POST /prompts/compose` and `GET /actions` are loopback READs** at the same trust
  boundary as the existing unauthenticated `/chat`, `/memory` and `/identity`: they
  expose KAI's own prompt/records to other local processes. This is deliberate (they
  are what make a behaviour change verifiable) and is documented in `docs/api.md`.

## 6. Reproduce

```bash
# tests + types
cd core && npm run typecheck && node scripts/test.mjs     # 664/664
cd ../app && npx tsc --noEmit && npm test                 # 80/80

# the packaged product
cd ../app && npm run tauri build                          # kai.exe + installer
./target/release/kai.exe                                  # cold-starts the Core
curl -s 127.0.0.1:8788/identity                           # build/commit == HEAD
curl -s 127.0.0.1:8788/maintenance/status                 # identity.current == true

# the live acceptance matrix
cd .. && KAI_HOST_TOKEN=<the app's token> node docs/evidence/phase4-live.mjs
```
