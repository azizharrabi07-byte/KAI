# Donor Ledger

Every candidate KAI has investigated, with the evidence behind each row. A row is
only as good as its citations.

**Method note (honest):** the plan called for six independent investigation lanes
running in parallel. On this machine **the subagent mechanism was unavailable** —
every spawned lane died on the retired `nvidia/z-ai/glm-5.2` child model (HTTP 410),
and the session-only model override that would have fixed it needs the user's
approval, which was not granted. So this ledger contains what **I** verified
directly, and the un-investigated candidates are marked `PENDING` with the exact
work each needs. Nothing here is presented as a completed review that was not run.

## Verified licences (fetched from the actual licence files, 2026-10-11)

| Donor | Licence file | Verdict |
|---|---|---|
| `NousResearch/hermes-agent` | `LICENSE` | **MIT**, "Copyright (c) 2025 Nous Research" |
| `anomalyco/opencode` | `LICENSE` (branch `dev`) | **MIT**, "Copyright (c) 2025 opencode" |
| `Louis-CFM/coucou` | `LICENSE` | **MIT**, "Copyright (c) 2026 Louis Raillé" |
| `Louis-CFM/coucou` | `LICENSE-ASSETS.md` | **All rights reserved** for the name, character and artwork — "except as stated below" |
| `badlogic/pi-mono` | `LICENSE` | **MIT**, "Copyright (c) 2025 Mario Zechner" |
| `openclaw/openclaw` | `LICENSE` | **MIT**, "Copyright (c) 2026 OpenClaw Foundation" |
| `morluto/rea` (`rea-agents` 6.4.0) | npm metadata | **MIT** |

**Consequence for Coucou:** the source is MIT but its identity and artwork are not.
Any adoption is limited to *mechanisms*, with no asset, name or character copied.

## Candidates

### Priority A — Hermes Agent (`NousResearch/hermes-agent`)
- **Licence:** MIT (verified above).
- **Capability sought:** skill management, prompt construction, and how reusable
  knowledge accumulates.
- **KAI gap:** #6 — KAI has a skills registry and a learning module but no
  evidence-backed pipeline from verified outcome → candidate lesson → versioned
  skill → evaluation → approval → activation → rollback.
- **Source evidence:** **PENDING** — the dedicated lane did not run (see method
  note). The files to read first: `agent/prompt_builder.py`,
  `tools/skill_manager_tool.py`, `tools/skills_tool.py`, and the skill audit
  workflow; verify each path still exists on the current default branch.
- **Runtime evidence:** none gathered.
- **Reuse decision:** **PENDING**. The expectation from KAI's own architecture is
  **Reimplement natively** (Hermes is Python; KAI's Core is TypeScript, and its
  learning must run through the same work board, Outcome Gate and Guard).

### Priority B — OpenCode (`anomalyco/opencode`)
- **Licence:** MIT (verified above).
- **Capability sought:** session/message interfaces, tool contracts, plan-vs-build,
  streaming events, cancellation.
- **KAI gap:** KAI's adapter already implements health/status/run_task/cancel_task
  and does **not** consume the SSE `GET /event` stream; event-driven progress is the
  real opportunity.
- **Source evidence:** **PENDING** (lane did not run). KAI's own adapter is at
  `core/src/agents/adapters/opencodeAdapter.ts` and the client at
  `core/src/agents/opencode.ts`; a review must read both before proposing anything.
- **Runtime evidence:** the service is installed (v1.18.35) but **not listening** on
  `:4096`; live tests skip with that named reason.
- **Reuse decision:** **PENDING**.

### Priority C — Coucou (`Louis-CFM/coucou`)
- **Licence:** MIT source; **assets reserved** (verified above).
- **Capability sought:** worker-event normalisation and desktop-presence pipeline.
- **KAI gap:** #4 partly (event/status provenance) — KAI's `KaiEventType` union and
  `shared/runtime-events.ts` already define a canonical event vocabulary.
- **Source evidence:** **PENDING**. Start from `docs/AGENTS.md`, then read the
  Windows hook/relay source; the doc's event names must not be assumed to be the
  wire payloads.
- **Reuse decision:** **PENDING**, with the asset restriction binding regardless.

### Priority D — Pi (`badlogic/pi-mono`)
- **Licence:** MIT (verified above).
- **Capability sought:** an extensible additional coding runtime KAI can launch.
- **KAI gap:** none proven yet — KAI has one adapter with a verified live path
  (Hermes) and one contract-tested adapter (Codex, CLI absent).
- **Source evidence:** **PENDING**. Do not assume Pi supplies subagents, plan
  approval or a permission architecture because it is extensible; verify.
- **Reuse decision:** **PENDING**.

### Priority E — OpenClaw (`openclaw/openclaw`)
- **Licence:** MIT (verified above).
- **Capability sought:** agent-loop reliability — typed event sink, tool-batch
  admission, continuation, steering, repeated-tool failure handling, recovery.
- **KAI gap:** partially #2/#3 (verification and stall behaviour). KAI already has
  a durable retry ledger, a dispatch ledger and an Outcome Gate; the question is
  what OpenClaw's loop does that those do not.
- **Source evidence:** **PENDING**; start at
  `packages/agent-core/src/agent-loop.ts`.
- **Reuse decision:** **PENDING**. KAI will not import a second agent loop.

### Priority F — OpenHands SDK + Rakazo (`OpenHands/software-agent-sdk`, `vnavani/Grokbot`)
- **Licence:** **PENDING** (not fetched).
- **Capability sought:** workspace/execution-provider separation; the computer-runtime
  interface (lifecycle, observation, actions, transfer, checkpointing).
- **KAI gap:** #3 — KAI now enforces workspace containment and a no-pre-existing-
  artifact proof, but its workstation contract (`core/src/workstation/provider.ts`)
  has no provider-neutral *execution* separation.
- **Source evidence:** **PENDING**. Rakazo's `docs/computer-runtime.md` is reported
  to warn that **shared team folders are not a security boundary** — that claim must
  be quoted from the source, and it matches KAI's own conclusion that a shared
  directory is not isolation.
- **Reuse decision:** **PENDING**; no VM is created or configured (no host change
  is authorized).

### Priority G — Grok-related projects
- **Licence:** **PENDING**. `LING71671/open-grokbot` is reported GPL-3.0-only, which
  is a hard constraint for a distributed product; `Franzferdinan51/Grok-Build-Desktop-App`
  has a licence that must be resolved before any copying — an unverified README
  claim is not sufficient.
- **Reuse decision:** **PENDING**; the default for GPL-3.0-only is **Study only**.

### Priority H — LobeHub (`lobehub/lobehub`)
- **Licence:** **PENDING** (canary LICENSE reported to add commercial-derivative
  conditions).
- **Reuse decision:** **PENDING**; architecture study and code reuse are separate
  decisions, and the default here is **Study only**.

## What the ledger is for

A row with no citation is not a finding. The next investigation must fill the
`PENDING` rows in the order above, and each completed row needs: identity (repo +
ref), licence (quoted), capability, source evidence (`path:line`), runtime evidence
(if any), the KAI gap, the reuse decision, the integration boundary, the risk, and
the acceptance test that proves the improvement.
