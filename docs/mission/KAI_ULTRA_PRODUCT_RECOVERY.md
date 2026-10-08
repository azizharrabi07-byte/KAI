# KAI — ULTRA PRODUCT RECOVERY + COMPLETION MISSION

## THIS IS A PRODUCT RECOVERY MISSION

STOP adding isolated UI features.

STOP polishing disconnected panels.

STOP treating "route exists" as "feature works".

The current application has regressed into a partially connected frontend.

The user-facing state is currently unacceptable.

Reported failures:

````text
1. Sending a message can throw the user out of the current session and back to the landing page.
2. KAI reports:
   "I am KAI. I couldn't get a result from Hermes just now —
   update stream HTTP 404..."
3. Main KAI chat is not reliably responding.
4. Sessions cannot reliably be created.
5. Sessions cannot reliably be renamed.
6. Commands do not work.
7. Tools do not work as a real user feature.
8. Skills are empty.
9. Memory is empty.
10. Home is empty.
11. Agents cannot be properly opened into their own conversations.
12. Agents currently behave like tiny task requests instead of real agent sessions.
13. Main KAI still uses the old 2D/MVP character.
14. Main KAI does not use the real character system already present in the island.
15. Feelings are not properly wired.
16. KAI customization is missing.
17. Agent customization is missing.
18. Themes/dark mode are missing or broken.
19. Plan mode is not functioning as a real planning mode.
20. Work mode is not functioning as a real execution mode.
21. MCP is not functioning as a complete user-facing capability.
22. Skills are not functioning as a usable KAI feature.
23. UX is laggy and poorly connected.
24. KAI.exe opens the island and main workspace simultaneously.
25. The island should NOT permanently sit beside the main app.
26. The island should become a companion that appears when:
    - the main workspace is closed/minimized
    - KAI needs the user
    - KAI is sending important progress/output
    - KAI needs approval
27. The island should stay available as a persistent lightweight status surface while the main workspace is closed.
28. The island's lower bar must remain removed.
29. The island should have only the top OPEN KAI action for opening/focusing the main workspace.
30. The main KAI workspace should be the real product.

We are fixing ALL of this.

---

# 0. ABSOLUTE PRODUCT DEFINITION

The target is:

```text
                         KAI
                          │
             ┌────────────┴────────────┐
             │                         │
      MAIN KAI WORKSPACE             ISLAND
       PRIMARY EXPERIENCE          COMPANION
             │                         │
             └────────────┬────────────┘
                          │
                       KAI CORE
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
    Identity           Sessions          Workforce
    Soul               Memory            Subagents
    Harness            Missions          Workers
    Skills             Policy            Hermes
    User               Approvals          OpenCode
    Learning           Recovery            Codex
       │                  │
       └──────────────────┼──────────────────┘
                          │
                         Tools
                          │
       ┌────────────┬─────┼─────┬────────────┐
       │            │     │     │            │
    Browser        CUA   Shell  Files        Git
                          │
                         MCP
````

There is ONE KAI.

The main workspace and island are two interfaces into the same KAI.

---

# 1. THE FIRST GATE — RESTORE REAL CHAT BEFORE ANYTHING ELSE

The application currently has a severe failure:

```text
message sent
→ current session disappears
→ landing page
→ Hermes HTTP 404 fallback
```

This must be solved before further UI expansion.

Do not redesign anything until this path is stable:

```text
Main Workspace
    ↓
current KAI session
    ↓
message input
    ↓
POST /chat
    ↓
KAI Core
    ↓
real response
    ↓
same session
    ↓
message appears
```

The exact contract must be re-read from the live backend before modifying anything.

Known contract:

```json
{
  "text": "...",
  "session_id": "..."
}
```

Verify the real implementation rather than trusting memory.

---

# 2. ZERO HERMES FALLBACK FOR NORMAL KAI CHAT

The normal KAI chat path must NOT fall through to:

```text
Hermes HTTP 404
```

and then show a misleading response like:

```text
"I am KAI, but I couldn't get a result from Hermes..."
```

That makes KAI sound like a wrapper around Hermes.

This is wrong.

Correct model:

```text
USER
 ↓
KAI
 ↓
