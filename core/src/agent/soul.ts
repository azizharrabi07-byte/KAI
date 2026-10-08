/**
 * KAI's identity, loaded from KAI_HOME and independent of every worker.
 *
 * The point of this module is one sentence: **KAI knows who it is with Hermes offline.**
 * Nothing here talks to Hermes, OpenCode or the network, so "KAI stopped being KAI when a
 * worker went away" is not a failure mode that exists.
 *
 * Three rules it enforces, all of which matter more than the loading itself:
 *
 *  - **Bounded.** A document contributes at most `MAX_DOC_CHARS`. Memory that grows
 *    without limit stops being read, and a prompt that grows without limit stops working.
 *  - **Redacted.** Identity text is composed into prompts and shown in the UI, so it is
 *    scrubbed of anything shaped like a credential first. A secret in `USER.md` must not
 *    become a secret in a prompt, a log or a screen.
 *  - **Honest about gaps.** A missing or unreadable document degrades to the built-in
 *    identity and is recorded in `problems`, rather than silently producing an empty soul.
 */

import { createHash } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { resolveKaiHome, readIfPresent, type KaiHome } from "./kai-home.ts";
import { redactText } from "../redact/index.ts";

/** Per-document ceiling. Enough for a real soul; not enough to swamp a prompt. */
export const MAX_DOC_CHARS = 8000;

/**
 * The reload semantics, as a fact rather than an intention.
 *
 * Chosen deliberately: **edit -> next KAI turn/session** (option (b)), implemented
 * as a cheap change-detection in front of an explicit reload. The identity provider
 * stamps SOUL.md / USER.md / MEMORY.md with (mtime, size) and re-reads them the next
 * time the soul is asked for anything, so a hand-edit takes effect on KAI's NEXT
 * turn without a restart. An explicit reload (or the `soul.set` tool) is still
 * available and forces the read immediately, which is what a UI control uses.
 *
 * Why not restart (option (c)): the whole point of the file contract is that the owner
 * can change KAI's identity while KAI is running. Why not "reload configuration" as
 * the ONLY path (option (a)): a stale soul that only refreshes when a caller remembers
 * to ask is exactly the silent-staleness failure this closes. Auto-detect + explicit
 * force covers both, and neither silently keeps using a personality the owner changed.
 *
 * The trade-off is honest: detection keys on (mtime, size), not a content hash, so a
 * write that changes neither within the same filesystem timestamp tick could be missed
 * until the next real change; `reload()`/`replaceSoul()` never miss because they force
 * the read. Reading every document on every turn would be the alternative, and it is
 * not worth doing for a file a human edits.
 *
 * ── The doc-vs-code gap this string used to carry (now closed) ────────────────
 * The semantics string formerly named `POST /soul` as the immediate-write path. There
 * is NO `POST /soul` route — grep over core/src/api/routes.ts finds none. The REAL
 * write path is the `soul.set` tool (runtime.ts, handler calling `replaceSoul()`), which
 * is policy-checked like every other mutation. The string now names what exists; the
 * absent route is recorded here rather than left as a route a reader would believe in.
 */
export const SOUL_RELOAD_SEMANTICS =
  "SOUL.md edits take effect on KAI's next turn (auto-detected by file mtime+size); " +
  "the soul.set tool or an explicit reload() applies them immediately; no restart is required.";

/** Used when SOUL.md cannot be read at all, so KAI is never identity-less. */
export const BUILT_IN_SOUL = `I am KAI, the user's own agent on this machine.
I decide what a request needs and do it, delegating to a worker when that is better.
I answer questions about my own state from that state, not from a model's guess.
I never claim something worked without checking, and I say plainly what I could not do.
Hermes and OpenCode are workers I may use. I am still KAI when they are unavailable.`;

export interface KaiIdentitySource {
  root: string;
  soulPath: string;
  identityPath: string;
  capabilitiesPath: string;
  userPath: string;
  memoryPath: string;
  workforcePath: string;
  policyPath: string;
}

export interface KaiIdentity {
  soul: string;
  /** IDENTITY.md — what KAI is in relation to its workers (the invariant). */
  identity: string;
  /** CAPABILITIES.md — what KAI can and cannot do, in KAI's own terms. */
  capabilities: string;
  user: string;
  memory: string;
  /** WORKFORCE.md — who KAI's agents are and how they are governed. */
  workforce: string;
  /** SAFETY.md — the operating rules that bind KAI's actions. */
  policy: string;
  /** Short content hash of the soul, so the UI can say "identity v…" and spot a change. */
  version: string;
  source: KaiIdentitySource;
  /** Files created on this run because they did not exist. */
  seeded: string[];
  /** Non-fatal problems, in words fit to show a user. */
  problems: string[];
  loadedAt: string;
}

