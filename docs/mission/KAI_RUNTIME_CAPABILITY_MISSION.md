KAI IS NOW INDEPENDENT FROM HERMES.

That part is working.

KAI can identify as KAI, use its own harness/soul, and generate responses without Hermes.

DO NOT REGRESS THAT.

The next objective is to turn KAI from a basic chatbot into the full personal AI operating environment we originally designed.

The current product is missing too many runtime capabilities:

* real file/system tools
* tool execution
* MCP
* skills
* plugins
* useful commands
* proper session management
* session resume/summaries
* direct agent sessions
* real agent souls/personas/memory
* KAI memory
* KAI soul evolution
* subagent orchestration
* proper OpenGhost-style response rendering
* reliable navigation
* Plan Mode
* Work Mode
* fast streaming
* performance
* proper Home
* customization
* real runtime state instead of empty placeholders

Do not hide these gaps with fake UI.

Implement the real systems.

==================================================
0. NON-NEGOTIABLE ARCHITECTURE
==============================

KAI remains the primary runtime.

KAI owns:

* identity
* soul
* harness
* model/inference
* reasoning
* memory
* sessions
* tools
* commands
* skills
* plugins
* MCP
* agents
* subagents
* planning
* work execution
* approvals
* UI state
* event stream

Hermes is OPTIONAL and must remain optional.

OpenCode is NOT another control plane.

OpenCode is a source repository to audit for useful implementation mechanisms.

Reuse mechanisms only where technically appropriate and legally permitted by the actual repository license.

Do not import OpenCode branding, personality, identity, UI identity, or architectural ownership.

KAI must remain unmistakably KAI.

==================================================

1. FIRST: AUDIT THE CURRENT KAI RUNTIME
   ==================================================

Before changing UI, inspect the actual implementation.

Create a capability/dependency matrix covering:

* chat
* sessions
* session persistence
* session deletion
* session rename
* session search
* session summaries
* transcript storage
* memory
* soul
* file access
* search
* shell/process execution
* tools
* approvals
* MCP
* skills
* plugins
* commands
* agents
* subagents
* Plan Mode
* Work Mode
* model switching
* provider switching
* streaming
* SSE/event handling
* navigation
* routing
* Home
* performance/rendering

For each one classify:

WORKING
PARTIAL
UI-ONLY
BACKEND-ONLY
MOCKED
MISSING
BROKEN

Then fix the underlying capability instead of creating another visual placeholder.

==================================================
2. FIX THE "PROMPT SENDS ME BACK HOME" BUG FIRST
================================================

This is a critical product bug.

When the user sends a prompt:

KAI MUST STAY IN THE CURRENT SESSION.

Never unexpectedly navigate to Home.

Inspect:

* router state
* route guards
* session hydration
* chat request lifecycle
* SSE event handling
* error boundaries
* component remounts
* session state replacement
* loading state
* failed requests
* URL changes
* React/Tauri navigation logic
* any "return home" fallback

Reproduce it.

Add a regression test.

Required:

CURRENT SESSION
→ send message
→ stream response
→ remain in CURRENT SESSION

Also test:

CURRENT SESSION
→ tool call
→ approval
→ result
→ remain in CURRENT SESSION

CURRENT SESSION
→ reload
→ restore CURRENT SESSION

Do not solve this with a hardcoded route hack.

Find and remove the actual cause.

==================================================
3. SESSIONS MUST BECOME REAL
============================

Implement a proper session system.

Every KAI session needs:

* stable ID
* title
* createdAt
* updatedAt
* lastMessageAt
* summary
* message count
* mode
* model/provider metadata if useful
* session kind
* archived/deleted state

Required operations:

NEW
RENAME
DELETE
RESTORE/RESUME
SEARCH
SWITCH
ARCHIVE

The sidebar/list must expose these actions.

Deleting a session must actually delete/archive it according to the chosen persistence model.

Do not leave dead buttons.

SESSION TITLE

Do not leave every session named "New Session".

Generate useful titles from the conversation.

Example:

"Restaurant QR SaaS Architecture"

"Fixing KAI MCP Integration"

"Study Plan — Physics Chapter 3"

SESSION SUMMARY

Every session should have a compact resumable summary.

When the user reopens a session, KAI should know:

* what the conversation was about
* what was decided
* important facts
* unfinished tasks
* important files
* last state
* next logical step

Do not send the entire lifetime transcript to the model every time.

Use a compact session summary + relevant recent context.

Add search.

Search must search:

* title
* summary
* transcript content

==================================================
4. KAI MEMORY + KAI SOUL
========================

KAI currently says it has memory, but the user cannot see or meaningfully use it.

Fix this.

Create clear memory layers:

A. SESSION MEMORY
Temporary context for the current conversation.

B. KAI MEMORY
Durable information KAI has learned about the user, projects, preferences, decisions, etc.

C. KAI SOUL
Higher-level persistent personality/relationship/preferences/state that evolves from relevant experiences.

D. AGENT MEMORY
Private memory belonging to an individual agent.

Agents must NOT accidentally share KAI's private memory.

Normal KAI conversations should contribute useful information to KAI memory.

Do not blindly store every message.

Use a memory extraction/evaluation step that identifies durable information.

Every durable memory should have provenance:

* source session
* timestamp
* category
* confidence
* origin

The Memory UI must let the user:

* inspect memories
* search memories
* remove memories
* correct memories
* understand where they came from

KAI's soul should not become random hidden prompt text.

Represent it as structured state where practical.

==================================================
5. FILE SEARCH MUST ACTUALLY WORK
=================================

Current failure:

User:
"Search inside my files."

KAI:
"Are you sure?"

User:
"Yes."

KAI:
"I don't know what you mean."

That means the model currently has no real file-search tool/function connected to its reasoning loop.

Fix this properly.

Implement real tools such as:

filesystem.list
filesystem.search
filesystem.read
filesystem.metadata

Respect sandbox/security boundaries.

When the user requests file searching:

KAI should:

1. understand the request
2. select filesystem.search
3. request approval only if policy requires it
4. execute the real tool
5. inspect results
6. continue reasoning
7. answer from the actual data

The tool result must become part of the model context.

Do not just tell the model that the tool exists.

Actually wire:

MODEL
→ TOOL SELECTION
→ TOOL EXECUTION
→ TOOL RESULT
→ MODEL
→ FINAL RESPONSE

Add real tests against files in the KAI environment.

==================================================
6. BUILD KAI'S REAL TOOL PLANE
==============================

KAI currently has essentially no useful tools.

Fix that.

Create a KAI-native tool registry.

Each tool needs:

* name
* description
* schema
* capability
* permission level
* execution handler
* timeout
* cancellation
* result format
* provenance
* error handling

Initial high-value tools:

filesystem.search
filesystem.list
filesystem.read
filesystem.write
filesystem.move
filesystem.delete

shell.exec

process.list
process.inspect

http.fetch

clipboard.read
clipboard.write

open.url

search/web research capability where available

time/date

system information

And other safe capabilities that already exist in the codebase.

Do NOT blindly enable destructive tools.

Everything must pass KAI policy/approval.

==================================================
7. SELECTIVELY TRANSPLANT OPEN CODE / OPENCODE MECHANISMS
=========================================================

Do a serious source audit of the local OpenCode backend.

Do not simply copy the entire repository.

Look specifically for mature mechanisms around:

* command parsing
* slash commands
* tool registry
* tool schemas
* tool calling loop
* MCP
* provider abstraction
* model selection
* sessions
* session compaction
* context management
* permissions
* approvals
* skills
* plugins
* file search
* shell execution
* agent spawning
* subprocess management
* event streaming
* transcript handling
* token/context compression
* resumable sessions

For every candidate mechanism produce:

SOURCE
→ what it does
→ why KAI needs it
→ license/provenance
→ KEEP/ADAPT/REWRITE/REJECT
→ exact KAI integration point

Only transplant useful backend mechanisms.

KAI's:

* identity
* soul
* memory model
* agent identity
* UI
* product semantics
* orchestration authority

remain KAI-native.

Do not turn KAI into an OpenCode clone.

==================================================
8. COMMAND SYSTEM
=================

KAI needs real slash commands.

Implement a command registry.

At minimum:

/new
/compress
/models
/providers
/tools
/skills
/agents
/mcp
/memory
/clear
/help

Add additional useful commands from the audited OpenCode mechanism set where appropriate.

Commands must actually execute.

Examples:

/new
→ create and switch to a new session

/compress
→ compact the current context while preserving important information

/models
→ show available models

/providers
→ show available providers

/tools
→ show actual KAI tools and status

/skills
→ show installed/available skills

/agents
→ show agents

/mcp
→ show MCP servers/status/tools

/memory
→ inspect KAI memory

/help
→ show available commands

Do not implement commands as fake text responses.

Use a command parser/runtime owned by KAI.

==================================================
9. COMMAND PALETTE
==================

Implement:

Ctrl+K
and Cmd+K on macOS-compatible paths.

The command palette should provide searchable actions:

* new session
* search sessions
* switch model
* switch provider
* tools
* skills
* MCP
* memory
* agents
* appearance
* settings
* Plan Mode
* Work Mode
* compress context
* clear session
* delete session

Actions must invoke the real underlying functionality.

==================================================
10. SKILLS
==========

KAI currently has no useful skill system.

Implement a KAI-native skills layer.

Audit useful skill mechanisms from OpenCode and other already-integrated open-source sources.

A skill should be able to define:

* name
* purpose
* trigger/selection description
* instructions
* optional tools
* constraints
* metadata
* version
* provenance

KAI should be able to discover relevant skills and invoke them.

The user should be able to inspect installed skills.

Do not make skills hidden prompt blobs.

Give them an actual runtime representation.

==================================================
11. PLUGINS
===========

Implement a plugin architecture only where it adds real capability.

Plugins must have:

* metadata
* capabilities
* lifecycle
* permissions
* tool exposure
* configuration
* provenance

Do not build a giant plugin marketplace now.

Build the runtime foundation.

==================================================
12. MCP
=======

KAI needs actual MCP support.

Implement or complete:

* server configuration
* discovery
* connection
* lifecycle
* tool listing
* resource listing
* invocation
* transport handling
* credentials
* permission policy
* error handling
* provenance

MCP tools should enter the same KAI tool plane.

Architecture:

KAI
→ MCP manager
→ MCP server
→ tool
→ result
→ KAI reasoning loop

Do not make MCP a separate UX universe.

==================================================
13. AGENTS / SUBAGENTS
======================

This is a major missing capability.

KAI must be able to launch subagents for specific tasks.

Example:

User:
"Build the backend for this feature."

KAI can decide:

Main KAI
→ spawn Backend Agent
→ assign task
→ monitor
→ receive result
→ evaluate
→ continue

Agent creation must be KAI-owned.

Each agent needs its own:

* name
* identity
* persona
* soul
* system instructions
* memory
* session
* tools
* capabilities
* model/provider
* appearance
* status

An agent must NEVER just be a generic Hermes identity.

==================================================
14. AGENT DIRECT SESSIONS
=========================

The user must be able to open a real session with an agent.

Example:

Agents
→ Backend Engineer
→ Open Chat

That should create/open:

AGENT SESSION

The agent replies as itself.

The session has its own transcript.

The session uses the agent's own soul/persona.

The agent accesses its own allowed memory.

Do not merely show a small "request/Bash/Approve/Reject" card.

That is not a real agent session.

==================================================
15. AGENT MEMORY ISOLATION
==========================

Agent A and Agent B should not automatically share private memories.

Each agent gets:

Private Agent Memory

KAI can selectively pass task context.

KAI can optionally read agent results.

This should be explicit.

==================================================
16. AGENT WORK ASSIGNMENT
=========================

KAI needs orchestration.

Implement concepts such as:

spawn
assign
pause
resume
cancel
inspect
message
collect_result
close

Example internal lifecycle:

KAI
→ spawn agent
→ assign task
→ agent works
→ agent requests approval if necessary
→ agent returns result
→ KAI evaluates result
→ KAI continues

KAI remains the supervisor.

==================================================
17. KAI SOUL VS AGENT SOUL
==========================

This distinction is mandatory.

KAI:

KAI SOUL
KAI MEMORY
KAI PERSONALITY

Agent:

AGENT SOUL
AGENT MEMORY
AGENT PERSONALITY

Agent conversations must not silently rewrite the wrong soul.

Normal user conversations with KAI can contribute to KAI's soul/memory.

An agent's private conversation contributes to that agent's own memory unless explicitly promoted by KAI.

==================================================
18. RESPONSE WRITING MUST BE FIXED
==================================

