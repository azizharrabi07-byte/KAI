# KAI Activity Trace — event model, levels, rendering, storage

## Event model

`ActivityEvent {seq, taskId?, workItemId?, workerId?, kind, label, detail?, at}`.
Kinds: plan, tool, worker, review, approval, verify, memory, skill, error,
done. Labels are tiny words ("Plan", "Coder-2 working", "18/18 passed",
"Verified", "Done"). Every event comes from a real runtime emission —
board transitions, tool lifecycle, delegation, review, approvals. Heartbeats
and progress are live-only; completions, failures, reviews and benchmark
updates persist as KaiEvents (`worker.started/completed/failed/cancelled`,
`review.requested/decided`, `delegation.routed`, `benchmark.updated`).

## Visibility levels

OFF (nothing recorded/shown), COMPACT (plan/tool/worker/review/approval/
verify/done/error; details stripped except errors), VERBOSE (everything with
details). Level read live from settings per call. Reasoning: HIDDEN drops
summaries; SUMMARY/PROVIDER_EXPOSED store them as quiet `Reasoning:` rows.

## Rendering

Chat thread: live status line during turns; settled tool cards collapse
(pre-existing). Activity route: grouped rows (worker/review/delegation/
benchmark map to Workforce) with relative times; `Reasoning:` rows render
quiet italic; OFF shows an explanatory note + Open Settings. Event cards
show payloads only in VERBOSE. No raw JSON, transcripts, arguments, or
chain-of-thought in any level unless VERBOSE inspection is opened.

## Storage

`activity_log` (seq PK, task/worker indexes), pruned beyond 2000 rows on
write — bounded forever. UI reads via GET /activity (task/work/limit/level).
Inspector drill-down per work item (children, activity, benchmark, review,
handoff summary capped at 400 chars — never transcripts).