export interface KaiIdentityProvider {
  identity(): KaiIdentity;
  /** Re-reads the files (the user may have edited them). */
  reload(): KaiIdentity;
  /**
   * Re-reads the files ONLY when one of them changed on disk since the last read.
   * This is the auto-detect half of the documented reload semantics.
   */
  reloadIfChanged(): KaiIdentity;
  /**
   * Replace SOUL.md with `text` (bounded) and reload immediately. This is the ONE
   * owner of the soul write, so the file contract and the in-memory identity cannot
   * drift. Returns the identity that is now live.
   */
  replaceSoul(text: string): KaiIdentity;
  /** The composed context an agent turn starts from. Redacted and bounded. */
  systemPrompt(): string;
  /** One sentence KAI can say about itself, with no dependency on any worker. */
  selfDescription(): string;
}

/**
 * Removes anything shaped like a credential.
 *
 * There is exactly ONE redactor in KAI — `src/redact/index.ts` — and this is a
 * thin delegation to it. The identity loader and its tests keep importing this
 * name, but the patterns, the marker and the idempotency guarantee live in the
 * shared module so the bus and the soul cannot drift apart. The old
 * breadth-first version that lived here (any 32+ hex or 40+ base64-ish run)
 * was replaced because it mangled hashes, ids and URLs in ordinary notes; read
 * the canonical module for why precision-first is the right trade.
 */
export function redactSecrets(text: string): string {
  return redactText(text);
}

/**
 * The first real SENTENCE in a document, with markdown headings and blank lines
 * skipped.
 *
 * The defect this closes: `selfDescription()` used to take the first non-empty
 * line of SOUL.md, which is the file's ATX heading (`# SOUL — who KAI is`), so
 * KAI literally said a markdown heading about itself and the following sentence
 * was concatenated onto it without a break. A self-description must be a
 * well-formed sentence a person could say, so headings and blank lines are
 * dropped and the first sentence-ending run is returned.
 */
export function firstSentence(text: string): string | null {
  const body = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}(\s|$)/.test(line))
    .join(" ");
  if (body.length === 0) return null;
  const match = /^.*?[.!?](?=\s|$)/.exec(body);
  const sentence = (match !== null ? match[0] : body).trim();
  return sentence.length > 0 ? sentence : null;
}

function bound(text: string, label: string, problems: string[]): string {
  if (text.length <= MAX_DOC_CHARS) return text;
  problems.push(
    `${label} is ${text.length} characters and was truncated to ${MAX_DOC_CHARS}`,
  );
  return `${text.slice(0, MAX_DOC_CHARS)}\n\n[truncated at ${MAX_DOC_CHARS} characters]`;
}

