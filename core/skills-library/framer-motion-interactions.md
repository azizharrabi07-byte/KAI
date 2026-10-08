---
name: framer-motion-interactions
description: Implement interface animation and micro-interactions that feel intentional â€” hover states, layout transitions, page transitions, and spring physics â€” without layout shift or frame drops. Use this skill when writing animation code in a running app.
---

# Framer Motion Interactions Skill

## Purpose
Implement interface animation and micro-interactions that feel intentional â€” hover states, layout transitions, page transitions, and spring physics â€” without layout shift or frame drops.

## When to use
Use this skill when writing animation code in a running app. Use `motion-design.md` to decide what should move and why; use this to build it.

## Inputs
- the component or route to animate
- the interaction being expressed (state change, navigation, feedback, attention)
- motion direction or brand tone
- performance budget and target devices

## Output
Return:
- the animation implementation with variants and transitions
- a timing and easing table for the interaction set, so values stay consistent
- reduced-motion fallbacks
- notes on what was deliberately left unanimated

## Constraints
- animate only `transform` and `opacity` on the hot path; animating layout properties causes jank
- durations: 100â€“200ms for state feedback, 200â€“400ms for entrances and transitions, above 500ms only for a deliberate showpiece
- use spring physics for anything that follows a gesture or pointer; use eased curves for choreographed sequences
- `layout` and `layoutId` are expensive â€” scope them to the element that actually moves
- stagger children instead of animating a list as one block, but cap total sequence length
- reserve space for entering content; never let animation cause cumulative layout shift
- honour `prefers-reduced-motion` â€” reduce to opacity or none, never leave content unreachable
- no animation on an element that carries an urgent error or validation message

## Examples
- Add hover and press states to a card grid without layout shift
- Build a route transition that preserves a shared element
- Replace scattered CSS transitions with one consistent motion token set
