---
name: official-claude-reference
description: Treat Anthropic's official repositories and docs as the source of truth for Claude Code, skills, plugins, and the API instead of answering from memory. Use whenever a question concerns Claude Code configuration, skill or plugin authoring, model ids, pricing, or SDK behavior.
---

# Official Claude Reference Skill

## Purpose
Ground any claim about Claude Code, skills, plugins, or the Claude API in Anthropic's official repositories and documentation rather than recall.

## When to use
Use this skill whenever a question concerns Claude Code configuration, skill or plugin authoring, hooks, MCP wiring, model identifiers, pricing, or SDK behavior — including when the answer feels obvious.

## Inputs
- the question or the feature being built
- the installed Claude Code version and platform
- which official sources are already available locally

## Output
Return:
- the answer, with the specific file or document it came from
- the verification actually run — the command executed and its output
- version caveats where behavior differs between releases
- an explicit statement when the official source does not cover the question

## Constraints
- check locally installed sources first — `~/.claude/plugins/marketplaces/` holds cloned official marketplaces and their real `SKILL.md` files, which beat any summary
- treat `anthropics/claude-plugins-official` and `anthropics/skills` as canonical for plugin and skill structure
- verify CLI behavior by running `claude <command> --help` rather than recalling flags
- never state a model id, price, context limit, or rate limit from memory; look it up
- when local sources and memory disagree, the local source wins and the disagreement is worth reporting
- distinguish what is documented from what is observed behavior; observed behavior can change without notice
- a skill only auto-loads from `skills/<name>/SKILL.md` with YAML frontmatter — verify layout against a real official skill before assuming a file will be discovered
- if a claim cannot be grounded, say so rather than presenting a plausible answer as verified

## Examples
- Confirm the exact frontmatter fields a skill supports before authoring one
- Check whether a Claude Code flag exists in the installed version
- Verify a model identifier and its context window before writing it into code
