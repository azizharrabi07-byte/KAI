# KAI — FINAL REPORT TO AZIZ
Generated: 2026-10-05 ~16:02 local. All numbers below are from commands run against the
RUNNING product on this machine, not from documentation.

## 1. HEAD AND BUILD/CORE IDENTITY (current, matching source)

HEAD              fa8ce40  ("the KAI-owned model provider ... + Wave 2 Home/Sessions/Commands")
Working tree      contains UNCOMMITTED, LIVE-VERIFIED fixes (see §3). It was NOT committed
                  because a concurrent session is editing the same tree right now (it wrote
                  nav-*.png / kai-nav-proof.json at 15:58). Committing would break the
                  zero-collision rule the order itself sets. Named, not swept in.

Running kai.exe   PID 17348, exe mtime 2026-10-05 15:54:36, path app/target/release/kai.exe
Running KAI Core  PID 20088 (== the process that OWNS port 8788)
                  GET /identity -> buildId 41b87e8807fd5348
                                   gitCommit fa8ce40eb3b2ef670d0333574323eaae0a85a683 (== HEAD)
                                   protocolVersion 1
                  identitySource app/target/release/core/build-info.json (the SHIPPED bundle)
                  bundle stamp buildId 41b87e8807fd5348 (dist and bundle agree)
Hermes worker     gateway RESTORED on 127.0.0.1:8642 (PID 23464) after the independence test.
OpenCode          127.0.0.1:4096 not running -> /health reports opencode upstream_unreachable.

STALENESS FIXED: the instance the supervisor measured (e2034bb, one 345x9 window) is gone;
the current binary is built from the current source (Core bundle res-tamped to HEAD).

## 2. TASK 1 ACCEPTANCE NUMBER — THE WINDOW

  DEFECT (measured before):  main window "KAI" = 345 x 9 px  (a sliver)
  NOW (measured, Win32 GetWindowRect on the running exe):

        main KAI window   1866 x 1051 px   visible, decorated, pos (35,35)
        CSS viewport      1289 x 704 px    (devicePixelRatio 1.4354)
        navigation rail   display:flex, 72 x 670 px, 13 nav buttons (Home button 46x46)
        island window     345 x 9 (collapsed companion) / 1034x459 when expanded

  Raw enumerator output is in docs/evidence/kai-workspace-final.json (osWindows field).

## 3. WHAT WAS ACTUALLY CHANGED AND VERIFIED LIVE

Real product defects found by measurement and fixed:

D1  SHELL SHOWED AN EMPTY PRODUCT ON LAUNCH (my fix).
    launch -> "Open KAI" painted 0 tools / 0 agents / 0 MCP for 80+ s; only a manual
    reload fixed it. Cause: every read without a live event of its own ran ONCE at boot
    (loadTools/loadAgents/refreshActive/refreshApprovals/buildLists/renderOverview). The
    shell page loads while KAI Core is still starting, those reads fail, and nothing
    retried them — while the workspace slice was quietly re-reading the same routes.
    Fix (app/src/shell/presence/presence.ts): one re-runnable `prime()` invoked at boot
    AND on every workspace transition to ONLINE; `buildLists()` made idempotent.
    PROVEN LIVE: after a real kill+relaunch, the footer read
    "56 tools registered | 0 of 0 MCP servers connected | 4 agents idle" within 2 s
    (was 0/0/0 at t=80 s before). app tsc 0, app suite 262/262.

D2  THE SIDEBAR WAS HIDDEN (root cause found here; fix landed in the shared tree).
    presence.css's @media(max-width:1000px) set `.rail{display:none}`. The main window is
    declared 1280 logical, but WebView2 folds Windows' 130% text scale into the device
    scale factor, so the CSS viewport came out 985 px — just under the 1000 px breakpoint —
    so the whole navigation rail vanished on any machine with large text. Same class as the
    island's already-fixed win_text_scale bug. The window is now sized so its WEBVIEW
    viewport is the declared design (main_target design geometry), and the media rule shows
    a 52 px rail instead of hiding it. PROVEN LIVE: rail display:flex, 72x670, 13 buttons,
    screenshot docs/evidence/ui-main-final-home.png (vision-checked: icons visible).
    NOTE ON OWNERSHIP: I found and diagnosed this; the CSS/Rust edits were written by a
    concurrent session in this shared tree. I rebuilt and verified them live.

