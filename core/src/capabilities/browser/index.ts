// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Browser capability barrel.
 *
 * Import from here rather than reaching into individual files: the split between
 * channel selection (interaction.ts), the transport seam (transport.ts),
 * ownership (ownership.ts), the fake transport (fake-transport.ts) and the
 * capability itself (capability.ts) is an internal structure, not a public one.
 */

export {
  INTERACTION_HIERARCHY,
  SEMANTIC_STRATEGIES,
  NO_AFFORDANCES,
  affordanceFor,
  hasSemanticChannel,
  isInteractionStrategy,
  isTransportAffordances,
  selectStrategy,
  type InteractionStrategy,
  type SemanticStrategy,
  type StrategyCandidate,
  type StrategyDecision,
  type TransportAffordances,
} from "./interaction.ts";

export {
  BROWSER_ACTIONS,
  ACTION_RISK,
  isBrowserAction,
  maxActionRisk,
  transportError,
  type ActOutcome,
  type ActRequest,
  type BrowserAction,
  type BrowserTransport,
  type ObservedPage,
  type ObserveRequest,
  type Result,
  type SemanticElement,
  type TargetInfo,
} from "./transport.ts";

export {
  createOwnershipRegistry,
  type OwnershipRegistry,
  type TargetLease,
} from "./ownership.ts";

export {
  createFakeTransport,
  type FakeCall,
  type FakeStats,
  type FakeTargetSpec,
  type FakeTransport,
  type FakeTransportOptions,
} from "./fake-transport.ts";

export {
  createBrowserCapability,
  type ActionResult,
  type BrowserCapability,
  type BrowserCapabilityOptions,
  type CallerContext,
  type InspectionResult,
  type StrategyLogEntry,
} from "./capability.ts";
