// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * SKILL.md validation (spec Part C1).
 *
 * A skill is a third-party artifact: it can be authored by a model, downloaded,
 * or pasted from anywhere. Nothing about it is trusted, so this module refuses
 * the shapes that turn "a document an agent reads" into "code that runs". It is
 * deliberately the ONLY place that decides whether a SKILL.md is acceptable,
 * and it is pure — it never touches the filesystem, so a refusal cannot have
 * half-written anything.
 *
 * The rejection classes, and what each one stops:
 *
 *   PATH_TRAVERSAL / INVALID_ID   an id/name that would resolve outside the
 *                                 skills root (`..`, separators, drive letters,
 *                                 null bytes, Windows device names).
 *   OVERSIZED                     a file big enough to wedge a prompt or a scan.
 *   INVISIBLE_UNICODE             zero-width, bidi-override, BOM, tag and
 *                                 other format characters — text that reads
 *                                 differently to a human than to a parser.
 *   ENCODED_PAYLOAD               base64/hex blobs and `data:` URIs — content
 *                                 smuggled past review as an opaque string.
 *   DOWNLOAD_EXEC                 the obvious download-and-run shapes
 *                                 (`curl … | bash`, PowerShell encoded commands,
 *                                 `certutil -decode`, …).
 *   FRONTMATTER_* / MISSING_* /
 *   INVALID_KEY / EMPTY_BODY      the structural requirements: a real header
 *                                 with a name and a description, and a body.
 *
 * Every check is conservative in the same direction as the rest of KAI: when in
 * doubt, refuse. Over-rejecting a document costs a re-author; under-rejecting
 * one costs the machine.
 */

import { Buffer } from "node:buffer";
import { fail, ok, skillError } from "./errors.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { ParsedSkill, SkillIssue, SkillIssueCode, SkillResult } from "./types.ts";

export const SKILL_LIMITS = {
  /** Whole SKILL.md, bytes. */
  skillBytes: 64 * 1024,
  idLength: 64,
  nameLength: 64,
  descriptionLength: 1024,
  purposeLength: 512,
  tools: 16,
  toolLength: 64,
  constraints: 8,
  constraintLength: 256,
  tags: 16,
  tagLength: 32,
} as const;

/** The frontmatter keys KAI understands. An unknown key is a refusal. */
export const ALLOWED_FRONTMATTER_KEYS: readonly string[] = [
  "name",
  "description",
  "purpose",
  "tools",
  "constraints",
  "version",
  "license",
  "tags",
  "author",
  "homepage",
];

/** A tool id a skill may name: dotted KAI ids (`filesystem.search`) and plain names. */
const SKILL_TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Invisible / bidi / control characters. Tab, newline and carriage return are
// the only control characters allowed.
const INVISIBLE_CHAR =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206A\uFEFF\uFFF9-\uFFFB]/u;
const TAG_CHAR = /[\u{E0000}-\u{E007F}]/u;

/** Base64-ish run length that is a payload rather than an identifier. */
const ENCODED_CHECKS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "a data: base64 URI", re: /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i },
  { label: "a long base64 blob", re: /[A-Za-z0-9+/]{100,}={0,2}/ },
  { label: "a long hex blob", re: /\b[0-9a-fA-F]{128,}\b/ },
  { label: "a hex-escaped byte run", re: /(?:\\x[0-9a-fA-F]{2}){12,}/ },
  {
    label: "a decode command",
    re: /\b(?:base64|b64decode|atob|frombase64string|certutil)\b[^\n]{0,60}(?:-d\b|--decode|-decode\b|\|\s*(?:sh|bash|python|perl|node))/i,
  },
];

const DOWNLOAD_EXEC_CHECKS: ReadonlyArray<{ label: string; re: RegExp }> = [
  {
    label: "a download piped into a shell/interpreter",
    re: /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|fetch)\b[^\n|]{0,400}\|[^\n]{0,30}\b(?:sh|bash|zsh|dash|ksh|powershell|pwsh|iex|invoke-expression|python[0-9.]*|perl|ruby|node)\b/i,
  },
  {
    label: "a shell running a downloaded script",
    re: /\b(?:bash|sh|zsh)\b[^\n]{0,40}\s-c\b[^\n]{0,80}\$\(\s*(?:curl|wget|iwr)\b/i,
  },
  {
    label: "a PowerShell encoded command",
    re: /\bpowershell(?:\.exe)?\b[^\n]{0,200}\s-(?:enc|encodedcommand)\b/i,
  },
  {
    label: "a certutil/bitsadmin decode",
    re: /\b(?:certutil|bitsadmin)\b[^\n]{0,160}(?:-decode|-urlcache)/i,
  },
  {
    label: "base64 decoded into an interpreter",
    re: /\bbase64\b[^\n]{0,30}(?:-d\b|--decode)\b[^\n]{0,80}\|\s*(?:sh|bash|python[0-9.]*|perl|ruby|node|iex)\b/i,
  },
];