export function createKaiIdentity(options: { root?: string } = {}): KaiIdentityProvider {
  const home: KaiHome = resolveKaiHome(options.root);

  function load(): KaiIdentity {
    const problems: string[] = [];

    const rawSoul = readIfPresent(home.soul);
    if (rawSoul === null || rawSoul.trim().length === 0) {
      problems.push(
        rawSoul === null
          ? `SOUL.md could not be read at ${home.soul}; using the built-in identity`
          : `SOUL.md is empty at ${home.soul}; using the built-in identity`,
      );
    }
    const soul = bound(redactSecrets(rawSoul?.trim() ? rawSoul : BUILT_IN_SOUL), "SOUL.md", problems);

    const rawUser = readIfPresent(home.user);
    if (rawUser === null) problems.push(`USER.md could not be read at ${home.user}`);
    const user = rawUser === null ? "" : bound(redactSecrets(rawUser), "USER.md", problems);

    const rawMemory = readIfPresent(home.memory);
    if (rawMemory === null) problems.push(`MEMORY.md could not be read at ${home.memory}`);
    const memory = rawMemory === null ? "" : bound(redactSecrets(rawMemory), "MEMORY.md", problems);

    // The KAI-owned supporting documents (identity invariant, capabilities, workforce
    // and safety rules). Each is optional: a home without them still yields a valid
    // identity, but a missing one is recorded so a reader is not misled about what
    // loaded. They are KAI's own files — no worker is consulted for any of them.
    const rawIdentity = readIfPresent(home.identity);
    if (rawIdentity === null) problems.push(`IDENTITY.md could not be read at ${home.identity}`);
    const identityDoc = rawIdentity === null ? "" : bound(redactSecrets(rawIdentity), "IDENTITY.md", problems);

    const rawCapabilities = readIfPresent(home.capabilities);
    if (rawCapabilities === null) problems.push(`CAPABILITIES.md could not be read at ${home.capabilities}`);
    const capabilitiesDoc =
      rawCapabilities === null ? "" : bound(redactSecrets(rawCapabilities), "CAPABILITIES.md", problems);

    const rawWorkforce = readIfPresent(home.workforce);
    const workforceDoc =
      rawWorkforce === null ? "" : bound(redactSecrets(rawWorkforce), "WORKFORCE.md", problems);

    const rawPolicy = readIfPresent(home.policy);
    const policyDoc = rawPolicy === null ? "" : bound(redactSecrets(rawPolicy), "SAFETY.md", problems);

    const version = createHash("sha256").update(soul).digest("hex").slice(0, 8);

    return {
      soul: soul.trim(),
      identity: identityDoc.trim(),
      capabilities: capabilitiesDoc.trim(),
      user: user.trim(),
      memory: memory.trim(),
      workforce: workforceDoc.trim(),
      policy: policyDoc.trim(),
      version,
      source: {
        root: home.root,
        soulPath: home.soul,
        identityPath: home.identity,
        capabilitiesPath: home.capabilities,
        userPath: home.user,
        memoryPath: home.memory,
        workforcePath: home.workforce,
        policyPath: home.policy,
      },
      seeded: [...home.seeded],
      problems,
      loadedAt: new Date().toISOString(),
    };
  }

  /** (mtime, size) per document — cheap enough to check on every soul read. */
  function fileSignature(path: string): string {
    try {
      const stat = statSync(path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  function signature(): string {
    return [home.soul, home.user, home.memory].map(fileSignature).join("|");
  }

  let currentSignature = signature();
  let current = load();

  /** Auto-detect: reload only when a source document actually changed. */
  function refresh(): KaiIdentity {
    const now = signature();
    if (now !== currentSignature) {
      current = load();
      currentSignature = now;
    }
    return current;
  }

  return {
    // Every read refreshes first, so a hand-edit to SOUL.md reaches the NEXT turn
    // without a restart (the documented semantics). `reload()`/`replaceSoul()` force.
    identity: () => refresh(),
    reload: () => {
      current = load();
      currentSignature = signature();
      return current;
    },
    reloadIfChanged: () => refresh(),
    replaceSoul: (text: string) => {
      const stored = text.slice(0, MAX_DOC_CHARS);
      writeFileSync(home.soul, stored, "utf8");
      current = load();
      currentSignature = signature();
      return current;
    },

    /**
     * What an agent turn starts from. Sections are omitted rather than left empty, so a
     * prompt never contains a heading with nothing under it.
     */
    systemPrompt(): string {
      const id = refresh();
      const parts = [`# Who I am\n\n${id.soul}`];
      if (id.identity.length > 0) parts.push(`# Who I am, in relation to my workers\n\n${id.identity}`);
      if (id.capabilities.length > 0) parts.push(`# What I can and cannot do\n\n${id.capabilities}`);
      if (id.user.length > 0) parts.push(`# What I know about the user\n\n${id.user}`);
      if (id.memory.length > 0) parts.push(`# What I remember\n\n${id.memory}`);
      if (id.workforce.length > 0) parts.push(`# My workforce\n\n${id.workforce}`);
      if (id.policy.length > 0) parts.push(`# My operating rules\n\n${id.policy}`);
      return parts.join("\n\n");
    },

    selfDescription(): string {
      // Read from the soul rather than restating it, so the two cannot drift apart.
      // A heading is not a self-description: skip it (and blank lines) and take the
      // first real sentence. If the file yields nothing usable, fall back to the
      // built-in soul's own sentence so KAI is never identity-less and never says a
      // markdown heading as what it is.
      const soul = refresh().soul;
      return (
        firstSentence(soul) ??
        firstSentence(BUILT_IN_SOUL) ??
        "I am KAI."
      );
    },
  };
}
