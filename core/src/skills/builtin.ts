// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's BUILTIN skill library — real procedures that ship with Core, seeded
 * idempotently on every boot (an id already present is left untouched, so a
 * human's replacement of a builtin is never overwritten).
 *
 * Every entry passes the SAME `parseSkillMarkdown` validation as a staged
 * third-party skill: builtins are trusted by authorship, not by a bypass.
 * They are read-only procedures (search, read, recall, report) — a builtin
 * never performs a mutation, so none needs an approval to be READ.
 *
 * Four entries are KAI-original; eight more are KAI-authored adaptations of
 * strong third-party workflows (MuseAI-Skills audit, docs/evidence/
 * MUSE_SKILLS_AUDIT.md): independently implemented in KAI's voice for KAI's
 * runtime, never copied — the source repo grants no clear reuse license.
 */

export interface BuiltinSkill {
  id: string;
  markdown: string;
}

const DEEP_RESEARCH = `---
name: deep-research
description: >
  Use when the user needs broad parallel research across many independent
  inputs that must all return the same shaped answer — screening vendors,
  candidates, papers, or options against one shared schema. Trigger on
  "research each of these", "compare all of these", "screen this list", or
  "look into every item below". Do NOT use for a single-item lookup, for
  subtasks that depend on each other's results, or when no common output
  shape exists.
purpose: Run one research brief across many independent inputs in parallel, then merge per-input findings into a coverage-tracked, verified deliverable.
tools: filesystem.search, filesystem.read, memory.list, missions.list, agents.list
constraints: |
  One shared output schema governs every line of inquiry; no line may invent its own fields.
  Lines of inquiry stay independent; a line that needs another line's result is out of scope.
  Deduplicate inputs before fan-out; never research the same item twice.
  Retry each failed line exactly once, then record it as a failure and move on.
  Report coverage explicitly: totals, successes, failures, and what is missing.
  Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.
tags: research, parallel, synthesis, coverage, verification
version: 2.0.0
license: MIT
---

## TRIGGER

Use this skill when a request names a set of independent items and one question to answer about every item: screening vendors, comparing candidates, surveying papers, checking a list of options against the same criteria. Signal phrases include "research each of these", "compare all of these", "screen this list", and "look into every item below".

Do NOT use it for a single-item lookup (answer directly), for subtasks that depend on each other's results (plan them in order instead), or when the items cannot share one output shape (fix the shape first, or split the request).

## CONTEXT

You are the coordinator of parallel lines of inquiry, not the researcher. Your job is to frame the work once, run one line per input against the same schema, track what is covered and what failed, then merge the findings into a single verified deliverable. One brief, one schema, many lines, one report. Never start lines before the brief and schema are fixed; rework discovered mid-flight means the framing was wrong, so fix the framing and rerun only the affected lines.

## METHOD

1. Intake and normalize. Restate the operation brief in one sentence. List every input explicitly, normalize spellings and variants, and drop exact duplicates before fan-out. If two inputs turn out to be the same item, say so in the notes rather than researching twice.
2. Fix the shared schema. Define the minimal typed fields every line must return (for example: verdict, key facts, evidence, confidence). Small beats complete: fields nobody will read invite invention. Every line returns exactly this shape plus its input id.
3. Fan out. Open one line of inquiry per input and run the lines concurrently. Lines never talk to each other and never share partial results; a line that needs another line's answer is a dependent subtask and does not belong here. Reply to the user immediately with the plan (brief, input count, schema) instead of going silent.
4. Track coverage live. Keep a running ledger: total inputs, completed, failed, still open. The ledger is part of the deliverable, not scratch bookkeeping.
5. Retry failed lines once. A line that errors or returns an unusable shape gets exactly one retry with a narrower instruction. A second failure becomes a failure record with its cause, not a silent drop and not an endless loop.
6. Synthesize. Merge per-input results into the comparison the user asked for: rankings, tables, common patterns, disagreements between sources. Keep per-input evidence attached to per-input claims; synthesis conclusions must cite which inputs support them.
7. Verify the deliverable. Confirm every input appears exactly once across results and failures, counts reconcile, every result matches the schema, and failures name their cause. Only then write the user-facing coverage report.

## TOOLS

- filesystem.search and filesystem.read: locate and read source material for each line of inquiry.
- memory.list: check whether prior work already answered an input before spending a line on it.
- missions.list: track the open lines of inquiry and their states where the workspace supports it.
- agents.list: confirm capacity before fanning out; keep concurrency bounded and observable.
- Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.

## CONSTRAINTS

- One schema governs every line; no line invents fields or changes types.
- Lines stay independent; dependent work is planned separately, never smuggled into a line.
- Inputs are deduplicated before fan-out; the same item is never researched twice.
- Each failed line is retried exactly once, then recorded as a failure with its cause.
- Coverage is reported explicitly: totals, successes, failures, and what remains unknown.
- Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.

## OUTPUT CONTRACT

Return two parts. First, a machine-shaped summary: total inputs, success count, failure count, a results array (one entry per success, each matching the shared schema and carrying its input id), a failures array (one entry per failure: input id plus cause), and short notes (dedupe decisions, retries, caveats). Second, a user-facing coverage report: what was asked, what was found per input in plain language, what failed and why, and what is still unknown. Never present partial coverage as complete; the counts must reconcile (successes plus failures equals total).

## VERIFICATION

Before delivering, confirm: every input appears exactly once across results and failures; success plus failure counts equal the total; every result conforms to the shared schema; every failure names a cause; no duplicate inputs were researched; synthesis claims cite their supporting inputs; the coverage report states what is missing. Re-read the deliverable once against this list; fix and re-check any miss before sending.
`;

const SESSION_BRIEFING = `---
name: Session Briefing
description: Hand over a session as a crisp briefing.
purpose: Summarise a conversation's state, open questions and next actions.
tools: memory.list, missions.list
constraints: Read-only, no new tasks
tags: [handover]
---

# Session Briefing

1. Read the session transcript in full, oldest first.
2. Write the briefing in four parts: decided, still open, next actions, things to remember.
3. Keep each part to five bullets or fewer. Quote the transcript for anything contentious.
4. Never invent follow-ups: an action is listed only if someone in the transcript asked for it.
`;

const PLAN_REVIEW = `---
name: Plan Review
description: Critique a draft plan before it runs.
purpose: Find the holes in a plan while it is still cheap to fix them.
tools: missions.list, filesystem.read
constraints: Read-only, advisory only
tags: [review]
---

# Plan Review

1. Read the plan end to end, then read every file it names.
2. Check each step for: a missing precondition, an irreversible action, an approval it forgot to ask for, a success criterion that cannot be observed.
3. Report findings as must-fix versus nice-to-have, each with the step number and the evidence.
4. End with a verdict: ready, ready with fixes, or not ready. Never rewrite the plan yourself.
`;

const FACT_CHECK = `---
name: Fact Check
description: Verify claims against workspace files.
purpose: Confirm or refute a list of claims with file evidence.
tools: filesystem.search, filesystem.read, memory.list
constraints: Read-only, quote sources
tags: [verification]
---

# Fact Check

1. Take each claim separately. Search the workspace for the exact terms first, then for synonyms.
2. Read the surrounding context of every hit; a matching word in an unrelated paragraph is not confirmation.
3. Grade each claim: confirmed, refuted, or unverifiable — with a one-line quote for the first two.
4. An unverifiable claim is reported as such, never filled in from general knowledge.
`;

const SKILL_CREATOR = `---
name: skill-creator
description: >
  Use when the user asks to create, update, or review a KAI skill file
  (SKILL.md): packaging a new capability, fixing trigger wording, or
  diagnosing a skill that will not load. Trigger on "create a skill", "make
  this a skill", "update the skill", or "why won't this skill load". Do NOT
  use for ordinary documents, prompts, checklists, or credential storage —
  skills are narrow, triggerable guidance, not general storage.
purpose: Author narrow triggerable KAI skills with a short operational core body and bulk detail in conditional references.
tools: filesystem.read, filesystem.list, filesystem.metadata, system.get_status
constraints: |
  Keep the SKILL.md core short and operational; move bulk detail to references.
  Frontmatter name and description are required; description must state WHEN the skill fires.
  Only known frontmatter keys are allowed; unknown keys refuse the file.
  Tool ids must be real KAI tool ids; never invent tool names.
  No download-and-execute shapes and no encoded opaque blobs as content.
  Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.
tags: skills, authoring, validation, triggers
version: 1.0.0
license: MIT
---

## TRIGGER

Use this skill when the user asks to create, update, or review a KAI skill: "create a skill for X", "make this a skill", "update the skill", "why won't this skill load", or "review this SKILL.md". The finished skill must pass the same test: its description states WHEN it fires in plain trigger phrases, so the router can reach for it without guessing.

Do NOT use it for ordinary documents, prompts, checklists, or credential storage. A skill is narrow, triggerable guidance that changes behavior at a decision point. If the content has no clear trigger moment, it is a note, not a skill — file it as one.

## CONTEXT

A KAI skill is a SKILL.md file: a small frontmatter header (identity plus limits the skill declares for itself) over a short operational body (what to do when triggered). Bulk detail — catalogs, examples, long procedures — lives in conditionally loaded references, never in the core. The core must stay small enough to read on every firing; references load only when the task at hand needs them. Author for the router first (can it find this skill?) and the reader second (can it act in one pass?).

## METHOD

1. Intake three things: the capability (what behavior changes), the trigger phrases (the user's words that should fire it), and the target skill id and path. If the capability overlaps an existing skill, extend that skill instead of authoring a rival.
2. Draft the frontmatter: a unique kebab-case name, a description that states WHEN to use the skill plus what it does, a short purpose line, the only tools it may use, and its self-declared constraints. No other keys; unknown keys refuse the file.
3. Draft the core body with TRIGGER, CONTEXT, METHOD, TOOLS, CONSTRAINTS, OUTPUT CONTRACT, and VERIFICATION sections. Short numbered steps, each step checkable. Cut anything the reader does not need on a routine firing.
4. Split bulk to references. Move catalogs, long examples, and rare branches into reference files the core points at conditionally ("load X only when Y"). The core keeps the decision; the reference keeps the detail.
5. Declare boundaries. State what the skill never does (for example: never runs unapproved tools, never stores secrets, never widens its own scope) alongside its validation limits.
6. Validate before finishing. Run the file through the KAI skill validator and fix every refusal; a skill that does not parse is not done.

## TOOLS

- filesystem.read and filesystem.list: inspect the target skill path and neighboring skills for overlap before authoring.
- filesystem.metadata: confirm the size and shape of the draft against the file limits.
- system.get_status: confirm workspace state where the authoring workflow needs it.
- Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.

## CONSTRAINTS

- Whole SKILL.md stays at or under 64KB; the core body stays short and operational.
- Frontmatter name and description are required; description must state WHEN the skill fires.
- Only known frontmatter keys are allowed; unknown keys refuse the file.
- Tool ids must be real KAI tool ids; never invent tool names.
- No download-and-execute shapes and no encoded opaque blobs as content.
- Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.

## OUTPUT CONTRACT

Deliver the SKILL.md file at its target path plus a short authoring note: the skill id, its trigger phrases, which references were created and when each loads, and the validator result. If an existing skill was extended instead, name it and describe what changed. Never deliver a skill that has not passed validation.

## VERIFICATION

Confirm before delivery: the file parses with the KAI skill validator and reports no issues; the name is unique kebab-case within its library; the description states WHEN to use it; the body covers TRIGGER, CONTEXT, METHOD, TOOLS, CONSTRAINTS, OUTPUT CONTRACT, and VERIFICATION; bulk detail sits in conditional references, not the core; there are no unknown frontmatter keys, no invented tool names, and no unapproved execution shapes; boundaries state what the skill never does. Re-run the validator after any fix.
`;

const ARTIFACT_VERIFICATION = `---
name: artifact-verification
description: >
  Use when a created deliverable must be checked before it reaches the user:
  documents, slide decks, spreadsheets, CSVs, PDFs, or rendered markdown.
  Trigger on "check this deliverable", "verify the deck", "is this PDF
  right", or any pre-send quality gate at the end of a build. Do NOT use to
  build or repair the artifact itself — this skill verifies; the builder
  skill creates.
purpose: Gate every file deliverable through generate, validate, render, inspect, verify, deliver before its link reaches the user.
tools: filesystem.read, filesystem.list, filesystem.metadata, system.get_status
constraints: |
  Every deliverable is opened fresh at delivery time; generator claims are never evidence.
  Existence, format, readability, content spot-checks, and corruption checks all run; no stage is skipped.
  Placeholder and filler text fails the artifact wherever it appears.
  At most three verification attempts per deliverable; then stop and ask the user.
  This skill verifies; it never rebuilds, and it never replaces the builder skill.
  Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.
tags: artifacts, verification, quality, delivery
version: 1.0.0
license: MIT
---

## TRIGGER

Use this skill after any builder produces a file deliverable and before its link reaches the user: documents, slide decks, spreadsheets, CSVs, PDFs, and rendered markdown. Signal phrases include "check this deliverable", "verify the deck", "is this PDF right", and any pre-send quality gate. It also fires automatically at the end of a build: no deliverable ships without passing through it.

It complements builder skills; it never replaces them. Builders create, this skill verifies. Do not rebuild inside verification and do not re-verify inside the builder — report failures back with specifics so the builder can fix them.

## CONTEXT

You are the last gate before delivery. Trust nothing from the generator: open the artifact fresh, check it the way the recipient will receive it, and judge with your own reads rather than the builder's claims. A deliverable passes only when it exists where promised, opens in its stated format, reads cleanly end to end, shows the expected content on spot-checks, and carries no corruption or leftover filler. Anything less is a failure with a specific cause, never a shrug.

## METHOD

Run the six stages in order, GENERATE to DELIVER:

1. GENERATE is the builder's job, already done. Collect the artifact kind, its path, and what the recipient was promised; verification starts from the promise, not the file.
2. VALIDATE the container. Confirm the file exists at the promised path, its format matches its extension, and it parses with an independent read (not the tool that wrote it). A file that will not parse is corrupt — stop here and report it.
3. RENDER it fresh. View the artifact exactly as the recipient will: page through documents and sheets, open the deck slide by slide, read the PDF end to end. Never judge from the generator's preview or from memory of what was requested.
4. INSPECT the render. Check layout and finish: overflow, collisions, spacing, contrast, and decoration on every page or slide; then scan all visible text for filler and leftovers such as TODO markers, placeholder headings, empty charts, and sample text that was never replaced.
5. VERIFY the content. Spot-check claims, numbers, and names against the brief; confirm the structure matches what was promised (page counts, slide counts, sheet tabs, sections). Three attempts maximum: after a third failed gate, stop and ask the user how to proceed instead of looping.
6. DELIVER or report. On a pass, hand over the link with a one-line verification note (what was checked). On a fail, return the specific cause plus the evidence, never a bare rejection.

## TOOLS

- filesystem.metadata: confirm the artifact exists, its size is plausible, and its format matches the promise.
- filesystem.read and filesystem.list: open the artifact and its siblings with an independent read for parse and spot-checks.
- system.get_status: confirm the workspace can render and inspect the artifact kind at hand.
- Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.

## CONSTRAINTS

- Every deliverable is opened fresh at delivery time; generator claims are never evidence.
- Existence, format, readability, content spot-checks, and corruption checks all run; no stage is skipped.
- Placeholder and filler text fails the artifact wherever it appears.
- At most three verification attempts per deliverable; then stop and ask the user.
- This skill verifies; it never rebuilds, and it never replaces the builder skill.
- Skills guide; tools run declaration, policy, approval, execution; nothing bypasses approval.

## OUTPUT CONTRACT

Return a verdict plus evidence. On a pass: PASS, the artifact path, and a one-line note of what was checked (pages or slides viewed, spot-checks run). On a fail: FAIL, the stage that caught it, the specific cause, and the evidence that shows it (page or slide reference, quoted text, read error). A fail always says what the builder must fix; a pass always says what was actually looked at.

## VERIFICATION

Confirm before the handover: the file exists at the promised path and opens in its stated format; the render viewed is fresh, not the generator's preview; every page or slide was inspected for layout faults; the full text was scanned for filler; content spot-checks trace to the brief; the attempt count stayed within three; the verdict carries its evidence. Only a deliverable that clears every check ships.
`;

const GOAL_TRACKING = `---
name: goal-tracking
description: Use when the user wants to define a new personal goal or get support on an existing one such as progress check-ins and reflection prompts across career and health and money and productivity and relationships and interests.
purpose: Capture each goal once in durable memory and support steady progress through missions and session tasks and honest progress reviews.
tools: memory.list, missions.list, filesystem.read, filesystem.search, filesystem.list, system.get_status
constraints:
- Run intake exactly once per goal and never re-run it unless the user explicitly asks
- Treat an existing goal record as the contract and do not rebuild it from files unprompted
- Store the goal in memory and track work in missions and session tasks without duplicating state
- Keep progress reviews honest about what is done and what is still open
- Ask for the smallest missing detail only and proceed with sensible defaults otherwise
- Never invent progress or backfill check-ins the user did not report
- Keep goal content private to the user session and never share it across personas
- Prefer short check-ins over long reports unless the user asks for depth
tags: goals, tracking, habits, missions, memory, planning
version: 1.0.0
license: MIT
---

## TRIGGER

Use this skill when the user asks to create a goal or work on one they already have. Typical signals are phrases like set a goal for me or track my progress or weekly check-in or help me stay on track. First decide which mode applies. If no stored goal record exists for the topic then run intake. If a record already exists then give ongoing support and never replay the intake questions blindly. A casual mention of a past aim with no request for help does not trigger this skill.

## CONTEXT

KAI tracks goals in three connected layers. Durable memory holds the goal record itself with the category and the commitment in the user's own words and the measure of success and the review cadence. Missions hold multi-session work that moves the goal forward. Session tasks hold today's concrete actions. Memory is the source of truth while missions and tasks mirror it and never replace it. Always load all three before acting by listing stored memory entries and open missions and current session state so that advice rests on the recorded goal rather than on guesswork.

## METHOD

Phase A is intake and it runs exactly once per goal. One, confirm the category such as career or health or money or productivity or relationships or interests or something else. Two, capture the commitment in one or two sentences using the user's own words. Three, agree on a measure that shows progress and a cadence for check-ins such as weekly or monthly. Four, store the record once in durable memory and create the first mission or session task from it. Then stop asking intake questions. Phase B is ongoing support. Open each session by re-reading the stored record. Compare reported progress against the agreed measure. Update the linked mission or session task to reflect what is done and what is next. Close with a short reflection of one win and one obstacle and one next action. If the user changes direction then update the existing record rather than starting a second intake.

## TOOLS

memory.list finds existing goal records and prevents duplicate intake. missions.list shows open mission items linked to the goal. filesystem.search with filesystem.read and filesystem.list locate goal notes the user keeps on disk. system.get_status reports current session state for grounding check-ins. Saving the goal record and creating or updating missions and session tasks goes through the agent's standard write paths and each write is confirmed back to the user in plain language.

## CONSTRAINTS

Run intake exactly once per goal and only again on explicit request. Treat the stored record as the contract. Keep memory as source of truth with missions and tasks as mirrors. Report progress honestly with done and open items separated. Ask only for the smallest missing detail and otherwise proceed with sensible defaults. Never invent progress or backfill check-ins. Keep goal content private to this user. Prefer short check-ins over long reports.

## OUTPUT CONTRACT

Intake returns the goal statement plus category plus measure plus cadence plus where the record was stored plus the first mission or task created. Ongoing support returns a brief status of done versus open plus updated missions or tasks plus one reflection with a win and an obstacle and a next action. Every response states which stored record it is based on so the user can correct it.

## VERIFICATION

After intake re-read the stored memory record and confirm the category and commitment and measure and cadence match what the user agreed. After support confirm the linked mission or task reflects the new state. If any layer disagrees then surface the mismatch to the user instead of silently overwriting. Close by naming the record and the next check-in date.
`;

const MEMORY_FORGETTING = `---
name: memory-forgetting
description: Use when the user explicitly asks KAI to forget a stored fact or preference or relationship detail or topic or event. Do not use for casual phrases like forget it that mean cancel or move on.
purpose: Remove a stored item with clearly stated bounds by inventorying every store first and deleting only what the architecture allows and verifying the result.
tools: memory.list, filesystem.search, filesystem.read, filesystem.list, agents.list, system.get_status
constraints:
- Inventory every store before promising anything and state the exact bounds of the deletion
- Never promise complete deletion across transcripts and summaries and ledgers and other personas
- Delete canonical memory entries only through the policy-gated path and only after explicit confirmation
- Require explicit user confirmation after showing scope and irreversibility and limits
- Remove exact entries only and never bulk delete or guess at related records
- Verify with a fresh read after deletion and report forgotten only on a clean check
- Preserve unrelated memories and keep a deletion note without the deleted content
- Treat ambiguous cancel phrases as out of scope and ask before acting
tags: memory, forgetting, privacy, deletion, cleanup
version: 1.0.0
license: MIT
---

## TRIGGER

Use this skill only when the user explicitly asks KAI to forget something stored. Signals are phrases like forget that or do not remember this or remove this from memory. A bare forget it usually means cancel or move on and is out of scope so ask what the user means before touching any store. Never trigger on vague discomfort without a concrete subject. The subject must name a fact or preference or relationship detail or topic or event.

## CONTEXT

One forget request can touch up to six different stores and they do not share a single delete button. One is canonical KAI memory entries which support policy-gated deletion through the memory.forget path. Two is the session transcript itself which is the record of this conversation. Three is summaries derived from the transcript which may restate the item in compressed form. Four is approval ledger entries which record that an action was authorised. Five is other personas' memories which belong to separate scopes and are never touched by one persona's request. Six is agent memory with local caches and derived records such as indexes or notes that repeat the item. The skill must inventory all six before promising anything and must state exact bounds. Canonical entries can be deleted while transcripts and derived summaries and ledger entries and other personas' memories are not covered by that one deletion.

## METHOD

Step one is plan and it is read-only. Locate the item with memory.list and filesystem.search and filesystem.read without changing anything. Build an inventory that lists each store with whether the item is present there and whether deletion is possible there. Step two is disclosure. Show the user the scope plus the irreversible nature of deletion plus the limits named above and ask for explicit confirmation. Proceed only on a clear yes. Step three is execute. Delete the canonical memory entry through the policy-gated path and remove exact local copies such as the user's own cached note identified by exact path. Never bulk delete and never guess at related records. Step four is refresh and verify. Re-read every store from step one with fresh calls and confirm the canonical entry is gone. Report forgotten only for stores verified clean and name each remaining store honestly as still present in transcript or summary or ledger or another persona with the reason that store is out of reach of this deletion.

## TOOLS

memory.list locates canonical entries that hold the item. filesystem.search with filesystem.read and filesystem.list find user-kept copies and cached notes on disk. agents.list identifies agent-scoped memory that may repeat the item. system.get_status grounds the check in current session state. Actual removal of a canonical entry runs only through the policy-gated deletion path after explicit user confirmation and never through the read tools above.

## CONSTRAINTS

Inventory every store before promising anything. State exact bounds and never promise complete deletion. Delete canonical entries only through the policy-gated path after explicit confirmation. Show scope plus irreversibility plus limits before acting. Remove exact entries only with no bulk deletes. Verify with fresh reads and report forgotten only on a clean check. Preserve unrelated memories and keep any deletion note free of the deleted content. Treat ambiguous cancel phrases as out of scope.

## OUTPUT CONTRACT

Planning returns the subject plus a per-store inventory of present or absent with deletable or not plus the explicit confirmation question. Execution returns per-store results of removed or retained with reason plus the fresh-read evidence for each removed store. Any retained occurrence is cited by location only and never restated in full.

## VERIFICATION

Run fresh memory.list and filesystem reads after deletion and confirm the canonical entry no longer appears. Confirm unrelated memories are untouched by spot-checking neighbouring entries. Confirm no confirmation was skipped by citing the user's explicit yes. If any check fails then say so plainly and offer the narrowest next step such as deleting one more exact copy the user approves.
`;

const TRAVEL_PLANNING = `---
name: travel-planning
description: Use when the user wants help planning a trip covering feasibility and options and logistics and packing checklists. Keep live availability and booking and transactions separate as an approval-gated step after planning is done.
purpose: Turn an open trip idea into a decision-ready plan from a smallest-useful-brief and hand off only confirmed choices to approval-gated booking.
tools: filesystem.search, filesystem.read, filesystem.list, memory.list, agents.list, system.get_status
constraints:
- Keep research and planning read-only and separate from booking and transactions
- Collect the smallest-useful-brief first and skip intake for concrete quick bookings
- Recheck live availability before claiming anything is bookable or priced
- Never present a research price as a locked booking or a held reservation
- Never treat a price check as booking intent without explicit user confirmation
- Finish planning before booking unless the user asks to jump ahead
- State the source and freshness of every price and schedule and requirement cited
- Require explicit approval before any transaction or reservation or purchase
tags: travel, planning, trips, booking, logistics
version: 1.0.0
license: MIT
---

## TRIGGER

Use this skill when a trip needs planning or logistics or feasibility or entry and transit checks. There are two entry paths. Open choice means the user has an idea but no fixed bookings so run the smallest-useful-brief intake below and then research. Concrete item means the user names something specific to secure such as one flight or one hotel night so skip the intake and move straight to the booking handoff. Never treat a price check as booking intent and never pick a final proposal from research alone without the user's decision.

## CONTEXT

Planning and booking have different owners. Planning owns structure and research and feasibility and logistics and checklists and it is read-only with places and options and comparisons and requirements. Booking owns live availability and live prices and fare terms and transactions. A research result is never a reservation and a quoted price is never a locked fare until a live check at booking time says so. Respect finish planning first by holding open questions until the user decides unless they explicitly ask to jump ahead to booking.

## METHOD

Step one is the smallest-useful-brief. Ask only for anchors and travelers and constraints plus bases and dates with flex plus budget meaning plus pace and interests and exclusions plus cabin and connection and stay and transport prefs. Use calendar or mail evidence the user offers and never mine private sources in shared chats. Step two is read-only research. Gather feasible options and compare them on cost and time and comfort and risk such as visas and transit rules. Step three is the decision-ready plan with a shortlist and trade-offs plus a recommended order of booking plus a checklist of documents and deadlines. Step four is the booking handoff for each confirmed choice. Restate exactly what was approved and require a live availability and price and terms check immediately before any transaction and require explicit user approval for that transaction. Report the live result before and after the action with source and freshness.

## TOOLS

filesystem.search with filesystem.read and filesystem.list retrieve saved itineraries and travel notes and packing lists. memory.list recalls traveler prefs and past trips and constraints the user already stated. agents.list finds agent support for parallel option gathering. system.get_status grounds dates and session state. Live availability with reservations and purchases runs only through the approval-gated booking path after explicit user confirmation and is never executed by the research tools above.

## CONSTRAINTS

Keep research read-only and separate from booking. Take the smallest-useful-brief first and skip intake for concrete items. Recheck live availability before claiming anything is bookable or priced. Never present research prices as locked bookings. Never read a price check as booking intent. Finish planning before booking unless asked otherwise. State source and freshness for every price and schedule and requirement. Require explicit approval before any transaction.

## OUTPUT CONTRACT

Planning returns the brief as understood plus a compared shortlist with trade-offs plus a recommended booking order plus open questions plus a documents and deadlines checklist. The booking handoff returns the exact approved item plus the live availability result with source and time plus the terms plus the explicit approval request plus the post-action confirmation. Anything not yet live-checked is labelled as research only.

## VERIFICATION

Before handoff confirm every price and schedule cites its source and time. Confirm the live availability check ran immediately before the transaction and not hours earlier. Confirm the user's explicit approval names the exact item and amount. After any action confirm what was reserved or that nothing was and state the next step plainly.
`;

const CONNECTOR_WORKFLOW = `---
name: connector-workflow
description: "Use when the user asks KAI to read, write, or act through an external connector or integration (mail, calendar, drive, tasks, tickets, or any third-party service): first prove the connector is registered, credentialed, and approved, and stop with an exact missing-item report if any check fails."
purpose: "Enforce the dormant-capability rule for external connectors: declare what is needed, verify live catalogue, credentials, and approvals, then execute inside approval. Never assume access."
tools:
  - system.get_status
  - skills.list
  - skills.relevant
  - skills.load
  - missions.list
constraints: |
  Treat every connector as absent until proven live in this session; earlier sessions prove nothing.
  If any of catalogue, credentials, scopes, or approvals is missing, stop and report exactly what is missing.
  Never invent access, borrow another connector, or skip the declaration, policy, approval, execution order.
  Request the smallest scope and fewest operations that satisfy the task; no bulk or exploratory writes.
  Keep secrets and raw tokens out of replies, logs, and stored records; report status in plain words.
  Execute only inside an explicit approval; re-check approval when the plan or scope changes.
tags:
  - connector
  - approvals
  - workflow
  - integrations
version: 1.0.0
license: MIT
---

## TRIGGER

Start this workflow when the user asks KAI to work with an outside service: reading mail, checking a calendar, listing drive files, managing tasks or tickets, posting to a service, or connecting a new account. Also start it when a plan already in motion reaches a step that needs an external system. Do not start it for work that stays inside KAI (local files, saved memory, mission records, status checks). Those need no connector, and this workflow would only add noise.

## CONTEXT

Five layers stay separate at all times:

- Skill instructions: this file. It describes the order of work. It grants zero access by itself.
- Allowed capabilities: the tool list above. These are the only actions this workflow may use.
- Auth requirements: connector registration, account credentials, scopes, and approvals. These are live facts to observe, never assumptions.
- Execution: the actual reads or writes against the outside service. Permitted only after every check below passes.
- Verification: the evidence that each check passed and that execution stayed inside approval.

The dormant-capability rule: until catalogue, credentials, scopes, and approvals are each confirmed live in this session, the connector is dormant. Dormant means unusable, not merely unconfigured. A connector that worked yesterday, in another session, or for another user is still dormant here until re-confirmed.

The fixed order is declaration, then policy, then approval, then execution. Skipping or reordering steps is a failure even when the outcome looks correct.

## METHOD

1. Declare. Write down the connector name, the exact operations needed (read or write, and which objects), and why each one is required. Keep it to one short list, before any checking begins.
2. Check the live catalogue. Use skills.list and skills.relevant to confirm the connector entry exists right now, then skills.load and system.get_status to confirm it is reachable. Note the entry name and live status as evidence.
3. Check credentials and scopes. Confirm the account is connected and the granted scopes cover every declared operation, including any scope-add step the platform requires for a new operation. A partial scope match counts as a miss.
4. Check approvals state. Confirm which operations are pre-approved for read, which need an explicit approval phrase for write, and whether that approval was actually given for this task. Irreversible actions always need exact-text approval.
5. Stop if anything is missing. When any of steps 2 to 4 fails, stop at once: make no external call, attempt no workaround, and report exactly what is missing (catalogue entry, credential, scope, or approval), who must provide it, and the smallest next step. Then end the attempt.
6. Execute inside approval. Only when steps 2 to 4 all pass, run the declared operations in the smallest form that satisfies the task, staying inside the approved scope. Read before writing wherever the task depends on live state, and keep writes bounded and reviewable.
7. Close out. Summarise what was done in plain words, with no commands, identifiers, tokens, or raw payloads in the user-facing reply. Note any approval consumed and anything the user should reconnect or re-approve later.

## TOOLS

- system.get_status: confirm platform and integration reachability before anything else.
- skills.list: confirm the connector entry exists in the live catalogue.
- skills.relevant: match the task to the right connector entry when several exist.
- skills.load: read the connector entry detail (scopes, approval phrases, limits) before acting.
- missions.list: check whether this task already has a mission record or prior approval context to cite.

When the task needs an action none of these can perform, that is a catalogue miss: stop per step 5 and say so.

## CONSTRAINTS

- Assume absent until proven live, in this session, with cited evidence.
- One missing layer stops everything: report it exactly and end the attempt.
- Never invent access, borrow another connector, or reorder declaration, policy, approval, execution.
- Smallest scope and fewest operations; no exploratory or bulk writes.
- Secrets stay out of replies, logs, and records; plain-word status only.
- Approval is per task and per scope; a changed plan needs a fresh check.

## OUTPUT CONTRACT

Two possible outcomes, never a mixture:

- Missing report: which layer failed (catalogue, credentials, scopes, approvals), the exact item absent, who provides it, and the smallest next step. No external calls were made.
- Execution result: operations run inside approval, a plain-word summary, the approval consumed, and any follow-up the user owns (reconnect, re-approve, review). No secrets, tokens, commands, or raw payloads appear in the reply.

## VERIFICATION

Before finishing, confirm each of these and say so briefly:

- Catalogue evidence cited (entry name plus live status from this session).
- Credential and scope evidence cited (account connected, scopes covering every operation).
- Approval evidence cited (which operations were read-allowed, which were explicitly approved).
- No external call happened before all three evidences existed.
- The reply holds no secrets, tokens, commands, identifiers, or raw payloads.
- When anything was missing, no execution was attempted and the missing item was named exactly.
`;

const EXECUTION_TRACE = `---
name: execution-trace
description: "Use when the user asks what happened during a failed, stalled, or finished task and the answer must be rebuilt from KAI's own bounded operational records: task entry, session turns, tool calls, approvals, agent runs, errors, and final state."
purpose: "Reconstruct a trustworthy read-only account of a task from its own records, with stated bounds and cited evidence instead of pasted transcripts."
tools:
  - missions.list
  - memory.list
  - agents.list
  - filesystem.list
  - filesystem.read
  - filesystem.search
  - system.get_status
constraints: |
  Inspect only the records named in METHOD for the task at hand; never browse unrelated tasks or accounts.
  Read-only throughout: reconstruct and cite, never modify, delete, or re-run anything under inspection.
  Cite evidence with record names and locators; never paste full transcripts, payloads, or secrets.
  State the bounds of the inspection up front: which records were read and which were not.
  When a needed record is absent or unreadable, say so exactly instead of filling the gap by guesswork.
  Keep the account proportional: objective, plan, key steps, errors, and final state, not a replay.
tags:
  - debugging
  - traceability
  - missions
  - diagnosis
version: 1.0.0
license: MIT
---

## TRIGGER

Start this workflow when the user asks what happened during a task: why it failed, where it stopped, what it changed, whether it finished, or what to try next after a failure. Typical prompts name a task, a mission, a session, or a time window and want an honest post-mortem. Do not start it for live control (retry, fix, or continue the task). Those are separate decisions the user makes after reading the trace.

## CONTEXT

Four points keep the inspection honest:

- Skill instructions versus records: this file tells how to inspect; the records are the evidence. Reading a record grants no right to change it, delete it, or re-run it.
- Records in scope: the task entry (objective, plan, steps, verification, synthesis), session turns with tool calls, the approvals log, agent runs, error entries, and final state. METHOD names each one.
- Bounds: only the task at hand, only read-only, and cite rather than paste. Unrelated tasks, other accounts, and full message transcripts are out of scope.
- Absence is a finding: a missing or unreadable record is reported exactly by name. It is never papered over with a guess.

## METHOD

1. Fix the question. Name the task, the run or session, and the time window in one sentence before reading anything. A trace without a fixed target drifts into unrelated records.
2. Read the task record. Pull objective, plan, steps, verification criteria, and synthesis. Note what was planned versus what actually ran.
3. Read session turns and tool calls for that run only. List the key operations in order with their outcomes, skipping routine chatter and repeats.
4. Read approvals. Record what was requested, what was granted or denied, and whether execution stayed inside the grant.
5. Read agent runs. Record which agents ran, what each was given, what each returned, and where handoffs happened.
6. Collect errors. Identify the first failure with its record locator, then judge whether later steps compounded it, worked around it, or recovered cleanly.
7. Establish final state. State what is true now (completed, partial, rolled back, unknown) with the evidence behind each claim.
8. Mark the gaps. For every needed record that was absent or unreadable, log its exact name as a gap. Never infer its contents.

## TOOLS

- missions.list: locate the task entry with its plan, steps, verification, and synthesis.
- memory.list: find stored facts the task read or wrote along the way.
- agents.list: enumerate the agent runs tied to the task and their outcomes.
- filesystem.list: scope the record files (turns, tool calls, approvals, errors) before opening any of them.
- filesystem.read: read one bounded record at a time, staying inside the stated window.
- filesystem.search: locate a specific operation, error string, or approval entry across the bounded records.
- system.get_status: confirm current platform state when judging final state claims.

When a needed record sits outside these tools, that is a bound, not a license to improvise: name it as unread and continue without it.

## CONSTRAINTS

- Only the records METHOD names, only for the task at hand.
- Read-only: no edits, no deletes, no re-runs under inspection.
- Cite with names and locators; never paste transcripts, payloads, or secrets.
- Bounds stated up front; gaps named exactly, never guessed.
- Proportional length: key steps and findings, not a turn-by-turn replay.

## OUTPUT CONTRACT

Deliver one trace report with these parts:

- Question: the fixed target (task, run or session, window).
- Bounds: which records were read and which were left out or unreadable.
- Task record summary: objective, plan, steps, verification, synthesis, plus planned-versus-actual drift.
- Key steps in order, each with outcome and locator.
- Approvals: requested, granted or denied, and whether execution stayed inside grant.
- Agent runs: who ran, given what, returned what, handoffs.
- First error with locator, plus whether later steps compounded or recovered.
- Final state with evidence, and open gaps by exact name.

Every claim carries a locator. No transcripts, payloads, or secrets appear anywhere in the report.

## VERIFICATION

Before finishing, confirm each of these and say so briefly:

- The question was fixed before any record was read.
- Only in-scope records for the task at hand were touched.
- The whole inspection stayed read-only.
- Bounds and gaps are stated by exact record name.
- Every claim has a locator; nothing rests on memory or guesswork.
- No transcripts, payloads, or secrets were pasted into the report.
- The report length fits the failure: findings and evidence, not a replay.
`;

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  { id: "deep-research", markdown: DEEP_RESEARCH },
  { id: "session-briefing", markdown: SESSION_BRIEFING },
  { id: "plan-review", markdown: PLAN_REVIEW },
  { id: "fact-check", markdown: FACT_CHECK },
  { id: "skill-creator", markdown: SKILL_CREATOR },
  { id: "artifact-verification", markdown: ARTIFACT_VERIFICATION },
  { id: "goal-tracking", markdown: GOAL_TRACKING },
  { id: "memory-forgetting", markdown: MEMORY_FORGETTING },
  { id: "travel-planning", markdown: TRAVEL_PLANNING },
  { id: "connector-workflow", markdown: CONNECTOR_WORKFLOW },
  { id: "execution-trace", markdown: EXECUTION_TRACE },
];

export interface SkillSeeder {
  has(id: string): boolean;
  register(input: { id: string; markdown: string; source?: string }): { ok: boolean };
}

/**
 * Register every builtin whose id is absent. Present ids are skipped (a human
 * replacement wins), and a builtin that fails validation is REPORTED, not
 * thrown — a bad builtin must never break the boot.
 */
export function seedBuiltinSkills(registry: SkillSeeder): { seeded: string[]; skipped: string[]; failed: { id: string }[] } {
  const seeded: string[] = [];
  const skipped: string[] = [];
  const failed: { id: string }[] = [];
  for (const skill of BUILTIN_SKILLS) {
    if (registry.has(skill.id)) {
      skipped.push(skill.id);
      continue;
    }
    const result = registry.register({ id: skill.id, markdown: skill.markdown, source: "builtin" });
    if (result.ok) seeded.push(skill.id);
    else failed.push({ id: skill.id });
  }
  return { seeded, skipped, failed };
}
