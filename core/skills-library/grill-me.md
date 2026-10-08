---
name: grill-me
description: Interrogate requirements with hard technical questions before any code is written, surfacing the decisions that would otherwise be made silently. Use this skill at the start of a new project, feature, or architectural change, especially when the brief is a sentence long.
---

# Grill Me Skill

## Purpose
Interrogate requirements with hard technical questions before any code is written, surfacing the decisions that would otherwise be made silently.

## When to use
Use this skill at the start of a new project, feature, or architectural change, especially when the brief is a sentence long. Do not use it for well-specified small tasks â€” it becomes an obstacle.

## Inputs
- the project or feature idea, at whatever fidelity exists
- known constraints: stack, deadline, team, budget, compliance
- what already exists versus what is greenfield

## Output
Return:
- questions in priority order, hardest and most consequential first, grouped by area
- for each, why the answer changes the implementation
- after answers: a requirements summary, the decisions locked in, the assumptions still open, and the risks accepted

## Constraints
- ask about the things that are expensive to change later: data model, auth and tenancy boundaries, sync versus async, failure and retry semantics, migration path
- probe scale and load with numbers, not adjectives â€” records, requests per second, concurrent users, growth
- force a decision on non-functional requirements: latency target, uptime expectation, data retention, privacy and regulatory scope
- challenge the premise when the stated solution does not follow from the stated problem
- ask what happens when each external dependency fails
- establish what "done" is tested against before discussing implementation
- do not write implementation code during this skill
- stop when further questions would not change the build; unresolved items ship as recorded assumptions

## Examples
- Interrogate a "build me a booking platform" brief before starting
- Pressure-test a proposed schema change against future access patterns
- Extract real non-functional requirements from a vague performance complaint
