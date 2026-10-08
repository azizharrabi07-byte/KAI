---
name: react-best-practices
description: Apply React performance rules â€” eliminating request waterfalls, controlling re-renders, virtualizing lists, and loading assets deliberately. Use this skill when a React app is slow, when reviewing a React diff for performance, or when building a data-heavy view.
---

# React Best Practices Skill

## Purpose
Apply React performance rules â€” eliminating request waterfalls, controlling re-renders, virtualizing lists, and loading assets deliberately.

## When to use
Use this skill when a React app is slow, when reviewing a React diff for performance, or when building a data-heavy view. Use `composition-patterns.md` for component API design and `web-design-guidelines.md` for the wider conformance audit.

## Inputs
- the component tree or route under review
- data fetching approach (RSC, loader, client fetch, query library)
- observed symptom plus any profiler or network trace
- performance target

## Output
Return:
- findings ordered by measured or expected impact
- the corrected code
- what to measure to confirm the fix
- rejected optimisations and why

## Constraints
- measure reliably before optimising â€” profile with CPU and network throttling, and disable extensions that skew runtime
- track and minimise re-renders with React DevTools or React Scan; do not guess at them
- fetch in parallel; sequential awaits and child-triggered fetches dominate most slow React apps
- hoist data requirements to a loader or colocate at the route; never fetch inside a component rendered in a list
- virtualize lists over 50 items
- prefer uncontrolled inputs; controlled inputs must stay cheap per keystroke
- mutations (`POST`/`PATCH`/`DELETE`) target under 500ms
- batch layout reads and writes; avoid forced reflow and repaint
- preload above-fold images and lazy-load the rest; always give images explicit dimensions to prevent CLS
- `preconnect` to CDN domains; preload critical fonts with `font-display: swap`
- subscribe to the narrowest slice of state a component needs; context holding a large object re-renders every consumer
- stabilise props and callbacks only where a memoised child depends on them; scattered `useMemo`/`useCallback` costs without benefit
- `key` must be a stable identity, never an array index for reorderable lists
- lazy-load on a real boundary â€” route, modal, heavy widget â€” always with a reserved-space fallback
- never trade correctness for renders; a stale closure is worse than a re-render

## Examples
- Diagnose a route with a three-deep request waterfall
- Fix a list that re-renders entirely on every keystroke
- Virtualize and lazy-load a heavy dashboard without introducing layout shift
