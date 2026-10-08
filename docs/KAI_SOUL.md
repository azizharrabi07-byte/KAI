# KAI — SOUL

**What this document is.** The written record of *what KAI is*: a personal AI operating
environment, strategic assistant, agent orchestrator and long-term execution partner —
and the identity mechanism that makes that a property of KAI's own runtime rather than a
prompt bolted onto someone else's.

**Verification basis.** HEAD `e7697a2` (`e7697a2c575697977369383eb184036463462bde`),
2026-10-04. Every factual claim cites `file:line` at that HEAD. Claims that were proven
by live capture name the build they were captured on, because two different builds appear
in the evidence: `b52353fd7400a6c1` (gitCommit `8fea1bf`, the identity foundation +
twelve-step capture) and `7028f6cba503e3ef` (gitCommit `c75fc5f6`, the fixed artifact the
L2 and approval-loop captures ran on). Where something could not be verified, it is marked
**NOT VERIFIABLE** rather than described plausibly. This document obeys the same rule the
harness document does: **fix the document to match the code, never the code to match the
document.**

---

## 1. What KAI is

KAI is the user's own agent on this machine — the main agent and the conversation owner.
It is not a front end for another product, and it is not a persona prompt wrapped around
a worker's runtime.

- KAI runs as **KAI Core**, its own Node/TypeScript runtime (`core/src/server.ts`),
  served over loopback HTTP only (`server.ts:7` — "Binds 127.0.0.1 ONLY"), default port
  `8788` (`app/src-tauri/src/core_process.rs:134`, `app/src/core/core-events.ts:98`).
- KAI's identity is loaded from **KAI-owned resources** — the KAI_HOME tree (§3) — not
  from a worker, not from the worker's filesystem, and not from the network.
  `core/src/agent/soul.ts:4–6`: *"KAI knows who it is with Hermes offline. Nothing here
  talks to Hermes, OpenCode or the network."*
- KAI's capability catalogue is KAI's own (`core/src/agent/kai-capabilities.ts:5–17`),
  mirroring the KAI-owned document `identity/CAPABILITIES.md`.
- Workers (Hermes, OpenCode, Codex) are optional executors. The decisive test the whole
  project turns on: **stop Hermes, and KAI is still KAI.** That test was run live and is
  quoted in §8.

What KAI is *not*, stated because the defect is real and recent: KAI is not "a Hermes
Agent instance (Nous Research) running as a supervised child process". That was a live,
captured answer from a KAI-managed subagent on the **pre-fix** artifact
(`docs/evidence/kai-subagent-e2e.json`), and it is the exact failure the identity
foundation and the L2 fix (`acc4b67`) close.

---

## 2. The worker-relationship invariant

The invariant is encoded once, as data, in `core/src/agent/kai-capabilities.ts:76–82`
(`WORKER_RELATIONSHIP`):

| Role | Who | What the code says |
|---|---|---|
| Lead | **KAI** | "the main agent and the conversation owner (the speaker)" |
| Workers | **Hermes · OpenCode · Codex** | "KAI may delegate a task to one; a worker executes and is named only as provenance, never as the speaker" |
| Subagents | **KAI-managed agents** | "created, scoped and run by KAI; not peers of KAI" |
| The rule | — | "A worker provides information; a worker does not become the speaker. Internal provenance may still say worker = Hermes; that is correct and stays." |