KAI conversation / session
 ↓
KAI orchestrator
 ↓
direct KAI capability OR worker
 ↓
structured result
 ↓
KAI response
```

If a worker is unavailable:

```text
KAI remains KAI.
```

The UI must not navigate away from the session.

The user must not be kicked back to Home/Landing because a stream fails.

---

# 3. LIVE CHAT ACCEPTANCE TEST

Before proceeding:

```text
1. Launch real kai.exe.
2. Open main KAI workspace.
3. Open/create session.
4. Send:
   "reply with exactly: PONG"
5. Observe the real request.
6. Observe the real response.
7. Verify URL remains on the same session.
8. Verify message remains in the current conversation.
9. Reload UI.
10. Reopen the same session.
11. PONG is still present.
```

Then test:

```text
stop Hermes
→ send message
```

Expected:

```text
KAI remains KAI
KAI remains in the session
KAI honestly reports unavailable capability
NO navigation to landing
NO raw worker identity
NO HTTP 404 worker fallback shown to user
```

This becomes a regression test.

---

# 4. FIX THE UPDATE STREAM

The reported:

```text
update stream HTTP 404
```

must be traced.

Do not hide it.

Trace:

```text
frontend SSE/event client
 ↓
actual endpoint
 ↓
Core server route
 ↓
event serialization
 ↓
reconnect
 ↓
state update
```

Verify the exact endpoint from the current server source.

Do not assume:

```text
/core/events
```

or any other path until the server actually defines it.

The stream must:

```text
connect
reconnect
deduplicate events
preserve session state
not redirect the application
```

If the stream fails:

```text
chat must STILL remain usable
```

The realtime stream is an enhancement, not permission to destroy the chat session.

---

# 5. SESSION ROUTING IS A HARD REQUIREMENT

The user must NEVER be thrown to the landing page simply because:

* an SSE connection failed
* a worker failed
* a tool failed
* an agent failed
* a request timed out
* Core temporarily disconnected

Preserve:

```text
current route
current session
current draft
current conversation
```

where technically possible.

Implement proper error boundaries.

A network failure is NOT a navigation event.

---

# 6. SESSION SYSTEM — MAKE IT FULLY FUNCTIONAL

The user must be able to:

```text
New Session
Open Session
Rename Session
Delete Session
Archive Session
Restore Session
Duplicate Session
Search Sessions
Switch Sessions
```

The current session list must display meaningful names.

NOT:

```text
session_8f72ab
session_9d31bc
```

Instead:

```text
OpenGhost Integration
KAI Identity
Restaurant Project
Discord MCP
Agent Design
```

Automatic session title generation should happen after the first meaningful user interaction.

Allow manual rename.

---

# 7. SESSION TITLE GENERATION

Use actual conversation content.

Example:

```text
User:
"Help me connect KAI to Discord through MCP."

Title:
"Discord MCP Setup"
```

Not:

```text
New Session
```

forever.

The title must persist in Core.

The UI must read it from Core.

---

# 8. HOME MUST BECOME A REAL KAI COMMAND CENTER

Home can NOT be empty.

Build:

```text
KAI

What should we work on?

[ large message composer ]

CURRENT ACTIVITY
────────────────
Researcher      Researching
Hermes          Executing
KAI             Waiting for approval

RECENT SESSIONS
────────────────
KAI Identity
OpenGhost UI
Discord MCP
Restaurant SaaS

MY AGENTS
────────────────
Researcher
Coder
Browser Agent

NEEDS YOUR ATTENTION
────────────────
1 approval

SYSTEM
────────────────
Core       Online
Workers    1 active
MCP        1 connected
Agents     3
```

EVERY value must come from real Core data.

No fake counters.

No hardcoded agents.

No invented MCPs.

---

# 9. MAIN NAVIGATION

The main KAI application should have a coherent navigation system.

Recommended:

```text
KAI

Home
Chat
Sessions
Missions
Agents
Workers
Tools
MCP
Activity
Memory
Skills
Settings
```

Avoid 20 tiny disconnected buttons.

Each item opens a real working surface.

---

# 10. AGENTS ARE REAL ENTITIES

A major current failure is that clicking an agent leads to a tiny task/request surface rather than an actual agent conversation.

Fix this completely.

Each agent needs:

```text
Identity
Soul
Personality
Purpose
Worker
Capabilities
Memory
Sessions
Appearance
Permissions
Status
```

---

# 11. AGENT DIRECTORY

Build a real agent management page.

Example:

```text
AGENTS

