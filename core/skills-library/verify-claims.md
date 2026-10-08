---
name: verify-claims
description: Traces factual claims to the primary source that owns them and records each with source, date, version and confidence. Use when research or a design discussion rests on a fact about an API, library, standard, law or market, when a claim sounds plausible but nobody has checked it, or when reading legwork can be delegated to a background agent.
---

A claim is only as good as the source that owns it. Memory and secondary write-ups age silently, and an unchecked fact in research becomes a requirement in the spec.

## 1. Isolate the claims

Write each claim as one checkable sentence, with the version or date it depends on ("SQLite in WAL mode allows concurrent writers", not "SQLite handles concurrency").

**Done when** every claim is one sentence that a single source could confirm or contradict.

## 2. Find the owning source

The primary source is whoever owns the fact:

- **Technical**: official documentation, the specification, the source code, the changelog or release notes of the exact version in use. Prefer the Context7 docs server for libraries, fetch the page otherwise.
- **Domain**: the regulator or legal text, the standards body, the company's own publication, first-party data.

Blog posts, forum answers and AI summaries only lead to the primary source; they are never cited as the source, because they are where claims drift.

**Done when** each claim has a primary source, or the search for one is recorded as failed.

## 3. Delegate long reading

When the claims need many sources or long documents and the discussion can go on meanwhile, hand the list to a background agent with steps 1, 2 and 4 of this skill and the target `sources.md`. Keep working; merge its entries when it reports.

**Done when** every claim is either checked or assigned to a running agent.

## 4. Record

In a research object, add one row per claim to its `sources.md`:

| Claim | Source | Accessed | Version | Confidence |

- **high**: the primary source states it directly for this version.
- **medium**: the primary source implies it, or states it for a nearby version.
- **low**: no primary source found; this is an assumption.

Outside a research object, give the same fields inline with the answer.

**Done when** every checked claim has a row with all five fields.

## 5. Report back

Group the claims as **confirmed**, **contradicted** and **unverified**. Say plainly when a claim that the discussion relies on was contradicted, and keep unverified claims labelled as assumptions wherever they are used, so they are never promoted to fact by repetition.

**Done when** each claim carries one of the three labels in the answer.
