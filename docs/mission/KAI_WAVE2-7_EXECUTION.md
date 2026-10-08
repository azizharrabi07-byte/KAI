# KAI — WAVE 2→7 FULL PRODUCT EXECUTION

## THE CHAT GATE IS GREEN — NOW FINISH THE ACTUAL PRODUCT

The first critical gate is now proven.

The real KAI chat/session failure has been fixed:

```text
KAI session
→ real Hermes worker session
→ worker result
→ KAI response
```

The poisoned-session self-binding was fixed and self-healing is proven on the real artifact.

Known-good commit:

```text id="b6dc91"
e2034bb
```

The real session that previously returned 404 now returns PONG with a real Hermes session.

Do NOT regress this.

The memory prompt-injection proof also held: recalled data was treated as data rather than instructions.

Now continue with the remaining product work.

---

# 1. DO NOT GO BACK TO CHAT ARCHITECTURE

The chat gate is now the baseline.

Preserve:

* KAI session ownership
* worker-session mapping
* self-healing
* KAI-authored responses
* no worker identity leakage
* no landing-page redirect on worker failure

Before modifying any frontend routing, create regression tests for:

```text id="fa2w1q"
PONG
same session
reload
Hermes offline
worker 404
Core offline
```

---

# 2. RUN THE FINAL WAVE IN PARALLEL

Now launch specialized streams for:

```text id="6r5p2x"
A — HOME
B — SESSIONS
C — AGENTS + DIRECT CHAT
D — AGENT SOUL/MEMORY/SETTINGS
E — KAI 3D CHARACTER
F — FEELINGS
G — APPEARANCE CUSTOMIZATION
H — SKILLS
I — COMMAND SYSTEM
J — PLAN MODE
K — WORK MODE
L — TOOLS
M — MCP UI
N — THEMES
O — ISLAND
P — PERFORMANCE
Q — OPEN GHOST VISUAL/STREAMING
R — SECURITY
S — END-TO-END QA
```

Every stream gets strict file ownership.

ONLY ONE integration agent may run the final Tauri build.

---

# 3. WAVE 2 — HOME

Home must become a real KAI command center.

It must show real:

```text id="h4w8kr"
recent sessions
active missions
agents
workers
tools
MCP status
pending approvals
current KAI state
recent activity
```

And:

```text
New Chat
New Session
New Mission
Create Agent
Open Tools
Open MCP
Open Agents
```

No hardcoded values.

---

# 4. WAVE 2 — SESSIONS

Make sessions fully usable:

```text
create
rename
search
open
switch
archive
restore
duplicate
delete where governed
```

Session titles must be meaningful.

Automatic title generation must derive from the actual conversation.

Example:

```text
"Discord MCP Setup"
"KAI Identity"
"OpenGhost Integration"
```

not opaque session IDs.

Persist them across restart.

---

# 5. WAVE 3 — AGENTS

Agents are a first-class product feature.

The user must be able to:

```text
create
edit
rename
duplicate
archive
restore
open
chat
assign work
pause
resume
cancel
retry
```

Each has:

```text
name
purpose
soul
personality
worker
capabilities
memory scope
appearance
sessions
```

---

# 6. DIRECT AGENT CHAT

Clicking an agent must open a REAL conversation.

NOT:

```text
bash
Approve
Reject
```

It must be:

```text
Agent name
Agent role

conversation

message input
```

The conversation must use the actual agent-owned session.

---

# 7. AGENT SOUL

Changing:

```text
Soul
Personality
Purpose
Worker
Capabilities
```

must change the actual runtime behavior.

Don't store it only in the frontend.

Test:

```text
edit soul
restart Core
open agent
agent still uses new soul
```

---

# 8. AGENT MEMORY

Expose agent memory.

Use the already-proven KAI memory authority.

Never create a second memory system.

Test:

```text
A writes private memory
B cannot read
explicit share
B can read shared item
restart
scope still correct
```

---

# 9. WAVE 4 — REAL 3D KAI

REMOVE the 2D/CSS MVP character.

Find and reuse the real character engine already used by the island.

Create a shared character module:

```text id="m7l2r1"
KAI Character Engine
├── Main Workspace
├── Island
└── Agent Appearance
```

One implementation.

One state source.

---

