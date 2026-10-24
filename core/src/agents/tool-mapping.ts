// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Hermes→KAI tool mapping — the name translation the worker boundary was missing.
 *
 * ── The problem this closes
 * `POST /worker/authorize` (`api/worker-authorize.ts`) authorizes a DELEGATED worker's
 * next action. It resolves the declared name with `runtime.tools.get(toolId)`, an EXACT
 * match against the ids this Core registers. A Hermes worker names its tools the way
 * Hermes does — `read_file`, `write_file`, `terminal` — so EVERY call was refused with
 * "not a tool this Core registers", before policy was even consulted. The boundary was
 * correct and useless: legitimate work was denied by a name mismatch, which is how a gate
 * ends up switched off.
 *
 * ── What this module is, and what it refuses to be
 * A translation layer is where a boundary gets widened by accident, so the rules are
 * deliberately narrow:
 *
 *   1. EXACT NAMES ONLY. No fuzzy match, no prefix match, no case folding — the sole
 *      prefix rule is `mcp-`, and it DENIES rather than maps (see the disposition list).
 *      A name that is neither mapped nor dispositioned is refused (`unknown_tool`); it is
 *      never defaulted to a nearby tool.
 *   2. A MAPPING NAMES ONE KAI ID AND STATES THE EQUIVALENCE. Where the two tools are not
 *      the same kind of thing, the name is refused instead — `unsupported_capability` for
 *      "KAI has nothing that does this", `ambiguous_mapping` for "one Hermes name is
 *      several KAI ids and guessing would pick a scope/semantic the caller never chose".
 *   3. ARGUMENTS ARE TRANSLATED, THEN VALIDATED. A Hermes argument with a different KAI
 *      name is renamed (`pattern`→`query`, `name`→`id`, `limit`→`maxResults`); a Hermes
 *      argument with NO KAI counterpart is an ERROR, never a silent drop. Dropping
 *      `offset` from a read returns the WRONG window of the file, and a wrong window looks
 *      exactly like a successful call. The caller (`api/worker-authorize.ts`) then runs the
 *      translated arguments through the KAI tool's own `validate()`, so what gets bound and
 *      shown to a human is the exact input the tool will receive.
 *   4. RISK COMES FROM THE REGISTRY. Each mapping declares the risk it was REVIEWED
 *      against; the live registry is consulted and a live risk WEAKER than that expectation
 *      refuses the call (`risk_regression`), so a later re-classification cannot quietly
 *      turn a reviewed mapping into an unattended one. A worker-supplied risk label is
 *      never read — not here, and not at the boundary.
 *   5. NOTHING HERE GRANTS ANYTHING. A hit is a name plus normalised arguments. The
 *      decision still comes from `runtime.policy.check` at the boundary, through the ONE
 *      policy engine every KAI tool call uses. There is no second policy path, no allowlist,
 *      no auto-approval, and no worker-supplied outcome anywhere in this module.
 *
 * ── `terminal` and `execute_code`: why they stay DENIED, and what is actually enforced
 * The tempting repair is `terminal{command}` → `shell.run{command}`. That exposes arbitrary
 * command execution, for a reason that is structural rather than incidental:
 *
 *   • `terminal`'s `command` is a SHELL COMMAND STRING — Hermes' own schema says so, and its
 *     description tells the model to use it for "builds, installs, git, processes, scripts,
 *     network". `shell.run`'s `command` is a PROGRAM: it is passed to `spawn()` as argv[0]
 *     with `shell: false` (`tools/workspace.ts` — `shellRun` → `exec` → `spawn(command, args,
 *     { shell: false })`).
 *   • So the naive map does not explode, it just breaks: `"npm run build && curl x | sh"` is
 *     looked up as a binary with that literal name → ENOENT. The obvious fix is to supply a
 *     shell (`cmd.exe /c <string>`), and THAT is the exposure: pipelines, chaining,
 *     redirection, substitution, PowerShell download cradles and destructive one-liners all
 *     come back at once, behind a SINGLE DESTRUCTIVE approval card that authorises the whole
 *     string — including the part the human did not read. `shell: false` is neutralised by
 *     the wrapper itself, and the approval binding hashes one opaque string, which leaves a
 *     deny rule nothing to match on.
 *   • A real restriction therefore has to exist BEFORE the binding — a command guard layer
 *     (hardline-command detection, a user-owned deny set, a program allowlist, runtime
 *     self-protection). KAI has none of those (`tools/workspace.ts` states the absence), and
 *     a guard that lives only in this module would be bypassed by the very next caller of
 *     `shell.run`. The only restriction KAI does enforce today is structural — no shell, an
 *     argv array, and a whole-call DESTRUCTIVE policy decision — and that structure is
 *     exactly what a shell-string translation has to throw away.
 *   So: `terminal`, `execute_code` and `process_manage` are PERMANENTLY DENIED. A benign
 *   `terminal{command: "ls"}` is refused too — there is no "safe subset" carve-out, because a
 *   carve-out is a guard pretending to be a mapping. The test file proves this by naming the
 *   payloads and asserting every one of them misses, and by asserting that NO Hermes name in
 *   this table resolves to `shell.run` or any other execution id.
 *   As a consequence, `execute_code` is refused for the same reason in a worse form: Hermes
 *   runs it in its own sandbox (tool allowlist, 300 s timeout, tool-call and output caps);
 *   KAI has no sandbox, so the only target would be an interpreter under `shell.run` —
 *   arbitrary code execution with none of those caps.
 *
 * ── Provenance of the argument sets
 * The Hermes argument names below were read from the registered schemas in the installed
 * Hermes tree (`tools/file_tools.py`: READ_FILE_SCHEMA/WRITE_FILE_SCHEMA/PATCH_SCHEMA/
 * SEARCH_FILES_SCHEMA, `tools/session_search_tool.py`: SESSION_SEARCH_SCHEMA,
 * `tools/skills_tool.py`: SKILLS_LIST_SCHEMA/SKILL_VIEW_SCHEMA) and the registered-name
 * inventory across `tools/*.py`. One place where that reading CHANGED the decision:
 * `write_file` documents "Creates parent directories automatically", so the translation sets
 * KAI's `createDirs: true` instead of inheriting KAI's `false` default (which would have
 * failed with ENOENT where Hermes succeeded).
 */

