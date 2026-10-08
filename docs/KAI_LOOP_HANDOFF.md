# KAI — LOOP HANDOFF

**The repository is the memory.** This file exists so a fresh context (or a fresh agent) can pick
up the loop mission from repository state alone, without the conversation history that produced it.

Last verified by the integrator: 2026-10-05, at commit `72ee851`.

---

## 1. BASELINE — VERIFIED, DO NOT LOSE THIS

```
core    tsc -p tsconfig.json --noEmit   exit 0
core    node scripts/test.mjs           862 tests / 849 pass / 0 fail / 13 skipped
app     npx tsc --noEmit                exit 0
app     npm test                        210 tests / 210 pass / 0 fail
```

**The running artifact predates all of this** — it is still build `7d8f322134be127b`. Everything
below is proven in source and in tests, NOT in the shipped binary. **A real `cd app && npx tauri
build` is owed before any of it can be called END-TO-END.**

Landed since the previous handoff (`7c59491`):

- **Canonical identity model** — `core/src/agent/identity-model.ts`, all twelve fields as real
  runtime values, the five authorities typed as their factories' own `ReturnType` so an authority
  field *is* the running subsystem object. Four competing pieces resolved into one. **Wired into
  `runtime.ts`** at the composition root. 14 tests call the real subsystems' real methods.
  NOT exposed on the Core API surface yet — so INTEGRATION PROVEN, not END-TO-END.
- **Island companion** — `app/src/island/{attention,companion,shared}.ts`: NEEDS_USER end-to-end,
  a pure structured-attention model, companion actions through the SAME CoreClient the workspace
  decides with (one approval authority, executed ONCE), one Core mirror. 210/210 app tests.
- **MCP stream COMPLETE** (`fdae194`) — both owed docs written; **Hermes-independence PROVEN**
  (process-tree walk: both MCP servers are direct children of KAI's own process, no Hermes between
  them; 0 hermes/8642 refs in `core/src/mcp/**`); **collision END-TO-END PROVEN live**
  (`mcp.alpha.echo`→"A", `mcp.beta.echo`→"B", no clobber); and a real uncaught-EPIPE bug found and
  fixed in `real-client.ts` — which the MCP-subset-only run had hidden.

The 13 skipped core tests are the live-agent suites skipping by design when their context is
absent — they are **not** green and must not be reported as green. Exporting `API_SERVER_KEY`
moves the baseline; without it the live-auth suites fail honestly rather than hiding.

**Run verification in the FOREGROUND.** A Hermes background process injects
`stdin is not a tty` and swallows the child's stdout, producing exit=1 with an output file
containing nothing but that string. This has faked a failure three times. It is an artifact, never
evidence about the product. Read redirected output back and check it contains real output.

---

## 2. WHAT IS ACTUALLY LIVE ON THE RUNNING PRODUCT

Verified against the running artifact (Core on `127.0.0.1:8788`):

```
GET /mcp               200   (was 404)
GET /tools             200   56 tools
GET /sessions/search   400   correct — it validates a required ?query=, it is not 404
GET /identity          200   buildId 7d8f322134be127b, pid 3864 == the 8788 owner, freshness fresh
```

**MCP is connected to a real server.** `discord` (stdio, `npx -y @iqai/mcp-discord`, credential
`env:DISCORD_TOKEN`) — MCP-Discord v1.0.0, protocol `2025-06-18`, **22 tools**, 0 refused, safe
READ `discord_login` proven, disconnect leaves no stale `CONNECTED`, reconnect restores tools.
`canva` (http) registers but its transport is unimplemented in this build → **BLOCKED_EXTERNAL**.

---

## 3. COMMITS THIS LOOP PRODUCED

```
72ee851  fix(app): add the workspace sources babb00f imports
babb00f  feat(app): the KAI workspace is mounted
7ae66f9  feat(mcp): KAI connects to a real MCP server, with secrets kept as references
f3d6896  evidence: both mounted surfaces proven live
015937e  feat(core): both handed-over surfaces are mounted
```

### THE LESSON THAT KEEPS REPEATING — INTEGRATION IS PART OF THE FEATURE

Three separate times, work was **built, tested, proven, and mounted nowhere**:

1. The tool and session surfaces (`/tools`, `/sessions/*`) — mounted by the integrator after the
   streams handed over a one-line wiring each.
2. The workspace panel — the stream built and proved it but did not own `app/src/main.ts`, so it
   shipped unreachable until the integrator wired it.
