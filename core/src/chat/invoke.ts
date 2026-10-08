// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * `@` explicit invocation — parsing only, no execution.
 *
 * A turn may open with `@` references: `@Researcher analyze these competitors`
 * means USE the Researcher agent; `@deep-research compare these` means USE the
 * deep-research skill. Parsing is a pure function over the text; RESOLUTION
 * (against the live registries) and EXECUTION (through the boundary) happen in
 * the router, which owns the policy context. An `@name` in the middle of a
 * sentence is prose, not an invocation — only LEADING tokens invoke.
 *
 * Rules, each load-bearing:
 *   - leading `@token` runs are collected in order; the rest is the content;
 *   - more than one AGENT is ambiguous and never executes silently;
 *   - unknown names are reported, never ignored and never executed;
 *   - an empty content after the tokens is refused (an invocation needs a task).
 */

export interface ParsedInvocation {
  /** Raw `@name` tokens, in order, without the `@`. */
  tokens: string[];
  /** The task text after the tokens. */
  content: string;
}

const TOKEN_RE = /^@([A-Za-z0-9][A-Za-z0-9_-]*)/;

/** Split leading `@name` tokens from the task. Null when the text does not open with one. */
export function parseInvocations(text: string): ParsedInvocation | null {
  const tokens: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    const match = TOKEN_RE.exec(rest);
    if (match === null || match[1] === undefined) break;
    tokens.push(match[1]);
    rest = rest.slice(match[0].length).trimStart();
  }
  if (tokens.length === 0) return null;
  return { tokens, content: rest };
}

export interface InvocationDirectory {
  /** Subagent spec ids + names, for matching (case-insensitive). */
  agents: Array<{ id: string; name: string }>;
  /** Skill ids + names + disabled state. */
  skills: Array<{ id: string; name: string; disabled: boolean }>;
}

export interface ResolvedInvocation {
  /** Matched subagent spec ids, in token order. */
  agents: string[];
  /** Matched skill ids, in token order. */
  skills: string[];
  /** Tokens matching nothing. */
  unknown: string[];
  /** Tokens matching a DISABLED skill (named, refused, never executed). */
  disabledSkills: string[];
  /** The task text after the tokens. */
  content: string;
}

/**
 * Resolve tokens against live directory state. Matching is by id OR name,
 * case-insensitive; an agent match wins over a skill match on collision, and
 * the collision is reported rather than hidden.
 */
export function resolveInvocations(parsed: ParsedInvocation, directory: InvocationDirectory): ResolvedInvocation {
  const agents: string[] = [];
  const skills: string[] = [];
  const unknown: string[] = [];
  const disabledSkills: string[] = [];
  for (const token of parsed.tokens) {
    const lowered = token.toLowerCase();
    const agent = directory.agents.find((entry) => entry.id.toLowerCase() === lowered || entry.name.toLowerCase() === lowered);
    if (agent !== undefined) {
      if (!agents.includes(agent.id)) agents.push(agent.id);
      continue;
    }
    const skill = directory.skills.find((entry) => entry.id.toLowerCase() === lowered || entry.name.toLowerCase() === lowered);
    if (skill === undefined) {
      if (!unknown.includes(token)) unknown.push(token);
      continue;
    }
    if (skill.disabled) {
      if (!disabledSkills.includes(skill.id)) disabledSkills.push(skill.id);
      continue;
    }
    if (!skills.includes(skill.id)) skills.push(skill.id);
  }
  return { agents, skills, unknown, disabledSkills, content: parsed.content };
}