import { isSafeSkillId } from "../skills/validate.ts";
import type { RiskLevel } from "../shared/contracts.ts";

/** Why an action could not be translated. Closed set: a caller can branch on it. */
export type ToolMappingRefusalCode =
  /** The name is not a Hermes tool this table knows, and it is not a KAI id either. */
  | "unknown_tool"
  /** On the permanent-deny list: the capability must never reach KAI from a worker. */
  | "permanent_deny"
  /** A real Hermes capability with no KAI equivalent — not mappable, not deniable-because-wrong. */
  | "unsupported_capability"
  /** One Hermes name, several KAI ids / several meanings: guessing would choose for the caller. */
  | "ambiguous_mapping"
  /** A declared Hermes argument that KAI cannot honour; it must not be silently dropped. */
  | "unsupported_argument"
  /** A missing/wrong-typed argument, or a key that is not an argument of this tool at all. */
  | "malformed_arguments"
  /** The mapping targets an id this Core does not register (drift guard). */
  | "not_registered"
  /** The live registry risk is weaker than the risk this mapping was reviewed against. */
  | "risk_regression";

/** The authority order used by the `risk_regression` guard. */
const RISK_AUTHORITY: Readonly<Record<RiskLevel, number>> = {
  READ: 0,
  WRITE: 1,
  EXTERNAL: 2,
  DESTRUCTIVE: 3,
};

export interface ToolMappingHit {
  ok: true;
  hermesTool: string;
  kaiToolId: string;
  /** Normalised arguments, in KAI's own field names. */
  args: Record<string, unknown>;
  /** What the two tools mean to each other, in one sentence a reviewer can check. */
  equivalence: string;
  /** The risk this mapping was reviewed against. */
  expectedRisk: RiskLevel;
  /** The risk the REGISTRY declares, when a registry view was supplied. */
  risk: RiskLevel;
}

export interface ToolMappingMiss {
  ok: false;
  hermesTool: string;
  code: ToolMappingRefusalCode;
  reason: string;
  /** The offending argument name, when the refusal is argument-level. */
  argument?: string;
}

export type ToolMappingResult = ToolMappingHit | ToolMappingMiss;

/** The only part of a tool registry this module reads: the risk the registry declares. */
export interface ToolRiskLookup {
  get(id: string): { risk: RiskLevel } | undefined;
}

// ── Argument plumbing ─────────────────────────────────────────────────────────

type ArgsOk = { ok: true; args: Record<string, unknown> };
type ArgsBad = { ok: false; code: ToolMappingRefusalCode; reason: string; argument?: string };

function bad(code: ToolMappingRefusalCode, argument: string | undefined, reason: string): ArgsBad {
  return argument === undefined ? { ok: false, code, reason } : { ok: false, code, reason, argument };
}

/** The wire shape: an object or nothing. Anything else cannot be translated or bound. */
function plainArgs(input: unknown): ArgsOk | ArgsBad {
  if (input === undefined || input === null) return { ok: true, args: {} };
  if (Array.isArray(input)) {
    return bad("malformed_arguments", undefined, "arguments must be an object or omitted, not an array");
  }
  if (typeof input !== "object") {
    return bad("malformed_arguments", undefined, `arguments must be an object or omitted; received ${typeof input}`);
  }
  return { ok: true, args: input as Record<string, unknown> };
}

/**
 * A key that is not an argument of this Hermes tool at all. Refused rather than forwarded:
 * forwarding it would reach KAI's own `validate()` as an unknown option and be attributed to
 * the wrong layer, and it is exactly how a caller smuggles a field past a review.
 */
function unknownArgument(
  args: Record<string, unknown>,
  allowed: readonly string[],
  hermesTool: string,
): ArgsBad | null {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      return bad(
        "malformed_arguments",
        key,
        `"${key}" is not an argument of Hermes' ${hermesTool}; it declares: ${allowed.join(", ")}`,
      );
    }
  }
  return null;
}

/**
 * A DECLARED Hermes argument that KAI cannot honour. This is the important refusal: the
 * argument exists, so it is tempting to drop it — and dropping it silently changes what the
 * call does (a read from the wrong offset, an unbounded window, an unbounded search).
 */
