# KAI Phase 2 — autonomous lead state

Durable handoff so no session restarts analysis from zero. Update this file, not just the chat.

## Repository

- HEAD at handoff: `ec3bbd8` (tree clean)
- Core tests: 605 / 605 pass / 0 fail / 0 skipped · App tests: 59 / 59 · typecheck clean (core + app)
- Product: `app/target/release/kai.exe`, installer `KAI_0.1.1_x64-setup.exe`
- Running Core identity must ALWAYS be checked before live work:
  `curl -s http://127.0.0.1:8788/identity` → buildId / gitCommit / pid, then confirm the pid owns 8788.
  A stale exe has already produced one wrong answer in this project; never skip this.

## Acceptance matrix (evidence-only; PARTIAL is not completion)

| item | state | evidence |
|---|---|---|
| C1 checkpoint create | PASS | live, checkpoint + sha listed |
| C2 checkpoint restore | PASS | gate 409 → approve → `{"ok":true,"verified":true,"restored":1}`; user git HEAD unchanged |
| C3 checkpoint failure honesty | PASS | non-existent target → 409 "target does not exist" |
| C4 before-accept recovery | **NOT RUN** | three probes failed to produce a BEFORE_ACCEPT row — see below |
| C5 after-accept recovery | PASS | classify → `AFTER_ACCEPT, replaySafe:false, sideEffectCount:1` |
| R1 one-time schedule | PASS | fired once, mission COMPLETED carrying `metadata.scheduleId` |
| R2 restart survival | PASS | survived a real app restart, then fired |
| R3 no double fire | PASS (same evidence) | exactly 1 mission per occurrence across a restart |
| R4 current policy at fire | **NOT RUN** | needs a policy-mutation route on the existing policy service |
| L1 correction → artifact | PASS | user correction classified; host path learns (memory hits 0→1) |
| L2 behaviour change | **PARTIAL** | persistence proven across restart; behaviour change lacks an action trace |
| I1–I4 worker→learning | **NOT RUN** | |
| prompt precedence | **NOT RUN** live | 24 unit tests pass; no action-trace proof |
| T1–T10 Phase 1 | PASS | 10/10 through the product (re-run after every change) |
| provenance security | PASS | HTTP refuses claimed `source:user` (400); external/worker learn nothing |
| memory M1–M5 | PASS | persist / restart recall / dedup / expiry / bounded refusal (403 with byte numbers) |
| skills S1–S4 | PASS | staged → approve → decide → install (sha256 matches) → discover → load; tamper → 403 HASH_MISMATCH |
| OpenCode A1 | EXTERNALLY BLOCKED | opencode-go 401 "Missing API key", Google ToS-disabled, nvidia 500, atessa unauthenticated, wedged :4096 |

## The C4 blocker (start here)

`recovery-ledger.db` does contain rows, with `phase = AFTER_ACCEPT`, `sideEffectCount = 1`,
`acceptedAt` set. What has NOT been produced is a row with `phase = BEFORE_ACCEPT`.

Three attempts failed to create one:
1. `memory.write` with an empty payload → **succeeded** (worth a separate look: an empty write)
2. `target: "no.such.tool"` → parked at WAITING_APPROVAL (executor's conservative EXTERNAL default)
3. `memory.write` with 300 KB → **succeeded**

Trace `core/src/recovery/boundary.ts` + `ledger.ts`: find where `begin(BEFORE_ACCEPT)` is
called relative to `accept(AFTER_ACCEPT)`. If `begin` only runs on the success path, then
`replaySafe:true` is unreachable in practice and that is a real defect, not a test problem.
Per the directive: do not label C4 "not reproducible" — prove it from source, locate why, fix
the lifecycle, add regression coverage, rerun.

## Defects already found and fixed this cycle

- capability availability was read from a snapshot instead of probed → capabilities refused while available
- the capability route could not return an approval → a DESTRUCTIVE capability could never run
- `runTask` reported `completed` with no output for a turn the server had aborted (silent success)
- one timeout governed both a control call and a whole worker turn
- mission steps took `sideEffecting` from the template → the acceptance boundary recorded nothing
- `GET /recovery/status` counted only open records → a working ledger looked empty
- the island's Allow button died silently on a stale card; post-boot approvals never showed a card

## Test discipline (learned the hard way)

This cycle produced **false passes and false failures in equal measure from the harness**:
a dead Core counted as a refusal; a malformed learning payload read as a product defect; a 409
body that did contain `approvalId` read three times as if it did not; `MissionStepInput` names
its tool in `target`, not `toolId`. So: print the raw response and status, print the ids,
independently query the resulting state, and only then classify. A harness error is neither a
product PASS nor a product FAIL.
