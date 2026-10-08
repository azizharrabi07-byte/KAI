// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core — computer-use (CUA) foundation, Phase 1 Part P.
 *
 * A thin, KAI-owned integration with a computer-use driver, with the four
 * safety mechanisms the brief makes the point of the task:
 *
 *   - human control hold (fail closed on an unreachable control endpoint)
 *   - stale-lease protection (a generation counter, so an old timer cannot
 *     release a newer lease)
 *   - observation deduplication (frame hashing, reported to callers)
 *   - transition protection (a control change mid-sequence invalidates the
 *     result rather than returning it as if nothing moved)
 *
 * SCOPE NOTE, stated plainly: the transport is FAKE-BACKED in this phase. The
 * real driver wiring — MCP over stdio to `cua-driver` 0.28.2, whose local
 * daemon on Windows is a named pipe — is deliberately NOT implemented here. The
 * `ComputerTransport` seam and the facts a later phase needs (version floor,
 * pipe name, executable) live in `transport.ts` and SEAM.md so nobody rediscovers
 * them. `session.transport.endpoint.kind === "fake"` is the machine-checkable
 * proof of the current backing.
 */

export {
  kaiError,
  type KaiErrorOptions,
} from "./errors.ts";

export {
  ControlLedger,
  createControlProbeClient,
  heldUnreachable,
  controlNowIso,
  UNREACHABLE_GENERATION,
  type AcquireResult,
  type ControlEndpoint,
  type ControlEndpointReading,
  type ControlHolder,
  type ControlLedgerOptions,
  type ControlProbeClientOptions,
  type ControlSnapshot,
  type ControlSource,
  type LeaseHandle,
  type ReleaseResult,
} from "./control.ts";

export {
  compareDriverVersions,
  isSupportedDriverVersion,
  parseDriverVersion,
  MINIMUM_DRIVER_VERSION,
  REAL_DRIVER_SEAM,
  type ActionOutcome,
  type ClickTarget,
  type ComputerTransport,
  type ConnectInfo,
  type DriverVersion,
  type Frame,
  type Inspection,
  type MouseButton,
  type ObserveOptions,
  type ScrollTarget,
  type TransportAction,
  type TransportEndpoint,
  type TransportResult,
  type WindowBounds,
  type WindowInfo,
} from "./transport.ts";

export {
  ObservationDeduper,
  hashFrame,
  type DedupeDecision,
  type DedupeReason,
  type ObservationStats,
} from "./observation.ts";

export {
  createFakeTransport,
  frameFromData,
  type FakeTransport,
  type FakeTransportCalls,
  type FakeTransportHooks,
  type FakeTransportOptions,
} from "./fake-transport.ts";

export {
  createComputerSession,
  type ActOutcome,
  type ComputerSession,
  type ComputerSessionOptions,
  type ConnectOutcome,
  type GuardFailure,
  type GuardFailureReason,
  type Guarded,
  type GuardSuccess,
  type HealthOutcome,
  type InspectOutcome,
  type ObserveOutcome,
  type ObserveSuccess,
  type WindowsOutcome,
} from "./session.ts";
