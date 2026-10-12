// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The security scan a candidate skill must pass before it can become ACTIVE.
 *
 * ## Why this is default-ON
 *
 * The donor this pattern comes from (`hermes-agent`, MIT) ships the equivalent
 * check behind an opt-in flag whose default is OFF, and swallows a scanner
 * failure into "allowed". KAI does neither:
 *
 *   - the scan runs on EVERY candidate, agent-created or imported, with no flag
 *     to turn it off;
 *   - a scanner that THROWS yields `ERROR`, and `ERROR` is never `CLEAN`.
 *
 * A skill is instruction text that a future prompt will trust, so a skill is the
 * one input where "we could not check it" must mean "it does not activate".
 *
 * ## What it looks for
 *
 * A skill is untrusted instructions. The findings below are the ways instruction
 * text attacks its own host: overriding the authority that governs it, reaching
 * for secrets, and turning a skill into a delivery vehicle for a remote command.
 * The verdict is bound to the exact bytes it scanned (their sha256), so a verdict
 * can never be reused for a different candidate.
 */

import { sha256Hex } from "./hash.ts";

export type ScanOutcome = "CLEAN" | "WARNING" | "BLOCKED" | "ERROR";

export interface ScanFinding {
  /** Stable code, so a policy can name the finding it refuses. */
  code: string;
  severity: "warning" | "blocked";
  message: string;
  /** The matched text, truncated. Evidence, never the whole body. */
  evidence: string;
  line?: number;
}

export interface ScanVerdict {
  outcome: ScanOutcome;
  findings: ScanFinding[];
  /** sha256 of the EXACT bytes scanned: a verdict is bound to a candidate. */
  sha256: string;
  scannedAt: string;
  reason: string;
  /** Set only for `ERROR`: why the scan could not be completed. */
  error?: string;
}

interface Pattern {
  code: string;
  severity: "warning" | "blocked";
  message: string;
  /** Matched against the whole text with the `i` flag. */
  regex: RegExp;
}

/**
 * Ordered by severity, and each is anchored to a behaviour rather than a
 * keyword, so a skill that merely DISCUSSES security is not blocked for saying
 * "approval" — it is blocked for instructing the model to skip one.
 */
const PATTERNS: readonly Pattern[] = [
  {
    code: "AUTHORITY_OVERRIDE",
    severity: "blocked",
    message: "instructs the model to ignore or replace its governing instructions",
    regex: /\b(ignore|disregard|forget|override|replace)\b[^.\n]{0,40}\b(previous|prior|earlier|system|above|original)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|directives?)\b/i,
  },
  {
    code: "IDENTITY_REPLACEMENT",
    severity: "blocked",
    message: "instructs the model to adopt a different identity or drop its own",
    regex: /\byou are (now|no longer)\b|\bact as (?:if you are )?(?:an? )?(?:unrestricted|unfiltered|jailbroken)\b|\bpretend (?:that )?you (?:are|have no)\b/i,
  },
  {
    code: "GUARD_TAMPERING",
    severity: "blocked",
    message: "instructs the model to weaken Guard, policy or the approval gate",
    regex: /\b(disable|bypass|skip|circumvent|remove|turn off|evade)\b[^.\n]{0,40}\b(guard|policy|approval|authorization|authorisation|permission|safety|security|gate)s?\b/i,
  },
  {
    code: "BUDGET_TAMPERING",
    severity: "blocked",
    message: "instructs the model to raise or reset its own execution budget",
    regex: /\b(increase|raise|reset|remove|extend|ignore|bypass)\b[^.\n]{0,30}\b(budget|limit|quota|ceiling|allowance|retr(?:y|ies))\b/i,
  },
  {
    code: "SELF_AUTHORIZATION",
    severity: "blocked",
    message: "instructs the model to authorise its own actions",
    regex: /\b(grant|give) (yourself|itself|me)\b[^.\n]{0,30}\b(access|permission|authority|approval)\b|\bself[- ]approve\b/i,
  },
  {
    code: "CREDENTIAL_ACCESS",
    severity: "blocked",
    message: "directs the model at credential stores or secret material",
    regex: /\b(process\.env|\.env\b|api[_-]?keys?|secrets?\.json|credentials?\.json|id_rsa|\.aws\/credentials|\.netrc|keychain)\b/i,
  },
  {
    code: "REMOTE_CODE_EXECUTION",
    severity: "blocked",
    message: "pipes a downloaded script into a shell",
    regex: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n]{0,80}\|\s*(ba|z|k)?sh\b|\b(iwr|invoke-webrequest)\b[^\n]{0,80}\|\s*iex\b/i,
  },
  {
    code: "DESTRUCTIVE_COMMAND",
    severity: "blocked",
    message: "contains an irreversible destructive command",
    regex: /\brm\s+-[a-z]*[rf][a-z]*\s+(?:\/|~|\$HOME|\*)(?=\s|$)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f|\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev\//i,
  },
  {
    code: "SECRET_LITERAL",
    severity: "blocked",
    message: "contains what looks like a live credential",
    regex: /\b(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  },
  {
    code: "INVISIBLE_TEXT",
    severity: "blocked",
    message: "hides text with invisible or direction-overriding characters",
    regex: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/,
  },
  {
    code: "PRIVILEGE_ESCALATION",
    severity: "warning",
    message: "asks for elevated privileges",
    regex: /\bsudo\b|\brunas\b|\bnet\s+localgroup\s+administrators\b/i,
  },
  {
    code: "RAW_IP_ENDPOINT",
    severity: "warning",
    message: "contacts a bare IP address rather than a named host",
    regex: /\bhttps?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  },
  {
    code: "BROAD_WRITE_SCOPE",
    severity: "warning",
    message: "writes beyond a declared working directory",
    regex: /\b(write|create|delete|modify)\b[^.\n]{0,30}\b(anywhere|everywhere|the whole (?:disk|filesystem|system)|all files)\b/i,
  },
  {
    code: "UNBOUNDED_LOOP",
    severity: "warning",
    message: "instructs an unbounded loop",
    regex: /\b(loop|repeat|retry)\b[^.\n]{0,30}\b(forever|indefinitely|until (?:it|you) succeed|endlessly)\b/i,
  },
];

