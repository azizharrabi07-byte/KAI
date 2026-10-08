# KAI ULTRA MISSION — plan, stream ownership, and durable state

This file is the **coordination artifact**. It exists so that the mission survives any single
agent's context window: if an agent stops, the plan, the ownership boundaries and the evidence
index are all on disk. Read this before starting any stream.

## 0. The one-sentence target

> **A genuinely KAI-owned runtime — its own identity, harness, memory, tools, MCP, sessions,
> subagents, control plane, PC capabilities and main UI — with Hermes as an optional worker.**

The test that decides everything: **stop Hermes, and KAI is still KAI.**

## 1. Why prompt-level identity is not enough

This is already established by evidence, not theory. A KAI-managed subagent, given KAI's exact
payload, answered:

> *"I'm not a KAI-native persona — I'm a Hermes Agent instance (Nous Research), running as a
> supervised child process delegated into this turn. The 'probe' label is just how KAI addressed
> me; nothing in my runtime identity encodes it."*

The cause was a real **worker-runtime identity path**, not bad prose. So:

```
WRONG   Hermes runtime + "You are KAI"
RIGHT   KAI runtime + KAI identity + KAI harness + KAI system rules + worker abstraction
```

## 2. ZERO COLLISION RULE — file ownership is binding

Two implementation agents must never edit the same file. Each stream declares **OWNER · FILES ·
DEPENDENCIES · OUTPUT** before editing. One integration stream reconciles.

**RESERVED — do not touch unless you are that stream:**
`core/src/api/routes.ts` · `core/tests/subagent.test.ts` · `docs/KAI_SOUL.md` ·
`docs/KAI_RUNTIME_ARCHITECTURE.md` · `docs/KAI_HARNESS.md`

**If your stream needs a route:** build your capability as a module that exports its own
registration function (e.g. `core/src/<area>/routes.ts` exporting `register<Area>Routes(app, deps)`).
Do **not** edit `routes.ts`; hand the one-line wiring to the integration stream. This keeps the
capability real and the collision zero.

## 3. Streams

| Stream | Owns | Output | State |
|---|---|---|---|
| **A — KAI SOUL** | `KAI_HOME`, identity resources, harness loading | `docs/KAI_SOUL.md` | foundation landed (`8fea1bf`), docs owed |
| **B — HERMES TRANSPLANT** | audit → selective transplant | `docs/HERMES_TO_KAI_MIGRATION.md` | **DONE** (`c41f930`) — 18 components classified |
| **C — TOOL PLANE** | `core/src/tools/**` | `docs/KAI_TOOL_ARCHITECTURE.md` | not started |
| **D — MCP** | `core/src/mcp/**` | `docs/KAI_MCP_ARCHITECTURE.md` | **known gap** — see §4 |
| **E — SESSIONS** | `core/src/sessions/**` | `docs/KAI_SESSION_ARCHITECTURE.md` | not started |
| **F — SUBAGENTS** | `core/src/workforce/subagent.ts` | `docs/KAI_SUBAGENT_ARCHITECTURE.md` | L2 identity fix `acc4b67`, approval-loop fix `6710b7f` |
| **G — PC CONTROL** | verification only | `docs/KAI_PC_CONTROL_ARCHITECTURE.md` | not started |
| **H — OPENGHOST MAIN UI** | `app/src/visual/**`, workspace views | `docs/KAI_WORKSPACE_ARCHITECTURE.md` | first slice proven (`e43b1d3`) |
| **I — ISLAND** | `app/src/island/**` | `docs/KAI_ISLAND_ARCHITECTURE.md` | companion refactor not started |
| **J — SECURITY** | adversarial attacks, read-only | `docs/evidence/kai-security-final.json` | not started |
| **K — INTEGRATION** | reconcile, rebuild, final proof | `docs/KAI_INDEPENDENCE_PROOF.md` | not started |

## 4. The known MCP gap (Stream D's starting fact)

