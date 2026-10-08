// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * discovery.ts — the employee discovery architecture (Part J).
 *
 * KAI must be able to answer "is Codex installed?" and, eventually, "KAI,
 * install Codex". This module answers the first honestly and builds the policy
 * boundary the second will have to pass through. It deliberately does NOT
 * install anything yet.
 *
 * ── Two ideas keep this safe ──────────────────────────────────────────────────
 *
 * 1. TRUSTED SOURCES. KAI never probes, and never installs, an arbitrary thing
 *    it found. A `TrustedSource` is declared in KAI's own code: it names the
 *    employee, how to *detect* it (a probe), and — only where KAI is allowed to
 *    act — how it *may* be installed (a package manager id, never a URL).
 *    `authorizeInstall` is the boundary: an unknown source or a URL-shaped
 *    package is refused as a value. This is the seam that stops "install Codex"
 *    from ever meaning "GET this link and run it".
 *
 * 2. PROBES ARE INJECTED. A probe is a small object with one method. The default
 *    probes talk to a local HTTP health route or look for an executable on PATH,
 *    but every probe can be replaced in `createDiscovery`, so tests exercise the
 *    classification without a network or a real install.
 *
 * Classification answers, per trusted source: installed? version? reachable?
 * authenticated? supported? capabilities? — and maps all of that onto one legal
 * `EmployeeState`, so a missing binary is UNAVAILABLE (a value), never an error.
 */

import { spawnSync } from "node:child_process";
import { isNonEmptyString, isRecord } from "../shared/contracts.ts";
import type {
  CapabilityId,
  EmployeeDescriptor,
  EmployeeMetadata,
  EmployeeState,
  KaiError,
  KaiErrorCode,
} from "../shared/contracts.ts";
import type { EmployeeKind } from "../shared/runtime-events.ts";
import { employeeError } from "./lifecycle.ts";
import { describeError, makeInstance, makeSnapshot } from "./employee.ts";

// ── Trusted sources ───────────────────────────────────────────────────────────

export type InstallSourceKind = "npm" | "winget" | "manual";

export interface TrustedInstallSource {
  /** Which package manager may act. "manual" means KAI hands the user instructions. */
  readonly kind: InstallSourceKind;
  /** The trusted package id (never a URL). Absent for "manual". */
  readonly package?: string;
  /** Human instruction, shown when KAI cannot install it itself. */
  readonly instructions?: string;
}

export interface TrustedSource {
  /** The employee id, e.g. "codex". Doubles as the trusted-source key. */
  readonly id: string;
  readonly kind: EmployeeKind;
  readonly name: string;
  readonly description?: string;
  /** Capabilities this employee is expected to declare once it is available. */
  readonly capabilities: readonly CapabilityId[];
  /** How to detect it. Absent means "not detectable yet", treated as not installed. */
  readonly probe?: EmployeeProbe;
  /** How it may be installed, if at all. Absent means manual-only. */
  readonly install?: TrustedInstallSource;
  /** When true, a reachable-but-unauthenticated employee is DEGRADED, not READY. */
  readonly requiresAuth?: boolean;
  /**
   * Optional version gate. A reported version outside this pattern is reported
   * as "supported: false" and classified UNAVAILABLE rather than silently used.
   */
  readonly supportedVersions?: RegExp;
}

export interface InstallRequest {
  sourceId: string;
  /** Optional package id. A URL here is refused. */
  package?: string;
}

export type InstallDecision =
  | { allowed: true; source: TrustedSource; install?: TrustedInstallSource }
  | { allowed: false; reason: string; error: KaiError };