function unsupportedArgument(
  args: Record<string, unknown>,
  unsupported: Readonly<Record<string, string>>,
): ArgsBad | null {
  for (const [key, why] of Object.entries(unsupported)) {
    // The argument's own name is prefixed, so a refusal always says WHICH argument it is
    // about — a reason a caller cannot attribute to a field is not an actionable reason.
    if (key in args) return bad("unsupported_argument", key, `"${key}" — ${why}`);
  }
  return null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function integerOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// ── The mapping table ─────────────────────────────────────────────────────────

interface MappingSpec {
  kaiToolId: string;
  /** The risk this mapping was reviewed against; the live registry must not be weaker. */
  expectedRisk: RiskLevel;
  equivalence: string;
  /** Every argument Hermes' own schema declares for this tool. */
  hermesArgs: readonly string[];
  normalise(args: Record<string, unknown>, hermesTool: string): ArgsOk | ArgsBad;
}

/** A simple single-extension glob, the only `file_glob` shape KAI's `include` can express. */
const SIMPLE_EXTENSION_GLOB = /^(?:\*\*\/)?\*(\.[A-Za-z0-9_+-]+)$/;

const MAPPINGS: Readonly<Record<string, MappingSpec>> = {
  // ── file → filesystem ───────────────────────────────────────────────────────
  read_file: {
    kaiToolId: "filesystem.read",
    expectedRisk: "READ",
    equivalence:
      "Read one bounded slice of a UTF-8 text file. KAI resolves the path to an absolute one and refuses anything outside a declared workspace root, which Hermes' own sandboxing does not do at this layer — so this mapping is strictly narrower, never wider.",
    hermesArgs: ["path", "offset", "limit"],
    normalise(args, name) {
      const bad_ = unknownArgument(args, ["path", "offset", "limit"], name) ?? unsupportedArgument(args, {
        offset:
          "KAI's filesystem.read always starts at byte 0: it has no LINE offset, so this argument cannot be honoured — and dropping it would return the wrong window of the file. Re-issue with `path` only.",
        limit:
          "KAI has no line-count limit. filesystem.read's `maxBytes` is a BYTE cap and is not the same bound as Hermes' `limit` (lines), so there is no faithful translation. Re-issue with `path` only.",
      });
      if (bad_ !== null) return bad_;
      const path = textOf(args["path"]);
      if (path === null) {
        return bad("malformed_arguments", "path", "path is required and must be a non-empty string");
      }
      return { ok: true, args: { path } };
    },
  },

  write_file: {
    kaiToolId: "filesystem.write",
    expectedRisk: "WRITE",
    equivalence:
      "Write one UTF-8 file at an explicit path, replacing its contents. Hermes' schema documents \"Creates parent directories automatically\", so the translation sets KAI's `createDirs: true` — inheriting KAI's `false` default would fail with ENOENT exactly where Hermes succeeds. KAI parks this (WRITE) for a human by default, and confines the path to a declared workspace root.",
    hermesArgs: ["path", "content"],
    normalise(args, name) {
      const bad_ = unknownArgument(args, ["path", "content"], name);
      if (bad_ !== null) return bad_;
      const path = textOf(args["path"]);
      if (path === null) {
        return bad("malformed_arguments", "path", "path is required and must be a non-empty string");
      }
      if (typeof args["content"] !== "string") {
        return bad("malformed_arguments", "content", "content is required and must be a string");
      }
      return { ok: true, args: { path, content: args["content"], createDirs: true } };
    },
  },

  search_files: {
    kaiToolId: "filesystem.search",
    expectedRisk: "READ",
    equivalence:
      "Content search inside the files under a directory, bounded and sandboxed. Only Hermes' content-search shape is mapped: `pattern`→`query`, `limit`→`maxResults`, and a simple extension `file_glob`→`include`. Hermes' file-NAME search (`target: \"files\"`) is refused, because its pattern is a GLOB while KAI's name mode matches a literal substring — and a glob that matches nothing looks like \"no results\".",
    hermesArgs: ["pattern", "target", "path", "file_glob", "limit", "offset", "order", "output_mode", "context"],
    normalise(args, name) {
      const allowed = ["pattern", "target", "path", "file_glob", "limit", "offset", "order", "output_mode", "context"];
      const bad_ = unknownArgument(args, allowed, name);
      if (bad_ !== null) return bad_;

      // Refusals first, so the reason is about the shape of the call rather than one field.
      const target = args["target"];
      if (target !== undefined && target !== "content") {
        return bad(
          "unsupported_argument",
          "target",
          `target: ${JSON.stringify(target)} selects Hermes' file-name search, whose pattern is a GLOB. KAI's filesystem.search name mode matches a literal substring, so a glob would silently match nothing. Re-issue with target: "content" (the default).`,
        );
      }
      const outputMode = args["output_mode"];
      if (outputMode !== undefined && outputMode !== "content") {
        return bad(
          "unsupported_argument",
          "output_mode",
          `output_mode: ${JSON.stringify(outputMode)} — KAI has no "file paths only" or "match counts" content-search mode. Only the default "content" shape is mapped.`,
        );
      }
      const context = args["context"];
      if (context !== undefined && context !== 0) {
        return bad(
          "unsupported_argument",
          "context",
          "KAI's filesystem.search returns the matching line (trimmed and clipped) and no surrounding context lines, so `context` cannot be honoured without changing what is returned. Omit it or pass 0.",
        );
      }
      const offset = args["offset"];
      if (offset !== undefined && offset !== 0) {
        return bad(
          "unsupported_argument",
          "offset",
          "KAI's filesystem.search has no result paging offset; dropping a non-zero offset would return the first page while the caller believes it is reading a later one.",
        );
      }
      const order = args["order"];
      if (order !== undefined && order !== "discovery") {
        return bad(
          "unsupported_argument",
          "order",
          `order: ${JSON.stringify(order)} — KAI's walk order is its own bounded traversal; it cannot promise Hermes' exact global newest-first order. Omit it or pass "discovery".`,
        );
      }

      const pattern = textOf(args["pattern"]);
      if (pattern === null) {
        return bad("malformed_arguments", "pattern", "pattern is required and must be a non-empty string");
      }

      const out: Record<string, unknown> = { query: pattern };

      const path = args["path"];
      if (path !== undefined && path !== ".") {
        const resolved = textOf(path);
        if (resolved === null) {
          return bad("malformed_arguments", "path", "path must be a non-empty string when present");
        }
        out["path"] = resolved;
      }
      // A `path` of "." (Hermes' default) is left off deliberately: KAI's own default is the
      // declared workspace root, which is where "." would resolve anyway — and passing a
      // relative "." through would make the answer depend on the Core's cwd.

      const fileGlob = args["file_glob"];
      if (fileGlob !== undefined) {
        if (typeof fileGlob !== "string") {
          return bad("malformed_arguments", "file_glob", "file_glob must be a string when present");
        }
        const match = SIMPLE_EXTENSION_GLOB.exec(fileGlob.trim());
        if (match === null || match[1] === undefined) {
          return bad(
            "unsupported_argument",
            "file_glob",
            `file_glob: ${JSON.stringify(fileGlob)} — KAI filters by file EXTENSION (an "include" list), so only a single-extension glob such as "*.py" or "**/*.ts" can be expressed. A compound or name-based glob cannot, and approximating it would silently change which files are searched.`,
          );
        }
        out["include"] = [match[1]];
      }

      const limit = args["limit"];
      if (limit !== undefined) {
        const parsed = integerOf(limit);
        if (parsed === null) {
          return bad("malformed_arguments", "limit", "limit must be an integer when present");
        }
        if (parsed < 1 || parsed > 500) {
          return bad(
            "unsupported_argument",
            "limit",
            `limit: ${parsed} is outside KAI's result bound (1–500). Refusing rather than returning a different number of hits than asked for.`,
          );
        }
        out["maxResults"] = parsed;
      }
      return { ok: true, args: out };
    },
  },

  // ── sessions → session ──────────────────────────────────────────────────────
  session_search: {
    kaiToolId: "session.search",
    expectedRisk: "READ",
    equivalence:
      "Find KAI's own recorded conversation turns by literal text. Only the query/limit pair is equivalent; Hermes' sort/detail/time-window/scroll shapes have no KAI counterpart, so a call using any of them is refused rather than answered from a different window.",
    hermesArgs: [
      "query",
      "limit",
      "sort",
      "detail",
      "after",
      "before",
      "exclude_session_ids",
      "session_id",
      "around_message_id",
      "window",
      "role_filter",
      "profile",
    ],
    normalise(args, name) {
      const hermesArgs = [
        "query",
        "limit",
        "sort",
        "detail",
        "after",
        "before",
        "exclude_session_ids",
        "session_id",
        "around_message_id",
        "window",
        "role_filter",
        "profile",
      ];
      const bad_ =
        unknownArgument(args, hermesArgs, name) ??
        unsupportedArgument(args, {
          sort: "KAI's session.search ranks its own way; there is no temporal bias to set, and pretending there is would misrepresent the order of the hits.",
          detail: "KAI returns matching turns, not a hydrated 'bookend' window, so there is nothing to select.",
          after: "KAI's session.search has no time window — passing one would return an unbounded set while the caller believed it was bounded.",
          before: "KAI's session.search has no time window — passing one would return an unbounded set while the caller believed it was bounded.",
          exclude_session_ids: "KAI's session.search has no exclusion list; dropping it would return sessions the caller meant to skip.",
          session_id: "KAI's session.search cannot be scoped to one session (that is Hermes' scroll/read shape).",
          around_message_id: "KAI has no message anchor to scroll around (that is Hermes' scroll shape).",
          window: "KAI has no anchor window (that is Hermes' scroll shape).",
          role_filter: "KAI's session.search does not filter by role.",
          profile: "KAI's sessions carry no Hermes profile concept.",
        });
      if (bad_ !== null) return bad_;
      const query = textOf(args["query"]);
      if (query === null) {
        return bad(
          "malformed_arguments",
          "query",
          "query is required: Hermes treats an omitted query as its 'browse recent sessions' shape, and KAI's session.search has no such shape — an empty search is not a translation of it.",
        );
      }
      const out: Record<string, unknown> = { query };
      const limit = args["limit"];
      if (limit !== undefined) {
        const parsed = integerOf(limit);
        if (parsed === null) {
          return bad("malformed_arguments", "limit", "limit must be an integer when present");
        }
        if (parsed < 1 || parsed > 1000) {
          return bad(
            "unsupported_argument",
            "limit",
            `limit: ${parsed} is outside KAI's session.search bound (1–1000).`,
          );
        }
        out["limit"] = parsed;
      }
      return { ok: true, args: out };
    },
  },

  // ── skills → skills ─────────────────────────────────────────────────────────
  skills_list: {
    kaiToolId: "skills.list",
    expectedRisk: "READ",
    equivalence:
      "List the installed skills as metadata (no bodies). KAI tags skills by source/tier rather than by Hermes' category directories, so a category filter cannot be expressed — and ignoring one would return a superset the caller did not ask for.",
    hermesArgs: ["category"],
    normalise(args, name) {
      const bad_ =
        unknownArgument(args, ["category"], name) ??
        unsupportedArgument(args, {
          category:
            "KAI's skills.list has no category filter: KAI indexes skills by source/tier, not Hermes' category directories. Ignoring the filter would return skills the caller excluded, so it is refused. List without it and select by id.",
        });
      if (bad_ !== null) return bad_;
      return { ok: true, args: {} };
    },
  },

  skill_view: {
    kaiToolId: "skills.load",
    expectedRisk: "READ",
    equivalence:
      "Load one skill's body by id. `name` is renamed to KAI's `id` and validated with the SAME predicate KAI's skills.load uses. Hermes' `file_path` (read an arbitrary linked file inside the skill) has no counterpart: KAI loads by id only, so it is refused rather than silently degraded to the whole skill body.",
    hermesArgs: ["name", "file_path"],
    normalise(args, name) {
      const bad_ =
        unknownArgument(args, ["name", "file_path"], name) ??
        unsupportedArgument(args, {
          file_path:
            "KAI's skills.load reads the skill by id and nothing else: there is no arbitrary-path read inside a skill. Refusing rather than returning the whole skill body in place of the linked file the caller asked for.",
        });
      if (bad_ !== null) return bad_;
      const id = textOf(args["name"]);
      if (id === null) {
        return bad("malformed_arguments", "name", "name is required and must be a non-empty string");
      }
      if (!isSafeSkillId(id)) {
        return bad(
          "malformed_arguments",
          "name",
          `${JSON.stringify(id)} is not a usable KAI skill id (KAI validates the same way for skills.load). A Hermes-qualified name such as "plugin:skill" has no KAI id.`,
        );
      }
      return { ok: true, args: { id } };
    },
  },
};

// ── The refusal table ─────────────────────────────────────────────────────────

type DispositionCode = "permanent_deny" | "unsupported_capability" | "ambiguous_mapping";

interface Disposition {
  code: DispositionCode;
  reason: string;
}

/** Every Hermes name this module has read from the installed tree, with its disposition. */
const DISPOSITION_ENTRIES: ReadonlyArray<readonly [string, Disposition]> = [
  // ── Execution / code — see the header: no command-level guard exists in KAI to make a
  //    shell-string translation safe, so the mapping stays denied rather than pretending.
  [
    "terminal",
    {
      code: "permanent_deny",
      reason:
        "Hermes' `command` is a SHELL STRING; KAI's shell.run takes a PROGRAM plus an argv array and spawns with shell:false. Making a shell string work means synthesising a shell (cmd.exe /c <string>), which re-enables pipelines, chaining, redirection, substitution and download cradles behind ONE approval card that covers the whole string. KAI has no hardline-command detector, no user deny-list and no program allowlist to bound that, and a guard living in this module would be bypassed by every other caller of shell.run. Denied — including for benign commands.",
    },
  ],
  [
    "execute_code",
    {
      code: "permanent_deny",
      reason:
        "Runs Python in Hermes' own sandbox (tool allowlist, 300 s cap, tool-call and output caps). KAI has no sandbox, so the only conceivable target would be an interpreter under shell.run — arbitrary code execution with none of those caps, on KAI's single DESTRUCTIVE id.",
    },
  ],
  [
    "process_manage",
    {
      code: "permanent_deny",
      reason:
        "Manages Hermes' background process sessions by session_id. KAI's shell.run is synchronous with an AbortSignal and a timeout and has no process registry, so there is no session to manage and no safe translation of one.",
    },
  ],

  // ── File mutation with no atomic counterpart ────────────────────────────────
  [
    "patch",
    {
      code: "permanent_deny",
      reason:
        "Atomic find-and-replace with a uniqueness contract (`old_string` must be unique unless replace_all). KAI has no filesystem.edit id; downgrading to filesystem.write would rewrite the whole file, clobber any concurrent edit and never fail on a stale old_string — a silent wrong result rather than a translation.",
    },
  ],

  // ── Raw browser surfaces: arbitrary script / raw CDP ───────────────────────
  [
    "browser_exec",
    {
      code: "permanent_deny",
      reason:
        "Arbitrary JavaScript execution inside the page — the same authority as a shell for anything the page can reach (session cookies, authenticated fetch, the app's own APIs).",
    },
  ],
  [
    "browser_cdp",
    {
      code: "permanent_deny",
      reason:
        "Raw Chrome DevTools Protocol: Network.* can read cookies and responses, Runtime.evaluate is arbitrary script, Page.navigate is unrestricted navigation. It is browser_exec with more attack surface.",
    },
  ],

  // ── Credential store ────────────────────────────────────────────────────────
  [
    "browser_vault_unlock",
    {
      code: "permanent_deny",
      reason:
        "Unlocks the human's credential vault. A delegated worker must never be able to open the store of logins it is not the owner of.",
    },
  ],
  [
    "browser_vault_fill",
    {
      code: "permanent_deny",
      reason:
        "Types a vaulted credential into a page. That is the human's password leaving the vault on a worker's instruction — credential exfiltration with a UI on top.",
    },
  ],
  [
    "browser_vault_save_login",
    {
      code: "permanent_deny",
      reason:
        "Writes a new credential into the human's vault, from a worker, with no owner review of what is being stored.",
    },
  ],
  [
    "browser_vault_enter_code",
    {
      code: "permanent_deny",
      reason:
        "Submits a vaulted one-time code, i.e. completes a second-factor challenge on the human's behalf — an authentication the human did not perform.",
    },
  ],
  [
    "browser_vault_list",
    {
      code: "permanent_deny",
      reason:
        "Enumerates the human's stored logins. Even the inventory is private data a worker has no need for, and it is the reconnaissance step for every entry above.",
    },
  ],

  // ── Host / OS control ───────────────────────────────────────────────────────
  [
    "computer_use",
    {
      code: "permanent_deny",
      reason:
        "Drives the human's own desktop (mouse, keyboard, screen). The nearest KAI id, capability.computer, takes {action, input} from KAI's own capability vocabulary and is DESTRUCTIVE for a whole session; translating a driver payload into it is a re-implementation, and unrestricted host control is not a worker capability.",
    },
  ],

  // ── Network read with no KAI counterpart ────────────────────────────────────
  [
    "web_search",
    {
      code: "permanent_deny",
      reason:
        "KAI registers no outbound network-read tool. The only way to reach the network from KAI today is shell.run (curl), which is arbitrary command execution — so there is no safe translation and none is invented here.",
    },
  ],
  [
    "web_extract",
    {
      code: "permanent_deny",
      reason:
        "Fetches and extracts arbitrary URLs. Same reasoning as web_search: the only KAI path to the network is command execution, which is exactly what a worker must not be handed.",
    },
  ],
  [
    "x_search",
    {
      code: "permanent_deny",
      reason:
        "Reads a third-party service through Hermes' own authenticated client. KAI has no such tool, and reusing a Hermes credential path from a KAI decision would authorise an identity KAI does not own.",
    },
  ],
  [
    "manage_connections",
    {
      code: "permanent_deny",
      reason:
        "Administers Hermes' provider connections and credentials. KAI's equivalent surface is server administration, not a worker action.",
    },
  ],
  [
    "manage_catalog",
    {
      code: "permanent_deny",
      reason:
        "Administers Hermes' model/tool catalogue — configuration, not work. A worker that can edit the catalogue it is run by is not being governed by it.",
    },
  ],

  // ── Agent interaction ───────────────────────────────────────────────────────
  [
    "clarify",
    {
      code: "ambiguous_mapping",
      reason:
        "Hermes' clarify asks the human an open question. KAI's nearest mechanism is approval.decide, which DECIDES a parked operation — a different direction and a different meaning. Synthesising one from the other would let a worker resolve a prompt it raised, i.e. answer itself.",
    },
  ],
  [
    "todo_list",
    {
      code: "unsupported_capability",
      reason:
        "KAI has no worker-facing todo store: work items are orchestrator rows with their own lifecycle, not an agent's scratch checklist. There is nothing to write it to.",
    },
  ],

  // ── Names whose natural KAI target is auto-allowed, or which split several ways ──
  [
    "cronjob_manage",
    {
      code: "unsupported_capability",
      reason:
        "Seven Hermes actions against KAI's schedule.manage, which has two ops (create/cancel); Hermes' schedule strings are not KAI's ExtendedSchedule task shape; and schedule.manage is on KAI's internal-state list, so it is authorized with NO approval card — mapping a worker's cron authoring there would grant unattended scheduled work.",
    },
  ],
  [
    "delegate_task",
    {
      code: "unsupported_capability",
      reason:
        "One call that spawns parallel children and returns their results inline, against KAI's two-step define-a-persona/run-a-registered-agent model, with no batch semantics and no output_schema. Its natural target, agents.run_task, also becomes auto-allowed whenever autonomy.level >= 2 && workerAuto === \"AUTO\", so a worker's approval would depend on a user setting instead of a review.",
    },
  ],
  [
    "skill_manage",
    {
      code: "unsupported_capability",
      reason:
        "KAI deliberately has no skill authoring tool (install must be bound to the approved BYTES, not to a generic operation), and Hermes' `operations` argument is a heterogeneous batch that would have to be split across toggle/delete. skill.delete is irreversible content destruction with no counterbalancing authoring path.",
    },
  ],
  [
    "memory",
    {
      code: "ambiguous_mapping",
      reason:
        "ONE Hermes name covering six verbs plus a batch `operations` array, against six separate KAI ids (memory.write/create/correct/forget/share/list). Only `action: list` is faithful; the writes cannot be translated without inventing a `scope` (global/session/mission/employee/project) that Hermes has no concept of, and KAI deliberately refuses to DEFAULT that field because silently landing a fact in global would widen something the caller meant to keep private.",
    },
  ],
];

// ── The long tail: capabilities with no KAI equivalent at all ─────────────────

/** A Hermes name that exists, does real work, and has nothing in KAI to translate it to. */
function noEquivalent(names: readonly string[], reason: (name: string) => string): ReadonlyArray<readonly [string, Disposition]> {
  return names.map((name) => [name, { code: "unsupported_capability" as const, reason: reason(name) }]);
}

const BROWSER_VERBS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_back",
  "browser_press",
  "browser_get_images",
  "browser_vision",
  "browser_console",
  "browser_dialog",
  "browser_recordings",
  "browser_screenshots",
] as const;