# 10. KAI CUSTOMIZATION

Bring the existing character customization into the main workspace.

User chooses:

```text
skin
outfit
color
accessories
decorations
```

Preview must use the REAL 3D KAI.

Persist across restart.

---

# 11. AGENT CUSTOMIZATION

Each agent must have independent appearance:

```text
skin
outfit
accessories
decorations
color
```

but use the same underlying character engine.

---

# 12. WAVE 4 — FEELINGS

Implement:

```text
AUTO
MANUAL
```

AUTO is driven by real runtime states.

MANUAL lets the user select supported feelings from the existing character system.

No timers.

Map actual runtime states:

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

to the actual supported character poses/states.

---

# 13. WAVE 5 — SKILLS

Skills must stop being an empty screen.

Audit the strongest Hermes/Claude-Code-style skills available locally.

Prefer useful mechanisms for:

```text
research
coding
Git
browser
testing
planning
verification
PC control
agent orchestration
```

Do not blindly import.

Every skill must be:

```text
audited
licensed
installed
registered
tested
```

through KAI's skill system.

---

# 14. WAVE 5 — COMMANDS

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

Commands must actually execute.

No dead command buttons.

---

# 15. COMMAND PALETTE

Implement:

```text
Ctrl/Cmd + K
```

Searchable commands:

```text
New Session
Create Agent
Open Agent
Open Tools
Open MCP
Open Memory
Open Skills
Enable Plan Mode
Enable Work Mode
Open KAI Appearance
Open Feelings
Open Approvals
```

---

# 16. WAVE 5 — PLAN MODE

Plan Mode means:

> Plan only. Do not execute the work.

Flow:

```text
user request
↓
KAI analysis
↓
structured plan
↓
plan visible
↓
user reviews
↓
approve
```

Plan should show real steps:

```text
PENDING
RUNNING
COMPLETE
FAILED
BLOCKED
```

Do not perform effectful work merely because the plan exists.

---

# 17. WAVE 5 — WORK MODE

Work Mode means:

> Execute the approved plan.

Connect it to:

```text
missions
tools
workers
subagents
progress
approvals
recovery
```

Show live progress.

The island must mirror Work Mode.

---

# 18. WAVE 5 — TOOLS

Tools page must show real tools.

For each:

```text
name
risk
status
approval requirement
recent executions
executionId
worker/agent
```

Running a tool must use real KAI ToolRegistry.

---

# 19. WAVE 5 — MCP

Keep current real state:

```text
Discord → connected
Canva → blocked if transport still unsupported
```

No fake connectivity.

Show:

```text
servers
status
tools
resources
errors
authentication state
```

Do not expose credentials.

---

# 20. WAVE 6 — ISLAND

The island is a companion, NOT the main app.

Desired behavior:

### Main workspace open

Island should not compete with the workspace.

### Main workspace closed/minimized

Island remains as the lightweight KAI presence/status surface.

### KAI needs user

Island becomes visible/attention state.

### Approval required

Island displays approval.

### Important result

Island may show compact result.

---

# 21. ISLAND UI

Delete the lower bar completely.

Keep only:

```text
OPEN KAI
```

at the top.

No duplicate Open buttons.

No bottom navigation.

`OPEN KAI` should focus/open the main workspace.

---

# 22. ISLAND LIFECYCLE

Prove:

```text
KAI.exe
→ Core alive
→ island available
→ open main workspace
→ island becomes secondary
→ close main workspace
→ island returns
→ Core remains alive
→ reopen main workspace
→ same Core/session
```

---

# 23. WAVE 6 — ISLAND APPROVALS

Same approval authority as main UI.

Approve from island:

```text
→ Core
→ same approval
→ same mission
```

No duplicated approval state.

---

# 24. WAVE 7 — PERFORMANCE

The user reported severe UX lag.

Profile and fix:

```text
duplicate SSE connections
duplicate listeners
excessive API calls
unbounded state
event reprocessing
3D renderer reinitialization
large session reloads
unnecessary rerenders
```

Target smooth interaction.

Do NOT solve performance by disabling features.

---

# 25. WAVE 7 — OPEN GHOST EXPERIENCE

Once functionality is stable:

Add the useful OpenGhost-derived mechanisms:

```text
rich streaming
visual artifacts
diagrams
structured output
tool activity
agent activity
smooth rendering
```