/**
 * Is this match inside a PROHIBITION rather than an instruction?
 *
 * The first version of this scanner blocked KAI's own `connector-workflow`
 * built-in, which says *"Never invent access, borrow another connector, or skip
 * the declaration, policy, approval, execution order."* That is the opposite of
 * an attack, and a scanner that cannot tell them apart would either block
 * legitimate skills or be weakened until it blocks nothing.
 *
 * The cue must appear in the same clause as the match, so "Never do X. Now do X"
 * is still caught: the second X has no cue before it, and EVERY match is
 * evaluated — a negation elsewhere in the text cannot hide a real instruction.
 */
const NEGATION_CUE = /\b(never|do not|don'?t|does not|doesn'?t|must not|mustn'?t|should not|shouldn'?t|cannot|can'?t|avoid|avoiding|refuse|refuses|forbid(?:den)?|without|not)\b/i;

function isNegated(text: string, index: number): boolean {
  const from = Math.max(0, index - 160);
  const window = text.slice(from, index);
  // Stop at the previous sentence/clause boundary: a cue in an earlier sentence
  // does not govern this one.
  const boundary = Math.max(
    window.lastIndexOf("."),
    window.lastIndexOf("\n"),
    window.lastIndexOf(";"),
    window.lastIndexOf(":"),
    window.lastIndexOf("!"),
    window.lastIndexOf("?"),
  );
  const clause = boundary === -1 ? window : window.slice(boundary + 1);
  return NEGATION_CUE.test(clause);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** A single line of evidence around a match, collapsed and truncated. */
function evidenceAt(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", index) + 1);
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end === -1 ? text.length : end).trim();
  const collapsed = line.replace(/\s+/g, " ");
  if (collapsed.length <= 160) return collapsed;
  const offsetInLine = index - start;
  const from = Math.max(0, offsetInLine - 40);
  return `${from > 0 ? "…" : ""}${collapsed.slice(from, from + 160)}…${length > 0 ? "" : ""}`;
}

/**
 * Scan candidate bytes.
 *
 * Deterministic and total: it never throws. A failure inside the scan is
 * reported as `ERROR` with the reason, and an `ERROR` verdict must be treated as
 * "do not activate" by every caller — it is emphatically NOT clean.
 */
export function scanSkill(
  input: { id: string; markdown: string },
  opts: { now?: () => Date } = {},
): ScanVerdict {
  const now = opts.now ?? (() => new Date());
  const scannedAt = now().toISOString();
  let sha256 = "";
  try {
    sha256 = sha256Hex(input.markdown);
    const findings: ScanFinding[] = [];
    for (const pattern of PATTERNS) {
      // A global regex is stateful; `exec` on a fresh match per pattern is not,
      // because each pattern is applied with `matchAll` semantics via a clone.
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`);
      for (const match of input.markdown.matchAll(regex)) {
        const index = match.index ?? 0;
        // Every match is evaluated. A prohibition is not an attack, and a
        // "never" elsewhere cannot hide the occurrence that IS an instruction.
        if (isNegated(input.markdown, index)) continue;
        findings.push({
          code: pattern.code,
          severity: pattern.severity,
          message: pattern.message,
          evidence: evidenceAt(input.markdown, index, match[0].length),
          line: lineOf(input.markdown, index),
        });
      }
    }
    const blocked = findings.filter((f) => f.severity === "blocked");
    const warned = findings.filter((f) => f.severity === "warning");
    if (blocked.length > 0) {
      return {
        outcome: "BLOCKED",
        findings,
        sha256,
        scannedAt,
        reason: `blocked: ${blocked.map((f) => f.code).join(", ")}`,
      };
    }
    if (warned.length > 0) {
      return {
        outcome: "WARNING",
        findings,
        sha256,
        scannedAt,
        reason: `warnings: ${warned.map((f) => f.code).join(", ")} — review before activating`,
      };
    }
    return { outcome: "CLEAN", findings: [], sha256, scannedAt, reason: "no findings" };
  } catch (error) {
    // The scanner itself failed. This is the case the donor source treated as
    // "allowed"; here it is ERROR, and ERROR never activates.
    return {
      outcome: "ERROR",
      findings: [],
      sha256,
      scannedAt,
      reason: "the scan could not be completed — an unscanned candidate is never activated",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** May a candidate with this verdict become ACTIVE? */
export function scanAllowsActivation(verdict: ScanVerdict, opts: { allowWarning?: boolean } = {}): boolean {
  if (verdict.outcome === "CLEAN") return true;
  if (verdict.outcome === "WARNING") return opts.allowWarning === true;
  // BLOCKED and ERROR both refuse. ERROR is listed explicitly so the intent is
  // readable: "we could not check it" is not a reason to activate.
  return false;
}