3. **`babb00f` itself** — it wired `main.ts` to import `app/src/workspace/**`, which was
   **untracked**. The commit did not build from a clean checkout, and local `tsc`/`npm test`
   passed *precisely because the untracked files were sitting on disk*. Fixed in `72ee851`.

**Therefore: after every batch — `git status`, and confirm every file a commit imports is
tracked. A green local suite says nothing about whether the change is IN THE REPOSITORY.**

---

## 4. OPEN GAPS — THE HONEST LIST

**Named by the owner as the two outstanding product pieces:**

1. **Canonical KAI identity model** — NOT PROVEN. The twelve fields
   (`agentId, displayName, identity, soul, capabilities, limits, userContext, memoryAuthority,
   workforceAuthority, sessionAuthority, policyAuthority, approvalAuthority`) must be **real
   runtime fields**, backed by the real subsystems, with `CoreIdentity` / `KaiIdentity` /
   `SOUL.md` / `KAI_HARNESS.md` resolving into ONE source of truth. A repo-wide grep has
   previously found nothing matching this shape.
2. **Island companion integration** — OPEN. Real-event states, Core-executed actions, structured
   attention, and shared state with the main workspace proven in both directions.

**Carried from the MCP stream (it hit its iteration cap):**

- `docs/KAI_MCP_MIGRATION.md` — not written.
- `docs/evidence/kai-mcp-all-credentials-final.json` — not written (raw result only at
  `~/.hermes/profiles/kai/cache/scratch/kai-mcp-live-result.json`).
