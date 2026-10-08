---
name: security-static-analysis
description: Detect vulnerabilities before commit using CodeQL, Semgrep, and SARIF processing, backed by manual review of the changed surface. Use this skill before merging changes that touch authentication, authorization, user input, file handling, secrets, deserialization, subprocess execution, or dependencies.
---

# Security Static Analysis Skill

## Purpose
Detect vulnerabilities before commit using CodeQL, Semgrep, and SARIF processing, backed by manual review of the changed surface.

## When to use
Use this skill before merging changes that touch authentication, authorization, user input, file handling, secrets, deserialization, subprocess execution, or dependencies. Also use for a periodic sweep of a whole service.

## Inputs
- the diff or codebase under review
- language and framework
- trust boundaries: what is user-controlled, what is internal
- which tools are available and may be run

## Output
Return:
- findings ranked by severity, each with file and line, the source-to-sink path, a concrete exploit scenario, and the fix
- tool findings and manual findings reported separately
- an explicit coverage statement: which tools ran, which rule packs, and what was not analysed
- items needing human judgement, listed apart from confirmed findings

## Constraints
- **CodeQL** for interprocedural taint tracking and data flow; build a database for the target language and run security-extended plus the Trail of Bits and community query packs; write data extension models for project-specific APIs the default models miss
- **Semgrep** for fast pattern-based scanning; start from OWASP, CWE, and Trail of Bits rulesets, then write custom YAML rules with taint mode for project-specific source-to-sink pairs
- **SARIF** for aggregating and deduplicating across tools; do not hand-merge results
- trace an actual reachable path before reporting; unreachable code is not a finding
- state a concrete failure scenario â€” inputs and impact â€” never a bare category label
- triage tool output for false positives explicitly; report suppressions rather than dropping them silently
- prioritise injection (SQL, command, template, path), broken access control, SSRF, insecure deserialisation, hardcoded secrets, and unsafe cryptographic defaults
- check authorization on every new endpoint, not just authentication
- treat any committed secret as compromised and requiring rotation
- run variant analysis: once a bug is confirmed, look for the same pattern elsewhere in the codebase
- this skill finds and explains vulnerabilities in code under review; it does not produce exploitation tooling

## Examples
- Review a pull request adding a file-upload endpoint
- Write a custom Semgrep taint rule for an internal sink and scan for it
- Aggregate CodeQL and Semgrep SARIF output and deduplicate before triage
