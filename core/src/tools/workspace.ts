// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core workspace tools — the first REAL shell / git / filesystem actions.
 *
 * Until now `filesystem`, `shell` and `git` were registered as honest UNAVAILABLE
 * stubs ("no such tool is implemented in KAI yet"). This module is the missing
 * implementation, and it is written to the same rule as every other action in the
 * Core: nothing here is reachable except through the ONE tool registry's boundary
 *
 *     validate -> risk classification -> policy -> (approval) -> execute
 *
 * so a shell command, a file write and a git read are classified, approvable and
 * recorded exactly like a memory write or a worker task. There is no second way
 * to run one.
 *
 * ── Honest risk, not decorative risk ─────────────────────────────────────────
 *   filesystem.read / filesystem.list / git.*   READ        (allowed unattended)
 *   filesystem.write                            WRITE       (parks for a human)
 *   shell.run                                   DESTRUCTIVE (parks for a human)
 *
 * `filesystem.write` and `shell.run` are also flagged `effectful`, which is the
 * separate fact the acceptance boundary records: their effect must survive a
 * crash as BEFORE_ACCEPT/AFTER_ACCEPT rather than being replayed blindly.
 *
 * ── Why the ops are plain functions ──────────────────────────────────────────
 * The capability layer (`capability.filesystem`, `capability.shell`,
 * `capability.git`) dispatches to these SAME functions. That keeps ONE policy
 * decision at ONE boundary: the capability tool already ran validate -> policy ->
 * (approval) before its `execute` is reached, so re-entering the registry for the
 * inner tool id would either double-park the action or need the approval to be
 * re-bound to a second tool id (which the registry correctly refuses). The
 * individual tools are registered too, so a mission step or a direct `invoke` uses
 * the identical implementation.
 *
 * Commands run through `execFile` with `shell: false`: an argument list is passed
 * to a real program, so there is no shell to interpolate metacharacters into. A
 * caller that genuinely needs a shell asks for one explicitly (e.g.
 * `command: "cmd"`, `args: ["/c", "..."]`), and that request is a DESTRUCTIVE
 * action that parks for a human like any other.
 */

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { isNonEmptyString, isRecord } from "../shared/contracts.ts";
import type { ToolDefinition } from "./registry.ts";

/** Largest file a read will return; the tail is reported as truncated, never silently dropped. */
export const MAX_READ_BYTES = 1_000_000;
/** Largest directory listing. */
export const MAX_LIST_ENTRIES = 500;
/** Largest captured stdout/stderr per stream. */
export const MAX_OUTPUT_CHARS = 262_144;
/** Default command timeout; a caller may lower it but not raise it past the ceiling. */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 120_000;

/** Largest result cap a search will honour, and its default. */
export const MAX_SEARCH_RESULTS = 500;
export const DEFAULT_SEARCH_RESULTS = 50;
/** How deep a recursive search will walk before it stops and says so. */
export const DEFAULT_SEARCH_DEPTH = 8;
export const MAX_SEARCH_DEPTH = 16;
/** Largest slice of one file a content search will read. */
export const MAX_SEARCH_FILE_BYTES = 1_000_000;
/** Directories a search skips by default: build/vendor trees, not "my files". */
export const SEARCH_SKIP_DIRS: readonly string[] = ["node_modules", ".git"];

export const WORKSPACE_TOOL_IDS = {
  read: "filesystem.read",
  list: "filesystem.list",
  search: "filesystem.search",
  metadata: "filesystem.metadata",
  write: "filesystem.write",
  gitStatus: "git.status",
  gitLog: "git.log",
  gitDiff: "git.diff",
  shell: "shell.run",
} as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Accept undefined/null or a plain object whose keys are all allowed. */
function parseOptions(input: unknown, allowed: readonly string[]): Parsed<Record<string, unknown>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (Array.isArray(input)) return { ok: false, reason: "input must be an object, not an array" };
  if (!isRecord(input)) return { ok: false, reason: `input must be an object or omitted; received ${typeof input}` };
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return { ok: false, reason: `unknown option "${key}"; allowed options: ${allowed.join(", ") || "none"}` };
    }
  }
  return { ok: true, value: input };
}