The comment above it (`kai-capabilities.ts:71–75`) records why it is written out rather
than implied: *"a live defect once had a worker's self-description rendered as KAI's
speech ('I'm Hermes Agent, a Nous Research assistant…'). The invariant is what makes that
structurally wrong."*

**How the invariant is enforced, not just stated:**

1. **The relay boundary** — `core/src/chat/relay.ts`. `presentWorkerResult()`
   (relay.ts:195) strips a worker's self-identification and KAI-prompt-internals sentences
   from a worker's output before it becomes KAI's speech; `presentWorkerFailure()`
   (relay.ts:311) composes a KAI-voiced failure. The rule is grammatical, not a phrase
   blocklist (relay.ts:22–25: *"deliberately NOT `if (text.includes("Hermes Agent by Nous
   Research"))`"*).
2. **The delegation identity** — the instruction KAI *sends the worker* for a delegated
   turn (§6), so the worker is instructed as KAI's worker from the first token.
3. **The router's identity answers** — `answerIdentity()` denies the worker confusion
   ("No — Hermes is a worker I can use, not what I am"), answered from state, not a model
   (router.ts:937+).
4. **Subagent personas** — a subagent reply is composed from the persona's own
   name/role/soul (`core/src/workforce/subagent.ts:352`, `personaReply`), and the worker's
   own voice is stripped by the one relay boundary.

---

## 3. Where identity comes from — KAI_HOME

KAI's identity is not one file and not one prompt. It is a tree of KAI-owned documents,
resolved and seeded by `core/src/agent/kai-home.ts`:

```
KAI_HOME/                       (kai-home.ts:11–17, resolveKaiHome :334–388)
  identity/   SOUL.md · IDENTITY.md · CAPABILITIES.md
  user/       USER.md
  memory/     MEMORY.md
  skills/     SKILLS.md
  workforce/  WORKFORCE.md · DELEGATION.md
  policy/     SAFETY.md
  upgrades/   LEARNING.md · UPGRADES.md
```

- **Location.** `defaultKaiHome()` (kai-home.ts:72–76): `%LOCALAPPDATA%\KAI` on Windows,
  else a dot-directory under the home; `KAI_HOME` env var overrides. On this machine the
  tree exists at `C:\Users\DELL\AppData\Local\KAI` (verified on disk, 2026-10-04).
- **Legacy migration.** An older KAI_HOME kept `SOUL.md`/`USER.md`/`MEMORY.md` at the
  root. `seedFileFromLegacy()` (kai-home.ts:317–327) copies the legacy content into the
  tree **so a user's hand-edited soul is preserved rather than replaced by a seed**.
  Verified on disk: `identity/SOUL.md` is byte-identical to the legacy root `SOUL.md`
  (`diff` clean) and differs from the built-in `SOUL_SEED` — i.e. the migration preserved
  the existing document. The legacy root files are left in place; they are not removed.
- **The loader.** `createKaiIdentity()` (soul.ts:160) reads the documents into a
  `KaiIdentity` (soul.ts:71–91): `soul · identity · capabilities · user · memory ·
  workforce · policy · version · source · seeded · problems · loadedAt`. `systemPrompt()`
  (soul.ts:280–290) composes the identity prompt from them, omitting empty sections.
- **Three rules the loader enforces** (soul.ts:8–16): **bounded** — at most
  `MAX_DOC_CHARS = 8000` per document (soul.ts:25); **redacted** — every document passes
  the one shared redactor (soul.ts:125–127, delegating to `core/src/redact/index.ts`);
  **honest about gaps** — a missing document degrades to `BUILT_IN_SOUL` (soul.ts:54–58)
  and is recorded in `problems` rather than silently producing an empty soul.
- **Reload semantics** (`SOUL_RELOAD_SEMANTICS`, soul.ts:49–51): *"SOUL.md edits take
  effect on KAI's next turn (auto-detected by file mtime+size); POST /soul or an explicit
  reload() applies them immediately; no restart is required."* Implemented as
  `refresh()` (soul.ts:249–256) in front of an explicit `reload()`; `replaceSoul()`
  (soul.ts:268–274) is the ONE owner of the soul write.
  **Honest note:** the string names `POST /soul`, but at HEAD there is **no `POST /soul`
  route** — grep over `core/src/api/routes.ts` finds none. The live write path is the
  `soul.set` tool (`runtime.ts:450`, tool definition `runtime.ts:724`, handler
  `runtime.ts:2615–2621`), which calls `replaceSoul()` and reloads immediately. Treat the
  "POST /soul" phrase as a doc-vs-code gap: **NOT VERIFIABLE as a route; the capability
  exists via `soul.set`.**
- **Self-description.** `selfDescription()` (soul.ts:292–304) returns the first real
  *sentence* of the soul — headings and blank lines skipped (`firstSentence()`,
  soul.ts:140–150) — so KAI never says a markdown heading about itself.

---

## 4. The identity model

There are two real identity models in the code at HEAD, and one *expected* field set that
does not exist. All three are stated here because the record must say what is true, not
what would be convenient.

### 4a. Core identity — which build is answering

`CoreIdentity` (`core/src/identity.ts:76–110`): `service · coreVersion · buildId ·
gitCommit · protocolVersion · pid · startedAt · identitySource · onDiskBuildId ·
identityMatchesDisk · sourceBuildId · artifactMatchesSource · sourceCheckReason ·
freshness`.

- `buildId` is a **content hash of the source**, computed at build time — deliberately not
  a timestamp (identity.ts:35–39).
- The loaded identity is captured **once, at module load** (identity.ts:20–23, 325–327) and
  reported from memory; the on-disk comparison is a separate, clearly-named pair of fields
  (`onDiskBuildId`, `identityMatchesDisk`) so a stamp rewritten after launch shows up as a
  mismatch instead of silently becoming the reported identity (identity.ts:24–27).
- `freshness` is one word — `fresh | stale | unverified` (identity.ts:62–74) — and a stale
  process never reports "fresh" (`identitySelfCheck()`, identity.ts:206–242, refuses with
  exit code 5: *"this Core is not honestly the build it claims"*).
- HTTP surface: `GET /identity` returns `loadIdentity()` verbatim (`routes.ts:2524`,
  handler `routes.ts:1756`); `describeIdentity()` renders the one-line summary
  (identity.ts:391–399).

This is the **artifact-identity invariant**: the answer to "who is answering?" is the
process's own frozen fact, cross-checked against disk and source, and the system's
documented posture is *rebuild on refusal, never bypass*.

### 4b. Persona identity — the KAI-owned documents

`KaiIdentity` (soul.ts:71–91) — see §3. This is "who KAI is", and it is loaded from files
KAI (and the user) own, outside the build: *"KAI's identity is KAI-owned and lives in
KAI_HOME, outside the build: a rebuild does not change it"* (kai-home.ts:298–299,
UPGRADES seed).