Researcher
Deep Research Specialist
Worker: Hermes
Status: Idle

Coder
Software Engineering
Worker: OpenCode
Status: Working

Browser Agent
Browser Automation
Worker: Hermes
Status: Idle
```

Clicking an agent must open its actual agent environment.

---

# 12. REAL AGENT CHAT

When the user selects an agent:

SHOW A REAL CHAT.

Not:

```text
bash
Approve
Reject
```

The user must get:

```text
Researcher

"I'm ready. What should I research?"

[ message input                              ]
```

The conversation must use the agent's real session.

---

# 13. AGENT SESSION CONTROLS

For each agent:

```text
Open Chat
New Session
Switch Session
Rename Session
View History
Archive
Restore
```

Agent conversations are distinct from:

```text
KAI conversations
worker execution transcripts
mission records
```

---

# 14. AGENT SOUL

Each agent must have an actual identity.

For example:

```text
Researcher
Purpose:
Investigate topics deeply.

Soul:
Curious, rigorous, source-driven.

Personality:
Analytical and concise.

Worker:
Hermes
```

The soul must actually be loaded when the agent speaks.

Do not store it only in the UI.

---

# 15. AGENT MEMORY

Each agent must have its own memory scope.

UI:

```text
Agent
→ Memory
→ Private
→ Shared
→ Recent
```

The underlying KAI memory authority remains the single source of truth.

Do NOT create another memory system.

---

# 16. AGENT CUSTOMIZATION

The user must be able to customize every agent.

```text
Name
Purpose
Soul
Personality
Worker
Capabilities
Memory
Skin
Outfit
Accessories
Decorations
Color
```

Saving the setting must affect the actual agent.

---

# 17. REAL 3D KAI — NO MORE 2D MVP

This is mandatory.

The current main workspace still displays the temporary CSS/2D orb.

REMOVE IT.

Find the actual KAI 3D character system already used by the island.

Extract it into a shared character system.

Use exactly that system for:

```text
Main KAI
Island KAI
Agent previews
Agent appearances
Feelings
Runtime reactions
```

ONE character engine.

No second implementation.

No simplified orb.

No replacement approximation.

---

# 18. KAI APPEARANCE CUSTOMIZATION

The user already designed and built the appearance system.

Bring that functionality into the main application.

The user must be able to choose:

```text
Skin
Outfit
Color
Accessories
Decorations
Other existing KAI appearance options
```

The preview must be the REAL 3D KAI.

Persist the selection.

Restore it after restart.

---

# 19. AGENT APPEARANCE CUSTOMIZATION

Every agent gets the same real character engine with independent customization.

Example:

```text
Researcher
skin = tan
outfit = lab coat
accessories = glasses
decorations = tablet
color = pink
```

The actual rendered character must reflect those choices.

---

# 20. FEELINGS SYSTEM

The Feelings control must become a genuine KAI feature.

It should use the real character system.

Support:

```text
AUTO
MANUAL
```

AUTO:

```text
runtime state
→ feeling/state
→ real 3D KAI
```

MANUAL:

```text
user chooses supported feeling
→ real 3D KAI changes
```

Do NOT create fake feelings that don't exist in the character engine.

Use the actual supported states/poses.

---

# 21. AUTOMATIC FEELINGS

Map the real runtime states:

```text
IDLE
THINKING
RESEARCHING
BROWSING
CODING
USING_CLI
DELEGATING
MULTI_AGENT
WAITING_APPROVAL
RECOVERING
SUCCESS
ERROR
OFFLINE
```

to the existing appropriate character poses/feelings.

Use actual runtime events.

NO timers.

NO random switching.

---

# 22. FEELING OVERRIDE RULE

Manual mode:

```text
user chooses appearance
→ character displays chosen state
```

Automatic mode:

```text
runtime controls state
```

Safety/status states may override manual presentation when necessary:

```text
OFFLINE
ERROR
WAITING_APPROVAL
RECOVERING
```

Document the behavior.

---

# 23. PLAN MODE

Plan Mode must be a real operating mode.

Definition:

> Plan Mode = KAI analyzes and prepares a structured plan without executing the planned work.

When Plan Mode is active:

```text
User request
 ↓
