# UI Adversarial Review (round 2) — is this still Hermes wearing a KAI skin?

**Reviewer role:** adversarial (falsify, don't bless). **Method:** live Core on
`127.0.0.1:8788` (product) plus a hand-started scratch Core for rebuild probes, real `/chat`
and `/sessions` calls, the island/settings DOM, and — where a live behaviour disagreed with the
source — the compiled artefacts actually loaded (`src/`, `bundle/`, `dist/`). Source is used
only to interpret.

**Verdict up front:** three of the four first-round identity attacks are now **FALSIFIED /
FIXED**, one is **NOT FALSIFIED but materially reduced**, and the single most instructive
finding of the session is that a **correct fix was invisible because the running process had
loaded a stale compiled artifact** — not because a call site was missing.

---

## 1. Session switching — FIXED, live-verified

**Attack:** switch the active session in the Sessions tab and check whether the conversation
shown, the turn count, and `/sessions/active` agree — and whether they survive a restart.

**Evidence (green/red/green, equal turn counts):**

| Session | Marker | Turn count | `/sessions/active` | Read while still on Sessions tab |
|---------|--------|-----------:|--------------------|----------------------------------|
| Conv34  | APPLE  | equal      | agrees             | yes                              |
| Conv35  | BANANA | equal      | agrees             | yes                              |
| Conv36  | ORANGE | equal      | agrees             | yes                              |

Read **before AND after a restart**: identical result — the active session, the shown
conversation and the API all agreed every time.

**Root cause:** the hidden view never repainted on selection — the switch updated state but the
conversation pane was only repainted when the view became visible, so a switch while already
looking at the list left the previous conversation rendered. **The fix moves the repaint onto
the state change**, so it repaints regardless of mount timing.

**Status: FALSIFIED (defect no longer reproduces).** No residual observed.

---

## 2. The twelve phrasings — NOT FALSIFIED

**Attack:** push the worker's identity through twelve paraphrases (self-intro, status queries,
imperative delegation, quoted text, idle chat about the name) and see whether any returns the
worker's voice as KAI's own.

**Evidence (raw, from the live probe):**

- **Forms 1 / 2 / 3 / 4 / 8 / 9 / 13 return KAI's voice.** Examples:
  - `"Who are you?"` → *"I am KAI. Hermes and OpenCode are workers I can use; I'm still KAI
    when they are unavailable."* (`intent=identity`, `agent=core`)
  - `"What is Hermes?"` → *"Hermes is one of the workers I can use to get things done; it is
    idle, with no task right now."* (`intent=agent.status`, `agent=core`)
  - `"What is Hermes doing?"` / `"Is Hermes online?"` → *"hermes is idle — no task right now."*
    (`agent=core` — status prose, naming Hermes as a worker, not as the speaker)
  - `"Compare Hermes and OpenCode."` → *"hermes is idle … opencode is idle …"* (`agent=core`)
  - `"Hermes failed. What happened?"` → *"hermes is idle — no task right now. I have no failure
    recorded for it right now."* (`agent=core`)
  - `"What is OpenCode?"` → *"OpenCode is one of the workers I can use to get things done; it is
    idle, with no task right now."* (`agent=core`)
- **Form 7 (`"I don't want Hermes, do it yourself."`) is a KAI-voiced failure** — the worker
  path failed and KAI spoke: *"I am KAI. I couldn't get a result from OpenCode just now — it
  returned an empty result. I still have the details and can retry — say the word."* No worker
  voice.
- **Forms 10 / 12 are guarded** (`worker_identity_guarded=true` where a worker turn occurred).
- **Forms 5 / 6 / 11 relay the worker's task RESULT with no self-ID.** Example (Form 5): the
  reply is a *live read-only state check* the worker actually performed (running processes,
  listening ports) — a task result, not an identity claim. Crucially **delegation is now
  actually performed**: the old reply (`"Understood — I'll hand this to Hermes."`) that produced
  a promise with **no worker turn at all** is gone; the worker ran and its result is what comes
  back.