Do NOT break working chat to add visual effects.

---

# 26. FINAL USER EXPERIENCE

The actual user flow must work:

```text
Launch KAI.exe
↓
KAI companion available
↓
Open KAI
↓
Main KAI workspace
↓
Real 3D KAI
↓
Chat
↓
Create session
↓
Rename session
↓
Open Agents
↓
Create Researcher
↓
Configure soul/personality
↓
Configure appearance
↓
Open Researcher
↓
Chat with Researcher
↓
Assign work
↓
See real activity
↓
Open Tools
↓
Run safe tool
↓
Approval
↓
Approve
↓
Open MCP
↓
See Discord
↓
Switch Plan Mode
↓
Create plan
↓
Approve
↓
Switch Work Mode
↓
Execute
↓
Character reacts
↓
Close Main Workspace
↓
Island remains
↓
Island shows progress
↓
Island requests approval
↓
Approve
↓
Open KAI
↓
Same session/mission
↓
Task finishes
```

---

# 27. ADVERSARIAL TEST

After everything works, deliberately test:

```text
Hermes OFF
Core restart
worker 404
MCP disconnect
approval rejection
approval expiration
tool failure
subagent failure
session reload
memory isolation
malicious memory
malicious visual
worker identity injection
invalid commands
rapid navigation
rapid session switching
```

Fix anything that breaks the user experience.

---

# 28. IMPORTANT — DO NOT LOSE FUNCTIONALITY FOR DESIGN

The priority is:

```text
WORKING
→ STABLE
→ USABLE
→ FAST
→ BEAUTIFUL
```

Not:

```text
BEAUTIFUL
→ BROKEN
```

---

# 29. ONE RELEASE BUILD OWNER

Only ONE integration agent runs:

```text
npx tauri build
```

Other agents can test source and units.

Before release build:

```text
stop running kai.exe
verify 8788
verify 9222
build
verify identity
launch
```

Never let four agents race `app/target`.

---

# 30. FINAL ACCEPTANCE MATRIX

Do not finish until these are all true:

```text
[ ] Chat works
[ ] same session retained after message
[ ] reload retains conversation
[ ] Hermes offline does not eject user
[ ] Sessions create
[ ] Sessions rename
[ ] Sessions search
[ ] Sessions switch
[ ] Session titles meaningful
[ ] Home useful
[ ] Commands work
[ ] Command palette works
[ ] Skills visible
[ ] Skills work
[ ] Memory visible
[ ] Memory works
[ ] Agents create
[ ] Agents edit
[ ] Agents have souls
[ ] Agents have personalities
[ ] Agents have memory
[ ] Agents have direct chats
[ ] Agents can receive work
[ ] Agents have configurable appearance
[ ] Main KAI has real 3D character
[ ] Feelings work
[ ] Auto feelings work
[ ] Manual feelings work
[ ] Appearance customization works
[ ] Plan Mode works
[ ] Plan Mode does not execute prematurely
[ ] Work Mode works
[ ] Tools work
[ ] MCP works
[ ] Approvals work
[ ] Dark mode works
[ ] Island lifecycle works
[ ] Island approval works
[ ] Island lower bar removed
[ ] Open KAI button works
[ ] Main UI and Island share state
[ ] OpenGhost visual features work
[ ] Performance is acceptable
[ ] Worker identity never leaks
```

---

# 31. DO NOT STOP WITH "MOSTLY DONE"

After each wave:

```text
inspect
build
launch
click
verify
screenshot
fix
```

If anything is missing:

```text
dispatch a new specialist
```

Continue until the acceptance matrix is complete.

---

# 32. FINAL DECLARATION

Only after the real application passes the complete user journey and the acceptance matrix may you declare:

```text
KAI READY FOR REAL USE
```

Otherwise report:

```text
KAI NOT READY
```

with exact blockers.

The final product must be:

```text
KAI = main intelligent environment
Hermes = worker
OpenCode = worker
Codex = worker
Subagents = real KAI agents
Main Workspace = primary application
Island = companion
```

Do not regress the now-fixed chat/session architecture.

Start Wave 2–7 now.
Parallelize aggressively.
Integrate carefully.
Test the real app.
Keep looping until KAI is actually usable.