# KAI Prompt Engine — builder, patterns, outcomes

## Builder

`buildWorkerPrompt` renders 13 fixed sections (MISSION, YOUR ROLE with
selection rationale, CURRENT OBJECTIVE, CONTEXT capped 2000 chars,
KNOWN STATE, PREVIOUS ATTEMPTS, CONSTRAINTS, ALLOWED SCOPE, REQUIRED
OUTPUT, SUCCESS CRITERIA, VERIFICATION, BUDGET, HANDOFF FORMAT, optional
SKILL CONTEXT capped 3000). Inputs are declared fields only — no
history/transcript parameter exists, so raw conversation can never be
forwarded. Every string passes `redactText`.

## Pattern library

`prompt_patterns` table: id, task type, template, required fields, failure
modes, verification, version, uses, successes. Selection by best
successes/uses ratio (min 1 use); outcomes recorded from verified
completions only. Prompt v1→failure→v2→success sequences become evidence
(E2E S4 proves failure context reaches the retry prompt).

## Outcome recording

Each delegation records worker, task type, pattern, result, verification,
cost, latency, rework — feeding worker benchmarks, pattern stats, and skill
metrics together (the §47 loop: TASK → ROUTE → EXECUTE → VERIFY → SCORE →
STORE → UPDATE → IMPROVE ROUTING).