export interface TrustedSourceRegistry {
  trust(source: TrustedSource): void;
  get(id: string): TrustedSource | undefined;
  list(): TrustedSource[];
  has(id: string): boolean;
  /** The installation policy boundary. Returns a decision, never throws. */
  authorizeInstall(request: InstallRequest): InstallDecision;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Anything that names a remote location rather than a package id. */
function looksLikeUrl(value: string): boolean {
  return URL_LIKE.test(value) || value.startsWith("//");
}

function deny(reason: string, code: KaiErrorCode = "POLICY_DENIED", detail?: string): InstallDecision {
  return { allowed: false, reason, error: employeeError(code, reason, detail) };
}

export function createTrustedSourceRegistry(
  initial: readonly TrustedSource[] = [],
): TrustedSourceRegistry {
  const sources = new Map<string, TrustedSource>();
  const trust = (source: TrustedSource): void => {
    if (isNonEmptyString(source?.id)) sources.set(source.id, source);
  };
  for (const source of initial) trust(source);

  return {
    trust,
    get: (id) => sources.get(id),
    list: () => [...sources.values()],
    has: (id) => sources.has(id),

    authorizeInstall(request: InstallRequest): InstallDecision {
      const source = sources.get(request.sourceId);
      if (source === undefined) {
        return deny(
          `"${request.sourceId}" is not a declared trusted source`,
          "POLICY_DENIED",
          `trusted sources: ${[...sources.keys()].join(", ") || "(none)"}`,
        );
      }
      // The whole point of the boundary: a package id, never a download.
      if (request.package !== undefined && looksLikeUrl(request.package)) {
        return deny(
          "KAI never installs from a URL",
          "POLICY_DENIED",
          "trusted sources declare a package id; there is no arbitrary-URL install path",
        );
      }
      if (source.install === undefined) {
        return deny(
          `trusted source "${source.id}" declares no install method`,
          "POLICY_DENIED",
          "install it by hand, then re-run discovery",
        );
      }
      if (
        request.package !== undefined &&
        source.install.package !== undefined &&
        source.install.package !== request.package
      ) {
        return deny(
          `"${request.package}" is not the trusted package for "${source.id}"`,
          "POLICY_DENIED",
          `the trusted package is "${source.install.package}"`,
        );
      }
      return { allowed: true, source, install: source.install };
    },
  };
}

// ── Probes ────────────────────────────────────────────────────────────────────

/**
 * What a probe learned. Every field is optional because "unknown" is a real
 * answer: a refused HTTP connection tells KAI the service is not reachable, but
 * nothing about whether the program is installed, so `installed` must be allowed
 * to stay undefined instead of being guessed as false.
 */
export interface ProbeObservation {
  installed?: boolean;
  version?: string;
  reachable?: boolean;
  authenticated?: boolean;
  endpoint?: string;
  capabilities?: readonly CapabilityId[];
  detail?: string;
}

export interface EmployeeProbe {
  readonly employeeId: string;
  probe(signal?: AbortSignal): Promise<ProbeObservation>;
}

export interface HttpProbeInterpretation {
  reachable: boolean;
  version?: string;
  authenticated?: boolean;
  detail?: string;
}

export type HttpProbeInterpreter = (body: unknown, status: number) => HttpProbeInterpretation;

export interface HttpProbeOptions {
  employeeId: string;
  baseUrl: string;
  /** Path of the (unauthenticated) health route, e.g. "/health". */
  healthPath: string;
  interpret?: HttpProbeInterpreter;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function defaultHttpInterpret(body: unknown, status: number): HttpProbeInterpretation {
  const reachable = status >= 200 && status < 300;
  const version = isRecord(body) && typeof body.version === "string" ? body.version : undefined;
  return {
    reachable,
    ...(version !== undefined ? { version } : {}),
    ...(reachable ? {} : { detail: `health route answered HTTP ${status}` }),
  };
}

/**
 * A probe for a locally-running service. A transport failure yields
 * `reachable: false` with `installed` left unknown — an honest, non-throwing
 * result that classifies as UNAVAILABLE.
 */
export function createHttpProbe(options: HttpProbeOptions): EmployeeProbe {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const interpret = options.interpret ?? defaultHttpInterpret;
  const timeoutMs = options.timeoutMs ?? 3000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    employeeId: options.employeeId,
    async probe(signal?: AbortSignal): Promise<ProbeObservation> {
      const url = `${baseUrl}${options.healthPath}`;
      try {
        const response = await fetchImpl(url, {
          headers: { accept: "application/json" },
          signal: signal ?? AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text().catch(() => "");
        let body: unknown = null;
        if (text.length > 0) {
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            body = null;
          }
        }
        const interpreted = interpret(body, response.status);
        return {
          installed: true,
          reachable: interpreted.reachable,
          authenticated: interpreted.authenticated,
          endpoint: baseUrl,
          ...(interpreted.version !== undefined ? { version: interpreted.version } : {}),
          ...(interpreted.detail !== undefined ? { detail: interpreted.detail } : {}),
        };
      } catch (error) {
        // Not "installed: false" — we simply cannot tell from a refused socket.
        return {
          reachable: false,
          endpoint: baseUrl,
          detail: `not reachable: ${describeError(error)}`,
        };
      }
    },
  };
}

export interface CommandRunResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

export interface CommandProbeOptions {
  employeeId: string;
  command: string;
  versionArgs?: readonly string[];
  /** Injected lookup; default searches PATH for the executable. */
  locate?: (command: string) => Promise<string | null>;
  /** Injected runner; default spawns the executable. */
  run?: (file: string, args: readonly string[]) => Promise<CommandRunResult>;
  /** Extract a version from `--version` output. */
  versionOf?: (stdout: string) => string | undefined;
}

const SEMVER = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/;

function defaultVersionOf(stdout: string): string | undefined {
  const match = SEMVER.exec(stdout);
  return match?.[1];
}

/** Search PATH with the OS tool. Never throws; absence is a null result. */
function defaultLocate(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const finder = process.platform === "win32" ? "where" : "which";
      const child = spawnSync(finder, [command], { encoding: "utf8", timeout: 4000, windowsHide: true });
      const stdout = typeof child.stdout === "string" ? child.stdout : "";
      if (child.status === 0 && stdout.trim().length > 0) {
        resolve(stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? null);
      } else {
        resolve(null);
      }
    } catch {
      resolve(null);
    }
  });
}

