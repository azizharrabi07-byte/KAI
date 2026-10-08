# HERMES-agent → KAI orchestration-mechanisms audit

- **Date (UTC):** 2026-10-07
- **Source:** `NousResearch/hermes-agent` @ `70dcdd640f0da6dd57c2ff362bf3a06cb837b885` (2026-10-07)
- **Method:** read-only research. Shallow blobless clone
  (`git clone --depth 1 --filter=blob:none --sparse`) into
  `C:\Users\DELL\AppData\Local\Temp\hermes-audit\hermes-agent`; full clone
  (17,811 files) was too large so only code paths were materialised via
  `sparse-checkout`: `agent/ tools/ providers/ skills/ cron/ pm/ gateway/
  hermes_cli/ hermes_platform/ acp_adapter/`, root `*.py`, `LICENSE`,
  `SOUL.md`, `AGENTS.md`, `README.md`. No binaries fetched, none executed.
- **KAI tree checked:** `C:\Users\DELL\Desktop\kai\core\src` (chat, workforce,
  sessions, skills, tools, prompts, providers, autonomy, learning, missions,
  events, model, approvals, checkpoints, memory, redact, recovery, policies).
- **Hard constraint (throughout):** KAI must NEVER depend on Hermes and must
  NEVER copy its identity, prompts, or branding. Every ADAPT below means
  *reimplement the mechanism natively in TypeScript*; no Hermes prompt text,
  persona, or product surface is carried over. License permits adaptation
  (MIT, see §7) but the constraint is stricter than the license — and compatible.

**Verdict scale:** `KEEP` = KAI already has this (no work) · `ADAPT` = useful,
rebuild natively in KAI · `REWRITE` = needed but must be redesigned for KAI's
architecture, not ported · `REJECT` = wrong for KAI (out of scope or
SaaS-specific).

**Counts:** 33 mechanisms — 10 KEEP · 14 ADAPT · 4 REWRITE · 5 REJECT.

---

## 1. Turn loop & completion contracts

### M01 — Phased turn pipeline (extracted phase helpers)
- **SOURCE:** `agent/conversation_loop.py` (`run_conversation`, `_LoopState`,
  `_run_phase`, `_run_api_retry_loop`), `agent/turn_facade.py`
  (`TurnFacadeMixin`), `agent/turn_api_request.py`,
  `agent/turn_request_assembly.py`, `agent/turn_response_intake.py`,
  `agent/turn_response_check.py`, `agent/turn_iteration_prep.py`,
  `agent/turn_tool_round.py` (`run_tool_round`, `ToolRoundVerdict`),
  `agent/turn_finalizer.py` (`finalize_turn`), `run_agent.py` (`AIAgent`).
- **PURPOSE:** One turn = admission → preflight → request assembly → API call →
  response check → tool round → stop gates → finalizer. Each phase is a small
  module with a verdict dataclass, so failures are localised and the loop can
  re-enter cleanly instead of one giant try/except.
- **KAI EQUIVALENT:** `core/src/chat/turns.ts` (turn lifecycle around brain),
  `core/src/chat/tasks.ts` (task state machine), `core/src/missions/executor.ts`.
- **Verdict: KEEP** (lifecycle shape exists; see M02 for the missing gates).
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only, no code copied.
- **TEST:** n/a (kept).

### M02 — Text-answer stop gates (verify-on-stop / pre_verify / terminal-tool guard) ⭐
- **SOURCE:** `agent/turn_stop_gates.py` (`apply_stop_gates`,
  `StopGateVerdict`), `agent/verification_stop.py`
  (`build_verify_on_stop_nudge`), `agent/turn_final_response.py`,
  `agent/kanban_stop.py`.
- **PURPOSE:** When the model stops with prose, three gates can append the
  answer as an *interim* row plus a synthetic user nudge and continue the turn
  (run tests after code edits; force worker to end with a terminal tool). The
  candidate answer is kept as a budget-exhaustion fallback. Solves "the model
  said done but never verified".
- **KAI EQUIVALENT:** NONE — `chat/tasks.ts` has a VERIFYING state but no
  mechanism that *forces* verification before COMPLETED.