function issue(code: SkillIssueCode, message: string, detail?: string): SkillIssue {
  return detail !== undefined ? { code, message, detail } : { code, message };
}

function codepoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Validate an id that will be used as a directory name. This is the string that
 * keeps `..` and separators from becoming filesystem traversal.
 */
export function validateSkillId(id: unknown): SkillIssue[] {
  const issues: SkillIssue[] = [];
  if (typeof id !== "string" || id.length === 0) {
    return [issue("INVALID_ID", "skill id must be a non-empty string")];
  }
  if (id.length > SKILL_LIMITS.idLength) {
    issues.push(issue("INVALID_ID", `skill id must be at most ${SKILL_LIMITS.idLength} characters`));
  }
  if (id.includes("..")) {
    issues.push(issue("PATH_TRAVERSAL", `skill id "${id}" contains ".."`, `id=${id}`));
  }
  if (/[/\\:]/.test(id) || id.includes("\0")) {
    issues.push(issue("PATH_TRAVERSAL", `skill id "${id}" contains a path separator or null byte`, `id=${id}`));
  }
  if (INVISIBLE_CHAR.test(id) || TAG_CHAR.test(id)) {
    issues.push(issue("INVISIBLE_UNICODE", `skill id "${id}" contains an invisible character`));
  }
  if (id !== id.trim() || id.startsWith(".") || id.endsWith(".")) {
    issues.push(issue("INVALID_ID", `skill id "${id}" has leading/trailing whitespace or a leading/trailing dot`));
  }
  if (!SKILL_ID_RE.test(id)) {
    issues.push(
      issue(
        "INVALID_ID",
        `skill id "${id}" must start with a letter or digit and contain only letters, digits, dot, underscore or hyphen`,
      ),
    );
  }
  if (RESERVED_WINDOWS_NAMES.test(id)) {
    issues.push(issue("INVALID_ID", `skill id "${id}" is a reserved device name`));
  }
  return issues;
}

/** True when `id` is usable as a single path segment. */
export function isSafeSkillId(id: unknown): id is string {
  return validateSkillId(id).length === 0;
}

function firstInvisible(text: string): { char: string; index: number } | undefined {
  const plain = INVISIBLE_CHAR.exec(text);
  const tag = TAG_CHAR.exec(text);
  const candidates: Array<{ char: string; index: number }> = [];
  if (plain !== null && plain[0] !== undefined) candidates.push({ char: plain[0], index: plain.index });
  if (tag !== null && tag[0] !== undefined) candidates.push({ char: tag[0], index: tag.index });
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0];
}

/** Scan one string for every refusal class; returns accumulated issues. */
function scanContent(markdown: string): SkillIssue[] {
  const issues: SkillIssue[] = [];

  const invisible = firstInvisible(markdown);
  if (invisible !== undefined) {
    issues.push(
      issue(
        "INVISIBLE_UNICODE",
        `SKILL.md contains an invisible/bidi/control character (${codepoint(invisible.char)}) at offset ${invisible.index}`,
        `char=${codepoint(invisible.char)}`,
      ),
    );
  }

  for (const check of ENCODED_CHECKS) {
    const match = check.re.exec(markdown);
    if (match !== null) {
      issues.push(
        issue(
          "ENCODED_PAYLOAD",
          `SKILL.md contains ${check.label}, which is refused: encoded payloads cannot be reviewed as text`,
          `matched=${JSON.stringify(match[0].slice(0, 48))}`,
        ),
      );
      break;
    }
  }

  for (const check of DOWNLOAD_EXEC_CHECKS) {
    const match = check.re.exec(markdown);
    if (match !== null) {
      issues.push(
        issue(
          "DOWNLOAD_EXEC",
          `SKILL.md contains ${check.label}, which is refused as a download-and-execute pattern`,
          `matched=${JSON.stringify(match[0].slice(0, 80))}`,
        ),
      );
      break;
    }
  }

  return issues;
}

