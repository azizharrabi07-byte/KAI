---
name: composition-patterns
description: Design component APIs around composition â€” compound components, slots, and context â€” to eliminate prop drilling and configuration-object bloat. Use this skill when a component's prop list is growing, when building a reusable component for others, or when a boolean flag is about to be added to control layout.
---

# Composition Patterns Skill

## Purpose
Design component APIs around composition â€” compound components, slots, and context â€” to eliminate prop drilling and configuration-object bloat.

## When to use
Use this skill when a component's prop list is growing, when building a reusable component for others, or when a boolean flag is about to be added to control layout. Use `react-best-practices.md` for runtime performance.

## Inputs
- the component and its current API
- the variations it must support, actual and anticipated
- consumers of the component and how they use it

## Output
Return:
- the proposed API with usage examples showing the common and the awkward cases
- the implementation
- a migration path for existing call sites
- what the new API deliberately cannot express

## Constraints
- prefer `<Card><Card.Header/><Card.Body/></Card>` over `<Card title=â€¦ subtitle=â€¦ footer=â€¦ showDivider />`
- children over configuration; a prop that accepts JSX is usually a slot that should be a subcomponent
- boolean props that alter layout are a smell â€” they multiply combinatorially and most combinations are untested
- context for implicit parent-child coupling within a compound component; never as a general data bus
- keep the parent unaware of which children are present; children read from context, they are not enumerated
- forward refs and spread remaining props to the underlying element so consumers are not blocked
- an escape hatch (`className`, `asChild`, render prop) beats a growing prop surface
- do not abstract on the first repetition; two similar call sites are not yet a pattern

## Examples
- Convert a 14-prop `Modal` into a compound component
- Replace prop drilling through three layers with a scoped provider
- Design a `DataTable` API that supports custom cells without a config object