const DESKTOP_UI = [
  "annotate_preview",
  "apply_layout",
  "close_terminal",
  "desktop_preview",
  "desktop_project",
  "drive_preview",
  "focus_pane",
  "gui_tour",
  "read_terminal",
  "read_window_below",
  "react_to_message",
  "show_tip",
] as const;

const MULTIMODAL = [
  "vision_analyze",
  "video_analyze",
  "image_generate",
  "video_generate",
  "xai_video_edit",
  "xai_video_extend",
  "text_to_speech",
] as const;

const KANBAN = [
  "kanban_show",
  "kanban_list",
  "kanban_complete",
  "kanban_block",
  "kanban_request_review",
  "kanban_request_changes",
  "kanban_heartbeat",
  "kanban_comment",
  "kanban_create",
  "kanban_link",
  "kanban_unblock",
  "kanban_attach",
  "kanban_attach_url",
  "kanban_attachments",
] as const;

const CONNECTORS = [
  "ha_list_entities",
  "ha_get_state",
  "ha_list_services",
  "ha_call_service",
  "feishu_doc_read",
  "feishu_drive_list_comments",
  "feishu_drive_list_comment_replies",
  "feishu_drive_reply_comment",
  "feishu_drive_add_comment",
  "yb_query_group_info",
  "yb_query_group_members",
  "yb_send_dm",
  "yb_search_sticker",
  "yb_send_sticker",
  "discord",
  "discord_admin",
] as const;

