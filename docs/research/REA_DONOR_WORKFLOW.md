# REA + Donor Research Workflow

How KAI investigates other agent projects and adopts from them **without** becoming
a Frankenstein. The rule that governs everything here:

> **When an upstream project is open-source and its complete source is available,
> read the source repository first. REA is for behaviour the source does not
> establish.**

REA's own skill says the same thing: skip it for ordinary architecture analysis of
a complete source repository.

## When to use which

| Question | Instrument |
|---|---|
| What does this project's code actually do? | **Direct source reading** — `path:line`, tests, commit history |
| What are its prompts, contracts, skills, scheduler, adapters, licences? | **Direct source reading** |
| What does a *compiled* Electron/JS app actually do? | **REA** (`analyze-javascript-application`, `capture-electron-scenario`) |
| What is inside a shipped bundle, a native binary, an APK? | **REA** (with the matching provider installed) |
| What is the observed runtime/wire behaviour? | **REA** capture tools |
| Is the licence reusable? | **Direct read of the licence file** — never the README's claim |

Never run REA to look thorough. Never repeat a readiness check that already
answered. Never install an analysis engine (Ghidra, IDA, Hopper, JADX, Binwalk)
unless a specific approved investigation needs it.

## REA state on this machine (verified, 2026-10-11)

| Fact | Value |
|---|---|
| Package | `rea-agents` **6.4.0** (npm `latest`), **MIT** |
| Install | global, pinned: `npm i -g rea-agents@6.4.0` → `%APPDATA%\npm\rea.cmd` |
| CLI verified | `rea --version` → `6.4.0`; `rea --help` lists the full command surface |
| OMP registration | **applied**, scoped: one `rea` entry added to `~/.omp/agent/mcp.json` |
| Backup | `~/.omp/agent/mcp.json.pre-rea-backup` |
| Skill | installed to `~/.agents/skills/reverse-engineer-anything` |
| Analysis providers | **ghidra and IDA are NOT configured and NOT installed** — by choice |
| Therefore usable | JavaScript/Electron reconstruction, web capture, evidence import/export, capability listing |
| Therefore NOT usable | native binary, managed, APK, firmware work (needs a provider we did not install) |

The registration points at the **stable global install path**, not the volatile
`npx` cache (the dry run first proposed the cache path, which a cache eviction
would break).

**REA is a development-time instrument, not a runtime dependency.** KAI must not
need REA to plan, dispatch, verify or settle a task. A REA result is untrusted
input: it can inform a developer's decision, and it can never grant a capability,
approve code, or bypass Guard.

## The workflow

1. **Name the KAI gap first.** A donor is only interesting if it addresses a
   *verified* defect. "Popular repository" is not a gap.
2. **Read the source.** Identify the exact mechanism (function, data structure,
   protocol), its call chain and its tests. Cite `path:line`.
3. **Only then, if behaviour is still unclear**, use REA on a compiled or opaque
   target, and record what REA could and could not establish.
4. **Check the licence** in the actual licence file, plus any asset/component
   licence that differs. Quote the identifier.
5. **Write the ledger entry** (see `DONOR_LEDGER.md`).
6. **Take the Shark review** (six lenses, independent first, merged after).
7. **Record the decision** (see `ADOPTION_DECISIONS.md`) — one of five outcomes.
8. **Prove the improvement** with a reproducible KAI test.

## The five reuse decisions

| Decision | Use when |
|---|---|
| **Adopt as an external worker** | A real coding runtime behind KAI's existing adapter contract (Hermes, OpenCode, Codex) |
| **Port a narrow mechanism** | A small, independently testable mechanism, and the licence permits it |
| **Reimplement natively** | The mechanism is valuable but the language/architecture/licence makes copying a poor fit |
| **Study only** | The ideas are useful but the implementation cannot be safely or legally adopted |
| **Reject** | Little value, an unsafe boundary, duplication of reliable KAI behaviour, or unverifiable |

## Evidence discipline

- Separate **direct observation** from **inference**; write `UNKNOWN` when the
  source does not answer.
- Static analysis is **never** proof of runtime execution.
- Decompiled output is **never** exact original source.
- A model's interpretation of evidence is **never** an independently confirmed fact
  until the appropriate verification exists.
- For large evidence, use the documented summary/page/focused-view mechanisms
  rather than feeding an entire analysis to a model.

## Scope and safety

- Only analyse artifacts within the authorized scope. Do not bypass authentication,
  do not execute unknown packages from donor repositories, and do not modify a
  target to get a more convenient result.
- No protected asset (branding, artwork, icons, sounds) is ever copied, even from an
  MIT-licensed project whose *assets* are separately reserved.
- Never copy credentials, private configuration or user data into KAI.