- **Hermes-independence proof not executed.** Deliberately deferred: PID 200 is `hermes.exe
  gateway run`, a multiplexer, and there is no installed service to restart it. Structural
  evidence only (KAI's MCP path is stdio, zero references to 8642 or Hermes). **This is the proof
  that MCP belongs to KAI and not to Hermes — it still needs doing.**
- Tool-collision proven at UNIT level only (`mcp.alpha.echo` / `mcp.beta.echo`); not re-run live.
- Full 838-suite not re-run after the MCP change (MCP subset only: 15/15).

**Other open items:**

- UI consumption of the new session/subagent routes — workspace panels exist; sessions and
  subagent surfaces are partial. No subagent chat UI; no `POST /subagents` route.
- PC-control UI integration — OPEN.
- Third-party MCP beyond discord/canva — nothing else is configured on this machine.
- 13 skipped core tests still need an explanation (acceptance-gate item).
- `learning.propose` dedupe residual: `learning/pipeline.ts` drops the `deduped` marker before the
  tool result exists, so it can name a memory it did not create. Named, not silently fixed.
- `/identity` reads `build-info.json` from disk on every call, so it can report a build the running
  process never loaded. Long-standing, still unfixed.
- `attachProvider` has zero production call sites; variant resolver unwired.

---

## 5. UNCOMMITTED / DIRTY — OWNERSHIP UNRESOLVED

```
 M app/src/settings/main.ts      dirty from another stream — INSPECT, PRESERVE, never discard blindly
 M core/tests/subagent.test.ts   dirty from another stream — same
?? docs/KAI_RUNTIME_ARCHITECTURE.md, docs/KAI_SOUL.md, docs/openghost-integration-audit.md,
?? docs/evidence/*.png, *.json, *.txt   (the docs/evidence stream's output, never committed)
```

The untracked `docs/evidence/**` files include real captures (`kai-twelve-hermes-down.json`,
`kai-subagent-e2e.json`, `subagents/concurrent.json`, `char-*.png`) that earlier work referenced.
**Decide their fate deliberately** — commit them as evidence or they are effectively lost.

---

## 6. STANDING RULES (from the mission documents, unchanged)

- **ZERO COLLISION RULE.** No two implementation agents edit the same files. Each stream declares
  OWNER / FILES / GOAL / DEPENDENCIES / OUTPUT. A stream needing a shared integration file does
  **not** edit it — it exports its own `registerXRoutes(app, deps)` and hands the integrator the
  exact import, call, dependencies and tests.
- **One integration stream is mandatory**, and it runs the full suite, builds the real artifact,
  launches it, and proves end-to-end. Integration is part of the feature, not cleanup.
- **Acceptance standard:** a route returning `200` is not integration. Prove
  `UI action → Core route → real runtime → real state change → event → UI update`.
- **Honesty vocabulary:** UNIT PROVEN / INTEGRATION PROVEN / END-TO-END PROVEN / MOCK ONLY /
  NOT PROVEN / BLOCKED_EXTERNAL / AUTH_FAILED. Do not round a level up.
- **Never fake.** No fake timers, no simulated agent activity, no fabricated MCP servers, no
  credential values anywhere (only `PRESENT` / `MISSING` / `EXPIRED` / `INVALID` / `NOT_REQUIRED`).

---

## 7. ENVIRONMENT TRAPS (each one has already cost real time)

- **`taskkill //F //PID` fails SILENTLY from MSYS bash.** Kill with
  `node -e "try{process.kill(PID)}catch(e){}"`.
- **The artifact-identity self-check is a permanent safety invariant.** If it REFUSES, the only
  valid response is **REBUILD** — never bypass it, never edit the expected hash, never run a stale
  artifact.
- **`kai.exe` holds a file lock** (`Access is denied (os error 5)`) — kill the `kai.exe` **parent**,
  not just the Core, before rebuilding.
- **A bare `cargo build --release` produces a dev-config exe** pointing at an unserved
  `localhost:1420` (`chrome-error://chromewebdata/`). Release builds must go through
  `cd app && npx tauri build`. The artifact is `app/target/release/kai.exe` — **not**
  `app/src-tauri/target/release/kai.exe`.
- **Two windows share the host `tauri.localhost`** — match it exactly, and match the **path**
  (`/island`, `/settings`).
- **The island auto-collapses ~10 s after launch**; reveal it via
  `__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'tray',payload:'open'})`.
- Launch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'` and a fresh
  `WEBVIEW2_USER_DATA_FOLDER`.
- `rustc/cargo 1.99.0` needs `export PATH=$PATH:/c/Users/DELL/.cargo/bin`.
- MSYS does **not** translate path arguments for native programs: pass `C:/Users/x` to `git`,
  `node`, `rg`; `/c/Users/x` only to bash builtins.
- Native modules are `node:sqlite` (`DatabaseSync`) — zero external dependencies, do not add one.
- **Only one writer may operate `kai.exe` at a time.**

---

## 8. EVIDENCE LOCATIONS

```
docs/evidence/kai-subagent-fixed.json          ~140 KB  L2 identity proof (KAI subagent answers as KAI)
docs/evidence/surfaces-integration.json        ~72 KB   404 -> live transitions, 5 verdicts
docs/evidence/kai-sessions-final.json          ~8.8 KB  session surface numbers
docs/evidence/kai-tools-final.json             tool plane, 238 lines
docs/evidence/mcp-integration.json             MCP mount, before/after bodies
docs/evidence/kai-soul-independent.json        identity claims, 32 tagged
docs/evidence/island-final.json                15,736 B / 22 sections — island lifecycle
docs/evidence/character-runtime-final.json     12/12 states via the renderer's own handle
docs/evidence/core-unreachable-final.json      the honest-failure card
docs/evidence/visual-engine-slice.json         visual engine, first slice
~/.hermes/profiles/kai/cache/scratch/kai-mcp-live-result.json   MCP live run (NOT yet in the repo)
```

Architecture documents: `docs/KAI_ULTRA_MISSION_PLAN.md` (coordination artifact — ownership,
collision rule, stream table), `docs/KAI_STAGE1_FREEZE.md`, `docs/KAI_TOOL_ARCHITECTURE.md`,
`docs/KAI_SESSION_ARCHITECTURE.md`, `docs/KAI_RUNTIME_ARCHITECTURE.md`, `docs/KAI_SOUL.md`,
`docs/KAI_HARNESS.md`, `docs/HERMES_TO_KAI_MIGRATION.md`, `docs/KAI_CAPABILITY_AUDIT.md`.

---

## 9. NEXT BATCH

Dispatch, in parallel, with disjoint file ownership:

- **A/B — canonical identity + harness** (`core/src/agent/**`, `core/src/identity.ts`,
  `core/tests/identity-*.test.ts`, `docs/KAI_SOUL.md`) — gap 1.
- **G — island companion** (`app/src/island/**`, `app/src/character/**`) — gap 2.
- **F — MCP completion** (`core/src/mcp/**`, the two owed docs) — the owed proofs above.
- **L — adversarial** against the current HEAD, read-only, reporting findings rather than editing.
- **M/N — integration owner**: `git status`, tracked-vs-imported audit, both tsc, both suites,
  real Tauri build, artifact freshness, launch, live probes, the end-to-end journey.

Then loop: collect, verify, integrate, rebuild, re-probe, find gaps, dispatch again.