From `docs/KAI_CAPABILITY_AUDIT.md`, queried live: **0 MCP servers, 0 plugins.** The MCP code is a
library plus 12 unit tests with **zero runtime call sites**; `createMcpRegistry`/`wireMcpTools`
have no caller; `WIRING.md` literally says *"the note the Core lead needs"*; `GET /mcp` returns
404; the capability reads `UNAVAILABLE`. The MCP *protocol* is used in production only as the
private transport between KAI and `cua-driver`.

So Stream D is not "improve MCP" — it is **wire MCP into KAI's runtime for the first time.**

## 5. Status vocabulary — mandatory

`UNIT PROVEN` · `INTEGRATION PROVEN` · `END-TO-END PROVEN` · `MOCK ONLY` · `NOT PROVEN` ·
`BLOCKED_EXTERNAL`

Never round a `NOT PROVEN` up to a PASS. **Distinguish `FILES EXIST` from
`KAI FUNCTIONALLY OWNS THE MECHANISM`** — a file having been copied is not completion.

## 6. Evidence index (the durable record)

```
docs/evidence/kai-twelve-hermes-down.json      twelve-step answers with Hermes genuinely killed
docs/evidence/kai-direct-hermes-down.json      direct capability + approval cycle, Hermes down
docs/evidence/kai-subagent-e2e.json            subagent e2e + the approval-loop defect
docs/evidence/island-final.json                island lifecycle, 5 proofs
docs/evidence/subagent-memory-final.json       memory isolation A–F + 14 negatives
docs/evidence/character-runtime-final.json     character runtime, 12/12 states
docs/evidence/core-unreachable-final.json      the visible offline card
docs/evidence/recovering-final.json            the RECOVERING chain to the renderer
docs/evidence/visual-engine-slice.json         the validated visual slice
```

Required but **not yet written**: `kai-identity-final.json` · `kai-harness-final.json` ·
`kai-independence-final.json` · `kai-tools-final.json` · `kai-mcp-final.json` ·
`kai-sessions-final.json` · `kai-subagents-final.json` · `kai-pc-control-final.json` ·
`kai-workspace-final.json` · `kai-island-final.json` · `kai-security-final.json`

## 7. Proven guarantees that must NOT be erased

Reorganizing code is allowed. Erasing these is not:

artifact identity (rebuild on refusal, never bypass) · scoped memory with subagent isolation and
governed sharing · the single approval authority · the policy engine · real browser/CDP · real CUA
(never downgraded to coordinate guessing) · the workforce abstraction · the character runtime ·
the visual validator and renderer · recovery · scheduler.

**The transplant fills capability gaps. It does not replace working architecture with a Hermes
equivalent to make the code look similar.**

## 8. Build discipline (each of these has cost real time here)

- Publishing: `cd app && npx tauri build` with the prebuild ENABLED. A bare
  `cargo build --release -p kai` yields a **DEV-MODE** binary loading `localhost:1420` and exits 1.
- `npm_config_ignore_scripts=true` silently leaves a **stale** Core bundle.
- **Kill the `kai.exe` PARENT** before building, via `node -e "try{process.kill(PID)}catch(e){}"`.
  `taskkill //F //PID` fails **silently** from MSYS bash. Killing only the Core lets the supervisor
  resurrect it and re-lock the binary mid-build (`failed to remove file kai.exe — os error 5`,
  which discards a completed Rust build at the link step).
- A build that prints nothing and reports no exit code produced **no binary**. Capture `BUILD_EXIT`.
- Never report source behaviour from an older binary. After every build record: `buildId`,
  `gitCommit`, `pid`, port owner, `freshness`.
- The Hermes background runner injects `stdin is not a tty` and **swallows child stdout** — run
  verification scripts in the FOREGROUND and write evidence to a file that is then read back.
- Island URL is exactly `http://tauri.localhost/` (settings shares the host); it auto-collapses ~10s.

## 9. Parallelize, but do not confuse

One writer per file. Read-only auditors and adversarial attackers run freely alongside
implementation. Test/proof agents are separate from implementation agents. The integration stream
is the only one that merges.

**And do not stop because a context window is filling.** The repository and these evidence files
are the durable state. Hand work to subagents and require compact evidence back.