- **Verdict: ADAPT** (top-10, #1). Native completion gate: a turn may not reach
  COMPLETED while file mutations lack a verification record or a delegated
  worker lacks a terminal status.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — reimplement, no prompt text reused.
- **TEST:** turn that edits code but runs no tests must NOT reach COMPLETED; on
  budget exhaustion the interim answer is returned flagged `unverified`.

### M03 — Iteration budget + deadline + estop sentinel ⭐
- **SOURCE:** `agent/iteration_budget.py` (`IterationBudget`),
  `agent/deadline.py` (`run_bounded_async`, `run_bounded_sync`,
  `kill_process_tree`), `agent/estop.py` (sentinel file pause),
  `agent/turn_retry_state.py` (`TurnRetryState`),
  `agent/turn_liveness.py`, `agent/turn_overflow.py`,
  `agent/turn_truncation.py`.
- **PURPOSE:** Every unbounded dimension gets a bound: iteration count, wall
  clock (with abandon-cleanup, not leak), and an operator estop file that
  pauses new work. Solves runaway cost/hangs.
- **KAI EQUIVALENT:** partial — `autonomy/supervisor.ts` (bounded re-attempts),
  scheduler/computer leases. No turn-level iteration budget, no estop.
- **Verdict: ADAPT** (top-10, #9).
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** `DeadlineExpired` aborts a hung worker and frees its lease; placing
  the estop sentinel pauses new turns with a clear status while in-flight turns
  settle.

### M04 — Classified-error recovery + fallback-chain swap/restore ⭐
- **SOURCE:** `agent/turn_recovery.py` (`recover_before_classification`,
  `recover_after_classification`, `route_classified_error`,
  `compute_error_backoff`, `interruptible_backoff_sleep`),
  `agent/turn_api_error.py`, `agent/route_binding.py`
  (`bind_route_entry`, `reinstall_primary_runtime`),
  `agent/error_classifier.py`, `agent/fallback_cooldown.py`.
- **PURPOSE:** Errors are classified (401/entitlement/rate-limit/transport/
  format/shape) and each class has a recovery: refresh creds once, strip images
  and retry, jittered backoff, swap to a fallback provider route — then restore
  the primary route next turn. Solves "one error class kills the session" and
  "fallback sticks forever".
- **KAI EQUIVALENT:** partial — `autonomy/supervisor.ts` retries *transient*
  failures only; `providers/registry.ts` live-probes. No error taxonomy, no
  per-class recovery, no fallback swap/restore.
- **Verdict: ADAPT** (top-10, #4): error taxonomy → per-class recovery table;
  worker-route fallback with mandatory primary restore.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** 401 refreshes credential once then fails closed (no loop);
  rate-limit backs off with jitter; fallback route serves exactly until the
  primary probes healthy again.

### M05 — Empty-response guard with cost-accounted budget ⭐
- **SOURCE:** `agent/empty_response_guard.py` (`record_empty_attempt`,
  `empty_retry_budget`, `streak_cost_usd`),
  `agent/turn_empty_response.py`.
- **PURPOSE:** Providers sometimes return zero output; naive retries burn money
  forever. Each empty attempt is recorded with estimated cost and the retry
  budget *shrinks as spend grows*. Solves silent money-burn loops.
- **KAI EQUIVALENT:** NONE (grep: no empty-response handling in `chat/` or `model/`).
- **Verdict: ADAPT** (top-10, #5).
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** provider returning empty 5× ends the turn BLOCKED with spend
  reported, never exceeding the empty-budget cap; a non-empty reply resets the streak.

### M06 — Repetition / runaway-stream watchdog
- **SOURCE:** `agent/repetition_guard.py` (`is_runaway_repetition`,
  `RunawayStreamWatch`, `is_repetition_dominated`),
  `agent/auxiliary_stream_watchdog.py`.
- **PURPOSE:** Detects degenerate token loops (periodic runs, line repetition,
  dominated windows) *while streaming* and interrupts with the partial text
  preserved. Solves context-flooding + cost blowout from looped output.
- **KAI EQUIVALENT:** NONE.
- **Verdict: ADAPT.**
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — algorithm reimplemented, no code copied.
- **TEST:** a forced `lorem`-loop stream aborts within N tokens, partial text
  preserved, turn continues with a repair nudge; normal prose never trips it
  (assert over a corpus of real turns).

### M07 — Durable turn lease + liveness watchdog ⭐
- **SOURCE:** `agent/turn_facade.py` (lease acquire/refresher/join/release,
  balanced start/finish marks), `agent/turn_facade_lease.py`
  (`admit_durable_turn_lease`), `agent/session_activity.py`.
- **PURPOSE:** Cross-process turn ownership: only one live turn per session;
  crash leaves a detectable orphaned lease instead of a stuck ACTIVE session.
  Solves double-turns and "session wedged ACTIVE after crash".
- **KAI EQUIVALENT:** partial — scheduler lease ledger (`approvals/parked.ts`,
  `maintenance/index.ts` reconciles dead-process leases), computer/browser
  leases. No *chat-turn* lease.
- **Verdict: ADAPT** (top-10, #7), scoped to chat turns; reuse KAI's lease-ledger pattern.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** kill Core mid-turn → restart reconciles the orphaned ACTIVE turn to
  a recoverable state; two concurrent turns on one session → exactly one admitted.

---

## 2. Context & prompt-cache engineering

### M08 — Copy-on-write prompt-cache plan ⭐
- **SOURCE:** `agent/prompt_caching.py` (`build_prompt_cache_plan`,
  `PromptCachePlan`, `effective_cache_ttl`, `auto_cache_ttl_for_source`,
  strip/re-decorate helpers), `agent/prompt_cache_boundary.py`
  (stable-prefix registry), `agent/prompt_cache_scope.py`
  (conversation-scope resolution, fork tags).
- **PURPOSE:** Places provider cache-breakpoint markers so the stable
  system/tools prefix is billed once and reused; per-source TTLs; forked
  sessions tagged so a subagent fork doesn't poison the parent's cache.
  Solves repeat-prompt cost and cache-thrash on multi-turn sessions.
- **KAI EQUIVALENT:** NONE (grep: no cache-control in `model/` or `prompts/`).
- **Verdict: ADAPT** (top-10, #2) in KAI's model plane (`model/`): stable-prefix
  planner emitting provider cache markers + scope tags.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** two identical consecutive turns place identical markers on the
  stable prefix (assert request payloads); forked worker scope carries a fork
  tag and never reuses the parent's cache entry; cache-hit rate observable in logs.

### M09 — Preflight + post-tool compression gates ⭐
- **SOURCE:** `agent/turn_preflight.py` (`run_preflight_compression`),
  `agent/turn_preflight_gate.py`, `agent/turn_context_compaction.py`,
  `agent/compression_facade.py` (commit-fence, timeout fallback prompt,
  cooldown ladder), `agent/context_compressor_prellm.py`,
  `agent/micro_compaction.py`, `agent/native_compaction.py`.
- **PURPOSE:** Check context budget *before* the model call and *after* tool
  results land — never discover overflow from a provider 400 error mid-turn.
  Compression runs on a snapshot under a progress timeout with a never-raise
  fallback prompt. Solves mid-turn context death.
- **KAI EQUIVALENT:** NONE — `prompts/compose.ts` bounds sections per-turn but
  nothing measures the assembled request against the model window pre-call.
- **Verdict: ADAPT** (top-10, #3): pre-call budget gate + post-tool-results
  compaction gate around `chat/brain.ts`.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** oversized history triggers summarisation *before* any API call
  (assert zero provider calls on the overflowing turn prefix); compressor
  timeout still yields a valid degraded prompt, never an exception.

### M10 — Ephemeral-scaffolding filtering in persistence
- **SOURCE:** `agent/session_persistence.py`
  (`_EPHEMERAL_SCAFFOLDING_FLAGS`, `SessionPersistenceMixin`, marker-based
  flush dedup), `agent/transcript_repair.py`
  (`sync_flushed_message_markers`), `agent/message_metadata.py`.
- **PURPOSE:** Internal rows (retry nudges, verification scaffolding, stop-guard
  synthetic users, thinking prefills) are flagged and *never persisted or
  replayed* — a resumed session replays only durable rows, keeping prefix-cache
  reuse intact. Solves "resume replays synthetic turns and breaks the cache".
- **KAI EQUIVALENT:** partial — `sessions/store.ts` persists turns/tool calls;
  no durable-vs-ephemeral row distinction.
- **Verdict: ADAPT:** mark KAI session rows durable/ephemeral at write time;
  resume/export read durable only.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** resume after an interrupted+recovered turn replays exactly the
  durable rows (assert row counts and no synthetic-nudge leakage into the model
  request).

### M11 — Bounded tool-error text (context hygiene)
- **SOURCE:** `tools/registry.py` (`_bound_error_text`: 2,048 chars to model /
  8,192 to logs, dispatch-boundary JSON trim),
  `agent/tool_result_classification.py`, `agent/tool_call_batches.py`.
- **PURPOSE:** A 1 MB traceback must never enter model context; logs keep more.
  Enforced at the dispatch boundary so retries can't stack unbounded errors.
  Solves error-text context flooding.
- **KAI EQUIVALENT:** partial — `tools/registry.ts` + `redact/` + action
  records; no evidence of size caps on error bodies entering context.
- **Verdict: ADAPT** (cheap, high-value): cap error/provenance text into the
  model request, full text to logs/action record.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** tool throwing a 1 MB error inserts ≤ cap bytes into the next model
  request while the action record retains the full body.

---

## 3. Streaming, status & reasoning delivery

### M12 — Single-writer stream ownership + interim dedup ⭐
- **SOURCE:** `agent/stream_delivery.py` (`StreamDeliveryMixin`, delta/
  reasoning hook fan-out, interim-text dedup), `agent/stream_single_writer.py`
  (`claim_stream_writer`), `agent/chat_completion_stream_monitor.py`,
  `agent/chat_completion_wait_notice.py`.
- **PURPOSE:** Exactly one writer owns the stream (fenced claims); duplicate
  interim text is delivered once; streamer callbacks are quiet (never raise
  into the stream path). Solves interleaved/garbled user-visible output when
  subagents, hooks, and the main turn all emit.
- **KAI EQUIVALENT:** partial — `lib/sse.ts` + `events/bus.ts` (per-subscriber
  try/catch). No single-writer claim, no interim dedup.
- **Verdict: ADAPT** (top-10, #10): writer-claim token on the SSE path + dedup
  of repeated interim deltas.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** concurrent subagent + main-turn deltas never interleave in one SSE
  channel; identical interim text delivered exactly once; a throwing subscriber
  doesn't break other subscribers.

### M13 — Reasoning-boundary normalisation
- **SOURCE:** `agent/reasoning_summaries.py`
  (`separate_glued_reasoning_blocks`), `agent/think_scrubber.py`,
  `agent/message_content.py` (`flatten_message_text`),
  `agent/reasoning_promotion.py`, `agent/lmstudio_reasoning.py`.
- **PURPOSE:** Providers emit reasoning in incompatible shapes (summary parts
  without delimiters, inline `<think>` spans); Hermes repairs boundaries so the
  reasoning pane and transcript stay coherent. Solves garbled reasoning display
  across providers.
- **KAI EQUIVALENT:** NONE at model plane (KAI normalises worker *events* via
  the bus, not provider reasoning shapes).
- **Verdict: REWRITE** — fold into KAI's model plane as provider-response
  normalisers owned per backend, not a shared scrubber module.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — idea only.
- **TEST:** each supported backend's raw reasoning chunks normalise to one
  canonical block sequence (fixture-driven per provider).

### M14 — Status-output discipline (retry-chatter buffering, quiet gating)
- **SOURCE:** `agent/status_output.py` (`StatusOutputMixin`, buffered retry
  chatter shown only on exhaustion, quiet-mode gating, deduped overflow
  warnings), `agent/display.py`, `agent/compaction_display.py`.
- **PURPOSE:** Users see one summary when all retries fail, not per-attempt
  spam; verbose/status/diagnostic channels are separated. Solves operator noise
  fatigue.
- **KAI EQUIVALENT:** partial — notifications + bus exist; no chatter-buffering
  convention.
- **Verdict: ADAPT** (small): buffer retry/fallback chatter, emit single
  summary on exhaustion; quiet mode suppresses non-essential status.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** a turn that succeeds on retry #2 emits zero retry chatter; one that
  exhausts emits exactly one summary event.

---

## 4. Tools, toolsets & skills

### M15 — Central tool registry (schema + handler + toolsets + availability)
- **SOURCE:** `tools/registry.py` (`registry.register()`, AST-harvested
  registration, `tool_error`), `model_tools.py` (registry as single query
  surface).
- **PURPOSE:** One declaration site per tool; model-facing schemas are derived,
  never hand-duplicated. Solves schema/dispatch drift.
- **KAI EQUIVALENT:** `core/src/tools/registry.ts` — and KAI goes further
  (validate → policy → approval → execute, failures as values).
- **Verdict: KEEP.**
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — n/a.
- **TEST:** n/a (kept).

### M16 — Untrusted-surface toolset restriction
- **SOURCE:** `toolsets.py` (`_HERMES_WEBHOOK_SAFE_TOOLS`, platform bundles,
  `_core_without`), `toolset_distributions.py`,
  `tools/kanban_toolset_context.py` (opt-in gating).
- **PURPOSE:** Webhook/untrusted inputs get a minimal tool subset regardless of
  the session's full toolsets — defence in depth beyond per-tool policy.
  Solves confused-deputy via untrusted entry points.
- **KAI EQUIVALENT:** partial — `capabilities/matrix.ts` + policy gates; no
  entry-point-derived toolset restriction.
- **Verdict: ADAPT:** bind a minimal toolset to untrusted entry routes.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** a webhook-sourced turn cannot invoke terminal/process tools even
  with a permissive policy fixture; the denial is logged as entry-point
  restriction, not policy.

### M17 — Skill disclosure hardening (dedup, injection scan, cached discovery)
- **SOURCE:** `tools/skills_tool.py` (`skills_list` metadata-only,
  `skill_view` full, 30 s discovery cache), `tools/skills_tool_dedup.py`,
  `tools/skills_guard.py` (`scan_skill`, `_INJECTION_PATTERNS`),
  `tools/skill_provenance.py`, `agent/skill_preprocessing.py`
  (`${HERMES_*}` tokens, capped inline-shell expansion),
  `agent/skill_commands.py`, `agent/skill_bundles.py`.
- **PURPOSE:** Progressive disclosure (list ≠ load), re-view dedup, install-
  time injection scanning, bounded discovery cost. Solves prompt-injection via
  skill bodies and repeated skill-load cost.
- **KAI EQUIVALENT:** mostly — `skills/registry.ts` (list metadata-only,
  `load()` sole body reader), `skills/validate.ts`, `learning/pipeline.ts`
  (stage-never-install). Missing: view-dedup + TTL-cached discovery + template
  token discipline.
- **Verdict: ADAPT** (delta only): per-session skill-view dedup, TTL discovery
  cache with explicit invalidation, injection scan before stage.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only; KAI's own
  skill format/wording untouched.
- **TEST:** viewing the same skill twice costs one body load; a SKILL.md with
  an instruction-override payload is refused at scan with a logged reason;
  in-place edits become visible within the TTL bound.

### M18 — Agent-managed skill lifecycle with guards
- **SOURCE:** `tools/skill_manager_tool.py`, `tools/skill_manager_guards.py`
  (pinned/delete/redirection guards), `tools/skill_manager_batch.py`,
  `tools/skill_linter.py`, `tools/skill_usage.py`, `tools/skill_ledger.py`.
- **PURPOSE:** The agent can author/edit procedural memory, but deletes,
  redirects, and pinned skills are guarded and every mutation is linted +
  ledgered. Solves self-corruption of long-term memory.
- **KAI EQUIVALENT:** `learning/pipeline.ts` + `skills/staging.ts` (pure
  propose → classify → validate → stage; human approval installs).
- **Verdict: KEEP** (KAI's stage-gate is the safer equivalent).
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — n/a.
- **TEST:** n/a (kept).

### M19 — Background process registry (terminal background=true)
- **SOURCE:** `tools/process_registry.py` (rolling output buffer, poll/log/
  wait/kill, JSON crash-recovery checkpoint, session scoping),
  `tools/async_delegation.py`, `tools/delegation_live_log.py`.
- **PURPOSE:** Long-running shell work is supervised: bounded output memory,
  crash-recoverable, killable, attributed to a session. Solves orphaned/
  forgotten background jobs.
- **KAI EQUIVALENT:** partial — scheduler (`scheduler/`) + recovery ledger;
  check KAI scheduler for output-buffer + kill semantics before building.
- **Verdict: ADAPT** only if KAI's scheduler lacks it (verify first): bounded
  output buffers + crash-recovery checkpoint + session-scoped kill.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** Core restart recovers the background-job record from checkpoint;
  output never exceeds the buffer cap; session teardown kills owned jobs.

---

## 5. Delegation & multi-agent lifecycle

### M20 — Delegation roles, toolset stripping, spawn-depth caps
- **SOURCE:** `tools/delegate_tool.py` (leaf/orchestrator roles, single +
  batch), `tools/delegate_tool_toolsets.py`
  (`DELEGATE_BLOCKED_TOOLS`, `_strip_blocked_tools`),
  `tools/delegate_tool_config.py` (max concurrent children, max spawn depth,
  worktree isolation, credential lease), `tools/delegate_tool_dispatch.py`,
  `tools/delegate_tool_child_run.py`.
- **PURPOSE:** Children get a *reduced* tool surface, bounded fan-out, bounded
  recursion depth, isolated credentials. Solves privilege-escalation-by-
  delegation and fork bombs.
- **KAI EQUIVALENT:** mostly — `workforce/manager.ts` (grants at risk levels,
  errors-as-values), `workforce/lifecycle.ts` (illegal moves refused).
  Verify depth caps + blocked-tool stripping exist; if not:
- **Verdict: ADAPT** (delta): max spawn depth + child toolset deny-list on top
  of KAI's grant model.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** depth-limit spawn refused as a value (parent unaffected); child
  invoking a stripped tool gets denial, never execution.

### M21 — Subagent lifecycle registry (steer / interrupt / reconnect)
- **SOURCE:** `agent/subagent_lifecycle.py` (`SubagentLifecycleService`,
  states, handles, cancel/reconnect), `tools/delegate_tool_registry.py`
  (active-subagent table, `steer_subagent`, `interrupt_subagent`),
  `tools/delegate_tool_progress.py` (`DelegateEvent`, progress callbacks),
  `agent/delegation_context.py` (fenced env, dispatcher-owned contexts).
- **PURPOSE:** Live children are addressable: progress streams to the parent,
  a human can steer or interrupt a specific child, and parent death doesn't
  orphan them silently. Solves fire-and-forget delegation.
- **KAI EQUIVALENT:** mostly — `workforce/manager.ts` + `lifecycle.ts` +
  `agents/registry.ts` + bus fan-in. Delta to verify: per-child
  steer/interrupt handles and progress-event taxonomy.
- **Verdict: ADAPT** (delta, top-10-adjacent): typed child progress events +
  steer/interrupt handles if absent.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** steering a running child delivers the steer message to that child
  only; interrupting it settles the parent turn with attribution intact.

### M22 — Worker terminal-tool contract (Kanban lifecycle pattern) ⭐
- **SOURCE:** `tools/kanban_tools.py` (in-process board tools, schema'd,
  gated), `agent/kanban_stop.py` (stop nudge), `agent/kanban_turn_recovery.py`,
  `agent/delegation_context.py` (`HERMES_KANBAN_TASK` fencing).
- **PURPOSE:** A worker may not end with prose — it must close with a terminal
  board op (complete/block/review); otherwise the loop nudges it once and then
  records a forced verdict. Solves "worker says done, board says otherwise".
  (The *board product* is out of scope — the *contract pattern* is the mechanism.)
- **KAI EQUIVALENT:** NONE as an enforced contract (`workforce/lifecycle.ts`
  has terminal states but nothing forces a worker to *declare* one with evidence).
- **Verdict: ADAPT** (top-10, #8): delegated work must settle with a terminal
  result record (completed/blocked + evidence refs); prose-only endings get one
  nudge, then a forced terminal verdict is recorded.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — contract pattern only;
  no Kanban branding/schema copied. (Kanban board itself: REJECT, M31.)
- **Verdict: ADAPT.**
- **TEST:** worker ending with prose is nudged once; still-no-verdict →
  terminal `unconfirmed` verdict recorded with the prose attached as evidence.

---

## 6. Background review & self-improvement

### M23 — Cache-parity background review fork ⭐
- **SOURCE:** `agent/background_review.py` (`prepare_background_review_run`,
  `spawn_background_review_thread`, `_run_review_fork`,
  `build_cache_parity_fork`, auto-deny tool wrapper, usage attribution),
  `agent/review_engine.py` (`start_review`), `agent/review_idle_queue.py`
  (`ReviewIdleQueue`, live-turn counting).
- **PURPOSE:** After a turn, a fenced fork (same session_id for cache parity,
  detached compression, auto-deny tools) reviews what happened and proposes
  memory/skill writes — off the hot path, cancellable when a live turn starts,
  usage attributed to the parent. Solves "learning blocks the user" and
  "review fights the live turn for cache".
- **KAI EQUIVALENT:** partial — `learning/pipeline.ts` (pure propose →
  classify → stage) runs synchronously per turn; no fork, no idle gating.
- **Verdict: ADAPT** (top-10, #6): post-turn async review producing lesson
  *candidates* into the existing pipeline; fenced (no world writes), idle-
  gated, cancellable by new user input.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** review runs off the hot path (turn latency unchanged); kills on new
  user input; writes nothing unless a proposal passes validation + human
  approval; review token usage attributed to the originating session.

### M24 — Idle-gated background work queue
- **SOURCE:** `agent/review_idle_queue.py` (`defer_mode`, `defer_max_age_s`,
  `review_targets_managed_local`), `agent/periodic_scheduler.py`,
  `agent/session_activity.py`.
- **PURPOSE:** Expensive background work (reviews, consolidation) waits for
  managed-server idle with a max-age ceiling, and live-turn counters can't leak.
  Solves background work degrading foreground latency.
- **KAI EQUIVALENT:** scheduler exists; verify idle-gating + max-age exists.
- **Verdict: ADAPT** (if absent): idle gate with max-age ceiling + balanced
  counters.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** background job submitted under load stays deferred; runs when idle
  or at max-age; start/finish counters balance under interrupt storms.

### M25 — Learning graph + mutations + curator consolidation
- **SOURCE:** `agent/learning_graph.py`, `agent/learning_mutations.py`,
  `agent/curator.py`, `agent/learn_prompt.py`, `agent/memory_manager.py`.
- **PURPOSE:** Accumulated lessons are consolidated (dedupe/contradiction
  resolution) rather than appended forever. Solves memory bloat and
  contradictory procedural memory.
- **KAI EQUIVALENT:** `learning/*` (classify + pipeline) + `memory/*`; verify
  consolidation exists.
- **Verdict: KEEP** if KAI memory consolidation covers it, else ADAPT as a
  periodic consolidation job (human-approved writes only).
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** contradictory lesson candidates consolidate to one entry with
  provenance; memory size stays bounded over N synthetic turns.

---

## 7. Session, provider & platform plumbing (mostly KEEP or REJECT)

### M26 — System-prompt assembly (stateless sections)
- **SOURCE:** `agent/prompt_builder.py`, `agent/system_prompt.py`,
  `agent/plan_prompt.py` (`agent/coding_context.py`, `agent/context_pin.py`,
  `agent/context_references.py`).
- **PURPOSE:** Identity, platform hints, skills index, and context files
  assembled from stateless functions with short read deadlines (5 s default —
  network filesystems must not stall turn start).
- **KAI EQUIVALENT:** `prompts/compose.ts` (+ `agent/soul.ts`) — section-ordered,
  fenced, budgeted; structurally stronger (untrusted bodies can't outrank safety).
- **Verdict: KEEP.** Only portable micro-idea: deadline-bounded context-file
  reads (likely already true in KAI; one-line check).
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — n/a. (No Hermes wording reused, per constraint.)
- **TEST:** n/a (kept).

### M27 — Provider registry + projection + route binding
- **SOURCE:** `agent/provider_registry.py` (`ProviderRegistry`),
  `agent/provider_projection.py` (`splice_provider_projection`),
  `agent/route_binding.py`, `agent/backend_identity.py`,
  `agent/credential_pool*.py`, `agent/auxiliary_client*.py`.
- **PURPOSE:** Many-vendor model access with credential pools, rotation,
  per-turn route swaps, and folding agent-provider activity back into turn
  state without double-executing tool calls.
- **KAI EQUIVALENT:** `providers/registry.ts` (live probes, kai-model brain +
  hermes/opencode *worker* transports), `agents/*` adapters.
- **Verdict: KEEP** the registry concept; **REJECT** the vendor zoo, credential
  pools, and rotation (KAI holds no vendor inference keys; workers bring their own).
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — n/a.
- **TEST:** n/a.

### M28 — Interrupt / steer / redirect control surface
- **SOURCE:** `agent/interrupt_control.py`, `agent/interrupt_scope.py`,
  `agent/interrupt_compat.py`, `agent/delegation_context.py`.
- **PURPOSE:** Soft/hard interrupts, tool-thread propagation, pending
  steer/redirect queues with human-vs-system attribution. Solves "stop means
  stop, and we know who asked".
- **KAI EQUIVALENT:** approvals park/release, workforce lifecycle refuses,
  bus delivery guards. Verify a unified turn-interrupt with attribution exists;
  if fragmented:
- **Verdict: ADAPT** (small): one interrupt surface with issuer attribution
  (human vs watchdog vs lifecycle) recorded on the turn exit reason.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — mechanism only.
- **TEST:** mid-tool user stop settles the turn `cancelled/by-user` within the
  bound; watchdog stop settles `cancelled/by-<producer>`; tool threads observe
  it (no orphaned execution).

---

## 8. Explicit REWRITE / REJECT list

### M29 — God-object agent decomposed via MRO mixins → REWRITE as phase pipeline
- **SOURCE:** `run_agent.py` (`AIAgent`) + ~15 `*Mixin` modules
  (`TurnFacadeMixin`, `StreamDeliveryMixin`, `StatusOutputMixin`,
  `SessionPersistenceMixin`, …) resolved through MRO.
- **PURPOSE:** Lets a huge agent stay splittable across files without
  restructuring — but method resolution is implicit and ordering fragile.
- **KAI EQUIVALENT:** KAI is already modular TS (`chat/`, `workforce/`, …).
- **Verdict: REWRITE** (guidance, not code): keep KAI's explicit composition;
  when adding M02/M09 gates, implement them as an explicit ordered phase list
  (data), never as mixins/base-class magic. No provenance issue.
- **TEST:** a test asserts the turn phase order declaratively (phases listed in
  one place; adding a gate = adding a list entry).

### M30 — 5,311-line context compressor → REWRITE natively, smaller
- **SOURCE:** `agent/context_compressor.py` (5,311 lines),
  `agent/conversation_compression*.py`, `agent/compression_marker.py`,
  `trajectory_compressor.py` (batch trajectory post-processor).
- **PURPOSE:** Head/tail protection, middle summarisation without splitting
  tool-call pairs, checkpoint carriers, token-pressure accounting.
- **Verdict: REWRITE:** KAI needs a small native summariser (protect head +
  last N turns, never split tool-call pairs, checkpoint carrier) behind the
  M09 gates — not a port. Trajectory batch tool: rebuild only if KAI starts
  eval-driven tuning.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — strategy reimplemented from scratch.
- **TEST:** compress a 100-turn synthetic history: head + tail intact, every
  tool-call pair intact, token count under target, summary turn human-readable.

### M31 — Kanban board product, gateway/cron/Telegram surfaces, pm/ → REJECT
- **SOURCE:** `tools/kanban_*.py` (board backend), `gateway/`, `cron/`,
  `tui_gateway/`, `pm/` (package manager), `hermes_cli/`, `apps/`, `web/`.
- **PURPOSE:** Hermes products and distribution — not orchestration mechanisms.
- **Verdict: REJECT** for KAI (KAI has its own app/scheduler/sessions). Only
  the *contract pattern* is salvaged (M22).
- **LICENSE/PROVENANCE:** n/a.

### M32 — Vendor adapters, MoA, billing/entitlement, relay/portal → REJECT
- **SOURCE:** `agent/*_adapter.py` (anthropic/bedrock/vertex/gemini/codex/
  copilot/moonshot…), `agent/moa_*.py`, `agent/nous_*.py`,
  `agent/billing_*.py`, `agent/portal_tags.py`, `agent/relay_*.py`,
  `agent/aux_accounting.py`, `agent/codex_runtime*.py`.
- **PURPOSE:** Hermes-the-SaaS: multi-vendor inference, mixture-of-agents,
  metering, portal tagging.
- **Verdict: REJECT** — KAI's model is kai-model brain + worker delegation
  (`providers/registry.ts`, `agents/`); a vendor zoo and SaaS metering are
  explicitly out of scope.
- **LICENSE/PROVENANCE:** n/a.

### M33 — Trajectory export + transcript repair → REWRITE (eval tooling, later)
- **SOURCE:** `agent/trajectory.py` (save/scratchpad helpers, lock-safe
  append incl. Windows `msvcrt`), `agent/transcript_repair.py`,
  `agent/title_generator.py`, `agent/session_persistence.py` (explicit export).
- **PURPOSE:** Deterministic, exportable turn records for evals/debugging;
  repair of flushed markers after crashes.
- **KAI EQUIVALENT:** partial — sessions store + action records + digests.
- **Verdict: REWRITE** (deferred): when KAI needs eval replay, build a native
  export (not the Hermes format) reusing M10's durable-row rule.
- **LICENSE/PROVENANCE:** MIT © 2025 Nous Research — format of our own.
- **TEST (when built):** export → replay produces identical tool-call sequence
  on a fixture session.

---

## Appendix A — License & provenance

- **License found:** `hermes-agent/LICENSE` — **MIT License, Copyright (c) 2025
  Nous Research.** Full text in the cloned tree at
  `hermes-agent/LICENSE` (permission to use/copy/modify/merge/publish/
  distribute/sublicense/sell with copyright + permission notice retained;
  provided "AS IS" without warranty).
- **What this permits:** studying and reimplementing the *mechanisms* above in
  KAI's TypeScript codebase. No Hermes code is copied by this audit.
- **Compliance posture (stricter than MIT, per task constraint):**
  1. No Hermes identity, persona, prompt text, or branding is reproduced
     anywhere in this audit or in any future adaptation.
  2. ADAPT/REWRITE items are clean-room reimplementations of control-flow
     ideas (gates, budgets, leases, queues), not code ports.
  3. If any Hermes-derived code snippet is ever copied verbatim in future
     work, the MIT copyright notice + permission notice must travel with it
     (license condition) — current plan avoids this entirely.
  4. Suggested: when the first ADAPT lands, add one line to KAI's NOTICE/
     attribution docs: "Orchestration mechanisms informed by study of
     NousResearch/hermes-agent (MIT © 2025 Nous Research; no code reused)."

## Appendix B — KAI files checked (equivalence basis)

`chat/turns.ts`, `chat/tasks.ts`, `chat/brain.ts`, `chat/router.ts`,
`workforce/manager.ts`, `workforce/lifecycle.ts`, `workforce/employee.ts`,
`workforce/subagent.ts`, `workforce/discovery.ts`, `sessions/service.ts`,
`sessions/store.ts`, `skills/registry.ts`, `skills/library.ts`,
`skills/staging.ts`, `skills/validate.ts`, `tools/registry.ts`,
`tools/types.ts`, `tools/provenance.ts`, `prompts/compose.ts`,
`providers/registry.ts`, `agents/registry.ts`, `agents/hermes.ts`,
`autonomy/supervisor.ts`, `learning/pipeline.ts`, `learning/classify.ts`,
`missions/mission.ts`, `missions/executor.ts`, `events/bus.ts`,
`lib/sse.ts`, `model/config.ts`, `model/openai-compatible.ts`,
`approvals/service.ts`, `approvals/parked.ts`, `checkpoints/checkpoint.ts`,
`recovery/ledger.ts`, `redact/index.ts`, plus repo-wide grep for
`cache_control|prompt.?cach|empty.?response|repetition|runaway|estop|
stop.?gate|verify.?on|preflight` (no KAI hits — confirming the ADAPT gaps).

## Appendix C — Suggested adaptation order (by reliability leverage)

1. M02 stop gates (ends "said done, never verified") + M22 terminal contract.
2. M09 compression gates (ends mid-turn context death) + M30 small summariser.
3. M08 cache plan (cost; needs model-plane support).
4. M04 error taxonomy + fallback restore (session survivability).
5. M07 turn lease (crash safety) + M03 budgets/estop (runaway safety).
6. M05/M06 stream guards (cheap loop insurance).
7. M12 single-writer stream + M14 chatter discipline (output coherence).
8. M10 durable/ephemeral rows + M11 error caps (context hygiene).
9. M23 background review fork + M24 idle queue (learning without latency cost).
10. M16/M17/M20/M21/M28 deltas (defence in depth on tools, skills, delegation).