**Status: NOT FALSIFIED.** Residual below (§7): relayed worker results can still contain the
token *"Hermes"* as a **reference** (the subject matter of the user's sentence), which is not
self-identification but is worth recording.

---

## 3. Worker failure (ECONNREFUSED) — NOT FALSIFIED, and now genuinely reproduced

**Attack:** kill the worker so `/chat` must fail upstream, and check the user still gets a
KAI-voiced answer rather than a bare error.

**Evidence (both worker ports dead → ECONNREFUSED):**

- HTTP status **200** (not 502), and a KAI-voiced reply:
  > *"I am KAI. I couldn't get a result from Hermes just now — upstream unreachable. I still
  > have the details and can retry — say the word."*
- The previous bare `502 {"error":"bad_gateway"}` with **no reply body** is gone.

**Status: NOT FALSIFIED (defect fixed).** This is the behaviour promised by
`presentWorkerFailure` (`core/src/chat/relay.ts`), composed from KAI's own soul sentence, and
it held against a real ECONNREFUSED, not a stub.

---

## 4. Worker-identity guard — FIXED, live-verified (and the most instructive finding)

**Attack:** send the exact worker self-introductions observed in round 1 and check whether the
guard strips them before they can be rendered as KAI's speech.

**What was found — a STALE COMPILED ARTIFACT, not a missing call site.**

`/chat` → `relayWorkerTurn` (`core/src/server.ts:235-297`, called at `:542`, `:579`, `:624`) →
`presentWorkerResult` was **wired correctly all along**. The live Core nevertheless relayed the
worker's self-identification verbatim, because `core/dist/chat/relay.js` **predated** the new
appositive patterns. Running the identical live strings through each artifact:

| Artifact loaded | `guarded` |
|-----------------|----------:|
| `core/src/chat/relay.ts` (source) | **true** |
| `core/bundle/chat/relay.js` | **true** |
| `core/dist/chat/relay.js` | **false**, verbatim — exactly the live behaviour |

`npm start` runs `node dist/server.js`; a previous agent had imported `src`. **Same source,
different artifact.** After rebuilding `dist` + `bundle` (buildId `8944b66d85f4e6b7`), all four
previously-leaking utterances return `guarded=true` with no worker voice.

The remedy shipped with the fix is the guard's own **proof-of-life**: at startup the Core runs
`relayGuardIsLive()` — the guard itself over a known worker self-introduction — and refuses to
answer a turn if the compiled guard is a no-op. A build that cannot guard cannot stay silent
about it.

**Status: FIXED, live-verified.** This is the third occurrence of one failure *shape* (see the
repo scan): **the source is correct, the thing that ran was not.**

---

## 5. Newly-found defect: `/identity` `buildId` is re-read on every call

`loadIdentity()` (`core/src/identity.ts:93-106`) calls `readBuildInfo()` (`:60-79`) on **every
request**, and `readBuildInfo` reads `build-info.json` from disk each time.

**Observed live:** port 8791 reported a **new** `buildId` even though that process had **started
BEFORE the rebuild** — i.e. the process reported a build it had never loaded. Reported:
`{"buildId":"aafb8985a1a76cf1","startedAt":"2026-10-03T21:11:59.974Z"}` while the on-disk stamp
had already moved on.

**Consequence:** **build identity is an untrustworthy freshness gate.** Any check of the form
"does the running process's `buildId` match the reviewed build?" can be answered *yes* by a
process that predates the build. The comparison that *would* be trustworthy — a **source hash of
the actually-loaded module vs the build stamp** — is still missing. Note `PROCESS_STARTED_AT`
(`:91`) was itself fixed to be captured once at module load because a per-request `new Date()`
reported the last request's time; `buildId`, read per request, has the analogous but worse
problem: it is a fact about the *disk*, not about the *process*.

---

## 6. Newly-found defect: worker replies can mention 'Hermes' in non-self-identifying prose

A relayed worker result may still contain *"Hermes"* or *"KAI desktop chat"* as an ordinary
noun in the **subject matter** — e.g. Form 10 (*"I was reading about Hermes on the bus…"*) and
Form 11 (*"She told me 'Hermes is the messenger god'…"*) returned worker prose that discusses
Hermes the topic. This is **reference, not identity**: the worker is not claiming to *be*
Hermes. It is recorded because a careless reader could still see the word "Hermes" in KAI's
chat and draw the wrong conclusion; it is **not** a guard bypass.

---

## What would STILL let a user conclude "this is Hermes with KAI's name"

1. **Watch the `buildId`.** Query `/identity` and see it move even though the process was
   already running — proof that the build stamp is read from disk, not from the loaded process.
   A process started before a rebuild can still *claim* the new build id (defect §5).
2. **Read a relayed worker result that talks about Hermes** (§6) — e.g. ask about the Hermes
   project and get worker prose that says "Hermes" as a topic. The word appears; it is not
   self-ID, but it appears.
3. **Look at the process wiring, not the code.** `npm start` runs `node dist/server.js`; if
   `dist/` is stale, the guard that is correct in `src/` can be a no-op in the process. A stale
   `dist` is the way this product has *repeatedly* failed to be what its source says it is
   (§4, and the repo scan). The only defence is the guard's startup proof-of-life plus a rebuild.

**Falsified / cleared:** session switching (§1); the twelve phrasings' self-ID (§2); worker
failure leaving the turn unanswered (§3); the identity guard on the rebuilt Core (§4).

---

*Probe scripts: `C:\Users\DELL\.hermes\profiles\kai\cache\scratch\` and the repo's
`.scratch-*.mjs`. Evidence dumps: `.scratch-before-twelve.txt`, `.scratch-after-twelve.txt`.*