KAI reasoning
 ↓
structured plan
 ↓
plan displayed
 ↓
user can inspect/edit/approve
```

Do NOT execute real work simply because the plan was generated.

Plan status:

```text
DRAFT
READY
APPROVED
REJECTED
```

---

# 24. PLAN MODE SHOULD BE READ/PLANNING FIRST

The user explicitly wants:

> Plan = read/think/structure/planning.

Therefore Plan Mode should prioritize:

```text
research
analysis
task decomposition
dependencies
risks
required tools
expected outputs
```

It should NOT automatically perform destructive/effectful actions.

---

# 25. WORK MODE

Work Mode is fundamentally different.

Definition:

> Work Mode = execute the approved/selected plan using KAI tools, workers, agents and missions.

Flow:

```text
PLAN
 ↓
APPROVE
 ↓
WORK
 ↓
EXECUTE
 ↓
VERIFY
 ↓
DONE
```

Work Mode can:

```text
use tools
delegate
spawn agents
browse
edit files
run shell
run Git
use MCP
perform approved actions
```

according to KAI policy.

---

# 26. PLAN ↔ WORK

The user should be able to move:

```text
Plan → Work
```

only when the plan is ready/approved.

If Work becomes blocked:

```text
WORK
 ↓
BLOCKED
 ↓
ASK USER
```

The island must show this attention state.

---

# 27. WORK MODE VISUALIZATION

Show:

```text
WORK MODE

Mission:
OpenGhost Integration

Plan:
4 / 7 complete

Current:
Testing Visual Engine

Agent:
Coder

Worker:
Hermes

Tools:
filesystem.read
shell
browser

Status:
RUNNING
```

All values real.

---

# 28. COMMAND SYSTEM

Commands must actually execute.

Implement a real command registry.

Examples:

```text
/help
/new
/session
/sessions
/agent
/agents
/mission
/missions
/tools
/mcp
/approve
/reject
/status
/memory
/skills
/browser
/terminal
/plan
/work
/feelings
/kai
```

Only expose commands that map to real functionality.

---

# 29. COMMAND PALETTE

Implement:

```text
Ctrl/Cmd + K
```

with:

```text
Search commands...
```

Examples:

```text
New Session
Create Agent
Open Sessions
Open Agents
Open Tools
Open MCP
Open Memory
Open Skills
Enable Plan Mode
Enable Work Mode
Open KAI Appearance
Open Feelings
Open Settings
Show Approvals
```

Every result must execute the correct real action.

---

# 30. SKILLS

Skills are currently empty.

Fix this.

Discover the useful skill system already available in Hermes/KAI.

Then selectively bring appropriate mechanisms into KAI.

DO NOT blindly copy everything.

For each candidate:

```text
source
purpose
dependencies
tools used
risk
license
KAI compatibility
```

Then install via KAI's skill architecture.

---

# 31. CLAUDE-CODE-STYLE CAPABILITIES

We want useful mechanisms, not branding.

Audit the strongest available Claude Code/Hermes-style workflows for:

```text
research
task decomposition
planning
coding
repository inspection
editing
verification
testing
Git
browser usage
tool selection
subagent delegation
context handling
recovery
long-running tasks
```

Adapt the useful mechanisms to KAI's own:

```text
ToolRegistry
Policy
Approvals
Sessions
Memory
Workforce
Skills
Missions
```

Do not import another control plane.

---

# 32. KAI SHOULD HAVE A REAL SKILL LIBRARY

Main UI:

```text
SKILLS

Research
Coding
Git
Browser
MCP
Testing
Planning
Verification
PC Control
```

Clicking a skill shows:

```text
Purpose
Tools
Permissions
Status
Source
Installed version
```

Only real installed skills should be listed.

---

# 33. MEMORY

Memory is currently visually empty.

Fix both:

```text
backend retrieval
AND
UI presentation
```

The user should be able to see:

```text
KAI Memory

