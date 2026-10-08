---
name: design-ticket
description: Cuts a Spec into agent-sized tickets and drafts each ticket body as a vertical slice with the Spec's Gherkin scenarios as acceptance criteria. Use when a Spec is split into tickets, or when a single ticket is written or reshaped so an agent can implement it.
---

A ticket is one package of work an agent finishes in one pull request, reading only the ticket, its Spec and the architecture issue. Tickets cut along layers or too large leave agents half-done, in conflict with each other, or guessing at what "done" means.

## 1. Cut vertical slices

Cut the Spec so that each ticket delivers observable behaviour through every layer it needs.

- **One ticket, one pull request.** When the slice needs several unrelated changes to be reviewed, cut it again.
- **Every Gherkin scenario of the Spec belongs to exactly one ticket.** A scenario in two tickets has no owner; a scenario in none is never built.
- **No ticket without a scenario**, except the integration test ticket and enabling work. Enabling work names the scenario it enables, so it cannot drift into speculative infrastructure.
- **Independent where possible.** When one slice needs another first, note it as a dependency candidate; the architecture review decides the order.
- **Leave technical design open.** A question like "which queue" goes into the list of technical questions for the architecture issue, not into a ticket as a decision.

Always add one **integration test ticket**: it builds the test harness and writes every scenario of the Spec as an automated test tagged as pending. Pending tests are excluded from the required CI gate, because red tests there would block every other pull request. Each feature ticket removes the tag from its scenarios and makes them green.

**Done when** a coverage table maps every scenario of the Spec to exactly one ticket, and the technical questions are listed separately.

## 2. Draft the bodies

Fill [the ticket template](references/ticket-template.md) in English for every ticket.

- Copy the acceptance criteria verbatim from the Spec. A reworded scenario no longer matches its integration test.
- Scope uses the Spec's terms. Out of scope names the neighbouring behaviour and which ticket owns it.
- Leave Dependencies and Implementation notes as placeholders. They are filled from the architecture review, once the order and approach are decided.
- The title is an imperative phrase naming the behaviour ("Charge a late cancellation fee"), not the layer ("Add cancellation table").

**Done when** every ticket body is filled except Dependencies and Implementation notes, and no `<…>` is left elsewhere.

## 3. Check the cut

- Read each ticket as an agent that has never seen the conversation: can it start without asking?
- No ticket's scope overlaps another's.
- The integration test ticket lists every scenario of the Spec.

**Done when** all three hold and the coverage table and technical questions are handed to the caller alongside the tickets.
