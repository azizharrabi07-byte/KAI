---
name: perplexity-research
description: Answer a question by searching, reading real sources, and synthesizing a cited brief with an explicit recommendation. Use when a question needs current or external evidence rather than recall, when options must be compared on stated criteria, or when a claim needs verifying against primary sources.
---

# Perplexity Research Skill

## Purpose
Answer a question by searching, reading real sources, and synthesizing a cited brief that ends in a recommendation.

## When to use
Use this skill when the answer depends on current or external evidence rather than recall, when options must be compared, or when a claim needs verifying. Use `research.md` for lightweight internal synthesis where no sources need fetching.

## Inputs
- the question, stated precisely
- decision criteria or constraints that make one answer better than another
- recency requirement — how stale an answer is acceptable
- any sources the user already trusts or rejects

## Output
Return:
- a direct answer in the first two sentences, before any evidence
- the evidence, each claim carrying an inline citation to a source actually read
- a comparison table when the question is a choice between options
- the recommendation, with the condition under which it would change
- open questions and what could not be verified

## Constraints
- search broadly, then read the primary source; never cite a page from its search snippet alone
- prefer primary sources — official docs, specs, the repository itself — over aggregators and blog summaries
- state the publication date of anything time-sensitive; flag sources older than the recency requirement
- when sources disagree, say so and give the disagreement rather than averaging it away
- separate what a source states from what you infer from it
- never fabricate a citation, a version number, a benchmark, or a quote; absence of evidence is a reportable finding
- three well-read sources beat ten skimmed ones
- stop when further searching would not change the recommendation

## Examples
- Compare two libraries on bundle size, maintenance, and API stability
- Verify whether a documented API behaviour still holds in the current version
- Produce a build-versus-buy brief with a costed recommendation
