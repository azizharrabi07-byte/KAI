---
name: website-systems-design
description: Plan a whole website as a system — page inventory, content model, component library, and navigation — before any page is designed. Use when scoping a marketing site, product site, or multi-page rebuild, or when pages have drifted into inconsistency.
---

# Website Systems Design Skill

## Purpose
Plan a whole site as a system: page inventory, content model, shared components, navigation, and the rules that keep pages consistent.

## When to use
Use this skill when scoping a marketing site, product site, or multi-page rebuild, or when existing pages have drifted apart. Use `web-landing-page.md` for a single page and `frontend-design.md` for the visual direction.

## Inputs
- business goal and the conversion or comprehension the site must produce
- audiences and their entry points
- content that already exists, and who will maintain it
- technical constraints: framework, CMS, hosting, integrations

## Output
Return:
- a page inventory with each page's single job and primary action
- a content model: the repeating entity types, their fields, and where they render
- a component inventory, marking which components are shared and which are page-specific
- navigation and URL structure, including how the site grows without restructuring
- a build order, sequenced so shared foundations land before individual pages
- what is deliberately out of scope for the first release

## Constraints
- design the repeating type before the individual page; a site is instances of a few patterns
- every page needs one job and one primary action — a page with two jobs is two pages
- URL structure is a long-term commitment; choose it before building, not after
- keep the component inventory small; a new component needs a reason the existing ones cannot serve
- match the content model to who maintains it — a model only a developer can update will go stale
- plan empty, single-item, and overflowing states for every listing
- decide the responsive strategy at system level so pages do not each invent their own
- name the SEO and metadata pattern once, applied per template rather than per page

## Examples
- Scope a five-page marketing site with a case-study content type
- Reconcile a site whose pages have each grown their own header variant
- Plan the component library for a product site before writing any page