const LONG_TAIL_ENTRIES: ReadonlyArray<readonly [string, Disposition]> = [
  ...noEquivalent(
    BROWSER_VERBS,
    (name) =>
      `KAI's nearest id is capability.browser{action, input}, whose \`action\` is resolved against KAI's OWN supportedActions vocabulary and whose risk (EXTERNAL) covers a whole browser session rather than one verb. ${name} would need a per-action translation with its own review — a re-implementation, not a mapping — so it is refused.`,
  ),
  ...noEquivalent(
    DESKTOP_UI,
    (name) =>
      `${name} drives or reads Hermes' desktop UI layer. KAI has no desktop-UI tool: the nearest surface is the DESTRUCTIVE capability.computer driver interface, which is a different interface (its own action vocabulary and payload shape), so this is not a mapping.`,
  ),
  ...noEquivalent(
    MULTIMODAL,
    (name) => `${name} has no KAI equivalent: KAI registers no vision, video, image, audio or media tool.`,
  ),
  ...noEquivalent(
    KANBAN,
    (name) =>
      `${name} operates Hermes' kanban board (cards in columns, heartbeats, attachments). KAI's board is a normalised work-item model with its own lifecycle (missions/workforce), not a card protocol, and it has no heartbeat, attach, link or review-request analogue — so there is no name-for-name translation.`,
  ),
  ...noEquivalent(
    CONNECTORS,
    (name) =>
      `${name} calls an external connector service (Home Assistant, Feishu, Yuanbao, Discord) through Hermes' own integrations. KAI registers no such integration, so there is nothing to route it to.`,
  ),
];

