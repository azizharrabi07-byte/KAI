# KAI Worker Bench — model, metrics, formula, routing

## Model

Every worker (persona id) owns a `WorkerProfile`: role, config fingerprint,
per-domain stats, overall value, confidence, sample count. Profiles persist
in `worker_profiles`. A config change (model, provider, instructions,
skills, tools, objective) resets the profile — measurements from
incompatible configurations are never mixed.

## Metrics (all 0..1, all measured)

quality, verification, completion, rework, tokenEfficiency, latency, safety
per domain (coding, debugging, research, writing, architecture, review,
testing, document, mcp, system, planning, general); overallValue,
overallConfidence (low <5, medium <20, high ≥20 samples), totalSamples,
trend (up/flat/down vs prior mean ±0.05).

## Formula (`computeOverallValue`, frozen)

```
base = 0.35*quality + 0.25*verification + 0.2*completion + 0.2*(reviewScore ?? 0.5)
mult = clamp(0.5 + difficulty, 0.5, 1.5)
value = base * mult / (1 + cost + latency + rework + failure + safety)
```

Penalties (all capped): cost min(0.3, usd*0.1), unknown cost skipped (0);
latency min(0.2, ms/300000*0.1); rework min(0.3, count*0.5); failure 0.4 when
incomplete; safety min(0.5, 1-safety). Difficulty 0..1 from file/tool/
dependency/subtask counts, risk weight, review rounds.

Proven: an 80k-token success outscores a 20k-token failure
(`orch-bench.test.ts`). Value per cost, never lowest token count.

## Routing

`dispatch.decide`: capability/skills/tools match → rank by value (domain),
latency, risk → DO_IT_SELF / DELEGATE_ONE / PARALLELIZE / DELEGATE_AND_REVIEW
/ ASK_USER / CHANGE_WORKER (avoid + ≥2 failures), each with a rationale
string built from structured stats (never chain-of-thought). Live proof:
difficult → DELEGATE_AND_REVIEW, simple → DELEGATE_ONE (`orch-e2e.json`
S3); bench contrast bad=0.10 vs good=0.45 on real outcomes.

## Confidence, samples, task value

Incremental means (no single-task overweighting); cold-start baselines per
role (coding/research/reviewer); task value recorded per completion for the
delegation-worth-it ledger. Benchmarks update from verified outcomes only —
workers can never write their own scores (§64); review attribution goes to
the reviewer.

## Security

Scores derive from terminal states + review verdicts written by KAI's loop,
never from worker self-reports. Config fingerprints prevent cross-version
contamination.
