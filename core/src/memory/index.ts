// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — public surface (Phase 2 Part B).
 *
 * Everything a caller outside `core/src/memory` should import. The two entry
 * points are:
 *
 *   import { openMemoryStore } from "./storage/memoryStore.ts";
 *   import { createMemoryEngine } from "./memory/index.ts";
 *
 *   const store = openMemoryStore({ path: dbPath });   // durable, node:sqlite
 *   const memory = createMemoryEngine({ store, publish });
 *
 * The legacy `createMemoryService` in `./service.ts` is unchanged; the engine is
 * additive. `MemoryEntryStore` is an interface, so a test can pass an in-memory
 * double without touching SQLite.
 *
 * What each Part maps to:
 *   B1 scopes/model      ./model.ts
 *   B2 hard bounds       ./bounds.ts  (+ enforced in ./engine.ts `persist`)
 *   B3 grammar/identity  ./entry.ts
 *   B4 topics/layout     ./topics.ts
 *   B5 scoped search     ./store.ts + ../storage/memoryStore.ts
 *   B6 capture           ./capture.ts (+ ./engine.ts `captureTurn`)
 *   B7 upkeep            ./upkeep.ts (+ ./engine.ts phases)
 *   B8 journal/revert    ./journal.ts (+ ./engine.ts)
 */

export {
  createMemoryEngine,
  type MemoryEngine,
  type MemoryEngineOptions,
  type CaptureResult,
  type EngineSearchOptions,
  type DigestOptions,
  type ConsolidateResult,
  type MemoryUpdatePatch,
} from "./engine.ts";

export {
  MEMORY_SCOPES,
  MEMORY_SCOPE_BOUNDS,
  MEMORY_PROVENANCES,
  MAX_CANDIDATES_PER_TURN,
  GLOBAL_SCOPE_ID,
  isMemoryScope,
  isActive,
  isExpired,
  isSuperseded,
  memoryRefusal,
  tokenizeMemoryText,
  toMemorySource,
  scopeRefId,
  type MemoryScope,
  type MemoryScopeRef,
  type MemoryProvenance,
  type MemoryEntry,
  type MemoryWriteInput,
  type MemoryWriteResult,
  type MemoryRefusal,
  type MemoryRefusalReason,
  type MemoryBounds,
  type MemoryTopic,
  type JournalRecord,
  type JournalOp,
} from "./model.ts";

export {
  computeHash,
  identityKey,
  normalizeContent,
  renderEntryLine,
  parseEntryLine,
  grammarRoundTrips,
  type ParsedEntryLine,
} from "./entry.ts";

export {
  createSubagentMemoryShares,
  type SubagentMemoryShare,
  type SubagentMemoryShares,
  type SubagentMemorySharesOptions,
} from "./shares.ts";

export {
  measureEntries,
  measureEntry,
  checkWriteBounds,
  consolidationPlan,
  boundsFor,
  usageSummary,
  formatBytes,
  type BucketUsage,
} from "./bounds.ts";

export {
  memoryLayout,
  ensureLayout,
  discoverTopics,
  parseTopicFile,
  renderTopicFile,
  renderIndex,
  slugify,
  type MemoryLayout,
  type DiscoveredTopic,
  type ParsedTopicFile,
} from "./topics.ts";

export {
  planRevert,
  snapshotEntry,
  entryFromSnapshot,
  newJournalId,
  type RevertPlan,
} from "./journal.ts";

export {
  extractCandidates,
  validateCandidate,
  classifyCandidate,
  resolveTopic,
  type CompletedTurn,
  type MemoryCandidate,
  type CandidateRejection,
  type ClassifiedCandidate,
} from "./capture.ts";

export {
  createMemoryUpkeep,
  UpkeepPausedError,
  type MemoryUpkeep,
  type MemoryUpkeepOptions,
  type UpkeepPhase,
  type UpkeepPhaseName,
  type UpkeepReport,
  type UpkeepStatus,
} from "./upkeep.ts";

export type {
  MemoryEntryStore,
  MemorySearchQuery,
  MemorySearchHit,
  MemoryScopeAccess,
  MemoryListOptions,
} from "./store.ts";
