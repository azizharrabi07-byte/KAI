// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The fake transport.
 *
 * WHY this ships in src rather than only in the test file: the brief requires
 * the transport to be a PLUGGABLE interface with a fake, and the fake is the
 * seam's executable specification — it proves the interface is implementable
 * without the real driver, and it is what every safety test drives. Keeping it
 * beside the interface (not inside a test) also means a later integration test
 * can reuse it.
 *
 * It never spawns anything. It returns deterministic frames so hashing and
 * deduplication are testable, and it records every call so a test can assert
 * that a refused action NEVER reached the driver.
 */

import { kaiError } from "./errors.ts";
import { hashFrame } from "./observation.ts";
import type {
  ActionOutcome,
  ComputerTransport,
  ConnectInfo,
  Frame,
  Inspection,
  ObserveOptions,
  TransportAction,
  TransportEndpoint,
  TransportResult,
  WindowInfo,
} from "./transport.ts";

/** Build a deterministic frame from a payload string. Exposed so tests can
 * mint "the same frame" and "a changed frame" without hand-writing hashes. */
export function frameFromData(data: string, width = 1920, height = 1080): Frame {
  return { data, width, height, hash: hashFrame(data) };
}

export interface FakeTransportHooks {
  /**
   * Invoked inside `observe`, before the frame is returned. A test uses this to
   * change control mid-observation and prove transition protection fires.
   */
  onObserve?: (options?: ObserveOptions) => void | Promise<void>;
  /** Invoked inside `act`, before the outcome is returned. Same purpose. */
  onAct?: (action: TransportAction) => void | Promise<void>;
}

export interface FakeTransportCalls {
  connect: number;
  inspect: number;
  act: TransportAction[];
  observe: number;
  windows: number;
}

export interface FakeTransportOptions {
  version?: string;
  /** When true, `connect` returns a transport error instead of succeeding. */
  connectFails?: boolean;
  frames?: readonly Frame[];
  inspection?: Inspection;
  windows?: readonly WindowInfo[];
  hooks?: FakeTransportHooks;
}

export interface FakeTransport extends ComputerTransport {
  readonly calls: FakeTransportCalls;
  /** Replace the frame the next `observe` returns. Lets a test mutate the screen. */
  setFrame(frame: Frame): void;
}

const DEFAULT_WINDOW: WindowInfo = {
  id: "win-1",
  title: "Untitled — Notepad",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: true,
  app: "notepad.exe",
};

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const version = options.version ?? "0.28.2";
  const endpoint: TransportEndpoint = { kind: "fake", version };
  const calls: FakeTransportCalls = { connect: 0, inspect: 0, act: [], observe: 0, windows: 0 };
  const hooks = options.hooks ?? {};
  let currentFrame: Frame = options.frames?.[0] ?? frameFromData("frame-0001");
  let frameIndex = 0;
  const frames = options.frames ?? [];

  const inspection: Inspection = options.inspection ?? {
    screen: { width: 1920, height: 1080 },
    windows: [DEFAULT_WINDOW],
    cursor: { x: 0, y: 0 },
  };
  const windows: readonly WindowInfo[] = options.windows ?? [DEFAULT_WINDOW];

  return {
    endpoint,
    calls,
    setFrame(frame: Frame) {
      currentFrame = frame;
    },

    async connect(): Promise<TransportResult<ConnectInfo>> {
      calls.connect += 1;
      if (options.connectFails) {
        return { ok: false, error: kaiError("AGENT_NOT_LISTENING", "fake transport is configured to fail connect") };
      }
      return { ok: true, value: { version, endpoint, capabilities: ["screenshot", "click", "type", "key", "scroll", "windows"] } };
    },

    async inspect(): Promise<TransportResult<Inspection>> {
      calls.inspect += 1;
      return { ok: true, value: inspection };
    },

    async act(action: TransportAction): Promise<TransportResult<ActionOutcome>> {
      calls.act.push(action);
      await hooks.onAct?.(action);
      return { ok: true, value: { performed: true, detail: action.kind } };
    },

    async observe(observeOptions?: ObserveOptions): Promise<TransportResult<Frame>> {
      calls.observe += 1;
      // Advance through a scripted frame list when one was supplied, so a test
      // can model a screen that changes on later captures.
      if (frames.length > 0) {
        currentFrame = frames[Math.min(frameIndex, frames.length - 1)] ?? currentFrame;
        frameIndex += 1;
      }
      await hooks.onObserve?.(observeOptions);
      return { ok: true, value: currentFrame };
    },

    async windows(): Promise<TransportResult<readonly WindowInfo[]>> {
      calls.windows += 1;
      return { ok: true, value: windows };
    },
  };
}
