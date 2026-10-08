---
name: coding-principles
description: Apply four operating principles to every code change: think before coding, simplicity first, surgical changes, goal-driven execution. Use this skill as the default posture for any code edit.
---

# Coding Principles Skill

## Purpose
Apply four operating principles to every code change: think before coding, simplicity first, surgical changes, goal-driven execution.

## When to use
Use this skill as the default posture for any code edit. It constrains how changes are made; other skills decide what to build.

## Inputs
- the change request
- the surrounding code and its conventions
- what "working" means for this change

## Output
Return:
- a short statement of assumptions and the intended approach, before editing
- the minimal diff that satisfies the request
- the verification actually run, with its output
- anything deliberately left undone

## Constraints
- **Think before coding** â€” state assumptions and the plan explicitly before the first edit; if two readings of the request produce different code, say which one you took
- **Simplicity first** â€” the minimum code that solves the problem; no speculative abstractions, config flags, or layers for requirements that do not exist yet
- **Surgical changes** â€” touch only what the task requires; no drive-by reformatting, renaming, dependency bumps, or reorganisation of unrelated files
- **Goal-driven execution** â€” define the success test upfront and loop until it passes; a change is not done because it looks right
- match the surrounding code's idiom, naming, and comment density rather than importing a personal style
- delete code rather than commenting it out
- when a principle conflicts with an explicit instruction, the instruction wins â€” note the tension once and proceed

## Examples
- Fix a bug without refactoring the surrounding module
- Add a small feature and resist generalising it prematurely
- Review a diff for scope creep before committing
