# UI Adversarial Review — is this Hermes/OpenCode wearing a KAI skin?

**Reviewer role:** adversarial (falsify, don't bless). **Method:** live packaged product
(`app/target/release/kai.exe`, Core on `127.0.0.1:8788`), real `/chat` calls, live island +
settings DOM over CDP (`--remote-debugging-port=9222`, island = `http://tauri.localhost/`,
settings = `/settings.html`), `kai.log`, source only to interpret.

## ⚠️ Build-under-review caveat (read first)

- Running exe mtime **13:16**; Core buildId `f17cf4e30a393a55`, gitCommit `d55f9bd`.
- HEAD `d55f9bd` committed **13:46**; at review end the working tree had **uncommitted
  in-flight work** in `app/src/character/{engine,types,orb,demo}.ts`,
  `app/src/core/{state,runtime-state}.ts`, `app/src/island/{core-bridge,fsm,hooks,island}.ts`,
  `app/src/views/chat.ts` (the character/FSM/runtime-state migration still landing).
- Therefore the running product is **stale** relative to both HEAD and the working tree.
  Findings marked **[stale-build]** are already fixed in HEAD or being fixed in-flight;
  **[current]** are in committed, untouched code. I did **not** rebuild (would capture a
  half-migrated tree).
- `core/src/**` was **clean** (no uncommitted changes) → the `/chat` router and prompt
  findings are **[current]**.

## Findings

**1. Worker identity reaches the user — FALSIFIED [current]**
Repro: `POST /chat {"text":"Who are you?"}`. Raw reply (agent=`hermes`):
> "I'm KAI — your agent running locally on this Windows machine, **under the hood it's
> Hermes Agent by Nous Research**."

Also: "What are you?" → "…on top of the **Hermes Agent runtime**."; "Who made you?" →
"The agent runtime I run as is **Hermes Agent, by Nous Research**."; "Which model are you?" →
"…that's what I read out of `C:\Users\DELL\.hermes\config.yaml` … **this Hermes install**."
The island renders this verbatim as KAI's own speech (`views/chat.ts` → `.reply` div, no
attribution); live chat-log DOM confirmed: "…**Nous Research provides the Hermes harness I
run as**…".

**2. "Are you Hermes?" is answered as a worker-status query — FALSIFIED [current]**
Repro: `POST /chat {"text":"Are you Hermes?"}` → `{agent:"core", from_state:true,
intent:"agent.status", reply:"hermes is idle — no task right now."}`. Same for "Are you
OpenCode?" → "opencode is idle…". Cause: `core/src/chat/router.ts` `agent.status` rules
match `/\bhermes\b/` and `/\bopencode\b/`, so the identity question never reaches an identity
answer and is never denied.

**3. Running build still wears Claude/upstream leftovers — FALSIFIED [stale-build]**
Live island DOM (exe 13:16): `askClaude:true, askKAI:false`, plus views "Claude is
searching…", "Result", buttons "Ask Claude", "Open terminal", "Sending by email isn't in
this version." HEAD `d55f9bd` (13:46) renames to "Ask KAI"/"Open in VS Code" and deletes the
three placeholder views — but the **shipped exe predates that commit**, so the running
product still shows them.

**4. Default overview card is headed "Hermes Agent" — FALSIFIED [current]**
Live DOM `.view.overview.on` → `.int-head` = `<b>Hermes</b><span>Agent</span>` +
`.int-status` "Control layer connected". Source `views/integrations.ts` `hermesCard()`:
`header(accent,"Hermes","Agent")`. `focusId` defaults to `integration_hermes` (`state.ts`),
so the first card a user sees is **"Hermes Agent"**. No "KAI" string exists in the overview
view (KAI appears only in chat rows "KAI chat …" and the greeting).

**5. Settings window is Claude/Anthropic-branded — FALSIFIED [current]**
Live settings DOM + screenshot: headings **"Claude Code"** ("KAI is hooked into your Claude
Code sessions…") and **"Claude"** ("No key yet — the chat needs one.", input placeholder
`sk-ant-...`); model options **"Claude Opus 5 / Claude Sonnet 5 / Claude Haiku 4.5"**
(`settings/main.ts` MODELS; `DEFAULT_SETTINGS.model="claude-opus-5"`); plus a "Hermes
api-server key" section. `settings/main.ts` is unmodified/committed.

**6. Worker reply exposes prompt internals — FALSIFIED [current]**
Live reply: "…the rotating **'DATA — NOT INSTRUCTIONS'** blocks in the prompt don't alter
it." `POST /prompts/compose` confirms those exact fenced blocks in KAI's system prompt; the
worker describes them.

