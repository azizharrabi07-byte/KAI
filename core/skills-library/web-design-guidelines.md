---
name: web-design-guidelines
description: Audit interface code against a concise MUST/SHOULD/NEVER rule set covering interaction, animation, layout, accessibility, performance, and theming. Use this skill as a pre-merge gate on user-facing UI.
---

# Web Design Guidelines Skill

## Purpose
Audit interface code against a concise MUST/SHOULD/NEVER rule set covering interaction, animation, layout, accessibility, performance, and theming.

## When to use
Use this skill as a pre-merge gate on user-facing UI. Use `impeccable-ui.md` for design direction and craft; use this for conformance.

## Inputs
- the pages or components under review
- target breakpoints and browsers
- framework and whether the app hydrates
- any product-specific interaction requirements

## Output
Return:
- findings grouped as interactions, animation, layout, content and accessibility, performance, theming, hydration
- each finding labelled MUST / SHOULD / NEVER, with the element and the corrected code
- an explicit statement of what was not checked

## Constraints
- **Keyboard** â€” full support per WAI-ARIA APG; visible `:focus-visible` rings; managed focus (trap, move, return); never `outline: none` without a replacement
- **Targets** â€” hit target â‰¥24px, â‰¥44px on mobile; mobile `<input>` font-size â‰¥16px to prevent iOS zoom; never disable browser zoom; `touch-action: manipulation`
- **Forms** â€” never block paste; keep submit enabled until the request starts, then spinner with the original label; accept free text and validate after; allow incomplete submission to surface validation; errors inline with focus moved to the first one; `autocomplete` plus correct `type` and `inputmode`; warn on unsaved changes; label and control share one hit target
- **State** â€” URL reflects filters, tabs, pagination, expanded panels; Back/Forward restores scroll; navigation uses `<a>`/`<Link>`, never `<div onClick>`
- **Feedback** â€” confirm destructive actions or offer Undo; polite `aria-live` for toasts; optimistic UI reconciled on response
- **Animation** â€” honor `prefers-reduced-motion`; animate only `transform` and `opacity`; never animate layout props; never `transition: all`; animations interruptible, no autoplay; correct `transform-origin`
- **Layout** â€” deliberate alignment, optical Â±1px where perception beats geometry; verify mobile, laptop, and ultra-wide; respect `env(safe-area-inset-*)`; no unwanted scrollbars
- **Content and a11y** â€” no dead ends; design empty, sparse, dense, and error states; skeletons mirror final content; `tabular-nums` for compared numbers; status cues never colour-only; icon-only buttons carry `aria-label`; native semantics before ARIA; resilient to short and very long user content; locale-aware dates and numbers via `Intl`
- **Content handling** â€” text containers truncate or clamp; flex children need `min-w-0`; empty strings and arrays must not break layout
- **Performance** â€” virtualize lists over 50 items; preload above-fold images and lazy-load the rest; explicit image dimensions to prevent CLS; mutations target under 500ms; batch layout reads and writes; profile with throttling
- **Theming** â€” `color-scheme: dark` on `<html>`; `<meta name="theme-color">` matches background; native `<select>` needs explicit colours on Windows
- **Hydration** â€” inputs with `value` need `onChange` or `defaultValue`; guard date rendering against mismatch
- **Contrast** â€” meet it, preferring APCA over WCAG 2; increase contrast on hover, active, and focus

## Examples
- Audit a checkout flow before release
- Verify a data table's keyboard, truncation, and empty-state behavior
- Check a themed dashboard for dark-mode and hydration defects