// ── Assembled tables (with load-time invariants) ──────────────────────────────

function assembleDispositions(): Readonly<Record<string, Disposition>> {
  const table: Record<string, Disposition> = {};
  for (const [name, disposition] of [...DISPOSITION_ENTRIES, ...LONG_TAIL_ENTRIES]) {
    if (table[name] !== undefined) {
      throw new Error(`tool-mapping: "${name}" has two dispositions; one name must have exactly one`);
    }
    if (name in MAPPINGS) {
      throw new Error(`tool-mapping: "${name}" is both mapped and refused; exactly one must hold`);
    }
    if (disposition.reason.trim().length === 0) {
      throw new Error(`tool-mapping: the disposition for "${name}" states no reason`);
    }
    table[name] = disposition;
  }
  return table;
}

/** name → why it can never be mapped. Every entry carries its own stated reason. */
const HERMES_TOOL_DISPOSITIONS: Readonly<Record<string, Disposition>> = assembleDispositions();

/** The Hermes names that are refused OUTRIGHT (the permanent-deny list), with their reasons. */
export function permanentDenyList(): Array<{ hermesTool: string; reason: string }> {
  return Object.entries(HERMES_TOOL_DISPOSITIONS)
    .filter(([, disposition]) => disposition.code === "permanent_deny")
    .map(([hermesTool, disposition]) => ({ hermesTool, reason: disposition.reason }));
}