function defaultRun(file: string, args: readonly string[]): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    try {
      const child = spawnSync(file, [...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
      resolve({
        ok: child.status === 0,
        stdout: typeof child.stdout === "string" ? child.stdout : "",
        stderr: typeof child.stderr === "string" ? child.stderr : "",
      });
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: describeError(error) });
    }
  });
}

/**
 * A probe for an installed executable. This is what "is Codex installed?"
 * becomes: locate `codex`, and if it is not on PATH report `installed: false` —
 * a value the manager turns into UNAVAILABLE, never an exception.
 */
export function createCommandProbe(options: CommandProbeOptions): EmployeeProbe {
  const locate = options.locate ?? defaultLocate;
  const run = options.run ?? defaultRun;
  const versionArgs = options.versionArgs ?? ["--version"];
  const versionOf = options.versionOf ?? defaultVersionOf;

  return {
    employeeId: options.employeeId,
    async probe(): Promise<ProbeObservation> {
      try {
        const file = await locate(options.command);
        if (file === null) {
          return { installed: false, reachable: false, detail: `"${options.command}" was not found on PATH` };
        }
        const result = await run(file, versionArgs);
        const version = versionOf(result.stdout) ?? versionOf(result.stderr ?? "");
        return {
          installed: true,
          reachable: result.ok,
          endpoint: file,
          ...(version !== undefined ? { version } : {}),
          ...(result.ok ? {} : { detail: `"${options.command} ${versionArgs.join(" ")}" exited non-zero` }),
        };
      } catch (error) {
        return { installed: false, reachable: false, detail: describeError(error) };
      }
    },
  };
}

// ── Classification ────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  sourceId: string;
  employeeId: string;
  kind: EmployeeKind;
  name: string;
  description?: string;
  installed: boolean;
  reachable: boolean;
  authenticated: boolean;
  supported: boolean;
  /** The one legal lifecycle state this observation implies. */
  state: EmployeeState;
  capabilities: readonly CapabilityId[];
  version?: string;
  endpoint?: string;
  problems: readonly string[];
}

/**
 * Map an observation onto one EmployeeState. The mapping is the "honest answer"
 * logic, in one place:
 *   not installed / unsupported / unreachable  -> UNAVAILABLE
 *   reachable but (possibly) unauthenticated   -> DEGRADED  (present, needs work)
 *   reachable and usable                        -> READY
 */
export function classifyEmployeeState(source: TrustedSource, observation: ProbeObservation): EmployeeState {
  if (observation.installed !== true) return "UNAVAILABLE";
  if (source.supportedVersions !== undefined && observation.version !== undefined) {
    if (!source.supportedVersions.test(observation.version)) return "UNAVAILABLE";
  }
  if (observation.reachable === false) return "UNAVAILABLE";
  if (source.requiresAuth === true && observation.authenticated !== true) return "DEGRADED";
  return "READY";
}

