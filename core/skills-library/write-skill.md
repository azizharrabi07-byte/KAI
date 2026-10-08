---
name: write-skill
description: Writes or edits a SKILL.md in the 64x-lunicorn plugin so it triggers reliably and gets followed the same way every run. Use when drafting a new skill, changing a skill's description or body, or moving skill content into reference files.
---

A skill is read by an agent that has only two things: the description, always in context, and the body, loaded once the description fires. Write both for that reader.

## 1. The one-sentence test

Say in one sentence what goes wrong when the skill does not kick in. That sentence is the skill's single job.

- Needs an "and" to be true: the skill does two jobs. Split it, unless the job *is* orchestrating the others.
- Cannot be said at all: the skill is too broad or not needed yet. Stop and name the gap instead of writing speculative content.

**Done when** the sentence exists and names one failure.

## 2. Invocation and name

- **model-invoked** when the agent must reach it on its own or another skill must call it. Holds reusable discipline.
- **user-invoked** (`disable-model-invocation: true`) when only Daniel starts it by command. Orchestrators live in `skills/orchestration/` and are always user-invoked.
- Calls go one way: user-invoked calls model-invoked. A model-invoked skill never calls a user-invoked one, and two user-invoked skills never call each other.
- Name is `<verb>-<noun>`, with the verb from `SKILL_NAME_VERBS` in `tools/validator/src/conventions.ts`. The noun names the thing the decision is about (`write-commit-message`), so the name reads as the job.

**Done when** category, invocation and name follow from the sentence in step 1.

## 3. The description

The description is the only API: it sits in context every turn and decides whether the body ever loads.

- Open with what the skill does, in third person ("Drafts…", "Reviews…").
- Follow with `Use when` and one trigger per distinct situation, in the words Daniel actually types or the moment the agent is actually in. Synonyms for one situation count as one trigger.
- Cover the case where the need is clear but the skill's topic is never named.
- For a user-invoked skill, write one plain line a human recognises in the command list.

**Done when** each trigger maps to a real situation and none repeats another.

## 4. The body

Write what changes behaviour compared to what the agent would do anyway.

- **Steps** in the order they run, each ending on a checkable **done when**. "Every changed file accounted for" drives the work; "understand the change" invites stopping early.
- **Reasons** in a short clause next to the rule. An agent that knows why a rule exists applies it to cases the rule never listed, which a bare MUST does not achieve.
- **Positive targets.** State the behaviour you want ("write one-line comments"). Use a prohibition only as a hard guardrail, paired with the behaviour to do instead.
- **Only what the agent cannot look up.** `package.json` scripts, the validator and the directory layout are already the source of truth; point to them. Write down the unwritten convention, the reason behind a choice, the trap no config reveals.
- **Only cases that exist.** Handle the situations the skill was harvested from. Options, branches and settings for situations nobody has hit yet stay out until they happen.

**Done when** every sentence would change what the agent does if it were deleted.

## 5. Reuse and disclosure

- **Reuse a discipline by invoking its skill by name** instead of copying its steps. A shared sentence or two may be repeated in both skills; a whole procedure lives in one skill.
- **What every run needs stays in `SKILL.md`.** What only some runs need moves to `references/<topic>.md` next to it, linked with the condition for reading it, for example "For Swift projects, read `references/swift.md`" written as a Markdown link.
- One level of references. A reference file does not point to further files.

**Done when** the body holds only what every run needs and each reference link says when to follow it.

## 6. Check

1. Read the description alone, as if it were the only line you saw: would it fire on the triggers from step 3, and stay quiet on neighbouring requests?
2. At least one eval case exists under `evals/<name>/<case>/prompt.md`, phrased the way Daniel would ask.
3. `npm run validate` passes. The validator owns lengths, fields, naming, links and registration; fix findings there instead of restating its limits in the skill.

**Done when** all three hold.