/** The reviewed mapping table, as data — for a report, a UI, or a test. */
export function describeToolMapping(): {
  mappings: Array<{
    hermesTool: string;
    kaiToolId: string;
    expectedRisk: RiskLevel;
    equivalence: string;
    hermesArgs: readonly string[];
  }>;
  refusals: Array<{ hermesTool: string; code: DispositionCode; reason: string }>;
} {
  return {
    mappings: Object.entries(MAPPINGS).map(([hermesTool, spec]) => ({
      hermesTool,
      kaiToolId: spec.kaiToolId,
      expectedRisk: spec.expectedRisk,
      equivalence: spec.equivalence,
      hermesArgs: spec.hermesArgs,
    })),
    refusals: Object.entries(HERMES_TOOL_DISPOSITIONS).map(([hermesTool, disposition]) => ({
      hermesTool,
      code: disposition.code,
      reason: disposition.reason,
    })),
  };
}

/** The KAI ids every mapping may produce. Nothing outside this set is reachable by name. */
export function mappedKaiToolIds(): string[] {
  return [...new Set(Object.values(MAPPINGS).map((spec) => spec.kaiToolId))].sort();
}

// ── KAI-side prohibitions for the WORKER path ────────────────────────────────

export interface WorkerForbiddenKaiTool {
  id: string;
  reason: string;
}

/**
 * KAI tool ids a DELEGATED WORKER may never be authorized for, whatever it names them.
 *
 * This is not a second policy engine: the running policy still decides everything else, and
 * these ids are refused HERE because each one is a *precondition* of the boundary itself
 * rather than an action taken through it — a worker that can author policy, replace KAI's
 * identity, load code, resolve the very approval that gates it, or administer KAI's MCP
 * servers is not a worker being governed. Two of them matter especially: `approval.decide`
 * and `schedule.manage` are on KAI's internal-state allowlist, so policy would authorize
 * them with no approval card at all, and `capability.system` is a DISPATCHER whose declared
 * risk (READ) understates what it can reach.
 *
 * Deliberately NOT here: `shell.run` and `filesystem.write`. Those are real work that the
 * policy engine already parks for a human — refusing them here would replace a reviewed
 * decision with a blanket ban, which is a different mistake.
 */
export const WORKER_FORBIDDEN_KAI_TOOLS: readonly WorkerForbiddenKaiTool[] = [
  { id: "policy.set", reason: "KAI's own policy authority: a worker that can author policy is not being governed by it." },
  { id: "soul.set", reason: "Replaces KAI's identity — the thing the boundary exists to keep distinct from the worker." },
  { id: "settings.update", reason: "Mutates global runtime configuration that governs every other call." },
  { id: "plugin.lifecycle", reason: "Loads or replaces code inside the Core." },
  { id: "doer.set", reason: "Toggles the autonomous Doer, i.e. whether anything is human-gated at all." },
  { id: "maintenance.run", reason: "A broad internal-state sweep with no worker-scoped meaning." },
  {
    id: "approval.decide",
    reason:
      "SELF-APPROVAL: the worker would be resolving the very request that gates it. KAI's internal-state rule auto-allows this id, so the boundary must refuse it by name.",
  },
  { id: "checkpoint.restore", reason: "Rolls state back behind the human's back, discarding work they may be reviewing." },
  { id: "session.clear", reason: "Destroys the transcript that approval bindings and evidence depend on." },
  { id: "session.delete", reason: "Destroys the transcript that approval bindings and evidence depend on." },
  { id: "skill.delete", reason: "Irreversible content destruction, with no KAI skill-authoring path to counterbalance it." },
  { id: "memory.forget", reason: "Deliberately parked for a human by default; a worker must not drive it." },
  {
    id: "mcp.register",
    reason: "MCP server ADMINISTRATION, not an MCP tool call: a worker would be adding a server to KAI's own configuration.",
  },
  { id: "mcp.update", reason: "MCP server administration: a worker would be redefining a server KAI already trusts." },
  { id: "mcp.enable", reason: "MCP server administration: a worker would be enabling a server the human left off." },
  { id: "mcp.disable", reason: "MCP server administration: a worker would be removing a server the human relies on." },
  { id: "mcp.remove", reason: "MCP server administration: a worker would be deleting the human's server configuration." },
  { id: "mcp.connect", reason: "MCP server administration: connecting spawns a process (EXTERNAL)." },
  { id: "mcp.disconnect", reason: "MCP server administration, disrupting KAI's own tooling." },
  { id: "mcp.refresh", reason: "MCP server administration: re-reads and re-admits a server's tool surface." },
  { id: "capability.mcp", reason: "The MCP capability dispatcher: same administration authority as the mcp.* ids." },
  {
    id: "capability.system",
    reason:
      "A DISPATCHER: {action, input} routes into another tool's own invoke path, and its declared risk (READ) understates what it can reach — the runtime records that this exact hole once reached DESTRUCTIVE shell.",
  },
  {
    id: "agents.run_task",
    reason:
      "Delegation: a worker spawning further workers is an escalation, and the runtime auto-allows this id when autonomy.level >= 2 && workerAuto === \"AUTO\", so its approval would depend on a user setting rather than a review.",
  },
];

