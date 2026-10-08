# KAI — PHASE A FREEZE (Stage 1 checkpoint)

Recorded before the architecture reset into Phase B (Hermes audit) and Phase C (KAI SOUL).
Nothing here is a claim about intent — every line is a fact read from the repository or the
running product at the moment of freezing.

## 1. The frozen revision

```
HEAD            e43b1d3  feat(visual): the validated Core->renderer visual-engine slice, proven live
ancestry        e43b1d3 <- ef044e2 <- 5839f96 <- 10b8853 <- 1eaa385 <- 3374839 <- fa8370a
```

| commit | what it closed |
|---|---|
| `fa8370a` | per-subagent memory isolation pinned (A–F + 14 negatives); shared-entry recall tokenizer fixed |
| `3374839` | KAI never speaks in a worker's voice when its Core is down |
| `1eaa385` | the OpenGhost audit, its reuse manifest, and the KAI capability audit |
| `10b8853` | a failed turn keeps its own message, so the offline card is never empty |
| `5839f96` | the RECOVERING event survives the whole path to the renderer (wiring, not a fake pose) |
| `ef044e2` | the RECOVERING nine-point chain proven live to the renderer receipt |
| `e43b1d3` | the validated Core->renderer visual-engine slice, proven live |

## 2. Test counts (recounted at freeze, not remembered)

```
core   755 tests / 742 pass / 0 fail / 13 skipped    tsc --noEmit exit 0
app    133 tests / 133 pass / 0 fail                 tsc --noEmit exit 0
```

The 13 skips are the pre-existing live-auth suites that skip when their context is absent.
They are **not** counted as green.

## 3. Build identity

```
buildId              f4d2232607117fa9
gitCommit            ef044e26
pid                  11900   ==  netstat owner of 127.0.0.1:8788
identityMatchesDisk  true
freshness            fresh
```

Built through `npx tauri build` with the prebuild enabled. No artifact-identity refusal, and
nothing was bypassed.

Note recorded honestly: `artifactMatchesSource` is `null` with the reason stated by the product
itself — a shipped bundle carries compiled output only, so source equality cannot be recomputed
beside the artifact. The precise anchor is the `buildId`.

## 4. Evidence on disk

```
docs/evidence/recovering-final.json          30,781 B
docs/evidence/character-runtime-final.json   16,093 B
docs/evidence/island-final.json              15,736 B
docs/evidence/subagent-memory-final.json     15,470 B
docs/evidence/core-unreachable-final.json    10,824 B
docs/evidence/visual-engine-slice.json       10,004 B
docs/evidence/kai-app-build-verify.log        2,150 B
docs/evidence/visual-rendered.png           21,288 B
docs/evidence/visual-rejection.png          21,288 B   (md5 identical to visual-rendered.png —
                                                         the refused intent drew nothing)
```

## 5. What is END-TO-END PROVEN at the freeze

```
CORE_UNREACHABLE visible UI      END-TO-END PROVEN
RECOVERING event pipeline        END-TO-END PROVEN
Artifact identity                END-TO-END PROVEN
Island lifecycle                 END-TO-END PROVEN
Memory isolation                 END-TO-END PROVEN
Memory sharing                   END-TO-END PROVEN
Character runtime states         END-TO-END PROVEN   (12/12, read from the renderer's own handle)
Visual engine slice              END-TO-END PROVEN   (validated intent -> real SVG in the UI;
                                                     validator refusal -> byte-identical frame)
```

```
Hermes <-> OpenCode concurrency  BLOCKED_EXTERNAL    (OpenCode provider unavailable / 503;
                                                     not faked, no substitute provider)
```

## 6. INVARIANTS THAT MUST SURVIVE THE RESET

The Hermes transplant is meant to fill capability gaps, not erase KAI's successful architecture.
These are explicitly preserved and must not be replaced by a Hermes equivalent:

- **KAI memory authority** — scoped memory, subagent isolation, governed sharing, persistence,
  adversarial tests.
- **KAI approval authority** — the single approval path; the island is UI over it, never a
  second policy engine.
- **KAI policy** — one policy engine, one security boundary.
- **KAI browser/CDP** — the real browser architecture.
- **KAI CUA** — real transport, never simulated.
- **KAI workforce** — the workforce and worker abstraction; subagents are KAI-managed.
- **KAI artifact identity** — the build/source identity invariant. On a refusal: **rebuild,
  never bypass.**

These already exist and are proven. Replacing them to make the code look similar to Hermes
would destroy working architecture.

## 7. Single-writer discipline

All commits in this repository use the repo-local identity `KAI <kai@local>`, so git cannot
distinguish sessions. Concurrent agents editing the same files has already caused a real
regression (a duplicated `MEMORY_SCOPES` list drifting from the canonical one and breaking the
whole-repo build). **Split work by file ownership**, and treat "green tests" as evidence only
when they were run against the artifact under test.

## 8. Environment facts worth carrying forward

- `rustc/cargo 1.99.0` — needs `export PATH=$PATH:/c/Users/DELL/.cargo/bin`.
- Product binary: `app/target/release/kai.exe` (**not** `app/src-tauri/target/...`).
- A bare `cargo build --release -p kai` yields a **DEV-MODE** binary that loads `localhost:1420`
  and exits 1. Publishing must go through `cd app && npx tauri build` with the prebuild enabled.
- `npm_config_ignore_scripts=true` silently leaves a **stale** Core bundle.
- Kill `kai.exe` with `node -e "try{process.kill(PID)}catch(e){}"` — `taskkill //F //PID`
  fails **silently** from MSYS bash.
- The Hermes background runner injects `stdin is not a tty` and **swallows child stdout** —
  verification scripts must run in the foreground and write evidence to a file that is read back.
- Island URL is exactly `http://tauri.localhost/`; the island auto-collapses ~10 s.

## 9. The open architectural direction (recorded, not started here)

Phase A freezes. Phase B audits Hermes as a source of mechanisms. Phase C builds KAI's own
identity foundation so KAI can boot, identify itself and operate **without loading Hermes
identity files**. The hard test for Phase E is that KAI remains KAI with Hermes entirely
unavailable. No large UI work proceeds until that is proven.

Licence boundary carried forward unchanged: OpenGhost's engine source is MIT, its name, ghost
identity, artwork, animations and visual design are excluded. KAI keeps its own name, icon,
character, artwork, palette and sounds.