function pathOf(value: unknown, label: string): Parsed<string> {
  if (!isNonEmptyString(value)) return { ok: false, reason: `${label} must be a non-empty string` };
  // Resolve to an absolute path and report THAT back, so the caller always sees
  // exactly which file it touched — a relative path is not an audit trail.
  const resolved = isAbsolute(value) ? value : resolve(value);
  // A READ tool that can read ANY file is not READ. Every workspace path is
  // confined to a DECLARED root before any I/O, so `C:/Windows/win.ini`, an SSH
  // key or `~/.hermes/.env` is refused rather than served.
  try {
    return { ok: true, value: assertInsideWorkspace(resolved) };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

/**
 * The roots a workspace tool may touch — declared, never implicit.
 *
 *   - the configured workspace root, `KAI_WORKSPACE_ROOT` (`;` or `,` separated),
 *     defaulting to the Core's own working directory;
 *   - the OS temp directory, where a mission or a test stages scratch work.
 *
 * A path is permitted only when it IS one of these roots or lies under it.
 */
export function workspaceRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.KAI_WORKSPACE_ROOT;
  const declared =
    raw !== undefined && raw.trim().length > 0
      ? raw.split(/[;,]/).map((p) => p.trim()).filter((p) => p.length > 0)
      : [process.cwd()];
  return [...declared, tmpdir()].map((p) => resolve(p));
}

/**
 * KAI's intended workspace root: the first declared root — the first entry of
 * `KAI_WORKSPACE_ROOT`, or the Core's working directory when nothing is
 * declared. (`workspaceRoots()` appends the OS temp dir last, so index 0 is
 * always the real workspace, never scratch.) Tools whose declaration leaves
 * `path` optional resolve an omitted path here instead of failing.
 */
export function defaultWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return workspaceRoots(env)[0] ?? process.cwd();
}

