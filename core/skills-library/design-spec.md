---
name: design-spec
description: Drafts the body of a Spec issue that describes domain behaviour and a functional change, with a Mermaid domain flow and Gherkin acceptance criteria, never implementation. Use when a Spec is drafted from a conversation or a research object, or when an existing Spec issue is edited.
---

A Spec states what the domain does differently afterwards. It is never implemented directly: it is split into sub-issues later, and technical design belongs to the architecture issue created then. A Spec that already says how to build something gets built straight from the Spec, skipping the split.

## 1. Sort the material

Go through the source and sort every statement:

- **Into the Spec:** behaviour, domain rules, terms, actors, outcomes, domain decisions and their reasons.
- **Out of the Spec:** technologies, modules, APIs, data schemas, screens, order of work. Keep these as a separate list of technical notes and name them to the caller; they are input for the architecture issue, not lost.

When a statement is both ("orders are stored for ten years"), keep the domain rule ("an order stays retrievable for ten years") and move the mechanism to the notes.

**Done when** every statement is either in the Spec material or in the technical notes.

## 2. Fill the template

Fill [the Spec template](references/spec-template.md) in English.

- The Spec stands on its own. Its reader may never see the conversation or research object.
- Every decision carries its reason. Rejected options appear as one line each.
- Terms match `CONTEXT.md` when the project has one; a new term is defined under Terms instead of silently coined.
- Write nothing the source did not decide. A gap goes to Open questions and risks and is named to the caller.
- Origin quotes Daniel's statements verbatim, in the language he used, so the intent survives the translation into English.

**Done when** every section is filled and no `<…>` is left.

## 3. Draw the domain flow

Draw the flow as a Mermaid `flowchart TD` of the new behaviour: trigger, domain decisions as diamonds, outcomes. Label nodes with terms from the Spec and actors from the domain, not services or functions, because the diagram is the Fachlichkeit at a glance.

- Quote every label (`A["Customer cancels (late)"]`); parentheses, colons and umlauts break unquoted labels.
- Never use `end` as a node id; it closes the chart.
- Every row of Behaviour change appears as a path in the flow.

When the change has no sequence and no decision, write `No flow: <reason>` instead. The section never disappears, so a missing diagram is always a visible choice.

**Done when** the section holds a flowchart covering every behaviour change, or a `No flow` line with a reason.

## 4. Write acceptance criteria in Gherkin

One `gherkin` block with one `Feature` and its scenarios:

- At least one scenario per row of Behaviour change and per domain rule.
- `Given` a domain state, `When` a domain event, `Then` an observable outcome. No endpoints, element ids or class names; they tie the criterion to one implementation.
- One behaviour per scenario. A `Then` with several unrelated outcomes becomes separate scenarios.

These scenarios become the integration tests later, so each must be checkable from outside the system.

**Done when** every behaviour change and every domain rule is covered by a scenario.

## 5. Check the draft

- The top note says the Spec is not implementable.
- No technical note leaked into any section, the flow included.
- Non-goals name at least what a reader would otherwise assume is included.

**Done when** all three hold and the technical notes are handed to the caller alongside the draft.
