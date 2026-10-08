// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Secret REFERENCES — how KAI holds a credential without ever storing its value.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `registry.ts` deliberately stores MCP secrets write-only, but "write-only"
 * still means the *value* sits in the catalogue that is persisted to disk. That
 * is the right trade only for a value a human typed into KAI directly. When a
 * credential already lives somewhere else on the machine (an environment
 * variable, the Windows Credential Manager), copying its literal value into
 * KAI's catalogue both duplicates the secret and leaves a plaintext copy on
 * disk — exactly what must not happen during a migration.
 *
 * So a stored secret may instead be a REFERENCE — a small string that names
 * where the value lives, resolved only at the moment a server is launched:
 *
 *     env:NAME              resolve from the process environment
 *     credman:TARGET        read Generic Credential TARGET from the Windows
 *                           Credential Manager (advapi32!CredReadW)
 *
 * PROPERTIES THAT MATTER
 * ----------------------
 *   - A reference is INERT at rest. The catalogue on disk holds `env:FOO`,
 *     never the value, so a leaked persisted file leaks a name, not a secret.
 *   - Resolution FAILS CLOSED. An unset variable or an absent credential is a
 *     typed `AGENT_AUTH_FAILED` value with a reason — never an empty string, an
 *     invented value, or a silent fallback to "no auth".
 *   - Nothing here ever writes a resolved value into a message, a listing or a
 *     log. The only output of a successful resolution is the value itself, to
 *     the one privileged caller (`credentialsFor`).
 *   - A bare string WITHOUT a recognised prefix is a literal and is returned
 *     unchanged: existing catalogues keep working, and only a value that names
 *     a location is treated as one.
 */

import { execFileSync } from "node:child_process";

/** How a stored secret obtains its value. */
export type SecretReferenceKind = "literal" | "env" | "credman";

/** A parsed secret reference. `literal` names nothing; the value IS the secret. */
export interface SecretReference {
  kind: SecretReferenceKind;
  /** For `env`/`credman`: the variable/target name. Never a secret. */
  name?: string;
}

/** The prefixes that turn a plain string into a reference. */
export const ENV_PREFIX = "env:";
export const CREDMAN_PREFIX = "credman:";

function safeName(value: string): boolean {
  // A reference name must not be able to smuggle a second row, a shell token,
  // or an empty target. Env names and CredMan targets are conservative here.
  return value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
}

/**
 * Classify one stored secret string. Ordering is deliberate: `credman:` is
 * checked before `env:` because they are disjoint, and a value that happens to
 * start with the other prefix is simply a different literal.
 */
export function parseSecretReference(value: string): SecretReference {
  if (value.startsWith(ENV_PREFIX)) {
    const name = value.slice(ENV_PREFIX.length);
    if (safeName(name)) return { kind: "env", name };
  }
  if (value.startsWith(CREDMAN_PREFIX)) {
    const name = value.slice(CREDMAN_PREFIX.length);
    if (safeName(name)) return { kind: "credman", name };
  }
  return { kind: "literal" };
}

/** True when the stored string is a reference (so it is inert at rest). */
export function isSecretReference(value: string): boolean {
  return parseSecretReference(value).kind !== "literal";
}

// ── Resolution ────────────────────────────────────────────────────────────────

export type ReferenceStatus = "PRESENT" | "MISSING" | "UNREADABLE";

/**
 * The outcome of resolving one reference. `value` is present ONLY when the
 * status is PRESENT; every call site must therefore branch on `ok` and can
 * never accidentally use a value that was not obtained.
 */
export type ReferenceResolution =
  | { ok: true; status: "PRESENT"; value: string }
  | { ok: false; status: Exclude<ReferenceStatus, "PRESENT">; reason: string };

/** A value reader, injectable so tests never touch the real environment/OS. */
export interface SecretResolver {
  env: (name: string) => string | undefined;
  credman: (target: string) => string | null;
}