function insideRoot(target: string, root: string): boolean {
  const norm = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
  const t = norm(target);
  const r = norm(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Refuse a path that is outside every declared workspace root. The check is
 * purely lexical and runs BEFORE any filesystem call, so a refusal never depends
 * on the file existing. Throws with the resolved path and the allowed roots.
 */
export function assertInsideWorkspace(p: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = resolve(p);
  const roots = workspaceRoots(env);
  if (roots.some((root) => insideRoot(target, root))) return target;
  throw new Error(
    `path "${target}" is outside the workspace sandbox; allowed roots: ${roots.join(", ")}`,
  );
}

function positiveInt(value: unknown, label: string, max: number, fallback: number): Parsed<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, reason: `${label} must be an integer` };
  if (value < 1) return { ok: false, reason: `${label} must be at least 1` };
  if (value > max) return { ok: false, reason: `${label} must be at most ${max}` };
  return { ok: true, value };
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── filesystem ────────────────────────────────────────────────────────────────

/** Read a UTF-8 text file, bounded. */
export function filesystemRead(input: unknown): { path: string; bytes: number; truncated: boolean; content: string } {
  const parsed = parseOptions(input, ["path", "maxBytes"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const path = pathOf(parsed.value.path, "path");
  if (!path.ok) throw new Error(path.reason);
  const maxBytes = positiveInt(parsed.value.maxBytes, "maxBytes", MAX_READ_BYTES, MAX_READ_BYTES);
  if (!maxBytes.ok) throw new Error(maxBytes.reason);

  const stat = statSync(path.value);
  if (stat.isDirectory()) throw new Error(`"${path.value}" is a directory; use filesystem.list`);
  const raw = readFileSync(path.value, "utf8");
  const clipped = clip(raw, maxBytes.value);
  return { path: path.value, bytes: stat.size, truncated: clipped.truncated, content: clipped.text };
}

/** List a directory (non-recursive), bounded. */
export function filesystemList(input: unknown): {
  path: string;
  entries: { name: string; type: "file" | "directory" | "other"; size: number }[];
  truncated: boolean;
} {
  const parsed = parseOptions(input, ["path", "limit"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const path = pathOf(parsed.value.path, "path");
  if (!path.ok) throw new Error(path.reason);
  const limit = positiveInt(parsed.value.limit, "limit", MAX_LIST_ENTRIES, MAX_LIST_ENTRIES);
  if (!limit.ok) throw new Error(limit.reason);

  const all = readdirSync(path.value, { withFileTypes: true });
  const dirents = all.slice(0, limit.value);
  const entries = dirents.map((entry) => {
    let size = 0;
    try {
      size = entry.isFile() ? statSync(resolve(path.value, entry.name)).size : 0;
    } catch {
      size = 0;
    }
    const type: "file" | "directory" | "other" = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
    return { name: entry.name, type, size };
  });
  return { path: path.value, entries, truncated: all.length > limit.value };
}

/** Write a UTF-8 text file. WRITE + effectful: the default policy parks it. */
export function filesystemWrite(input: unknown): { path: string; bytes: number } {
  const parsed = parseOptions(input, ["path", "content", "createDirs"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const path = pathOf(parsed.value.path, "path");
  if (!path.ok) throw new Error(path.reason);
  if (typeof parsed.value.content !== "string") throw new Error("content must be a string");
  const createDirs = parsed.value.createDirs === true;
  if (parsed.value.createDirs !== undefined && typeof parsed.value.createDirs !== "boolean") {
    throw new Error("createDirs must be a boolean when present");
  }
  if (createDirs) mkdirSync(dirname(path.value), { recursive: true });
  writeFileSync(path.value, parsed.value.content, "utf8");
  return { path: path.value, bytes: Buffer.byteLength(parsed.value.content, "utf8") };
}

// ── filesystem.search / filesystem.metadata (read-only) ───────────────────────

/** One hit: a filename match, or a matching line inside a file. */
export interface FilesystemSearchMatch {
  path: string;
  kind: "name" | "content";
  /** 1-based line number, for a content match only. */
  line?: number;
  /** The matching line, trimmed and clipped; content matches only. */
  preview?: string;
}

export interface FilesystemSearchResult {
  root: string;
  query: string;
  mode: "content" | "name" | "both";
  matches: FilesystemSearchMatch[];
  filesScanned: number;
  filesSkipped: number;
  /** True when the result cap was reached and more matches may exist. */
  truncated: boolean;
  /** True when the walk finished within its depth cap; false means it stopped early. */
  scanComplete: boolean;
  /** Directory names that were skipped (build/vendor trees, or caller-supplied). */
  skippedDirs: string[];
}

/** A file whose first bytes contain a NUL is treated as binary and not content-scanned. */
function looksBinary(buffer: Buffer): boolean {
  const window = Math.min(buffer.length, 8192);
  for (let index = 0; index < window; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * Search inside the files that live under a sandboxed root.
 *
 * `filesystem.search` is the tool a "search inside my files" request selects.
 * It walks the tree under `path` (confined to a declared workspace root by
 * `pathOf`), matching either FILE NAMES (`mode: "name"`) or file CONTENTS
 * (`mode: "content"`, the default) — the mode the user's phrasing most often
 * means. Every bound is explicit and reported: `maxResults`, `maxDepth`,
 * per-file `maxFileBytes`, and the binary/symlink skip. Nothing is silently
 * dropped: a cap that bites sets `truncated` or `scanComplete: false`.
 */
export function filesystemSearch(input: unknown): FilesystemSearchResult {
  const parsed = parseOptions(input, [
    "path",
    "query",
    "mode",
    "maxResults",
    "maxDepth",
    "maxFileBytes",
    "caseSensitive",
    "skipDirs",
    "include",
  ]);
  if (!parsed.ok) throw new Error(parsed.reason);
  // An omitted path searches the workspace root — the declaration promises it
  // is optional, so execution must honour that rather than fail. An explicit
  // path is still confined to the sandbox by `pathOf`.
  const rawPath = parsed.value.path === undefined ? defaultWorkspaceRoot() : parsed.value.path;
  const path = pathOf(rawPath, "path");
  if (!path.ok) throw new Error(path.reason);
  if (!isNonEmptyString(parsed.value.query)) throw new Error("query must be a non-empty string");
  const query = parsed.value.query;

  let mode: "content" | "name" | "both" = "content";
  if (parsed.value.mode !== undefined) {
    if (parsed.value.mode !== "content" && parsed.value.mode !== "name" && parsed.value.mode !== "both") {
      throw new Error('mode must be one of: content, name, both');
    }
    mode = parsed.value.mode;
  }
  const maxResults = positiveInt(parsed.value.maxResults, "maxResults", MAX_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS);
  if (!maxResults.ok) throw new Error(maxResults.reason);
  const maxDepth = positiveInt(parsed.value.maxDepth, "maxDepth", MAX_SEARCH_DEPTH, DEFAULT_SEARCH_DEPTH);
  if (!maxDepth.ok) throw new Error(maxDepth.reason);
  const maxFileBytes = positiveInt(parsed.value.maxFileBytes, "maxFileBytes", MAX_SEARCH_FILE_BYTES, MAX_SEARCH_FILE_BYTES);
  if (!maxFileBytes.ok) throw new Error(maxFileBytes.reason);
  if (parsed.value.caseSensitive !== undefined && typeof parsed.value.caseSensitive !== "boolean") {
    throw new Error("caseSensitive must be a boolean when present");
  }
  const caseSensitive = parsed.value.caseSensitive === true;

  let skipDirs: string[] = [...SEARCH_SKIP_DIRS];
  if (parsed.value.skipDirs !== undefined) {
    if (!Array.isArray(parsed.value.skipDirs) || parsed.value.skipDirs.some((d) => typeof d !== "string")) {
      throw new Error("skipDirs must be an array of directory names when present");
    }
    skipDirs = parsed.value.skipDirs as string[];
  }

  let include: string[] | undefined;
  if (parsed.value.include !== undefined) {
    if (!Array.isArray(parsed.value.include) || parsed.value.include.some((e) => typeof e !== "string")) {
      throw new Error("include must be an array of file extensions when present");
    }
    include = (parsed.value.include as string[]).map((ext) => (ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: FilesystemSearchMatch[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  let scanComplete = true;

  const atCap = (): boolean => matches.length >= maxResults.value;

  const scanFile = (filePath: string): void => {
    filesScanned += 1;
    if (mode === "name" || mode === "both") {
      const name = basename(filePath);
      const haystack = caseSensitive ? name : name.toLowerCase();
      if (haystack.includes(needle)) {
        matches.push({ path: filePath, kind: "name" });
        if (atCap()) return;
      }
    }
    if (mode === "content" || mode === "both") {
      let buffer: Buffer;
      try {
        buffer = readFileSync(filePath);
      } catch {
        filesSkipped += 1;
        return;
      }
      if (looksBinary(buffer)) {
        filesSkipped += 1;
        return;
      }
      const text = buffer.subarray(0, maxFileBytes.value).toString("utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          matches.push({ path: filePath, kind: "content", line: index + 1, preview: clip(line.trim(), 200).text });
          if (atCap()) return;
        }
      }
    }
  };

  const walk = (dir: string, depth: number): void => {
    if (atCap() || depth > maxDepth.value) {
      if (depth > maxDepth.value) scanComplete = false;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      filesSkipped += 1;
      return;
    }
    for (const entry of entries) {
      if (atCap()) return;
      const full = join(dir, entry.name);
      // A symlink could point outside the sandbox, so it is never followed.
      if (entry.isSymbolicLink()) {
        filesSkipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (include !== undefined && !include.includes(extname(entry.name).toLowerCase())) continue;
      // Confine even a discovered path, so a crafted directory name cannot escape.
      assertInsideWorkspace(full);
      scanFile(full);
    }
  };

  const rootStat = statSync(path.value);
  if (rootStat.isDirectory()) {
    walk(path.value, 1);
  } else {
    scanFile(path.value);
  }

  return {
    root: path.value,
    query,
    mode,
    matches,
    filesScanned,
    filesSkipped,
    truncated: atCap(),
    scanComplete,
    skippedDirs: skipDirs,
  };
}

/** Describe one path's metadata without reading its contents. Read-only. */
export function filesystemMetadata(input: unknown): {
  path: string;
  exists: boolean;
  type: "file" | "directory" | "symlink" | "other" | "missing";
  size?: number;
  modifiedAt?: string;
  createdAt?: string;
  mode?: string;
  extension?: string;
} {
  const parsed = parseOptions(input, ["path"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const path = pathOf(parsed.value.path, "path");
  if (!path.ok) throw new Error(path.reason);
  if (!existsSync(path.value)) return { path: path.value, exists: false, type: "missing" };
  const stat = lstatSync(path.value);
  const type = stat.isSymbolicLink()
    ? "symlink"
    : stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : "other";
  return {
    path: path.value,
    exists: true,
    type,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
    mode: `0${(stat.mode & 0o777).toString(8)}`,
    extension: extname(path.value).toLowerCase(),
  };
}

// ── git (read-only) ───────────────────────────────────────────────────────────

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when a caller-provided AbortSignal stopped the run. */
  cancelled?: boolean;
  durationMs: number;
}

/**
 * Terminate a spawned child AND its descendants. `child.kill()` only ends the
 * direct child: a `cmd.exe` (or anything it launched) keeps running after the
 * parent dies, so Stop would lie. Windows has no process groups for this, so
 * the tree kill goes through `taskkill /T /F`; POSIX kills the group.
 */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => undefined);
    } else if (pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Live command-stream sink. The CORE installs one sink at boot; `exec` calls it
 * for every chunk the real child process produces — stdout and stderr as they
 * arrive, plus start/exit lifecycle. This is the ONE seam that turns a buffered
 * `execFile` callback into a real-time stream; it is not a second event model
 * (the sink just publishes Core events on the existing bus).
 */
export interface CommandStreamEvent {
  commandExecutionId: string;
  type: "command.started" | "command.stdout" | "command.stderr" | "command.exit";
  command: string;
  args: string[];
  cwd: string;
  /** Present for stdout/stderr. */
  stream?: "stdout" | "stderr";
  chunk?: string;
  /** Present for exit. */
  exitCode?: number | null;
  timedOut?: boolean;
  /** Present and true on exit when an AbortSignal stopped the run. */
  cancelled?: boolean;
  durationMs?: number;
}

let commandStreamSink: ((event: CommandStreamEvent) => void) | null = null;
let commandSeq = 0;

/** THE one place the Core wires live command output into its event bus. */
export function setCommandStreamSink(sink: ((event: CommandStreamEvent) => void) | null): void {
  commandStreamSink = sink;
}

function exec(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  opts?: { signal?: AbortSignal },
): Promise<ExecResult> {
  const startedAt = Date.now();
  const commandExecutionId = `cmd_${Date.now().toString(36)}_${(commandSeq++).toString(36)}`;
  const signal = opts?.signal;
  // Already cancelled before the child exists: no process, no events past the
  // exit record — stopping before a start is still a stop.
  if (signal?.aborted === true) {
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    });
  }
  return new Promise<ExecResult>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    } catch (error) {
      reject(new Error(`${command} could not run: ${messageOf(error)}`));
      return;
    }
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };
    const emit = (event: Omit<CommandStreamEvent, "commandExecutionId" | "command" | "args" | "cwd">): void => {
      if (settled) return;
      try {
        commandStreamSink?.({ commandExecutionId, command, args, cwd, ...event });
      } catch {
        // Observation is best-effort; execution continues regardless.
      }
    };
    const onAbort = (): void => {
      // Stop means stop: kill the whole tree (not just the direct child),
      // record the REAL exit, and emit nothing further for this execution.
      if (child.pid !== undefined) killProcessTree(child.pid);
      const durationMs = Date.now() - startedAt;
      emit({ type: "command.exit", exitCode: null, timedOut: false, durationMs, cancelled: true });
      finish({ exitCode: null, stdout: out.join(""), stderr: err.join(""), timedOut: false, cancelled: true, durationMs });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    emit({ type: "command.started" });

    const out: string[] = [];
    const err: string[] = [];
    let outLen = 0;
    let errLen = 0;
    const cap = MAX_OUTPUT_CHARS * 4;
    const push = (stream: "stdout" | "stderr", buf: Buffer): void => {
      const text = buf.toString("utf8");
      if (stream === "stdout") {
        if (outLen < cap) { out.push(text); outLen += text.length; }
      } else if (errLen < cap) { err.push(text); errLen += text.length; }
      emit({ type: stream === "stdout" ? "command.stdout" : "command.stderr", stream, chunk: text });
    };
    child.stdout?.on("data", (b: Buffer) => push("stdout", b));
    child.stderr?.on("data", (b: Buffer) => push("stderr", b));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      else {
        try { child.kill(); } catch { /* already gone */ }
      }
    }, timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      const code = error.code;
      // A numeric exit is a RESULT; a missing binary (ENOENT) / signal is a real
      // failure with nothing to report — the same rule the callback form used.
      if (typeof code === "number") {
        const durationMs = Date.now() - startedAt;
        emit({ type: "command.exit", exitCode: code, timedOut, durationMs });
        finish({ exitCode: code, stdout: out.join(""), stderr: err.join(""), timedOut, durationMs });
        return;
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settled = true;
      reject(new Error(`${command} could not run: ${messageOf(error)}`));
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      const durationMs = Date.now() - startedAt;
      emit({ type: "command.exit", exitCode: timedOut ? null : code, timedOut, durationMs });
      finish({ exitCode: timedOut ? null : code, stdout: out.join(""), stderr: err.join(""), timedOut, durationMs });
    });
  });
}

async function git(args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  const result = await exec("git", args, cwd, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode ?? "?"}): ${result.stderr.trim() || "no stderr"}`);
  }
  return result;
}

function gitCwd(input: Record<string, unknown>): string {
  if (input.cwd === undefined) return process.cwd();
  if (!isNonEmptyString(input.cwd)) throw new Error("cwd must be a non-empty string when present");
  // A relative cwd is the default workspace; an absolute one is still confined
  // to the declared roots, so `git -C C:/Users/...` and a shell cwd cannot walk
  // out of the workspace either.
  return assertInsideWorkspace(isAbsolute(input.cwd) ? input.cwd : resolve(input.cwd));
}

export async function gitStatus(input: unknown): Promise<{ cwd: string; branch: string; clean: boolean; entries: string[] }> {
  const parsed = parseOptions(input, ["cwd"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const cwd = gitCwd(parsed.value);
  const result = await git(["status", "--porcelain=v1", "-b"], cwd, DEFAULT_SHELL_TIMEOUT_MS);
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines.find((line) => line.startsWith("## ")) ?? "## (unknown)";
  const branch = header.slice(3).split("...")[0]?.trim() ?? "";
  const entries = lines.filter((line) => !line.startsWith("## "));
  return { cwd, branch, clean: entries.length === 0, entries };
}

export async function gitLog(input: unknown): Promise<{ cwd: string; commits: { sha: string; subject: string }[] }> {
  const parsed = parseOptions(input, ["cwd", "limit"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const cwd = gitCwd(parsed.value);
  const limit = positiveInt(parsed.value.limit, "limit", 200, 20);
  if (!limit.ok) throw new Error(limit.reason);
  const result = await git(
    ["log", "--no-color", `--max-count=${limit.value}`, "--pretty=format:%H%x09%s"],
    cwd,
    DEFAULT_SHELL_TIMEOUT_MS,
  );
  const commits = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab < 0 ? { sha: line, subject: "" } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  return { cwd, commits };
}

export async function gitDiff(input: unknown): Promise<{ cwd: string; staged: boolean; diff: string; truncated: boolean }> {
  const parsed = parseOptions(input, ["cwd", "staged"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  const cwd = gitCwd(parsed.value);
  if (parsed.value.staged !== undefined && typeof parsed.value.staged !== "boolean") {
    throw new Error("staged must be a boolean when present");
  }
  const args = ["diff", "--no-color", ...(parsed.value.staged === true ? ["--cached"] : [])];
  const result = await git(args, cwd, DEFAULT_SHELL_TIMEOUT_MS);
  const clipped = clip(result.stdout, MAX_OUTPUT_CHARS);
  return { cwd, staged: parsed.value.staged === true, diff: clipped.text, truncated: clipped.truncated };
}

// ── shell ─────────────────────────────────────────────────────────────────────

export async function shellRun(input: unknown, signal?: AbortSignal): Promise<{
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}> {
  const parsed = parseOptions(input, ["command", "args", "cwd", "timeoutMs"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (!isNonEmptyString(parsed.value.command)) throw new Error("command must be a non-empty string");
  let args: string[] = [];
  if (parsed.value.args !== undefined) {
    if (!Array.isArray(parsed.value.args) || parsed.value.args.some((a) => typeof a !== "string")) {
      throw new Error("args must be an array of strings when present");
    }
    args = parsed.value.args as string[];
  }
  const cwd = gitCwd(parsed.value);
  const timeoutMs = positiveInt(parsed.value.timeoutMs, "timeoutMs", MAX_SHELL_TIMEOUT_MS, DEFAULT_SHELL_TIMEOUT_MS);
  if (!timeoutMs.ok) throw new Error(timeoutMs.reason);

  const result = await exec(parsed.value.command, args, cwd, timeoutMs.value, { ...(signal !== undefined ? { signal } : {}) });
  const stdout = clip(result.stdout, MAX_OUTPUT_CHARS);
  const stderr = clip(result.stderr, MAX_OUTPUT_CHARS);
  return {
    command: parsed.value.command,
    args,
    cwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    ...(result.cancelled === true ? { cancelled: true as const } : {}),
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    durationMs: result.durationMs,
  };
}

// ── Capability probes ─────────────────────────────────────────────────────────

/** Is the git CLI actually runnable? Measured, not declared. */
export async function probeGit(): Promise<{ available: boolean; detail: string }> {
  try {
    const result = await exec("git", ["--version"], process.cwd(), 10_000);
    const version = result.stdout.trim();
    return {
      available: result.exitCode === 0 && version.length > 0,
      detail: version.length > 0 ? version : "git produced no version",
    };
  } catch (error) {
    return { available: false, detail: `git is not runnable: ${messageOf(error)}` };
  }
}

/**
 * Can this process really spawn a program? Measured by spawning the very Node
 * binary running the Core, which is the one program guaranteed to exist here.
 */
export async function probeShell(): Promise<{ available: boolean; detail: string }> {
  try {
    const result = await exec(process.execPath, ["-e", "process.stdout.write('ok')"], process.cwd(), 10_000);
    return {
      available: result.exitCode === 0 && result.stdout.includes("ok"),
      detail: result.exitCode === 0 ? `program execution works via ${process.execPath}` : `spawn exited ${result.exitCode}`,
    };
  } catch (error) {
    return { available: false, detail: `program execution unavailable: ${messageOf(error)}` };
  }
}

// ── Capability dispatch ───────────────────────────────────────────────────────

/**
 * The op a capability action resolves to, keyed by `<capabilityId>.<action>`.
 * `filesystem.read`, `shell.run`, `git.status`, … The capability tool calls this
 * AFTER the registry has already validated and policy-checked the capability
 * action, so the effect happens inside the boundary exactly once.
 */
export const WORKSPACE_OPS: Readonly<Record<string, (input: unknown) => unknown | Promise<unknown>>> = {
  [WORKSPACE_TOOL_IDS.read]: filesystemRead,
  [WORKSPACE_TOOL_IDS.list]: filesystemList,
  [WORKSPACE_TOOL_IDS.search]: filesystemSearch,
  [WORKSPACE_TOOL_IDS.metadata]: filesystemMetadata,
  [WORKSPACE_TOOL_IDS.write]: filesystemWrite,
  [WORKSPACE_TOOL_IDS.gitStatus]: gitStatus,
  [WORKSPACE_TOOL_IDS.gitLog]: gitLog,
  [WORKSPACE_TOOL_IDS.gitDiff]: gitDiff,
  [WORKSPACE_TOOL_IDS.shell]: shellRun,
};

/** The real workspace tools, as registry definitions. */
export function createWorkspaceTools(): ToolDefinition[] {
  return [
    {
      id: WORKSPACE_TOOL_IDS.read,
      name: "Read a file",
      description: "Read a UTF-8 text file from this machine, bounded. Reports the absolute path and byte length; a truncated read says so.",
      risk: "READ",
      schema: {
        kind: "object",
        properties: {
          path: {
            type: "string",
            description: "File to read; a relative path is resolved against the Core's working directory.",
            required: true,
          },
          maxBytes: {
            type: "integer",
            description: "Bound on the returned content; the tail is reported as truncated, never silently dropped.",
            minimum: 1,
            maximum: MAX_READ_BYTES,
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["path", "maxBytes"]);
        if (!parsed.ok) return parsed;
        const path = pathOf(parsed.value.path, "path");
        if (!path.ok) return path;
        const maxBytes = positiveInt(parsed.value.maxBytes, "maxBytes", MAX_READ_BYTES, MAX_READ_BYTES);
        if (!maxBytes.ok) return maxBytes;
        return { ok: true, value: { path: path.value, maxBytes: maxBytes.value } };
      },
      async execute(input) {
        return filesystemRead(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.list,
      name: "List a directory",
      description: "List the entries of a directory on this machine (non-recursive), bounded.",
      risk: "READ",
      schema: {
        kind: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory to list; a relative path is resolved against the Core's working directory.",
            required: true,
          },
          limit: {
            type: "integer",
            description: "Maximum entries to return.",
            minimum: 1,
            maximum: MAX_LIST_ENTRIES,
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["path", "limit"]);
        if (!parsed.ok) return parsed;
        const path = pathOf(parsed.value.path, "path");
        if (!path.ok) return path;
        const limit = positiveInt(parsed.value.limit, "limit", MAX_LIST_ENTRIES, MAX_LIST_ENTRIES);
        if (!limit.ok) return limit;
        return { ok: true, value: { path: path.value, limit: limit.value } };
      },
      async execute(input) {
        return filesystemList(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.search,
      name: "Search files",
      description:
        "Search INSIDE files under a directory: match file contents line by line (mode \"content\", the default), file names (mode \"name\"), or both. Recursive, sandboxed, bounded — reports how many files it scanned and whether a cap was hit.",
      risk: "READ",
      schema: {
        kind: "object",
        properties: {
          query: {
            type: "string",
            description: "The text to find (a substring; case-insensitive unless caseSensitive is set).",
            required: true,
          },
          path: {
            type: "string",
            description:
              "Directory or file to search; resolved against the Core's working directory and confined to the workspace sandbox. Optional — when omitted the workspace root is searched (KAI_WORKSPACE_ROOT, else the Core's working directory).",
          },
          mode: {
            type: "string",
            description: "Match contents, names, or both.",
            enum: ["content", "name", "both"],
          },
          maxResults: {
            type: "integer",
            description: "Maximum matches to return.",
            minimum: 1,
            maximum: MAX_SEARCH_RESULTS,
          },
          maxDepth: {
            type: "integer",
            description: "Maximum directory depth to walk.",
            minimum: 1,
            maximum: MAX_SEARCH_DEPTH,
          },
          maxFileBytes: {
            type: "integer",
            description: "Largest slice of each file read for a content match.",
            minimum: 1,
            maximum: MAX_SEARCH_FILE_BYTES,
          },
          caseSensitive: {
            type: "boolean",
            description: "Match case-sensitively (default false).",
          },
          skipDirs: {
            type: "array",
            description: "Directory names not to descend into (default: node_modules, .git).",
          },
          include: {
            type: "array",
            description: "Only scan files with these extensions, e.g. [\".ts\", \".md\"].",
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, [
          "query",
          "path",
          "mode",
          "maxResults",
          "maxDepth",
          "maxFileBytes",
          "caseSensitive",
          "skipDirs",
          "include",
        ]);
        if (!parsed.ok) return parsed;
        if (!isNonEmptyString(parsed.value.query)) return { ok: false, reason: "query must be a non-empty string" };
        // An omitted path resolves to the workspace root HERE, at the boundary,
        // so the invocation record names the directory that was actually
        // searched — never an absent field that execution silently filled in.
        const rawPath = parsed.value.path === undefined ? defaultWorkspaceRoot() : parsed.value.path;
        const path = pathOf(rawPath, "path");
        if (!path.ok) return path;
        if (parsed.value.mode !== undefined && !["content", "name", "both"].includes(parsed.value.mode as string)) {
          return { ok: false, reason: "mode must be one of: content, name, both" };
        }
        const maxResults = positiveInt(parsed.value.maxResults, "maxResults", MAX_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS);
        if (!maxResults.ok) return maxResults;
        const maxDepth = positiveInt(parsed.value.maxDepth, "maxDepth", MAX_SEARCH_DEPTH, DEFAULT_SEARCH_DEPTH);
        if (!maxDepth.ok) return maxDepth;
        const maxFileBytes = positiveInt(parsed.value.maxFileBytes, "maxFileBytes", MAX_SEARCH_FILE_BYTES, MAX_SEARCH_FILE_BYTES);
        if (!maxFileBytes.ok) return maxFileBytes;
        if (parsed.value.caseSensitive !== undefined && typeof parsed.value.caseSensitive !== "boolean") {
          return { ok: false, reason: "caseSensitive must be a boolean when present" };
        }
        for (const listField of ["skipDirs", "include"] as const) {
          const value = parsed.value[listField];
          if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
            return { ok: false, reason: `${listField} must be an array of strings when present` };
          }
        }
        return { ok: true, value: { ...parsed.value, path: path.value } };
      },
      async execute(input) {
        return filesystemSearch(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.metadata,
      name: "Stat a path",
      description: "Report a path's metadata — type, size, timestamps and permissions — without reading its contents. Read-only; a missing path reports exists:false.",
      risk: "READ",
      schema: {
        kind: "object",
        properties: {
          path: {
            type: "string",
            description: "File or directory to describe.",
            required: true,
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["path"]);
        if (!parsed.ok) return parsed;
        const path = pathOf(parsed.value.path, "path");
        if (!path.ok) return path;
        return { ok: true, value: { path: path.value } };
      },
      async execute(input) {
        return filesystemMetadata(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.write,
      name: "Write a file",
      description: "Write a UTF-8 text file on this machine, creating parent directories on request. A WRITE, so the default policy parks it for a human.",
      risk: "WRITE",
      effectful: true,
      schema: {
        kind: "object",
        properties: {
          path: {
            type: "string",
            description: "File to write; a relative path is resolved against the Core's working directory.",
            required: true,
          },
          content: {
            type: "string",
            description: "The full UTF-8 content of the file.",
            required: true,
          },
          createDirs: {
            type: "boolean",
            description: "Create missing parent directories first.",
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["path", "content", "createDirs"]);
        if (!parsed.ok) return parsed;
        const path = pathOf(parsed.value.path, "path");
        if (!path.ok) return path;
        if (typeof parsed.value.content !== "string") return { ok: false, reason: "content must be a string" };
        if (parsed.value.createDirs !== undefined && typeof parsed.value.createDirs !== "boolean") {
          return { ok: false, reason: "createDirs must be a boolean when present" };
        }
        return {
          ok: true,
          value: {
            path: path.value,
            content: parsed.value.content,
            ...(parsed.value.createDirs !== undefined ? { createDirs: parsed.value.createDirs } : {}),
          },
        };
      },
      async execute(input) {
        return filesystemWrite(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.gitStatus,
      name: "git status",
      description: "Read the working-tree status of a git repository (porcelain). Read-only.",
      risk: "READ",
      schema: {
        kind: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository directory; defaults to the Core's working directory.",
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["cwd"]);
        if (!parsed.ok) return parsed;
        if (parsed.value.cwd !== undefined && !isNonEmptyString(parsed.value.cwd)) {
          return { ok: false, reason: "cwd must be a non-empty string when present" };
        }
        return { ok: true, value: parsed.value };
      },
      async execute(input) {
        return gitStatus(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.gitLog,
      name: "git log",
      description: "Read the recent commit log of a git repository. Read-only.",
      risk: "READ",
      schema: {
        kind: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository directory; defaults to the Core's working directory.",
          },
          limit: {
            type: "integer",
            description: "Maximum commits to return.",
            minimum: 1,
            maximum: 200,
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["cwd", "limit"]);
        if (!parsed.ok) return parsed;
        if (parsed.value.cwd !== undefined && !isNonEmptyString(parsed.value.cwd)) {
          return { ok: false, reason: "cwd must be a non-empty string when present" };
        }
        const limit = positiveInt(parsed.value.limit, "limit", 200, 20);
        if (!limit.ok) return limit;
        return { ok: true, value: parsed.value };
      },
      async execute(input) {
        return gitLog(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.gitDiff,
      name: "git diff",
      description: "Read a git diff (working tree, or staged with staged:true). Read-only.",
      risk: "READ",
      schema: {
        kind: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Repository directory; defaults to the Core's working directory.",
          },
          staged: {
            type: "boolean",
            description: "Diff the staged changes instead of the working tree.",
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["cwd", "staged"]);
        if (!parsed.ok) return parsed;
        if (parsed.value.cwd !== undefined && !isNonEmptyString(parsed.value.cwd)) {
          return { ok: false, reason: "cwd must be a non-empty string when present" };
        }
        if (parsed.value.staged !== undefined && typeof parsed.value.staged !== "boolean") {
          return { ok: false, reason: "staged must be a boolean when present" };
        }
        return { ok: true, value: parsed.value };
      },
      async execute(input) {
        return gitDiff(input);
      },
    },
    {
      id: WORKSPACE_TOOL_IDS.shell,
      name: "Run a program",
      description:
        "Run a program with an explicit argument list (no shell), bounded by timeout and output size. DESTRUCTIVE, so the default policy parks it for a human.",
      risk: "DESTRUCTIVE",
      effectful: true,
      schema: {
        kind: "object",
        properties: {
          command: {
            type: "string",
            description: "The program to run (an executable name or path; no shell interpolation).",
            required: true,
          },
          args: {
            type: "array",
            description: "Argument list of strings passed to the program.",
          },
          cwd: {
            type: "string",
            description: "Working directory; defaults to the Core's working directory.",
          },
          timeoutMs: {
            type: "integer",
            description: "Command timeout in milliseconds.",
            minimum: 1,
            maximum: MAX_SHELL_TIMEOUT_MS,
          },
        },
        additionalProperties: false,
      },
      validate(input) {
        const parsed = parseOptions(input, ["command", "args", "cwd", "timeoutMs"]);
        if (!parsed.ok) return parsed;
        if (!isNonEmptyString(parsed.value.command)) return { ok: false, reason: "command must be a non-empty string" };
        if (parsed.value.args !== undefined) {
          if (!Array.isArray(parsed.value.args) || parsed.value.args.some((a) => typeof a !== "string")) {
            return { ok: false, reason: "args must be an array of strings when present" };
          }
        }
        if (parsed.value.cwd !== undefined && !isNonEmptyString(parsed.value.cwd)) {
          return { ok: false, reason: "cwd must be a non-empty string when present" };
        }
        const timeoutMs = positiveInt(parsed.value.timeoutMs, "timeoutMs", MAX_SHELL_TIMEOUT_MS, DEFAULT_SHELL_TIMEOUT_MS);
        if (!timeoutMs.ok) return timeoutMs;
        return { ok: true, value: parsed.value };
      },
      async execute(input, ctx) {
        return shellRun(input, ctx?.signal);
      },
    },
  ];
}