Recent
Pinned
User
Session
Mission
Shared
```

Do not fabricate memories.

---

# 34. MEMORY WRITE/RECALL

Test from the real UI:

```text
User:
"Remember that my favorite editor is VS Code."

Then:
"What is my favorite editor?"
```

Prove:

```text
persist
restart Core
recall
```

Use the existing governed KAI memory authority.

---

# 35. THEMES

Implement:

```text
Light
Dark
System
```

The entire application must respond.

Not just the sidebar.

Persist the choice.

No restart required.

Apply to:

```text
chat
cards
sidebar
sessions
agents
tools
MCP
settings
dialogs
command palette
visuals
code
inputs
scrollbars
```

---

# 36. ISLAND BEHAVIOR

This must be fixed completely.

When KAI.exe starts:

### If main workspace has never been opened:

You may show the island as the lightweight entry point.

But the user should not have to fight two competing windows.

### When Main Workspace is open:

The island should disappear/minimize/hide from the user's primary desktop presence.

### When Main Workspace is closed/minimized:

The island returns as the companion.

### When KAI needs the user:

The island appears / becomes attention-grabbing.

### When KAI sends an important result:

The island may surface it compactly.

### When an approval is required:

The island MUST show it.

The main workspace and island still share the same Core.

---

# 37. ISLAND UI

REMOVE THE LOWER BAR COMPLETELY.

Do not move it.

Delete it.

Keep ONLY:

```text
OPEN KAI
```

at the upper/header location.

No duplicate `Open`.

No second launch control.

`OPEN KAI` must open/focus the real main workspace.

---

# 38. ISLAND APPROVAL

Example:

```text
KAI NEEDS YOUR APPROVAL

Allow:
filesystem.write

[Approve]
[Reject]
```

Clicking Approve calls the SAME approval in KAI Core.

Do not maintain island-local approval state.

---

# 39. ISLAND PROGRESS

Example:

```text
KAI
Researching...

Researcher
running

Hermes
executing

Progress
62%
```

The values must be real.

---

# 40. PERFORMANCE

The current UX is lagging.

Measure the actual problem.

Investigate:

```text
unnecessary polling
excessive re-renders
SSE event duplication
unbounded event history
large React state updates
3D renderer lifecycle
duplicate listeners
duplicate API requests
repeated session loads
unnecessary DOM rebuilding
```

Fix root causes.

Do NOT solve lag by disabling functionality.

---

# 41. EVENT STREAM EFFICIENCY

Ensure:

```text
one main event connection per UI surface where possible
```

or another deliberate connection architecture.

Do not create:

```text
every component → independent SSE
```

leading to dozens of duplicate streams.

Deduplicate events by ID.

Bound the in-memory event history.

---

# 42. KAI UI MUST NOT CRASH ON WORKER FAILURE

If:

```text
Hermes returns 404
OpenCode unavailable
MCP disconnected
Worker timeout
```

the UI must remain in the current session.

It may display:

```text
Worker unavailable
```

but it must NOT:

```text
redirect to Home
reset conversation
lose the composer
destroy session
```

---

# 43. VISUAL QA

After every significant UI wave:

1. Build the real Tauri application.
2. Launch the actual app.
3. Confirm URL is:

```text
http://tauri.localhost/
```

4. Do NOT use a Vite/browser rendering as proof.
5. Take screenshots.
6. Inspect them with vision.
7. Interact with the real controls.
8. Record defects.
9. Fix them.

---

# 44. MAIN CHARACTER ACCEPTANCE

Before completion:

```text
Main Workspace:
REAL 3D KAI

Island:
REAL 3D KAI

Feelings:
REAL 3D KAI

KAI customization:
REAL 3D KAI

Agent customization:
REAL 3D KAI
```

No 2D fallback unless a genuine runtime environment does not support 3D, and then report it explicitly.

---

# 45. OPEN GHOST BEHAVIOR

Use the valuable OpenGhost interaction mechanisms:

```text
rich streaming
structured visuals
diagram rendering
live updates
tool activity
agent activity
```

but keep:

```text
KAI identity
KAI branding
KAI character
KAI architecture
```

OpenGhost is the technology source.

---

# 46. RICH STREAMING

Once basic chat is stable:

```text
User
 ↓
