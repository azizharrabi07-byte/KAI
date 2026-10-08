// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Render a SKILL.md from a draft.
 *
 * The learning pipeline produces a DRAFT (name/description/body), and this
 * turns it into the exact markdown that will be staged, hashed and — only after
 * a human approves that hash — installed. Values that could be read as YAML
 * structure are emitted as JSON strings, which the parser reads back verbatim,
 * so a description containing a colon cannot silently change the header.
 */

export interface SkillDraft {
  name: string;
  description: string;
  version?: string;
  purpose?: string;
  tools?: readonly string[];
  constraints?: readonly string[];
  tags?: readonly string[];
  body: string;
}

const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 ._/()-]*$/;

function yamlScalar(value: string): string {
  if (PLAIN_SCALAR.test(value) && value === value.trim() && !value.includes(": ")) {
    return value;
  }
  return JSON.stringify(value);
}

export function renderSkillMarkdown(draft: SkillDraft): string {
  const lines = ["---", `name: ${yamlScalar(draft.name)}`];
  if (draft.description.length > 0) {
    lines.push(`description: ${yamlScalar(draft.description)}`);
  }
  if (draft.version !== undefined && draft.version.length > 0) {
    lines.push(`version: ${yamlScalar(draft.version)}`);
  }
  if (draft.purpose !== undefined && draft.purpose.length > 0) {
    lines.push(`purpose: ${yamlScalar(draft.purpose)}`);
  }
  if (draft.tools !== undefined && draft.tools.length > 0) {
    lines.push(`tools: ${draft.tools.map((tool) => yamlScalar(tool)).join(", ")}`);
  }
  if (draft.constraints !== undefined && draft.constraints.length > 0) {
    lines.push(`constraints: ${draft.constraints.map((line) => yamlScalar(line)).join(", ")}`);
  }
  if (draft.tags !== undefined && draft.tags.length > 0) {
    lines.push(`tags: ${draft.tags.map((tag) => yamlScalar(tag)).join(", ")}`);
  }
  lines.push("---", "", draft.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  return lines.join("\n");
}