export function classifyDiscovery(source: TrustedSource, observation: ProbeObservation): DiscoveryResult {
  const problems: string[] = [];
  const installed = observation.installed === true;
  const reachable = observation.reachable === true;
  const authenticated = observation.authenticated === true;

  let supported = installed;
  if (
    installed &&
    source.supportedVersions !== undefined &&
    observation.version !== undefined &&
    !source.supportedVersions.test(observation.version)
  ) {
    supported = false;
    problems.push(`version ${observation.version} is outside the supported range for ${source.id}`);
  }
  if (!installed) problems.push(`${source.name} is not installed here`);
  else if (!reachable) problems.push(`${source.name} is installed but not reachable`);
  if (observation.detail !== undefined && observation.detail.length > 0) problems.push(observation.detail);

  return {
    sourceId: source.id,
    employeeId: source.id,
    kind: source.kind,
    name: source.name,
    ...(source.description !== undefined ? { description: source.description } : {}),
    installed,
    reachable,
    authenticated,
    supported,
    state: classifyEmployeeState(source, observation),
    capabilities: observation.capabilities ?? source.capabilities,
    ...(observation.version !== undefined ? { version: observation.version } : {}),
    ...(observation.endpoint !== undefined ? { endpoint: observation.endpoint } : {}),
    problems,
  };
}

// ── Discovery engine ──────────────────────────────────────────────────────────

export interface Discovery {
  sources(): TrustedSource[];
  /** Probe one source, or every source when `sourceId` is omitted. Never throws. */
  scan(sourceId?: string): Promise<DiscoveryResult[]>;
}

export interface DiscoveryOptions {
  sources: readonly TrustedSource[];
  /** Per-source probe overrides — tests use this instead of the network. */
  probes?: Record<string, EmployeeProbe>;
  timeoutMs?: number;
  now?: () => number;
}