/**
 * Resolve one stored secret string to its value. A literal resolves to itself;
 * a reference resolves through the injected reader and fails closed.
 *
 * The reason strings name the KEY and the LOCATION, never the value — a
 * failure that echoed the value would be the exact leak this design prevents.
 */
export function resolveStoredSecret(stored: string, resolver: SecretResolver): ReferenceResolution {
  const reference = parseSecretReference(stored);
  if (reference.kind === "literal") {
    return stored.length > 0
      ? { ok: true, status: "PRESENT", value: stored }
      : { ok: false, status: "MISSING", reason: "the stored value is empty" };
  }
  if (reference.kind === "env") {
    const value = resolver.env(reference.name as string);
    if (value === undefined || value.length === 0) {
      return {
        ok: false,
        status: "MISSING",
        reason: `environment variable "${reference.name}" is not set (or empty) in the process KAI launched`,
      };
    }
    return { ok: true, status: "PRESENT", value };
  }
  const value = resolver.credman(reference.name as string);
  if (value === null) {
    return {
      ok: false,
      status: "MISSING",
      reason: `Windows Credential Manager has no readable generic credential named "${reference.name}"`,
    };
  }
  if (value.length === 0) {
    return { ok: false, status: "UNREADABLE", reason: `credential "${reference.name}" resolved to an empty value` };
  }
  return { ok: true, status: "PRESENT", value };
}

/** Presence of a reference without ever producing its value. Used by evidence. */
export function inspectStoredSecret(stored: string, resolver: SecretResolver): ReferenceStatus {
  const resolved = resolveStoredSecret(stored, resolver);
  return resolved.ok ? "PRESENT" : resolved.status;
}

// ── Windows Credential Manager reader ────────────────────────────────────────

/**
 * A `CredReadW` call, expressed in PowerShell so this module needs no native
 * build step. The TARGET is passed through the environment (never interpolated
 * into the script text) so a target name can never become PowerShell code.
 * The value is written to stdout as-is; the caller captures it in memory and
 * this module never logs the command's output.
 */
const CREDMAN_PS = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class KaiCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@
Add-Type -TypeDefinition $sig
$ptr = [IntPtr]::Zero
if (-not [KaiCred]::CredRead($env:KAI_CREDMAN_TARGET, 1, 0, [ref]$ptr)) { exit 2 }
try {
  $c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][KaiCred+CREDENTIAL])
  if ($c.CredentialBlobSize -eq 0) { exit 3 }
  $bytes = New-Object byte[] $c.CredentialBlobSize
  [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
  $text = [System.Text.Encoding]::Unicode.GetString($bytes)
  [Console]::Out.Write($text)
} finally {
  [KaiCred]::CredFree($ptr)
}
`;

let credmanCache: Map<string, string | null> | undefined;

/** Read a generic credential, or `null` when it does not exist / cannot be read. */
export function readWindowsCredential(target: string, opts: { platform?: string; run?: typeof execFileSync } = {}): string | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return null;
  credmanCache ??= new Map<string, string | null>();
  if (credmanCache.has(target)) return credmanCache.get(target) ?? null;
  const run = opts.run ?? execFileSync;
  let result: string | null = null;
  try {
    const out = run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", CREDMAN_PS],
      { env: { ...process.env, KAI_CREDMAN_TARGET: target }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const trimmed = String(out).replace(/\u0000+$/, "");
    result = trimmed.length > 0 ? trimmed : null;
  } catch {
    // A missing credential exits non-zero; a host without PowerShell throws.
    // Both are "unreadable", never an invented value.
    result = null;
  }
  credmanCache.set(target, result);
  return result;
}

/** The default resolver: the real process environment and the real CredMan. */
export function defaultSecretResolver(): SecretResolver {
  return {
    env: (name) => process.env[name],
    credman: (target) => readWindowsCredential(target),
  };
}

/** Test seam: reset the in-process CredMan cache. */
export function resetCredmanCache(): void {
  credmanCache = undefined;
}
