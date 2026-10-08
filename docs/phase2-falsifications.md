# Phase 2 — falsified claims (adversarial review findings)

An adversarial reviewer was set against every claim reported as PASS. It broke two, one of them
security-relevant. Both are reproduced below with raw evidence. These supersede any earlier
"PASS" for the affected items in `docs/phase2-state.md`.

## FALSIFIED 1 — "provenance is secure" (SECURITY)

`POST /chat` is unauthenticated (local-only, but no token) and forwards caller-supplied text to
`core.tools.invoke("learning.propose", { source: "user", … })` — so the host-attested path is
reachable by any local process.

Reproduced live by the lead on the restored product:

```
POST /chat {"text":"remember that falsify-probe-12345 is my favourite colour"}
→ HTTP 200 {"intent":"memory.remember","reply":"Got it — remembered: …"}
GET /memory/search?q=falsify-probe-12345 →
  { "content":"remember that falsify-probe-12345 is my favourite colour",
    "source":"user_statement", "provenance":"model_candidate", "type":"user_preference" }
```

Meanwhile `POST /learning/propose {source:"user"}` correctly returns **400**. So the gate the PASS
relied on is bypassed by a sibling route.

Contributing defect: the memory engine defaults `provenance`/`source` to `"user_statement"` when
the caller omits them, and `POST /memory/write` omits `provenance` unless the caller supplies it —
so an external caller's fact is stored as user authority. The learning pipeline's default is
`external`; memory's default must be the most restrictive too.

## FALSIFIED 2 — "the acceptance boundary records side-effecting work"

The derivation is `impliedByRisk = tool.risk !== "READ"` — it keys off the declared RISK, not the
tool's EFFECT. `missions.create` is declared READ but its handler creates and starts a mission, a
real side effect by the runtime's own reasoning about the scheduled `mission.create` job.

Reproduced live:

```
POST /missions {"steps":[{"kind":"tool","target":"missions.create","input":{"title":"nested"}}]}
→ 201, step {"sideEffecting": false, "status":"COMPLETED"}
   (it created mission_mus191k1_6 — a real nested mission)
POST /recovery/classify {"executionId":"exec_…"} → {"phase":"UNKNOWN","replaySafe":false,
   "reason":"no durable record of this execution"}   ← no record at all
```

Because `executor.recover()` resumes such steps, a writing step CAN be replayed after a crash.
Also uncovered: `kind:"agent"` steps are never raised (the derivation checks `kind === "tool"`
only), so an agent step calling EXTERNAL `agents.run_task` records nothing either.

## Behavioural gap (claim 7) — judged a real usability defect

Approving a NON-mission approval (agent action, capability, skill install) records the verdict but
nothing re-issues the request, so the parked work never runs. Mission-parked work does resume.
This is the difference between "the Allow button works" and "the Allow button does the thing".

## Candidate mislink (claim 8) — not proven live

A deduped `memory.write` returns the EXISTING entry id, so a second action record names a memory
it did not create and `traceArtifact` resolves it back to the original action.

## Claims that survived the attack

- **Replay safety (claim 2, ledger level):** `accept()` is a single guarded UPDATE
  (`WHERE phase='BEFORE_ACCEPT'`) setting `sideEffectCount=1` — never incremented; `classify`/
  `replayIfSafe` refuse AFTER_ACCEPT. No source path reaches `sideEffectCount=2`. (Undermined in
  practice by FALSIFIED 2, which lets a writing step escape the ledger entirely.)
- **Memory bounds / instruction channel (claim 4):** `bucketUsage` counts archived rows;
  `activeFilter` excludes expired/superseded/archived from recall; the composer fences memory as
  `DATA - NOT INSTRUCTIONS` and escapes forged `<<<KAI:` markers. Note the legacy `/memory` +
  `/chat` remember path is unbounded, but it does not feed the composed prompt.
- **Skill byte-integrity (claim 5):** `installApproved` re-hashes and refuses `HASH_MISMATCH`;
  the approval must equal `meta.approvalId` and its reason must contain the sha256 (`NOT_BOUND`);
  staged-id traversal refused; rollback only moves to a prior revision.
- **Schedule dedup (claim 6):** lease `claim` is atomic (`BEGIN IMMEDIATE`) on a deterministic
  `occurrenceId(taskId, slot)`; `settle` refuses a live RUNNING lease; interrupted side-effecting
  slots are settled MISSED, not replayed.