/**
 * Parse a comma/bracket list (tags, skill tools). Shared shape because both
 * are author-declared string sets with a count cap and per-item validation.
 */
function parseStringList(
  raw: string | undefined,
  opts: { max: number; maxItem: number; label: string; itemRe?: RegExp },
): { items: string[]; issues: SkillIssue[] } {
  if (raw === undefined || raw.trim() === "") return { items: [], issues: [] };
  const cleaned = raw.replace(/^\[/, "").replace(/\]$/, "");
  const items = cleaned
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const issues: SkillIssue[] = [];
  if (items.length > opts.max) {
    issues.push(issue("TOO_MANY_TAGS", `at most ${opts.max} ${opts.label} are allowed`));
  }
  for (const item of items) {
    if (item.length > opts.maxItem) {
      issues.push(issue("INVALID_KEY", `${opts.label} entry "${item.slice(0, 20)}…" is longer than ${opts.maxItem} characters`));
    } else if (opts.itemRe !== undefined && !opts.itemRe.test(item)) {
      issues.push(issue("INVALID_KEY", `${opts.label} entry "${item.slice(0, 40)}" is not a valid tool id`));
    }
  }
  return { items: [...new Set(items)].slice(0, opts.max), issues };
}

function parseTags(raw: string | undefined): { tags: string[]; issues: SkillIssue[] } {
  if (raw === undefined || raw.trim() === "") return { tags: [], issues: [] };
  const cleaned = raw.replace(/^\[/, "").replace(/\]$/, "");
  const tags = cleaned
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const issues: SkillIssue[] = [];
  if (tags.length > SKILL_LIMITS.tags) {
    issues.push(issue("TOO_MANY_TAGS", `at most ${SKILL_LIMITS.tags} tags are allowed`));
  }
  for (const tag of tags) {
    if (tag.length > SKILL_LIMITS.tagLength) {
      issues.push(issue("INVALID_KEY", `tag "${tag.slice(0, 20)}…" is longer than ${SKILL_LIMITS.tagLength} characters`));
    }
  }
  return { tags: [...new Set(tags)].slice(0, SKILL_LIMITS.tags), issues };
}

/**
 * Parse and validate a SKILL.md. Returns the parsed skill or the precise issues
 * that made it unacceptable. Pure: nothing is written, ever.
 */