Current responses are ugly continuous paragraphs.

Fix this at BOTH levels:

A. MODEL INSTRUCTIONS
B. FRONTEND RENDERER

KAI should write like a competent AI coding/assistant product.

Use:

* clear headings
* short paragraphs
* bullet lists
* numbered steps
* tables where useful
* code blocks
* inline code
* emphasis
* callouts where appropriate
* structured tool results
* compact summaries
* readable spacing

Avoid giant continuous paragraphs.

Avoid meaningless repetition.

Avoid dumping internal reasoning.

Avoid excessive prose when a structured answer is better.

OPEN GHOST / OPENGHOST SOURCE

Audit the existing OpenGhost rendering mechanisms already identified in the repository.

Pay particular attention to the proven mechanisms around:

* markdown
* streaming
* syntax highlighting
* TeX
* diagrams
* rich tool/approval cards
* stream view

Use the useful rendering mechanisms, not OpenGhost branding.

The objective is:

KAI model output
→ structured streaming
→ excellent renderer
→ polished readable KAI response

Do not simply inject raw plain text into one <div>.

==================================================
19. STREAMING
=============

KAI must stream responses smoothly.

Required:

model token chunks
→ incremental response
→ incremental rendering

Avoid re-rendering the entire transcript for every token.

Use:

* append-only streaming state where possible
* memoization
* stable message IDs
* batched updates
* throttled rendering
* virtualization if transcripts become large

Tool events must stream into the same session correctly.

==================================================
20. PERFORMANCE / LAG
=====================

The current UI is laggy.

Profile before changing random things.

Measure:

* first token latency
* chat submit latency
* streaming update frequency
* transcript render cost
* memory retrieval latency
* tool execution latency
* session load latency
* navigation latency
* agent list rendering
* sidebar rendering

Look for:

* full transcript rerenders
* excessive React state propagation
* duplicate SSE listeners
* polling loops
* unnecessary fetches
* repeated model calls
* large context sent every turn
* synchronous disk work on the UI thread
* unbounded event history
* expensive markdown rendering on every token

Fix the real bottlenecks.

Target a noticeably smoother UI.

==================================================
21. SESSION CONTEXT COMPRESSION
===============================

Implement real context compression.

The purpose of:

/compress

is to reduce context size while preserving:

* goals
* decisions
* important facts
* files
* unfinished work
* constraints
* important memory references

Then continue the same session.

Do not destroy the session.

==================================================
22. PLAN MODE
=============

Plan Mode must be a real mode.

In PLAN mode KAI can:

* inspect
* reason
* search
* analyze
* create a plan

But cannot execute mutations.

The UI must clearly indicate:

PLAN MODE

No destructive/write tool execution.

==================================================
23. WORK MODE
=============

WORK MODE executes an approved plan.

Architecture:

User
→ KAI creates plan
→ user approves
→ Work Mode
→ KAI executes
→ tools/agents/MCP
→ results
→ KAI evaluates
→ final response

The user should be able to see:

* plan
* current step
* tool activity
* subagent activity
* approval state
* result

==================================================
24. HOME
========

Remove the pointless Home decoration.

The Home screen should NOT exist just to look nice.

Make it useful or make it minimal.

Useful Home content can include:

* recent sessions
* active agents
* running tasks
* pending approvals
* recent memories
* current projects
* quick actions
* system/tool status

Do not fill the screen with decorative cards that provide no information.

==================================================
25. TOOLS / SKILLS / MCP / AGENTS UI
====================================

These are operational parts of KAI, not decorative pages.

Each should reflect actual runtime state.

Example:

TOOLS
Filesystem Search — READY
Shell — APPROVAL REQUIRED
HTTP — READY
...

MCP
Discord — CONNECTED
Canva — BLOCKED / CONFIG REQUIRED

SKILLS
Research — READY
Coding — READY
...

AGENTS
Backend Engineer — IDLE
Researcher — RUNNING
...

Never show fake entries.

==================================================
26. ERROR HANDLING
==================

Never silently navigate somewhere else after an error.

Never replace a useful error with a generic Home screen.

When an operation fails:

stay in the current context
show the actual failure
preserve the user's input
allow retry
provide diagnostics where appropriate

Errors must have ownership:

KAI error
MODEL provider error
TOOL error
MCP error
AGENT error
NETWORK error

Do not incorrectly report one subsystem as another.

==================================================
27. TEST HERMES-INDEPENDENCE AGAIN
==================================

After all changes:

Kill Hermes.

KAI must STILL:

* chat
* stream
* remember
* manage sessions
* search files
* run available native tools
* use skills that do not require Hermes
* create/manage agents where supported
* plan
* operate in Work Mode where supported

Then restart Hermes.

KAI should still work normally.

Hermes should only improve optional delegated capabilities.

==================================================
28. TEST MATRIX
===============

Create a real end-to-end matrix.

CHAT
PASS

* normal chat
* streaming
* markdown
* code
* structured answers

SESSIONS
PASS

* new
* rename
* delete
* search
* resume
* summarize
* compress
* reload

FILES
PASS

* list
* search
* read

TOOLS
PASS

* discovery
* selection
* execution
* result
* approval
* error

COMMANDS
PASS

* /new
* /compress
* /models
* /providers
* /tools
* /skills
* /agents
* /mcp
* /memory

AGENTS
PASS

* create
* own identity
* own soul
* own memory
* direct session
* assign task
* return result

MEMORY
PASS

* write
* retrieve
* inspect
* delete
* provenance

MCP
PASS

* discovery
* connect
* tools
* invocation
* errors

MODES
PASS

* Plan Mode
* Work Mode

PERFORMANCE
PASS

* long conversation
* streaming
* session switching
* many agents
* tool activity

NAVIGATION
PASS

* sending a message NEVER unexpectedly returns Home

==================================================
29. DO NOT POLISH THE UI BEFORE THE RUNTIME WORKS
=================================================

Priority order:

P0
Fix navigation/session corruption.

P1
Real sessions + summaries + deletion/search.

P2
Real filesystem/tools/tool loop.

P3
Commands + command palette.

P4
Skills + plugins + MCP.

P5
Agent runtime + agent sessions + agent memory/souls.

P6
KAI memory + soul evolution.

P7
OpenGhost-style streaming/rendering.

P8
Plan Mode + Work Mode.

P9
Performance optimization.

P10
Only then polish secondary UI.

==================================================
30. IMPLEMENTATION DISCIPLINE
=============================

Do not create fake arrays.

Do not create fake tools.

Do not create fake agents.

Do not create UI-only state.

Do not create hardcoded demo results.

Do not say "implemented" until there is an actual working path.

Every capability must have:

UI
→ Core
→ runtime
→ persistence where needed
→ tests
→ real proof

Use existing KAI infrastructure whenever possible instead of creating duplicate systems.

Reuse and adapt proven OpenCode mechanisms only after auditing their implementation and license.

Keep KAI's own identity and architecture.

==================================================
31. FINAL ACCEPTANCE CRITERIA
=============================

KAI should feel like:

A REAL PERSONAL AI OPERATING ENVIRONMENT

not:

"A chatbot with a personality."

A user should be able to:

open KAI
→ create a session
→ talk naturally
→ search their files
→ use tools
→ invoke skills
→ connect MCP
→ run commands
→ inspect memory
→ resume sessions
→ create agents
→ chat directly with agents
→ assign work
→ have KAI spawn subagents
→ plan
→ approve
→ execute
→ inspect results
→ continue the conversation

while KAI remains:

KAI.

Not Hermes.
Not OpenCode.
Not a wrapper.

==================================================
32. REPORT BACK
===============

Do not only report commits.

Report:

1. What was actually implemented.
2. What remains missing.
3. Current architecture.
4. Which OpenCode mechanisms were audited.
5. Which were transplanted/adapted.
6. License/provenance decisions.
7. Exact files changed.
8. Test counts.
9. Real E2E results.
10. Performance measurements.
11. Remaining known bugs.
12. One concrete demonstration of:
    KAI → tool
    KAI → file search
    KAI → command
    KAI → agent
    KAI → memory
    KAI → MCP
    KAI → Plan Mode
    KAI → Work Mode

Do NOT stop after making the UI look complete.

The goal is a functioning KAI runtime.

KAI is the brain.
KAI owns the operating environment.
OpenCode contributes proven mechanisms where useful.
Hermes is optional delegation.

Do not reverse those roles.