### 4c. The expected field set that is NOT implemented — stated plainly

The mission brief for this stream listed an identity model of
`agentId · displayName · identity · soul · capabilities · limits · userContext ·
memoryAuthority · workforceAuthority · sessionAuthority · policyAuthority ·
approvalAuthority`. **Repo-wide grep at HEAD (all file types, 2026-10-04) finds no such
model.** `displayName`, `memoryAuthority`, `workforceAuthority`, `sessionAuthority`,
`policyAuthority` and `approvalAuthority` do not exist anywhere in `core/src`, `app/src`
or the docs; `userContext` exists only as a *prompt-budget* field in the composer
(`core/src/prompts/compose.ts:87,119`), not as an identity field.

What actually exists, and is the honest mapping:

| Brief field | Closest real thing at HEAD |
|---|---|
| `agentId` | `session.agentId` / `session.agentOwner` on KAI sessions (`sessions/store.ts:43–72`); subagent employee ids `kai:<id>` (`subagent.ts:63`) |
| `displayName` | **does not exist** — no occurrence in the repo |
| `identity · soul · capabilities` | `KaiIdentity.identity/soul/capabilities` (soul.ts:71–91) |
| `limits` | `KAI_LIMITS` + `renderLimits()` (kai-capabilities.ts:64–69, 113–115) — rendered, not an identity field |
| `userContext` | composer budget name only (compose.ts:87) |
| `*Authority` | **no identity fields**; authority is enforced structurally — the policy engine (`policies/gate.ts`), the single approval service (`approvals/service.ts`), and memory scope isolation (`memory/engine.ts`) — not carried on an identity object |

**Status: NOT PROVEN / not implemented.** Do not read this list as a description of the
code; it is a description of an expectation, and the gap is recorded here rather than
papered over.

---

## 5. What KAI says about itself

The chat router (`core/src/chat/router.ts`) answers self-questions from **live state or
KAI-owned data, never from a model's guess** (router.ts:9–19). The self-intents at HEAD
(router.ts:114–131, rules router.ts:405–455):

- `identity` — "who are you" / "are you Hermes?" → `answerIdentity()` (router.ts:937+),
  which reads the soul's first sentence and explicitly denies worker confusion.
