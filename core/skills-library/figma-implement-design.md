---
name: figma-implement-design
description: Turn a Figma node into working code in a real codebase â€” the read-from-Figma direction. Use this skill whenever a Figma design is to be implemented, ported, or built as code.
---

# Figma Implement Design Skill

## Purpose
Turn a Figma node into working code in a real codebase â€” the read-from-Figma direction.

## When to use
Use this skill whenever a Figma design is to be implemented, ported, or built as code. Do not use it to write back into Figma. Use `frontend-design.md` when there is no design file and direction must be invented.

## Inputs
- a Figma URL containing a `node-id` (a file-only URL is not enough)
- the target project's framework, component library, and styling system
- existing design tokens and components to map onto
- which breakpoints the design covers

## Output
Return:
- the implementation in the project's real stack
- a mapping of Figma tokens and components to existing project equivalents, with gaps flagged
- an asset list for anything that must be downloaded and committed
- a discrepancy list: anything that cannot be built as drawn, with the proposed resolution

## Constraints
- pull design context on the target node before writing any code; a screenshot alone is not a substitute
- treat returned code as a **reference, not final code** â€” it arrives as React plus Tailwind and must be adapted to the project's language, framework, and conventions
- check the project for existing components, layout patterns, and tokens before generating new equivalents
- honour hints in priority order: Code Connect snippets â†’ component documentation links â†’ design annotations â†’ design tokens â†’ raw hex and absolute positioning
- absolute positioning is the weakest signal; reimplement layout with the project's own primitives
- render every icon and image from its exported asset â€” never hand-write `<svg>`/`<path>`, never leave a placeholder; you do not have the real vector data
- asset URLs expire in about seven days, so for committed code download the exact bytes or wire the image to a real data source
- reuse a project icon component only when the glyph actually matches; a name match is not enough
- size images explicitly â€” fixed container with both width and height, leaf image filling it, never `auto`
- on error, stop and read the message before retrying; on timeout, retry against a smaller node
- never invent interaction states the design omits â€” flag hover, focus, disabled, loading, empty, and error gaps
- accessibility stays non-negotiable even where the design ignores it

## Examples
- Implement a marketing hero frame against the existing token set
- Port a Figma component set into typed components with all variants
- Reconcile a redesign against the current design system and report the drift