Also verified live (task-1 acceptance chain implemented -> mounted -> LAUNCHED -> clicked
-> real Core request -> real state change -> real UI update):
  - All 12 nav routes clicked via the running webview (CDP): Home, Chat, Sessions, Missions,
    Agents, Workers, Tools, MCP, Activity, Memory, Skills, Settings. Each renders a real
    Core-backed view. Full transcript: docs/evidence/nav-clickthrough.json.
    Home "Core online / 56 tools / 4 agents / 0 MCP servers / build 41b87e8807fd5348";
    Tools "56 tools registered / 41 park for approval / MCP unavailable / 0 MCP servers";
    Agents "4 active" with real souls; Workers "hermes idle / opencode offline" (TRUTHFUL);
    Sessions real; Missions real; Memory real.
    => TRUE STATUSES, not faked: MCP is reported UNAVAILABLE with 0 servers; workers report
       their real state; nothing claims health it cannot support.

## 4. STREAM MATRIX  (PASS / PARTIAL / BLOCKED / NOT IMPLEMENTED)

UI RESET
  A  window + shell/layout .......... PASS     (window real 1866x1051, sidebar visible,
                                               12 routes clicked, Core-backed, screenshotted)
  B  chat + sessions ................ PARTIAL  (chat renders real turns of the real 280-turn
                                               session; sessions list real. NOT proven:
                                               rename/search/sort/archive/restore/delete)
  C  agents ......................... PARTIAL  (agents view lists 4 real subagents with souls;
                                               live creation flow not exercised end-to-end)
  D  tools + MCP + activity ......... PARTIAL  (tools + MCP TRUE; Activity view still shows
                                               "Nothing yet" while the drawer shows real
                                               events -> open defect, not fixed)
  E  island ......................... PARTIAL  (companion: window 345x9 collapsed, island
                                               probe mode=expanded/view=approval, no big chat;
                                               `-`/`X` distinction not separately exercised)
  F  branding ....................... PARTIAL  (audit complete with file:line; fixes NOT
                                               applied — 4 USER_VISIBLE source strings + a
                                               runtime data leak, see §6)

ULTRA MISSION
  C  tool plane (core/src/tools) .... PARTIAL  (56 tools registered+listed through the real
                                               route with honest risk/effectful flags; core
                                               suite tool tests green. Not re-audited file-by-file)
  D  MCP ............................ PARTIAL  (GET /mcp now answers 200 with a UNAVAILABLE
                                               capability + management tools; ZERO servers
                                               registered, so no MCP tool is callable. The
                                               missing piece is a registered server, i.e. config)
  E  sessions ....................... PARTIAL  (40 sessions persisted and listed; subagent
                                               session isolation covered by the suite)
  G  PC control ..................... PARTIAL  (capabilities route + POST /capabilities/:id/test
                                               exercised; filesystem path sandbox now present
                                               and live-verified to REFUSE paths outside the
                                               root — closes the arbitrary-read exploit H1)
  I  island companion ............... PARTIAL  (companion refactor present and probed)
  J  security ....................... NOT IMPLEMENTED (adversarial re-audit done: 9 findings
                                               STILL PRESENT, 1 PARTIAL, 0 FIXED — see §6)
  K  integration .................... PARTIAL  (rebuilt, reconciled, independence proven §5)

## 5. THE MISSION'S OWN TEST — KAI WITH HERMES DOWN  (PROVEN)

Procedure: recorded the gateway command line, stopped the Hermes gateway (PIDs 22112/11268),
confirmed 8642 was dead and KAI Core reported hermes.reachable:false, probed KAI, restarted
the gateway (now PID 23464, "Gateway is running"), confirmed 8642 is LISTENING again.

With Hermes DOWN, KAI Core answered 19/20 subsystem routes with HTTP 200:
  /identity /health /independence /state /tools /mcp /sessions /subagents /agents /employees
  /capabilities /approvals /missions /memory/search /skills /schedules /recovery/status
  /actions /checkpoints   (/prompts/compose is 404 for GET — not a regression)
And KAI stayed KAI:
  "Who are you?"  -> agent=core intent=identity
                     "I am KAI. Hermes and OpenCode are workers I can use; I'm still KAI
                      when they are unavailable."
  "Are you Hermes?" -> "No — Hermes is a worker I can use, not what I am. I am KAI."
  "What can you do?" -> its own capability list from its own state.
  unknown question -> honest "I don't have a rule for that, and no agent is connected right
                     now, so I can't hand it off." (no fabrication)
Evidence: docs/evidence/kai-independence-final.json (Hermes down) and
          docs/evidence/kai-independence-baseline.json (Hermes up, same 19 routes).

HONEST LIMIT: /independence reports KAI's OWN model provider is CONFIGURED=false,
reachable=false, reason "no API key configured". So KAI's identity/state/harness answers and
all control-plane reads are genuinely independent of Hermes, but a generative turn that needs
a model still needs a worker until KAI's own key is set. This is an external configuration
gap, not a code defect (recorded as BLOCKED_EXTERNAL below).

## 6. ADVERSARIAL FINDINGS (independently re-verified against current core/src)

