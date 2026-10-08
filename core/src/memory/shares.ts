// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI Core memory — governed cross-subagent sharing.
 *
 * A subagent's private memory (`scope: "subagent"`) is unreachable from another
 * subagent by default. This module is the ONLY way one subagent's fact can reach
 * another: an explicit, named grant of ONE entry from ONE persona to ONE persona.
 *
 * It is deliberately NOT a second memory system. A share stores a POINTER
 * (`entryId`), never a copy of the fact. The fact itself still lives in exactly
 * one place — the addressed subagent's bucket in the one canonical memory store —
 * and recall resolves the pointer at read time, so revoking a share removes
 * access without ever having duplicated the fact. What this module owns is the
 * GOVERNANCE record: who shared what to whom, and under which KAI approval.
 *
 *   - A grant is backed by a real approval id. `grant` refuses an empty one, so a
 *     share cannot be minted by a caller that skipped the approval boundary.
 *   - Grants persist beside KAI's other state (a JSON file, the same pattern the
 *     subagent registry uses) so a `toSubagent`'s access survives a Core restart
 *     exactly as the source fact does.
 *   - Recall is fail-closed: only grants whose recipient matches are ever read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface SubagentMemoryShare {
  id: string;
  /** The subagent whose private bucket the shared entry lives in. */
  fromSubagent: string;
  /** The specific entry shared. A pointer, never a copy of the fact. */
  entryId: string;
  /** The subagent permitted to recall it. */
  toSubagent: string;
  /** The KAI approval that authorised the share. Never invented. */
  approvalId: string;
  /** ISO-8601 instant the share was granted. */
  at: string;
  reason?: string;
}

export interface SubagentMemoryShares {
  /** Grant ONE entry from `fromSubagent` to `toSubagent`, under an approval. */
  grant(input: {
    fromSubagent: string;
    entryId: string;
    toSubagent: string;
    approvalId: string;
    reason?: string;
    now?: Date;
  }): { ok: true; share: SubagentMemoryShare; deduped: boolean } | { ok: false; reason: string };
  revoke(id: string): boolean;
  get(id: string): SubagentMemoryShare | undefined;
  /** Shares that name `subagentId` as the recipient — the only ones it may read. */
  forRecipient(subagentId: string): SubagentMemoryShare[];
  list(): SubagentMemoryShare[];
}

export interface SubagentMemorySharesOptions {
  /** JSON file to persist grants to. Absent => in-memory only (tests). */
  path?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function newShareId(now: Date): string {
  return `share-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isShare(value: unknown): value is SubagentMemoryShare {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    nonEmpty(v.id) &&
    nonEmpty(v.fromSubagent) &&
    nonEmpty(v.entryId) &&
    nonEmpty(v.toSubagent) &&
    nonEmpty(v.approvalId) &&
    nonEmpty(v.at)
  );
}

export function createSubagentMemoryShares(
  options: SubagentMemorySharesOptions = {},
): SubagentMemoryShares {
  const path = options.path;
  const records = new Map<string, SubagentMemoryShare>();

  /** Load persisted grants once. A corrupt or missing file is empty, never an error. */
  function loadPersisted(): void {
    if (path === undefined) return;
    try {
      if (!existsSync(path)) return;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) return;
      for (const row of parsed) {
        if (!isShare(row)) continue; // drop a malformed row rather than refuse to start
        records.set(row.id, row);
      }
    } catch {
      // absent or unreadable: a first run, not a failure
    }
  }

  function persist(): void {
    if (path === undefined) return;
    try {
      writeFileSync(path, JSON.stringify([...records.values()], null, 2), "utf8");
    } catch {
      // A read-only home must not take memory recall down; the grant still holds.
    }
  }

  loadPersisted();

  function grant(input: {
    fromSubagent: string;
    entryId: string;
    toSubagent: string;
    approvalId: string;
    reason?: string;
    now?: Date;
  }): { ok: true; share: SubagentMemoryShare; deduped: boolean } | { ok: false; reason: string } {
    if (!nonEmpty(input.fromSubagent)) return { ok: false, reason: "fromSubagent must be a non-empty subagent id" };
    if (!nonEmpty(input.toSubagent)) return { ok: false, reason: "toSubagent must be a non-empty subagent id" };
    if (!nonEmpty(input.entryId)) return { ok: false, reason: "entryId must be a non-empty memory entry id" };
    // Governance: a share is only ever minted under a real approval. Refusing an
    // empty approval id is what keeps this from being a self-service bypass.
    if (!nonEmpty(input.approvalId)) return { ok: false, reason: "approvalId must name the KAI approval that authorised the share" };
    if (input.fromSubagent === input.toSubagent) return { ok: false, reason: "a share must cross subagents" };

    // Idempotent: an identical share already granted is returned, not duplicated.
    for (const existing of records.values()) {
      if (
        existing.fromSubagent === input.fromSubagent &&
        existing.entryId === input.entryId &&
        existing.toSubagent === input.toSubagent
      ) {
        return { ok: true, share: existing, deduped: true };
      }
    }

    const now = input.now ?? new Date();
    const share: SubagentMemoryShare = {
      id: newShareId(now),
      fromSubagent: input.fromSubagent,
      entryId: input.entryId,
      toSubagent: input.toSubagent,
      approvalId: input.approvalId,
      at: now.toISOString(),
    };
    if (input.reason !== undefined && input.reason.length > 0) share.reason = input.reason;
    records.set(share.id, share);
    persist();
    return { ok: true, share, deduped: false };
  }

  function revoke(id: string): boolean {
    const existed = records.delete(id);
    if (existed) persist();
    return existed;
  }

  function get(id: string): SubagentMemoryShare | undefined {
    return records.get(id);
  }

  function forRecipient(subagentId: string): SubagentMemoryShare[] {
    return [...records.values()]
      .filter((s) => s.toSubagent === subagentId)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  function list(): SubagentMemoryShare[] {
    return [...records.values()];
  }

  return { grant, revoke, get, forRecipient, list };
}
