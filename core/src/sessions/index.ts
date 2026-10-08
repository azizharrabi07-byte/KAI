// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

export {
  createSessionStore,
  defaultSessionsPath,
  escapeLike,
  type KaiSession,
  type SessionSearchHit,
  type SessionSearchMatch,
  type SessionStatus,
  type SessionStore,
  type SessionTurn,
  type SessionTurnRole,
} from "./store.ts";
export {
  createSessionService,
  type SessionErrorCode,
  type SessionMemoryScope,
  type SessionResult,
  type SessionResumeInput,
  type SessionService,
  type SessionServiceOptions,
  type SessionView,
} from "./service.ts";
export {
  TRANSCRIPT_KINDS,
  classifySession,
  createSessionTranscriptRouter,
  type SessionTranscript,
  type SessionTranscriptKind,
  type SessionTranscriptRouter,
  type TranscriptErrorCode,
  type TranscriptInput,
  type TranscriptKind,
  type TranscriptResult,
} from "./router.ts";
export {
  SESSION_TOOL_IDS,
  createSessionTools,
  registerSessionTools,
  type SessionToolDeps,
} from "./tools.ts";
export {
  registerSessionRoutes,
  type SessionRouteDeps,
  type SessionRouteRegistration,
} from "./routes.ts";