Security (docs/evidence/kai-security-final.json): 10 findings checked, 0 FIXED, 1 PARTIAL,
9 STILL PRESENT. H1 PARTIAL: tools/workspace.ts now confines filesystem paths to declared
roots (live-verified to refuse C:/Windows/win.ini and ~/.hermes/.env), but server.ts still
dispatches the whole route plane with no auth and hostAttested() is called on one route only.
H2-H6 and M1-M4 persist (unauthenticated approval decision; approval bound to toolId not to
the reviewed input; /sessions/:id/turns skipping the owner check; memory-scope identity;
/prompts/compose open; legacy /memory defaulting to user provenance; workforce.subagent
auto-authorized though EXTERNAL; unbounded soul interpolation; identity-guard noun set gaps).

Branding (docs/evidence/kai-branding-final.json): 4 USER_VISIBLE source strings —
app/src/settings/main.ts:131, app/src-tauri/tauri.conf.json:81, app/src-tauri/src/integrations.rs:929
and :951 — plus a RUNTIME DATA leak: the live session store holds 22 assistant turns containing
"Hermes Agent" (18 with "Nous Research"), e.g. "Hermes Agent, by Nous Research — running on
your Windows box...", rendered as KAI's own chat turns. The worker-voice guard exists in
core/src/chat/relay.ts but the already-persisted turns are what a user reads.

## 7. SUITES AND EVIDENCE FILES

Suites run this session:
  core  npx tsc --noEmit -> 0 ;  npm test -> 871 tests, 858 pass, 0 fail, 13 skipped
  app   npx tsc --noEmit -> 0 ;  npm test -> 262 tests, 262 pass, 0 fail

11/11 required evidence files written, each valid JSON, each from real command output:
  kai-identity-final.json      identity + identity model + 2 live chat probes
  kai-harness-final.json       /identity/model + KAI_SOUL.md (sha256) + capabilities held
  kai-independence-final.json  19 live routes with Hermes stopped
  kai-tools-final.json         56 tools, risk histogram, per-tool permission flags
  kai-mcp-final.json           capability UNAVAILABLE, 0 servers, management tools
  kai-sessions-final.json      40 real sessions
  kai-subagents-final.json     4 real subagents with roles/souls
  kai-pc-control-final.json    GET /capabilities + POST /capabilities/:id/test
  kai-workspace-final.json     main window OS geometry + live webview state
  kai-island-final.json        island OS geometry + live companion probe
  kai-security-final.json      10 findings re-verified with file:line
  (+ kai-branding-final.json, kai-independence-baseline.json, nav-clickthrough.json)

Screenshots proving the main window is REAL and vision-inspected (docs/evidence/):
  ui-main-final-home.png    sidebar visible, "Core online / 56 tools / 4 agents / build 41b87e88"
  ui-main-final-chat.png    real transcript, usable composer, sidebar visible
  ui-main-final-agents.png  real agent cards
  ui-main-fresh-tools.png   "56 tools registered / MCP unavailable" (true status)
  ui-main-final-chat/home/agents + ui-main-fresh-* + ui-main-window-fresh.png
  VISION RESULT: readable text, clickable buttons, usable input, correctly sized panels, no
  overlap/clipping, branding = KAI only in the UI chrome, orb character present.

## 8. BLOCKED_EXTERNAL (with evidence)

1. KAI's OWN INFERENCE IS UNCONFIGURED. /independence: inference.configured=false,
   reachable=false, reason "no API key configured". Until a key is set, KAI's generative
   turns depend on a worker. Needs an API key from Aziz — code cannot supply it.
2. NSIS INSTALLER STEP FAILS. `npm run tauri build` produced the app binary ("Built
   application at ... kai.exe"), then died in makensis: File
   "...core/bundle/agent/identity-model.d.ts -> no files found" (installer.nsi line 680).
   The .d.ts is not produced by the bundle (which ships .js); the nsi file list expects it.
   The APP is unaffected; only the installer is. Fix is in the bundling/resources manifest.
3. DISK 94% FULL (17 GB free). Tight for repeated release builds; a full disk previously
   killed runs. Not fixed here.

## 9. WHAT IS *NOT* PROVEN (no rounding up)

- Streams B, C, D(sessions), G, I are PARTIAL: the routes/views are real and exercised, but
  their full operation sets (rename/sort/archive, live agent creation, capability-by-capability
  PC control) were not each driven end-to-end this session.
- Stream J (security) fixes were NOT applied — this was an adversarial read-only audit.
- The peer-session window/nav CSS+Rust edits are verified LIVE by me but their code review is
  theirs, and the tree is uncommitted.
- No unit test was written for the D1 priming fix; it is proven by a live kill+relaunch run,
  which is the stronger evidence, but there is no regression guard in the suite yet.
