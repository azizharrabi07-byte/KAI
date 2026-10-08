// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * A deliberately small YAML-subset parser for SKILL.md frontmatter.
 *
 * KAI ships no YAML dependency (the Core is a local process and every
 * dependency is one more thing the desktop app carries), so this parses the
 * subset a real SKILL.md uses: top-level `key: value` scalars, double-quoted
 * scalars (parsed as JSON so escapes work), `key: |` / `key: >` block scalars,
 * and `- item` lists. Anything outside that subset is reported as an error and
 * the caller refuses the file — an unparseable header is never guessed at.
 *
 * The parser does NOT decide whether the content is acceptable; it only turns
 * it into a map. Validation lives in `validate.ts`.
 */

export interface FrontmatterParse {
  /** A `---` block opened the document. */
  found: boolean;
  /** A closing `---` was found. */
  closed: boolean;
  /** The flat key/value map (lists are comma-joined, blocks are newline-joined). */
  raw: Record<string, string>;
  /** Structural problems; non-empty means the frontmatter is unusable. */
  errors: string[];
  /** Everything after the closing delimiter. */
  body: string;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseFrontmatter(markdown: string): FrontmatterParse {
  const text = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  const first = lines[0];
  if (first === undefined || first.trimEnd() !== "---") {
    return { found: false, closed: false, raw: {}, errors: [], body: text };
  }

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trimEnd() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return {
      found: true,
      closed: false,
      raw: {},
      errors: ["frontmatter block is not closed with a --- line"],
      body: "",
    };
  }

  const raw: Record<string, string> = {};
  const errors: string[] = [];
  const fm = lines.slice(1, close);

  for (let i = 0; i < fm.length; i += 1) {
    const line = fm[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      errors.push(`unexpected indented line in frontmatter: "${line.trim()}"`);
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      errors.push(`frontmatter line is not "key: value": "${line.trim()}"`);
      continue;
    }
    const key = match[1] ?? "";
    let value = (match[2] ?? "").trim();

    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      // Block scalar: subsequent lines that are indented belong to the value.
      const fold = value.startsWith(">");
      const block: string[] = [];
      let j = i + 1;
      for (; j < fm.length; j += 1) {
        const blockLine = fm[j] ?? "";
        if (blockLine.trim() === "") {
          block.push("");
          continue;
        }
        if (!/^\s/.test(blockLine)) break;
        block.push(blockLine.replace(/^\s+/, ""));
      }
      i = j - 1;
      value = fold ? block.join(" ").trim() : block.join("\n").replace(/\s+$/, "");
    } else if (value === "") {
      // A key with no inline value may own a `- item` list.
      const items: string[] = [];
      let j = i + 1;
      for (; j < fm.length; j += 1) {
        const listLine = fm[j] ?? "";
        const item = /^\s*-\s*(.+?)\s*$/.exec(listLine);
        if (item !== null && item[1] !== undefined) {
          items.push(stripQuotes(item[1]));
          continue;
        }
        if (listLine.trim() === "") continue;
        break;
      }
      if (items.length > 0) {
        i = j - 1;
        value = items.join(", ");
      }
    }

    value = stripQuotes(value);
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      errors.push(`duplicate frontmatter key "${key}"`);
    }
    raw[key] = value;
  }

  const body = lines.slice(close + 1).join("\n");
  return { found: true, closed: true, raw, errors, body };
}