KAI
 ↓
stream response
 ↓
progressive text
 ↓
tools
 ↓
visuals
 ↓
final result
```

The typing/streaming experience should be smooth.

Do not implement OpenGhost-style streaming until normal chat is stable.

---

# 47. BUILD ORDER

DO NOT attempt every part simultaneously in one giant branch.

Use parallel specialists but integrate in dependency order:

### WAVE 1 — STABILITY

```text
Chat
Session routing
SSE
Session persistence
No landing-page crashes
```

### WAVE 2 — CORE PRODUCT

```text
Home
Sessions
Agents
Direct agent chats
Memory
Skills
Commands
```

### WAVE 3 — KAI CHARACTER

```text
3D character
Feelings
Appearance
Agent appearance
```

### WAVE 4 — EXECUTION

```text
Tools
MCP
Approvals
Plan Mode
Work Mode
Missions
```

### WAVE 5 — COMPANION

```text
Island lifecycle
Island attention
Island approvals
Open KAI
```

### WAVE 6 — EXPERIENCE

```text
Dark mode
Streaming
Visual engine
OpenGhost interaction mechanisms
Performance
```

### WAVE 7 — ADVERSARIAL

Break everything deliberately.

Then fix it.

---

# 48. PARALLEL AGENTS

Use as many specialized subagents as useful.

Recommended streams:

```text
1. Chat/session recovery
2. Event stream
3. Home/dashboard
4. Sessions
5. Agents/subagent chat
6. Memory
7. Skills
8. Commands/command palette
9. Character engine
10. Feelings
11. KAI appearance
12. Agent appearance
13. Tools UI
14. MCP UI
15. Plan Mode
16. Work Mode
17. Island
18. Theme
19. Performance
20. OpenGhost streaming
21. Visual engine
22. Security
23. End-to-end QA
24. Release/build integration
```

But enforce:

```text
ONE OWNER PER FILE
```

Use separate worktrees for conflicting streams.

---

# 49. ONE RELEASE BUILD OWNER

ONLY one integration agent may run:

```text
npx tauri build
```

Other agents can run:

```text
tsc
unit tests
component tests
```

but do not race each other against the same `app/target`.

Before final build:

```text
kill running KAI parent
verify 8788 ownership
verify 9222 ownership
build
verify identity
launch
test
```

---

# 50. NO FALSE PASS

The project already caught several examples of:

```text
source works
but artifact is stale
```

or:

```text
feature implemented
but not mounted
```

or:

```text
DOM exists
but real UI doesn't work
```

Therefore every feature needs:

```text
source
→ build
→ live artifact
→ user action
→ Core
→ state
→ visible result
```

before:

```text
END-TO-END PROVEN
```

---

# 51. FULL ACCEPTANCE MATRIX

Do not finish until all are real:

```text
[ ] KAI chat sends
[ ] KAI chat answers
[ ] same session remains open
[ ] no worker 404 fallback
[ ] update stream works or gracefully degrades
[ ] sessions create
[ ] sessions rename
[ ] sessions search
[ ] sessions switch
[ ] session titles are meaningful
[ ] sessions persist
[ ] Home works
[ ] commands work
[ ] command palette works
[ ] tools visible
[ ] tools execute
[ ] tools approvals work
[ ] MCP visible
[ ] MCP tools execute
[ ] Discord MCP works
[ ] Canva correctly marked blocked if still unsupported
[ ] skills visible
[ ] skills usable
[ ] memory visible
[ ] memory write/recall works
[ ] agents can be created
[ ] agents can be edited
[ ] agent soul works
[ ] agent personality works
[ ] agent memory works
[ ] agent appearance works
[ ] agents have direct sessions
[ ] user can chat directly with agents
[ ] user can assign real work
[ ] plan mode works
[ ] plan mode does not execute work prematurely
[ ] work mode executes real mission
[ ] tools/workers/subagents visible during work
[ ] KAI has real 3D character
[ ] island has same real 3D character
[ ] feelings work
[ ] AUTO feelings work
[ ] MANUAL feelings work
[ ] KAI customization works
[ ] theme switching works
[ ] dark mode works
[ ] OpenGhost-derived rich streaming works
[ ] visual engine works in chat
[ ] main workspace is responsive
[ ] no major lag
[ ] island does not compete with main workspace
[ ] island lower bar removed
[ ] only Open KAI remains on island
[ ] island approvals work
[ ] island appears when KAI needs user
[ ] island remains useful when main app closes
[ ] no duplicate KAI state
[ ] worker identity never leaks
```

---

# 52. FINAL USER SCENARIO

The final test MUST be performed from the user's perspective.

```text
Launch KAI.exe.