/** Race a probe against a timeout so a hung probe becomes a value, not a stall. */
async function withTimeout(
  promise: Promise<ProbeObservation>,
  timeoutMs: number,
  id: string,
): Promise<ProbeObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeObservation>((resolve) => {
    timer = setTimeout(() => {
      resolve({ reachable: false, detail: `probe of "${id}" exceeded ${timeoutMs}ms` });
    }, timeoutMs);
    if (timer !== undefined && typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createDiscovery(options: DiscoveryOptions): Discovery {
  const sources = [...options.sources];
  const overrides = options.probes ?? {};
  const timeoutMs = options.timeoutMs ?? 3000;

  return {
    sources: () => [...sources],
    async scan(sourceId?: string): Promise<DiscoveryResult[]> {
      const targets = sourceId === undefined ? sources : sources.filter((s) => s.id === sourceId);
      const results: DiscoveryResult[] = [];
      for (const source of targets) {
        const probe = overrides[source.id] ?? source.probe;
        let observation: ProbeObservation;
        if (probe === undefined) {
          observation = { installed: false, reachable: false, detail: "no probe is configured for this source" };
        } else {
          try {
            observation = await withTimeout(probe.probe(), timeoutMs, source.id);
          } catch (error) {
            observation = { installed: false, reachable: false, detail: describeError(error) };
          }
        }
        results.push(classifyDiscovery(source, observation));
      }
      return results;
    },
  };
}

// ── Bridging discovery into the workforce ─────────────────────────────────────

/**
 * A descriptor for a discovered employee KAI has no adapter for yet. Its
 * instance reports the discovered snapshot (READY / DEGRADED / UNAVAILABLE) but
 * carries no adapter, so it is observable without being delegate-able — KAI can
 * truthfully say "OpenCode is running" before it is wired to hand it work.
 */
export function descriptorForDiscovery(result: DiscoveryResult): EmployeeDescriptor {
  const metadata: EmployeeMetadata = {
    id: result.employeeId,
    name: result.name,
    origin: `discovered:${result.sourceId}`,
    capabilities: [...result.capabilities],
    ...(result.version !== undefined ? { version: result.version } : {}),
    ...(result.description !== undefined ? { description: result.description } : {}),
  };
  return {
    metadata,
    async create(input = {}) {
      const snapshot = () =>
        makeSnapshot(result.state, {
          reachable: result.reachable,
          authenticated: result.authenticated,
          ...(result.version !== undefined ? { version: result.version } : {}),
          problems: result.problems,
        });
      return makeInstance({
        instanceId: input.instanceId ?? `${result.employeeId}#discovered`,
        employeeId: result.employeeId,
        kind: result.kind,
        capabilities: result.capabilities,
        initialState: result.state,
        snapshot: async () => snapshot(),
      });
    },
  };
}

// ── Installer interface (interfaces only for Phase 1) ─────────────────────────

export interface InstallPlan {
  employeeId: string;
  source: TrustedSource;
  install?: TrustedInstallSource;
}

export interface InstallResult {
  ok: boolean;
  detail?: string;
}

/**
 * The installer seam. Phase 1 establishes the interface and the lifecycle around
 * it; it wires no auto-installer. A later phase supplies one whose every action
 * has already passed `TrustedSourceRegistry.authorizeInstall`.
 */
export interface EmployeeInstaller {
  canInstall(plan: InstallPlan): boolean;
  install(plan: InstallPlan): Promise<InstallResult>;
}

// ── The trusted sources KAI knows today ───────────────────────────────────────

export const HERMES_DEFAULT_BASE_URL = "http://127.0.0.1:8642";
export const OPENCODE_DEFAULT_BASE_URL = "http://127.0.0.1:4096";
export const HERMES_HEALTH_PATH = "/health";
export const OPENCODE_HEALTH_PATH = "/global/health";

/** Hermes' api-server answers GET /health with `{ status: "ok", version }`. */
export function createHermesSource(baseUrl = HERMES_DEFAULT_BASE_URL): TrustedSource {
  return {
    id: "hermes",
    kind: "hermes",
    name: "Hermes Agent",
    description: "Hermes Agent api-server",
    capabilities: ["run_task", "message", "sessions"],
    probe: createHttpProbe({
      employeeId: "hermes",
      baseUrl,
      healthPath: HERMES_HEALTH_PATH,
      interpret: (body, status) => {
        const record = isRecord(body) ? body : {};
        const ok = status >= 200 && status < 300 && record.status === "ok";
        return {
          reachable: ok,
          ...(typeof record.version === "string" ? { version: record.version } : {}),
          ...(ok ? {} : { detail: `health route did not report status "ok" (HTTP ${status})` }),
        };
      },
    }),
    // Hermes is not installable by KAI yet: hand the user instructions instead.
    install: { kind: "manual", instructions: "Install Hermes Agent, then start its api-server." },
  };
}

/** OpenCode's headless server answers GET /global/health with `{ healthy, version }`. */
export function createOpenCodeSource(baseUrl = OPENCODE_DEFAULT_BASE_URL): TrustedSource {
  return {
    id: "opencode",
    kind: "opencode",
    name: "OpenCode",
    description: "OpenCode headless server",
    capabilities: ["run_task", "message", "sessions"],
    probe: createHttpProbe({
      employeeId: "opencode",
      baseUrl,
      healthPath: OPENCODE_HEALTH_PATH,
      interpret: (body, status) => {
        const record = isRecord(body) ? body : {};
        const ok = status >= 200 && status < 300 && record.healthy === true;
        return {
          reachable: ok,
          ...(typeof record.version === "string" ? { version: record.version } : {}),
          ...(ok ? {} : { detail: `health route did not report healthy (HTTP ${status})` }),
        };
      },
    }),
    install: { kind: "npm", package: "opencode-ai", instructions: "npm install -g opencode-ai" },
  };
}

/** The Codex CLI. Detection is a PATH lookup; absence is UNAVAILABLE, not an error. */
export function createCodexSource(): TrustedSource {
  return {
    id: "codex",
    kind: "codex",
    name: "Codex CLI",
    description: "OpenAI Codex command-line agent",
    capabilities: ["run_task"],
    probe: createCommandProbe({ employeeId: "codex", command: "codex" }),
    install: { kind: "npm", package: "@openai/codex", instructions: "npm install -g @openai/codex" },
  };
}

/** The trusted sources KAI ships with. Probes here are real; tests override them. */
export function defaultTrustedSources(): TrustedSource[] {
  return [createHermesSource(), createOpenCodeSource(), createCodexSource()];
}
