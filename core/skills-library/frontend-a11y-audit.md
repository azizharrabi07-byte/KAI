---
name: frontend-a11y-audit
description: Audit an interface for accessibility — semantic structure, keyboard and focus, contrast, and responsive behavior — and return the corrected code. Use before shipping user-facing UI, when a component must meet WCAG, or when keyboard and screen-reader behavior is unverified.
---

# Frontend Accessibility Audit Skill

## Purpose
Audit an interface for semantic structure, keyboard and focus behavior, contrast, and responsive resilience, and return the fixes.

## When to use
Use this skill before shipping user-facing UI, when a component must meet a WCAG target, or when keyboard and screen-reader behavior has never been verified. Use `web-design-guidelines.md` for the broader conformance sweep that also covers performance and theming; this skill goes deep on accessibility alone.

## Inputs
- the pages or components under review
- accessibility target, default WCAG 2.2 AA
- assistive technologies that must be supported
- known user-reported problems

## Output
Return:
- findings grouped as structure, keyboard and focus, contrast and colour, responsive and zoom, and assistive-technology naming
- each finding with the element, the failing criterion, the user impact, and the corrected code
- a pass/fail summary against the stated target
- what could not be verified without manual or screen-reader testing, stated explicitly

## Constraints
- **Structure** — one `<h1>`, headings in order with no skipped levels, landmarks (`main`, `nav`, `header`, `footer`), lists marked up as lists, tables with real headers
- native semantics before ARIA; an ARIA role patching a `<div>` that should be a `<button>` is a finding, not a fix
- **Keyboard** — every interactive element reachable, operable, and in a logical tab order; visible `:focus-visible` indicator; focus trapped in modals and returned on close; no keyboard traps
- **Naming** — icon-only controls need `aria-label`; form controls need programmatically associated labels; accessible names must match the visible label
- **Contrast** — text meets AA, non-text UI and focus indicators meet 3:1; never convey status by colour alone
- **Motion** — honour `prefers-reduced-motion`; no autoplaying or looping motion without a control
- **Responsive** — no horizontal scroll at 320px, content survives 200% zoom and 400% reflow, touch targets ≥44px, no fixed heights that clip text
- **Dynamic content** — validation errors announced and focus moved to the first one; async updates in a polite live region; loading states announced
- test with the keyboard alone before reporting; static inspection misses focus-order defects
- report severity by user impact — a keyboard trap blocks people, a marginal contrast ratio does not
- automated checks catch a minority of issues; never imply full coverage from a tool run

## Examples
- Audit a modal dialog for focus management and escape behavior
- Verify a form's error handling is announced to screen readers
- Check a data table for header semantics and zoom resilience