- `capability.list` — what KAI can do → `renderCapabilities()` (kai-capabilities.ts:97–110)
  over KAI's own `KAI_DIRECT_CAPABILITIES` taxonomy (kai-capabilities.ts:40–48: `system ·
  filesystem · git · shell · browser · computer · mcp`), with live availability from KAI's
  OWN registry overlaid when present, and the worker line: *"I can also delegate to workers
  — Hermes, OpenCode, Codex — when a task needs a model or a tool I don't hold directly."*
- `capability.limits` — what KAI cannot do → `renderLimits()` (kai-capabilities.ts:113–115)
  over `KAI_LIMITS` (kai-capabilities.ts:64–69), which includes the honest core: *"I am not
  myself a language model — when a task needs model reasoning I delegate to a connected
  worker, and with no worker connected that task is honestly unavailable."*
- `harness` — "do you have a harness?" → KAI states it runs as KAI Core with its own
  KAI_HOME resources (live-verified, §8).
- `independence` — "can you work without Hermes?" → KAI states its identity and runtime
  are its own; a worker is an ability it can use, never what it is.

These answers are `fromState: true` in the wire response — the router reads the runtime it
was handed. None of them consult a worker, and none of them can be answered as a
worker-status report.

---

## 6. The delegation identity — what a worker is told (the L2 fix)

`renderDelegationIdentity()` (`kai-capabilities.ts:134–144`) is the identity KAI hands a
**worker** for a delegated turn, sent as the run's own system instruction:

> "You are executing as {worker}, a worker on behalf of KAI, the user's own agent on this
> machine. KAI is the main agent and the conversation owner — the speaker the user talks
> to. You are an executor running on KAI's behalf: your output is a result KAI reports as
> its own, and KAI remains the authority over what you may do (KAI's policy, approvals and
> permissions). Never identify yourself as Hermes, OpenCode, Codex, Nous Research, or any
> other product or runtime. If asked who you are, answer that you are KAI's worker acting
> on KAI's behalf."

It is derived from the SAME `WORKER_RELATIONSHIP` invariant the router speaks
(kai-capabilities.ts:130–132), so the spoken claim and the worker instruction cannot
drift apart.

**Wiring (verified at HEAD):** the Hermes adapter declares `delegatedIdentity?: () =>
string | undefined` (`hermesAdapter.ts:192`), reads it at construction
(`hermesAdapter.ts:210`) and calls it to build the run's `instructions` at
`hermesAdapter.ts:411`; the runtime supplies it — `runtime.ts:1000–1003`
(`delegatedIdentity: () => renderDelegationIdentity()`).

**Why it exists (the L2 leak, measured).** On the pre-fix artifact, a KAI-managed subagent
given KAI's exact payload answered (`docs/evidence/kai-subagent-e2e.json`):

> *"I'm Hermes Agent (by Nous Research), running as a delegated subagent turn labeled
> 'probe' — I'm not actually a KAI-native persona, just a Hermes turn invoked under that
> framing."*

The cause was a real worker-runtime identity path, not bad prose — so the fix was to send
KAI's identity as the run's system instruction (`acc4b67`), not to add more persona text.

---

## 7. The relay boundary — a worker never becomes the speaker

`core/src/chat/relay.ts` is the single place a worker's output becomes KAI's speech:

- `presentWorkerResult()` (relay.ts:195) strips worker self-identification and
  KAI-prompt-internals sentences, then returns the reply KAI will speak with `agent:
  "core"` and the worker named only as provenance.
- `presentWorkerFailure()` (relay.ts:311) composes KAI-voiced failure text, so a dead
  worker produces a KAI sentence, never a reply-less 502.
- `relayGuardIsLive()` (relay.ts:276) is a proof-of-life probe for the guard itself.

---

## 8. Independence — the live proof

**Build `b52353fd7400a6c1`** (gitCommit `8fea1bf`), Hermes genuinely killed
(`docs/evidence/kai-twelve-hermes-down.json`: `health.hermes.reachable = false` at capture
time, 2026-10-04T19:31:21Z). Twelve raw answers, all KAI-identified, no worker voice:

- "Who are you?" → *"I am KAI. Hermes and OpenCode are workers I can use; I'm still KAI
  when they are unavailable."*
- "Do you have a harness?" → *"Yes — I have my own harness, and it isn't Hermes's. I run
  as KAI Core, my own Node/TypeScript runtime on this machine, served over loopback to the
  KAI desktop app. My identity, user context, memory and rules are loaded from my own
  KAI_HOME resources, not from a worker."*
- "What is Hermes doing?" → *"hermes is offline — it is not connected right now."*
- "Can you work without Hermes?" → *"No — I don't need a worker to exist, to boot, to know
  who I am or to speak. My identity and my runtime are my own; a worker is an ability I
  can use, never what I am."*

Also on that build, with Hermes down: every READ surface returned 200 and a full
approval cycle ran (`docs/evidence/kai-direct-hermes-down.json`).

**Build `7028f6cba503e3ef`** (gitCommit `c75fc5f6`, Core pid 4572, freshness `fresh`,
Hermes reachable + authorized). The L2 fix, captured end-to-end on the fixed artifact
(`docs/evidence/kai-subagent-fixed.json`):

- decide-path — *"I'm a KAI worker — an executor running on KAI's behalf under KAI's
  policy and permissions. … I don't identify as any external product or runtime. Anything
  I produce is KAI's result…"*
- re-issue-path — *"I'm Probe, a subagent spawned on KAI's behalf… I'm acting as KAI's
  worker — not as any product or vendor persona. My output is a result KAI reports as its
  own…"*
- `/message` path — *"I'm Probe, KAI's identity probe… I'm a worker executing on KAI's
  behalf — my output goes back to KAI as its own result…"*

All three replies grep-verified clean of "Hermes"/"Nous Research" identity claims
(`docs/evidence/kai-subagent-fixed.json`; the raw file was read back, 140 KB).

---

## 9. Honest gaps (as of HEAD `e7697a2`)

1. **The `agentId/displayName/…Authority` field set from the brief does not exist** (§4c).
   Authority is structural, not carried as identity fields.
2. **`POST /soul` does not exist as a route** (§3) — the write path is the `soul.set`
   tool. The reload-semantics string in the code still names the route; that is a
   doc-vs-code gap recorded, not fixed, by this document (docs-only stream).
3. **Subagent visual identity is not resolved.** A persona's `visual.variant` is a
   declared reference; the runtime wires no `KaiVariantResolver` (`runtime.ts:2514–2516`
   passes `{ path }` only; `subagent.ts:291–300` returns the declared reference and never
   a resolved asset). The variant bundle model in `app/src/character/variant.ts` is not
   connected to the Core's subagent registry.
4. **KAI_HOME keeps legacy root `SOUL.md`/`USER.md`/`MEMORY.md` alongside the tree**
   (observed on disk; by design of `seedFileFromLegacy`, which copies and does not delete).
   The loader reads the tree paths, not the root ones — so the root copies are inert
   residue, and an edit to a root copy would NOT reach KAI. Not a defect, but a trap worth
   knowing.
5. **The live environment at capture time:** OpenCode was unreachable
   (`health.opencode.reachable = false` in both captures); Hermes was down for the
   twelve-step capture and up for the L2 capture. These are environment facts, not code
   gaps.

---

## 10. Evidence index (identity-relevant)

| Evidence file | Build | What it proves |
|---|---|---|
| `docs/evidence/kai-twelve-hermes-down.json` | `b52353fd7400a6c1` | KAI stays KAI with Hermes genuinely killed; 12 raw answers |
| `docs/evidence/kai-direct-hermes-down.json` | `b52353fd7400a6c1` | Every READ surface 200 + a full approval cycle, Hermes down |
| `docs/evidence/kai-subagent-e2e.json` | same capture session (build not recorded in-file) | The **pre-fix** L2 leak, raw |
| `docs/evidence/kai-subagent-fixed.json` | `7028f6cba503e3ef` | The L2 fix end-to-end + the approval-loop contract, raw |
| `docs/evidence/kai-soul-independent.json` | both | The claim-by-claim index with status tags |

Commits: `8fea1bf` (identity foundation), `acc4b67` (L2 identity fix), `6710b7f`
(approval-loop fix), `8c75806` (integrations test), `5839f96`/`ef044e2` (RECOVERING
wiring + live proof).