/** id → prohibition. A static, string-keyed table, so it is a Record, not a Map. */
const WORKER_FORBIDDEN_INDEX: Readonly<Record<string, WorkerForbiddenKaiTool>> = Object.fromEntries(
  WORKER_FORBIDDEN_KAI_TOOLS.map((entry) => [entry.id, entry]),
);

/** The prohibition for a KAI id on the worker path, if it has one. */
export function workerForbiddenKaiTool(id: string): WorkerForbiddenKaiTool | undefined {
  return WORKER_FORBIDDEN_INDEX[id];
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * Translate one declared Hermes action into a KAI tool id plus normalised arguments.
 *
 * `tools` is optional so the table can be exercised in isolation, but the BOUNDARY always
 * passes the real registry: it is what makes the risk in the result the registry's rather
 * than this table's, and it is what turns a stale mapping (`not_registered`) or a
 * re-classified tool (`risk_regression`) into a refusal instead of a silent grant.
 *
 * Nothing here decides. A hit means "these are the same action, spelled KAI's way", and the
 * caller still has to validate, policy-check and (where required) obtain a human approval.
 */
export function resolveHermesTool(
  hermesTool: unknown,
  args: unknown,
  tools?: ToolRiskLookup,
): ToolMappingResult {
  const name = typeof hermesTool === "string" ? hermesTool.trim() : "";
  if (name.length === 0) {
    return {
      ok: false,
      hermesTool: "",
      code: "unknown_tool",
      reason: "the action names no tool, so there is nothing to translate",
    };
  }

  // 1. A permanently denied or unsupported NAME is refused regardless of its arguments:
  //    a deny that depends on the arguments is a deny that can be argued with.
  if (name.startsWith("mcp-")) {
    return {
      ok: false,
      hermesTool: name,
      code: "permanent_deny",
      reason:
        `"${name}" is an MCP tool name published by a server, and the names are server-defined and unbounded, so no allowlist can enumerate them. KAI's own mcp.* ids are server ADMINISTRATION, not MCP calls, so mapping one here would let a worker reconfigure KAI's servers. Deny by default; a specific server would have to be admitted deliberately, by the owner, with its own review.`,
    };
  }
  const disposition = HERMES_TOOL_DISPOSITIONS[name];
  if (disposition !== undefined) {
    return { ok: false, hermesTool: name, code: disposition.code, reason: disposition.reason };
  }

  // 2. A mapped name is translated and its arguments normalised.
  const spec = MAPPINGS[name];
  if (spec === undefined) {
    return {
      ok: false,
      hermesTool: name,
      code: "unknown_tool",
      reason: `"${name}" is not a tool this Core registers, and no Hermes→KAI mapping covers it, so it cannot be authorized`,
    };
  }

  const parsed = plainArgs(args);
  if (!parsed.ok) {
    return { ok: false, hermesTool: name, code: parsed.code, reason: parsed.reason };
  }
  const normalised = spec.normalise(parsed.args, name);
  if (!normalised.ok) {
    return {
      ok: false,
      hermesTool: name,
      code: normalised.code,
      reason: normalised.reason,
      ...(normalised.argument !== undefined ? { argument: normalised.argument } : {}),
    };
  }

  // 3. Against the LIVE registry: the tool must exist, and its risk must not have been
  //    weakened since this mapping was reviewed.
  if (tools !== undefined) {
    const live = tools.get(spec.kaiToolId);
    if (live === undefined) {
      return {
        ok: false,
        hermesTool: name,
        code: "not_registered",
        reason: `"${name}" maps to KAI tool "${spec.kaiToolId}", which this Core does not register, so nothing may be authorized for it`,
      };
    }
    if (RISK_AUTHORITY[live.risk] < RISK_AUTHORITY[spec.expectedRisk]) {
      return {
        ok: false,
        hermesTool: name,
        code: "risk_regression",
        reason: `"${name}" maps to "${spec.kaiToolId}", whose registered risk is ${live.risk} — weaker than the ${spec.expectedRisk} this mapping was reviewed against. Refusing rather than authorizing an action under a risk no reviewer agreed to.`,
      };
    }
    return {
      ok: true,
      hermesTool: name,
      kaiToolId: spec.kaiToolId,
      args: normalised.args,
      equivalence: spec.equivalence,
      expectedRisk: spec.expectedRisk,
      risk: live.risk,
    };
  }

  return {
    ok: true,
    hermesTool: name,
    kaiToolId: spec.kaiToolId,
    args: normalised.args,
    equivalence: spec.equivalence,
    expectedRisk: spec.expectedRisk,
    risk: spec.expectedRisk,
  };
}
