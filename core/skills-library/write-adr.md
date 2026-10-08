---
name: write-adr
description: Proposes an ADR for a settled decision only when it is hard to reverse, surprising without context and the result of a real trade-off, writes it to the project's docs/adr/ only after Daniel's ok, with status accepted, a replaced ADR's status pointing to it and the ADR index regenerated, and leaves a declined decision where it was made. Use when Daniel answers a proposed ADR, with ok or with a no such as "that does not need an ADR", when a decision settles or Daniel confirms one, such as during an interview, a triage or an architecture review, before judging whether it deserves an ADR at all, or when a skill hands over decisions to record, such as a Spec's decisions.
---

An ADR is read by someone who was not in the conversation and wants to know why the project is the way it is. An ADR for every decision buries the few that matter; an ADR written without Daniel's ok makes a decision permanent that he never chose to record.

Run it in the main conversation: only there can Daniel give his ok.

## 1. Read docs/adr/

Read `docs/adr/README.md` at the project root and every ADR file `docs/adr/NNNN-<slug>.md` next to it. A project has one `docs/adr/`, and ADRs go there even when the decision concerns code in a subdirectory. When `docs/adr/` or its `README.md` does not exist, propose and write nothing and say: "No docs/adr/README.md at the project root. Run write-agent-docs first." Creating it here would skip the template `write-agent-docs` generates.

**Done when** the index and the ADR files are read, or the run has stopped with that sentence.

## 2. Gather the decision

For each decision settled in the conversation or handed over, take:

- the decision as Daniel confirmed it,
- the reason, in Daniel's words where he gave them,
- the options that lost, and why,
- the ADR it replaces, when the caller or the conversation names one.

Add no fact nobody stated: a reason invented here misleads every later reader.

**Done when** each decision has these parts, or a part is known to be absent.

## 3. Three criteria

A decision whose question `Write ADR NNNN <title>?` is already in the conversation passed this check when it was asked; go on with step 5.

Otherwise check the decision against what the conversation says, not against how important it feels. An ADR is proposed only when all three hold:

- **Hard to reverse:** changing it later means migrating stored data, breaking clients or links, or rewriting code across the project. A setting, a constant or a change confined to one place is easy to reverse.
- **Surprising without context:** a reader of the project without this conversation would expect something else or ask why. A choice that follows an existing ADR, a project guideline or what every similar place already does is obvious in context.
- **Real trade-off:** at least two options could work, and the chosen one gives up something another offered. When only one option works, nothing was traded.

- **All three hold:** go on with step 4.
- **One or more miss:** propose nothing, ask nothing and record or copy the decision nowhere: it already lives where it was made, and an ADR for it would bury the ones that matter. Answer in exactly this shape, naming only the first criterion it misses in the order listed above, with no word on the other criteria, because weighing those reads as arguing for an ADR:

  ```
  The decision on <what was decided, described by the choice itself> gets no ADR: it misses <criterion>, because <one-clause reason>.

  Nothing is written. The decision stays where it was made, in <place>, and is not recorded under docs/adr/ or anywhere else.
  ```

  Describe the choice in words, such as "rounding invoice totals per line", never by its label such as "option A": a label reads as one option among several still open.

  The place is where it was settled, such as the architecture review. Name no other file or directory for it, because naming one reads as moving the decision there.

**Done when** each decision holds all three criteria or has its answer in that shape.

## 4. Propose

Build the ADR from step 2:

- **Number:** the next four-digit number after the highest ADR file. Numbers are never reused or renumbered.
- **Title:** a short phrase naming what was decided, in the words the decision was confirmed in, first word capitalised. A title that names a consequence instead of the decision reads as a different decision.
- **File:** `docs/adr/NNNN-<slug>.md`, the slug being the title in lowercase kebab case.

Show it as plain lines, not inside a code block, so the question reads as a question, ask once, then end the turn. Open with the sentence that asks for the ok, so the question cannot be read as announcing a write:

```
<decision> is hard to reverse, surprising without context and the result of a real trade-off, so I propose recording it as a new ADR. I write nothing until you give your ok.

Proposed ADR:

docs/adr/NNNN-<slug>.md
Title: <title>
Decision: <decision>
Rejected: <options that lost>
Supersedes: ADR <NNNN> <title>

Write ADR NNNN <title>?
```

Leave out the `Supersedes` line when the decision replaces no ADR. Several decisions settled together get one proposal and one question each.

**Done when** each ADR to propose was shown with its question, and the turn ends.

## 5. Daniel's answer

Only a yes, such as "yes" or "ok", to the last question `Write ADR NNNN <title>?` for this decision writes the ADR:

- **Yes:** go on with step 6.
- **Anything else**, a no, a correction, another topic or no answer: write nothing, and record or copy the decision nowhere else. Say that no ADR is written for the decision, named by what it decides, and that it stays where it was made, naming that place, such as the architecture review and its architecture issue: Daniel declined an ADR for a decision he knows, so the place he made it is where he will look for it. After a correction that changes the ADR, build it again from his words and ask again.

**Done when** each proposed ADR has Daniel's yes, or nothing is written for it.

## 6. Write

Read [references/adr-template.md](references/adr-template.md) for the ADR format and the index rules.

1. **The ADR file.** Take the file name the proposal showed, or build it as in step 4 when none was shown. Write it in the format, every paragraph and list item on one line:
   - `# NNNN — <Title>`, then `Status: accepted, YYYY-MM-DD` with today's date, the day of Daniel's ok: his ok is the acceptance, so no ADR waits as proposed.
   - `## Context`: why a decision was needed and what the options were; when it replaces an ADR, link that ADR.
   - `## Decision`: what was decided.
   - `## Verification`: only when the decision was checked, with how.
   - `## Consequences`: bullets with what becomes easier and what harder, from the trade-off.
   - `## Alternatives`: one bullet `**<option>:** <why it lost>.` per option that lost.

   Every section except Verification is there: there is no short form. Content comes from step 2 only.
2. **The replaced ADR**, when there is one: on its `Status:` line, replace only the status and its date with `superseded by [NNNN](NNNN-<slug>.md), YYYY-MM-DD`, with the new ADR's number and file and today's date. Keep any text after the date as it is, because it is part of the record, such as a link to an ADR this one superseded itself: `Status: accepted, 2026-03-02. Supersedes [0001](0001-<slug>.md).` becomes `Status: superseded by [0005](0005-<slug>.md), 2026-09-15. Supersedes [0001](0001-<slug>.md).` Every other line stays as it is: an accepted ADR is history, and only its status may point onward.
3. **The index.** Regenerate `docs/adr/README.md` as the content of the fenced `docs/adr/README.md` block, with `<<adr_index>>` replaced by the table the index rules build from every ADR file, the new and the replaced one included, ending with exactly one newline. Build the table from the files rather than editing the old one, so it equals what `write-agent-docs` generates and its next run reports `unchanged`.

**Done when** the ADR file, the replaced ADR's status line and the regenerated index are written.

## 7. Report

Name the written ADR, the replaced ADR, and `docs/adr/README.md`, and say they are changed and not committed. Committing is left to the project's change flow, like every other file a house skill writes.

**Done when** the report names every written file, or says that no ADR was written and why.
