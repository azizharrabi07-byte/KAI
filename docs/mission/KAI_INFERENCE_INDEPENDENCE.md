We need to make one architectural correction before doing anything else.

KAI MUST NOT depend on Hermes to generate its normal responses.

Hermes is a worker/delegation engine only. It is NOT KAI's brain, model provider, conversation backend, identity backend, or required runtime dependency.

CURRENT PROBLEM

The current architecture still routes ordinary KAI chat through Hermes:

KAI UI → KAI Core → Hermes → model → Hermes → KAI

This is wrong for the final product.

TARGET ARCHITECTURE

KAI must own the primary intelligence path:

KAI UI
→ KAI Core
→ KAI Brain / Inference Layer
→ Model Provider
→ KAI reasoning loop
→ KAI memory / tools / planning / agents
→ response

Hermes becomes OPTIONAL:

KAI
→ decides whether delegation is useful
→ Hermes worker
→ result returned to KAI

KAI must be capable of functioning normally with Hermes completely stopped, unavailable, disconnected, or uninstalled.

HARD REQUIREMENTS

1. KAI NORMAL CHAT MUST NOT CALL HERMES

When the user sends a normal message to KAI, the request must go directly through KAI's own model/inference abstraction.

Do not use the Hermes `/v1/runs` endpoint as the normal KAI chat backend.

Do not use Hermes sessions as KAI conversation sessions.

Do not use Hermes identity/context as KAI identity/context.

Do not translate KAI chat into a Hermes chat request.

2. CREATE A REAL KAI MODEL PROVIDER ABSTRACTION

Implement a clean KAI-owned interface such as:

ModelProvider

* chat(...)
* stream(...)
* structured(...)
* embeddings(...) where needed
* health(...)
* capabilities(...)

Then provide an actual provider implementation.

The provider can use the currently available model/API configuration, but the provider must belong to KAI's architecture and must be callable without Hermes.

The exact external model provider is an implementation detail.

The critical requirement is:

KAI → ModelProvider

NOT:

KAI → Hermes → ModelProvider

3. KAI MUST OWN THE REASONING LOOP

KAI's runtime should own:

* system identity
* soul/personality
* conversation context
* memory retrieval
* tool selection
* tool execution
* approvals
* planning
* plan execution
* agent delegation
* final response generation
* streaming
* session state

Do not move these responsibilities back into Hermes.

4. HERMES BECOMES A WORKER

Hermes may remain integrated as an optional worker.

For example:

User:
"Build the restaurant QR system."

KAI:

* reasons about the request
* creates a plan
* decides whether delegation is beneficial
* optionally sends implementation work to Hermes
* receives results
* evaluates them
* continues reasoning
* reports the final result as KAI

But for:

"Hey KAI, what do you think about this?"

Hermes must not be involved at all.

5. ZERO-HERMES CHAT TEST

Create a hard proof test:

* completely terminate Hermes
* make sure its process is not running
* block/disable its port if necessary
* start KAI Core
* start KAI UI
* create a fresh KAI session
* send several normal messages
* verify KAI generates real responses
* verify streaming works
* verify memory still works
* verify session persistence works
* verify KAI personality remains KAI

The test MUST fail if KAI accidentally tries to contact Hermes.

Instrument/log the dependency path so we can prove:

normal_chat_calls_to_hermes = 0

6. HERMES FAILURE MUST NOT BECOME A KAI CHAT ERROR

Remove user-facing errors such as:

"I couldn't get a result from Hermes."

for ordinary KAI conversations.

If Hermes is offline, KAI chat should behave exactly the same as long as KAI's own model provider is available.

Only delegated jobs should report Hermes failure.

7. REMOVE HERMES SESSION COUPLING

KAI conversation IDs must remain KAI-owned.

Do not reuse Hermes session IDs as KAI session IDs.

Do not bind a KAI conversation permanently to a Hermes worker session.

KAI session persistence must survive Hermes deletion.

8. REMOVE HERMES IDENTITY FROM KAI'S RESPONSE PATH

KAI's system identity must originate from KAI's own harness/soul.

The model must receive KAI's actual identity/context from KAI Core.

Never rely on Hermes default instructions/profile to make the model behave like KAI.

9. KAI'S MEMORY MUST BELONG TO KAI

KAI retrieves and writes its own memory.

Hermes may receive selected task context when delegated, but Hermes memory must never be the authority for KAI's personal memory.

10. KAI'S TOOLS MUST BELONG TO KAI

The KAI tool registry and policy system remain KAI-owned.

KAI decides:

* whether a tool should run
* why it should run
* whether approval is required
* what arguments are allowed
* how results enter the reasoning context

Hermes can be one optional execution worker, not the owner of the KAI tool plane.

11. KAI AGENTS MUST BE KAI AGENTS

Subagents created by KAI must have:

* KAI-owned identity
* their own soul/personality
* their own memory scope
* their own session
* their own capabilities
* direct conversations
* their own appearance/configuration

They must not secretly become Hermes identities.

12. PLAN MODE / WORK MODE

PLAN MODE:

* KAI reasons and produces a plan
* no execution
* no Hermes requirement
* no external mutation

WORK MODE:

* KAI executes the approved plan
* KAI controls the execution loop
* KAI may delegate selected implementation tasks to Hermes
* KAI remains the supervisor and final authority

13. UI MUST REFLECT THIS ARCHITECTURE

Do not expose Hermes as if it were KAI's backend brain.

The main chat should simply be:

KAI

not:

KAI → Hermes

Hermes may appear under delegation/workers/integrations when appropriate.

14. AUDIT THE CURRENT CODE BEFORE MODIFYING IT

Search the entire KAI codebase for:

* Hermes chat calls
* Hermes session creation
* Hermes session IDs
* Hermes `/v1/runs`
* Hermes provider adapters
* Hermes identity injection
* Hermes-dependent fallback paths
* `"I couldn't get a result from Hermes"`
* any normal chat route that indirectly reaches Hermes

Produce a dependency map.

Classify every occurrence:

KEEP — legitimate optional worker integration
REPLACE — normal KAI intelligence path
REMOVE — accidental Hermes coupling
ADAPT — delegation-only integration

15. DO NOT FAKE THE MODEL

Do not implement hardcoded canned responses.

Do not create fake local inference.

Do not claim KAI is independent merely because Hermes is not running.

There must be a real model/inference call through a KAI-owned provider abstraction.

16. REAL E2E ACCEPTANCE TEST

The final proof must show two independent paths.

PATH A — KAI ALONE

Hermes OFF

User → KAI → model → KAI response

PASS required.

PATH B — KAI + HERMES

Hermes ON

User → KAI → model/reasoning → optional delegation → Hermes worker → result → KAI → user

PASS required.

The two paths must be independent.

FINAL ARCHITECTURAL RULE

KAI is the brain.

Hermes is a worker.

Never reverse those roles.

Do NOT spend this task polishing UI, 3D appearance, themes, or other secondary features until this dependency is actually fixed and proven.

After implementation, report:

* current KAI inference architecture
* exact files changed
* model/provider used by KAI
* all remaining Hermes dependencies
* zero-Hermes test results
* KAI-alone chat transcript/result
* KAI+Hermes delegated-work result
* commits
* test counts
* any limitations