I see the island only as the compact KAI companion.

Open KAI.

The main KAI workspace opens.

I see REAL 3D KAI.

I type:

"Who are you?"

KAI answers as KAI.

I click Sessions.

I create "Testing KAI".

I send:

"Remember that I prefer dark mode."

KAI responds.

I open Memory.

The memory exists.

I open Agents.

I create:

"Researcher"

I give it:

Soul
Personality
Hermes worker
Pink skin
Lab coat
Glasses

I save it.

I open Researcher.

I get a REAL agent conversation.

I tell it:

"Research the MCP ecosystem."

It creates real work.

I return to KAI.

I see real worker/subagent activity.

I open Tools.

I run a safe tool.

Approval appears.

I approve it.

I open MCP.

Discord is connected.

I enable Dark Mode.

The entire application changes.

I switch to Plan Mode.

I ask:

"Build a research plan for X."

KAI creates a REAL plan.

No work executes.

I approve/transition to Work Mode.

KAI executes the plan.

Tools/workers/subagents run.

The 3D KAI changes feelings naturally.

I close the main workspace.

The island remains.

The island says:

"KAI is working."

If approval is needed:

The island displays it.

I approve from the island.

The mission continues.

I reopen KAI.

The same session and mission are there.

The task finishes.

KAI summarizes.

I stop Hermes.

KAI still knows who it is.

KAI still works where direct capabilities exist.

No landing-page jump.

No 404 fallback.

No worker identity.

```

---

# 53. COMPLETION LOOP

After every wave:

```text
READ REPORTS
↓
CHECK GIT
↓
CHECK TSC
↓
CHECK TESTS
↓
BUILD
↓
LAUNCH
↓
INTERACT
↓
SCREENSHOT
↓
VISION INSPECTION
↓
IDENTIFY DEFECTS
↓
DISPATCH MORE AGENTS
↓
FIX
↓
REPEAT
```

Continue until the acceptance matrix is genuinely complete.

Do not stop because:

* a module compiles
* tests pass
* UI looks nice
* an agent says "done"
* the backend is functional
* documentation is complete

The product must work.

---

# 54. FINAL RULE

The desired end state is NOT:

```text
Hermes backend
+
KAI branding
+
unfinished UI
```

It is:

```text
                         KAI
                          │
             ┌────────────┴────────────┐
             │                         │
       MAIN KAI WORKSPACE            ISLAND
         full application          companion
             │                         │
             └────────────┬────────────┘
                          │
                       KAI CORE
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
      Soul              Memory            Agents
      Harness           Sessions          Workers
      Skills            Missions          Subagents
      Tools             Policy            Hermes
      MCP               Approvals          OpenCode
      PC Control        Recovery           Codex
```

KAI is the product.

Hermes is a worker.

OpenGhost is a technology source.

The island is a companion.

The main workspace is the real KAI environment.

---

# FINAL COMMAND

Use maximum safe parallelism.

Do not miss small details.

Do not leave dead buttons.

Do not leave empty pages.

Do not leave mocked data.

Do not leave 2D KAI.

Do not leave broken sessions.

Do not leave broken commands.

Do not leave empty skills.

Do not leave empty memory.

Do not leave fake agents.

Do not leave fake work modes.

Do not leave fake plan modes.

Do not leave the island competing with the main workspace.

Do not let worker failures eject the user from KAI.

Do not hide defects behind "coming soon."

Fix the application until the complete user scenario actually works.

Then rebuild the real release artifact.

Launch it.

Use it.

Inspect it.

Run the acceptance matrix.

Only when everything genuinely works:

# KAI READY FOR REAL USE