export function parseSkillMarkdown(markdown: unknown, opts: { id?: string } = {}): SkillResult<ParsedSkill> {
  const now = (): Date => new Date();

  if (typeof markdown !== "string") {
    return fail(skillError("VALIDATION_FAILED", "skill content must be a string", now), [
      issue("NOT_A_STRING", "skill content must be a string"),
    ]);
  }

  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > SKILL_LIMITS.skillBytes) {
    // Return before scanning: never run regexed passes over an oversized blob.
    return fail(
      skillError(
        "VALIDATION_FAILED",
        `SKILL.md is ${bytes} bytes, over the ${SKILL_LIMITS.skillBytes}-byte limit`,
        now,
      ),
      [issue("OVERSIZED", `SKILL.md is ${bytes} bytes, over the ${SKILL_LIMITS.skillBytes}-byte limit`, `size=${bytes}`)],
    );
  }

  const issues: SkillIssue[] = [];

  if (opts.id !== undefined) {
    issues.push(...validateSkillId(opts.id));
  }
  issues.push(...scanContent(markdown));

  const fm = parseFrontmatter(markdown);
  let name = "";
  let description = "";
  let version: string | undefined;
  let purpose: string | undefined;
  let tools: string[] = [];
  let constraints: string[] = [];
  let tags: string[] = [];

  if (!fm.found) {
    issues.push(issue("FRONTMATTER_MISSING", "SKILL.md must begin with a --- frontmatter block"));
  } else {
    if (!fm.closed) {
      issues.push(issue("FRONTMATTER_INVALID", "frontmatter block is not closed with a --- line"));
    }
    for (const error of fm.errors) {
      issues.push(issue("FRONTMATTER_INVALID", error));
    }
    for (const key of Object.keys(fm.raw)) {
      if (!ALLOWED_FRONTMATTER_KEYS.includes(key.toLowerCase())) {
        issues.push(issue("INVALID_KEY", `unknown frontmatter key "${key}"`));
      }
    }

    const rawName = fm.raw["name"];
    const rawDescription = fm.raw["description"];
    if (rawName === undefined || rawName.trim().length === 0) {
      issues.push(issue("MISSING_NAME", 'frontmatter requires a non-empty "name"'));
    } else {
      name = rawName.trim();
      if (name.length > SKILL_LIMITS.nameLength) {
        issues.push(issue("INVALID_NAME", `name must be at most ${SKILL_LIMITS.nameLength} characters`));
      }
      if (/[/\\]/.test(name) || name.includes("..") || INVISIBLE_CHAR.test(name) || TAG_CHAR.test(name)) {
        issues.push(issue("INVALID_NAME", `name "${name}" contains path or invisible characters`));
      }
    }
    if (rawDescription === undefined || rawDescription.trim().length === 0) {
      issues.push(issue("MISSING_DESCRIPTION", 'frontmatter requires a non-empty "description"'));
    } else {
      description = rawDescription.trim();
      if (description.length > SKILL_LIMITS.descriptionLength) {
        issues.push(
          issue("MISSING_DESCRIPTION", `description must be at most ${SKILL_LIMITS.descriptionLength} characters`),
        );
      }
    }

    const rawVersion = fm.raw["version"];
    if (rawVersion !== undefined && rawVersion.trim() !== "") version = rawVersion.trim();

    const parsedTags = parseTags(fm.raw["tags"]);
    tags = parsedTags.tags;
    issues.push(...parsedTags.issues);

    // Optional runtime metadata: purpose (why), tools (may-use allowlist),
    // constraints (self-declared limits). All validated, all surfaced — a
    // skill that declares them is bound by them in the UI and the prompt.
    const rawPurpose = fm.raw["purpose"];
    if (rawPurpose !== undefined && rawPurpose.trim() !== "") {
      purpose = rawPurpose.trim();
      if (purpose.length > SKILL_LIMITS.purposeLength) {
        issues.push(issue("INVALID_KEY", `purpose must be at most ${SKILL_LIMITS.purposeLength} characters`));
      }
      if (INVISIBLE_CHAR.test(purpose) || TAG_CHAR.test(purpose)) {
        issues.push(issue("INVISIBLE_UNICODE", "purpose contains an invisible character"));
      }
    }
    const parsedTools = parseStringList(fm.raw["tools"], {
      max: SKILL_LIMITS.tools,
      maxItem: SKILL_LIMITS.toolLength,
      label: "tools",
      itemRe: SKILL_TOOL_RE,
    });
    tools = parsedTools.items;
    issues.push(...parsedTools.issues);
    const rawConstraints = fm.raw["constraints"];
    if (rawConstraints !== undefined && rawConstraints.trim() !== "") {
      // One per line, or comma-separated on one line.
      const list = rawConstraints.includes("\n") ? rawConstraints.split("\n") : rawConstraints.split(",");
      constraints = [...new Set(list.map((line) => line.trim()).filter((line) => line.length > 0))].slice(
        0,
        SKILL_LIMITS.constraints,
      );
      if (list.filter((line) => line.trim().length > 0).length > SKILL_LIMITS.constraints) {
        issues.push(issue("TOO_MANY_TAGS", `at most ${SKILL_LIMITS.constraints} constraints are allowed`));
      }
      for (const line of constraints) {
        if (line.length > SKILL_LIMITS.constraintLength) {
          issues.push(
            issue("INVALID_KEY", `constraint "${line.slice(0, 20)}…" is longer than ${SKILL_LIMITS.constraintLength} characters`),
          );
        }
        if (INVISIBLE_CHAR.test(line) || TAG_CHAR.test(line)) {
          issues.push(issue("INVISIBLE_UNICODE", "a constraint contains an invisible character"));
        }
      }
    }

    if (fm.closed && fm.body.trim().length === 0) {
      issues.push(issue("EMPTY_BODY", "skill body must not be empty"));
    }
  }

  if (issues.length > 0) {
    const codes = [...new Set(issues.map((entry) => entry.code))].join(",");
    return fail(
      skillError("VALIDATION_FAILED", `SKILL.md refused: ${issues[0]?.message ?? "invalid"}`, now, codes),
      issues,
    );
  }

  const parsed: ParsedSkill = {
    name,
    description,
    tags,
    frontmatter: { ...fm.raw },
    body: fm.body,
    markdown,
  };
  if (opts.id !== undefined) parsed.id = opts.id;
  if (version !== undefined) parsed.version = version;
  if (purpose !== undefined) parsed.purpose = purpose;
  if (tools.length > 0) parsed.tools = tools;
  if (constraints.length > 0) parsed.constraints = constraints;
  return ok(parsed);
}