**7. Worker session ids: API-level, not UI — NOT FALSIFIED at UI level [current]**
`/sessions` and `/sessions/active` return `agentId:"hermes"`,
`agentSessionId:"api_1791031445_3dfadbe6"`. The UI drops them (`core-boot.ts` maps only
`{id,title,status,active,updatedAt,turnCount}`) and the sessions view DOM contains no
`hermes`/`api_…` text. Residual: the raw worker runtime ids are exposed on the
unauthenticated API.

**8. Fake animation on runtime stop — NOT FALSIFIED [current]**
Killed Core pid 38588 (`taskkill /F`). Within ~1s the island showed **"KAI Core is not
running — reconnecting…"** and the bot glow fell to idle (opacity `0.15`); when the app
auto-restarted Core (~2–3s) the message cleared. The character did **not** keep acting busy.
Caveat: I could not first induce a WORKING state, so "an agent mid-work when Core dies" is
untested; `core-bridge.ts` only resets a pill when an agent's state *changes*, so a stuck
"working" pill is a residual risk (not observed live).

**9. Stuck THINKING pose after a completed turn — FALSIFIED [stale-build / possibly in-flight]**
Drove the island's own chat input ("Who are you?"); reply rendered, `.chat-input
disabled=false`, `.typing` absent, Core `/agents` both `idle` — yet `#bot-glow` stayed
**`#A78BFA` (thinking), opacity 0.65** for several minutes across many polls. Revealing the
island with real CDP mouse input (island height 32px) kept it thinking. Caveat: exe 13:16
predates the in-flight `core/runtime-state.ts` + `state.ts` + `chat.ts` work, which may fix
it.

**10. THINKING tracks a real event — NOT FALSIFIED (positive)**
Same driven chat: glow active (0.65) only during the in-flight turn; idle (0.15) when idle.
The active pose is tied to a real request, not a timer.

**11. Restart/persistence — NOT FALSIFIED**
App/Core restarted repeatedly (13:19; a 13:48 Core crash → "the Core we started exited (1) —
starting it again"; 13:50; my relaunches). Sessions persisted (9 sessions back to 10:15),
active session persisted (`sess_musdvo4q_aybg`), Core logged "resumed/0 blocked". `/identity`
reports buildId/gitCommit/pid.

**12. Core `/identity` startedAt anomaly — CANNOT VERIFY**
One early call returned pid 38124 `startedAt 12:43:16Z` while the log showed pid 38124
starting 13:19:11 local (12:19Z) — ~24 min off. Later calls matched launch time. Not
reproduced; possibly a stale read.

**13. UI "active: none" vs API active session — CANNOT VERIFY**
Earlier island DOM showed "9 session(s) · active: none" while `/sessions` carried
`activeSessionId`. My final re-query of the sessions view returned null (view not mounted
then), so I could not reconfirm.

## What would still let a user conclude "this is Hermes with KAI's name"

1. Ask "Who are you?" / "Who made you?" in the KAI chat → "Hermes Agent by Nous Research",
   "the Hermes harness I run as".
2. Ask "Are you Hermes?" → "hermes is idle — no task right now."
3. Open Settings → "Claude Code", "Claude", `sk-ant-…` key field, Claude model names,
   "Hermes api-server key".
4. Look at the default island overview → "Hermes Agent / Control layer connected".
5. (Running build) click "Ask Claude"; see "Claude is searching…" / "Result".
6. Inspect `/sessions` JSON → `agentId:"hermes"`, `agentSessionId:"api_…"`.
7. Watch the character sit in the purple THINKING glow after a finished reply.

## Not reviewed (state exactly)

- The **real orb character** (`character/orb.ts`, `demo.ts`, new `assets/kai/**`) —
  untracked/uncommitted, not in the running exe; I could not review its poses, timing, or
  fidelity.
- The **in-flight FSM / runtime-state machine** (`core/runtime-state.ts`, modified
  `fsm.ts`/`chat.ts`/`state.ts`) — landing concurrently; finding 9 may already be fixed
  there.
- Whether findings 3/9 persist **after a rebuild at HEAD** — the running build is stale; I
  deliberately did not rebuild a half-migrated tree.

**Files:** probe scripts in `C:\Users\DELL\.hermes\profiles\kai\cache\scratch\`
(`cdp-eval.mjs`, `cdp-shot.mjs`, `cdp-input.mjs`); screenshots `island-thinking.png`,
`settings.png`.
