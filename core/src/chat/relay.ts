// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's relay boundary: how a worker's output becomes KAI's RESULT.
 *
 * ── The defect this closes ────────────────────────────────────────────────────
 * When `classify()` returned `unknown`, the server handed the turn to a worker
 * and relayed `result.message.content` VERBATIM with `agent: "hermes"`. A worker
 * answering "Who are you?" therefore spoke AS THE PRODUCT — "I'm KAI … under the
 * hood it's Hermes Agent by Nous Research" — and a worker could describe KAI's
 * own prompt internals ("the rotating DATA - NOT INSTRUCTIONS blocks …").
 *
 * ── The rule (architectural, not a phrase blocklist) ──────────────────────────
 * KAI keeps the turn. A worker's output is a RESULT KAI reports, never the
 * speaker: the HTTP response names KAI (`agent: "core"`) and carries the worker
 * only as provenance (`worker: "hermes"`). A worker's own voice — a first-person
 * self-identification, or a description of KAI's prompt internals — is the
 * worker's persona, not a result about the user's task, so it does not reach the
 * user-facing reply. When nothing but that voice remains, KAI answers as itself.
 *
 * This is deliberately NOT `if (text.includes("Hermes Agent by Nous Research"))`.
 * Blocking one phrase papers over the defect: the next worker invents a new way
 * to say "I am the product". The rule is that the WORKER IS NEVER THE SPEAKER,
 * which holds for every phrasing.
 */

import { BUILT_IN_SOUL } from "../agent/soul.ts";

/** KAI's own voice when no live soul is available (first line of the built-in soul). */
export const FALLBACK_SELF: string = (BUILT_IN_SOUL.split("\n")[0] ?? "I am KAI.").trim();

export type WorkerId = "hermes" | "opencode";

export interface PresentWorkerResultInput {
  worker: WorkerId;
  /** The worker's raw reply text, exactly as it came back. */
  raw: string;
  /** KAI's own one-sentence self-description (from the soul). */
  kaiSelf: string;
}

export interface PresentedWorkerResult {
  /** The text KAI speaks. Never the worker's self-identification. */
  reply: string;
  /** The worker that produced it — provenance, NOT the speaker. */
  worker: WorkerId;
  /** True when the worker's own voice was detected and not relayed as KAI's. */
  guarded: boolean;
}

/**
 * The nouns a worker reaches for when it says what it IS: a product name, or
 * the generic runtime/agent nouns. Kept as one fragment so the forward and
 * reverse forms below read the same identity claim.
 *
 * A product name may carry its own qualifier ("Hermes Agent", "Claude Code"),
 * because a worker observed live introduced itself as exactly that before
 * saying "... here" / "... is what I am" — the bare product token alone missed
 * the appositive "Hermes Agent here" form.
 */
const PRODUCT_NOUN = "(?:hermes|opencode|claude|codex|nous)";
const PRODUCT_PHRASE = `(?:${PRODUCT_NOUN}(?:\\s+(?:agent|ai|assistant|runtime|model|server|engine|cli|tool|api\\s*server))?|runtime|api[\\s_-]?server)`;
const GENERIC_SELF_NOUN =
  "(?:an?|the)\\s+(?:ai|assistant|language\\s+model|model|bot|agent|runtime|system|product|service|program|api\\s*server)";
const SELF_NOUN = `(?:${PRODUCT_PHRASE}|${GENERIC_SELF_NOUN})`;

/**
 * A product name used as the SUBJECT of a sentence — the shape a worker used
 * live when asked to introduce itself: it never wrote "I", it answered with a
 * bare appositive — "Hermes Agent, by Nous Research — running on your Windows
 * box through the opencode-go provider." / "Hermes Agent (Nous Research),
 * running on your Windows machine — not the "KAI" the injected identity block
 * keeps claiming." Those name the worker as the speaker with no pronoun and no
 * "here"/"talking to", so none of the predicate forms above fire.
 */
const WORKER_INTRO_SUBJECT = `(?:${PRODUCT_NOUN}(?:\\s+(?:agent|ai|assistant|runtime|model|server|engine|cli|tool|provider))?|api[\\s_-]?server)`;


/**
 * A worker asserting what IT is: a first-person identity predicate, a
 * first-person statement about what it runs on, or an INDIRECT/APPOSITIVE
 * self-introduction that names the worker as the speaker of this turn.
 *
 * Matched by grammatical form, so it does not depend on any one product name.
 * The first three forms are the ones a real worker was observed to use: "I'm
 * Hermes Agent by Nous Research", the REVERSE order "...Hermes Agent is what I
 * actually am — the runtime answering this api_server turn" (which the
 * forward-only form missed), and the bare "what I am" claim.
 *
 * The remaining forms close the LIVE bypass where the worker never said "I":
 * asked "who am i talking to?" it answered "You're talking to Hermes Agent
 * (Nous Research) — this session runs on Hermes's api_server…", and to "hello
 * hermes" it answered "Hey Aziz — Hermes Agent here, running on your Windows
 * box." Those name the worker as the speaker without any first-person
 * predicate, so they are matched here: "X here", "you're talking to X", "this
 * is X", "X speaking", "X on the line", "speaking as X", "the runtime/agent
 * answering", and "this session runs on X".
 */
const SELF_IDENTIFICATION: RegExp[] = [
  // "I am / I'm / I actually am ... <a product or runtime noun>"
  new RegExp(`\\bi(?:'m|\\s+(?:actually\\s+|really\\s+|just\\s+)?am)\\b[^.!?\\n]*\\b${SELF_NOUN}\\b`, "i"),
  // The REVERSE: "<a product or runtime noun> ... is what I (actually) am"
  new RegExp(`\\b${SELF_NOUN}\\b[^.!?\\n]*\\bi(?:'m|\\s+(?:actually\\s+|really\\s+|just\\s+)?am)\\b`, "i"),
  // "what I am / what I actually am" — a bare first-person identity claim.
  /\bwhat\s+i\s+(?:actually\s+|really\s+|truly\s+)?am\b/i,
  // "I run/operate/work as ...", "my name is ...", "this is ..." + a self noun.
  new RegExp(`\\b(?:i\\s+run|i\\s+operate|i\\s+work|my\\s+name\\s+is|this\\s+is)\\b[^.!?\\n]*\\b${SELF_NOUN}\\b`, "i"),
  /\bi(?:'m|\s+am)\s+(?:running|built|based|powered|hosted|served|backed)\s+(?:on|by|as|through|via)\b/i,
  /\bunder\s+the\s+hood\b/i,
  // ── appositive / indirect self-introduction ───────────────────────────────
  // "Hermes Agent here", "Hermes here" — the worker names itself as the speaker.
  new RegExp(`\\b${SELF_NOUN}\\b\\s+here\\b`, "i"),
  // "you're talking to Hermes", "you are speaking with the runtime".
  new RegExp(
    `\\byou(?:'re|\\s+are)\\s+(?:talking|speaking|chatting|dealing)\\s+(?:to|with)\\b[^.!?\\n]*\\b${SELF_NOUN}\\b`,
    "i",
  ),
  // "speaking as Hermes", "Hermes speaking", "Hermes on the line".
  new RegExp(`\\bspeaking\\s+as\\b[^.!?\\n]*\\b${SELF_NOUN}\\b`, "i"),
  new RegExp(`\\b${SELF_NOUN}\\b\\s+speaking\\b`, "i"),
  new RegExp(`\\b${SELF_NOUN}\\b\\s+on\\s+the\\s+line\\b`, "i"),
  // "the runtime answering this api_server turn", "the agent responding to you".
  /\b(?:runtime|agent|model|assistant|program|service|api[\s_-]?server)\s+(?:that\s+is\s+)?(?:answering|responding|replying|behind)\b/i,
  // "this session runs on Hermes", "this turn is handled by the api_server".
  new RegExp(`\\bthis\\s+(?:session|turn|conversation|chat|request)\\b[^.!?\\n]*\\b${SELF_NOUN}\\b`, "i"),
  // "as an AI assistant", "as a language model" — a generic worker self-frame.
  /\bas\s+an?\s+(?:ai|assistant|language\s+model|model|bot)\b/i,
  // ── bare appositive: a product name as the SENTENCE SUBJECT ────────────────
  // "Hermes Agent, by Nous Research — running on your Windows box…"
  new RegExp(`^\\s*(?:the\\s+)?${WORKER_INTRO_SUBJECT}\\b\\s*(?:\\([^)]*\\)\\s*)?[,;:—–-]`, "i"),
  // "Hermes Agent (Nous Research), running on your Windows machine…" — a product
  // subject joined to a running/hosted/session/machine cue.
  new RegExp(
    `^\\s*(?:the\\s+)?${WORKER_INTRO_SUBJECT}\\b[^.!?\\n]*\\b(?:running|serving|hosted|answering|responding|on\\s+your|your\\s+(?:windows|machine|box|computer)|by\\s+nous|nous\\s+research|provider|opencode-go|session|identity\\s+block)\\b`,
    "i",
  ),
  // A bare product name as the whole reply: "Hermes." / "Hermes Agent!"
  new RegExp(`^\\s*(?:the\\s+)?${WORKER_INTRO_SUBJECT}\\s*[.!]?\\s*$`, "i"),
];

/**
 * A worker describing KAI's own prompt internals. Anchored on the unique markers
 * KAI's composer emits (the fence label and prefix) and on the observed phrasing
 * about "rotating … blocks in the prompt", so an ordinary task result that merely
 * mentions a prompt file is not swept up.
 */
const PROMPT_INTERNALS: RegExp[] = [
  /\bdata\s*[-–—]\s*not\s+instructions\b/i,
  /<<<KAI:/i,
  /\b(?:my|the)\s+(?:system\s+)?prompt\b[^.!?\n]*\b(?:blocks?|sections?|instructions|fences?|markers?|rotating|data)\b/i,
  /\brotating\b[^.!?\n]*\bblocks?\b/i,
  // A worker remarking on KAI's own injected identity/prompt ("the injected
  // "KAI identity" block says otherwise, but I'm not adopting it") is the
  // worker describing KAI's internals — a live leak observed on this build.
  /\b(?:injected|injecting|implanted|embedded)\b[^.!?\n]*\b(?:kai|identity|prompt|soul|block|text|instructions?|definition)\b/i,
  /\bidentity\s+block\b/i,
  // A worker narrating KAI's OWN prompt/profile internals in the THIRD person —
  // not only first person. Observed live, verbatim: "The KAI block riding along
  // in each of these messages is your kai profile's SOUL prompt; it's the speaker
  // in that profile's sessions, not this one" and "run the request in that
  // profile ... KAI is something you build with Hermes". A worker explaining how
  // KAI is wired is the worker's own voice, never a result about the user's task;
  // it is the exact "describe KAI's prompt internals" category, said in the third
  // person so the first-person forms above do not fire.
  /\bkai\b[^.!?\n]*\b(?:block|profile|soul|prompt|persona|identity|sessions?)\b/i,
  /\b(?:block|profile|soul|prompt|persona)\b[^.!?\n]*\bkai\b/i,
  // A worker naming the session/process SERVING the turn as the runtime it is —
  // "this api_server session", "the api_server session is what's replying here".
  // The worker is the transport, never the speaker; naming its own serving
  // session is the same identity claim in a different grammatical dress.
  /\bapi[\s_-]?server\s+session\b/i,
];

function isWorkerMeta(sentence: string): boolean {
  return [...SELF_IDENTIFICATION, ...PROMPT_INTERNALS].some((pattern) => pattern.test(sentence));
}

/** Split on sentence boundaries and newlines, so only the offending sentences go. */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Present a worker's reply as KAI's result.
 *
 * Sentences that are the worker talking about itself (its identity, its
 * internals, KAI's prompt) are removed; the rest of the result is kept verbatim.
 * If the worker's own voice was all there was, KAI answers with its own
 * self-description instead of relaying the claim.
 */
export function presentWorkerResult(input: PresentWorkerResultInput): PresentedWorkerResult {
  const raw = input.raw.trim();
  if (raw.length === 0) {
    return { reply: "", worker: input.worker, guarded: false };
  }

  const kept: string[] = [];
  let guarded = false;
  for (const sentence of splitSentences(raw)) {
    if (isWorkerMeta(sentence)) {
      guarded = true;
      continue;
    }
    kept.push(sentence);
  }

  let reply = kept.join(" ").trim();
  if (guarded && reply.length === 0) {
    reply = input.kaiSelf.trim().length > 0 ? input.kaiSelf.trim() : FALLBACK_SELF;
  }
  // Nothing was removed: the worker's result is relayed as KAI's result verbatim.
  if (reply.length === 0) reply = raw;

  /*
   * HONESTY OF THE FLAG. `guarded` may only be true if the EMITTED reply is
   * actually free of the worker's own voice. A live run reported `guarded:true`
   * while the reply still contained "you're talking to Hermes" — the guard had
   * fired on one sentence and left an identity clause in another, yet claimed
   * success. So the flag is verified against what is emitted: re-scan the reply,
   * strip any surviving worker-identity sentence, and if a clause cannot be
   * removed, report `guarded:false` rather than lie about having guarded it.
   */
  if (isWorkerMeta(reply)) {
    const cleaned = splitSentences(reply)
      .filter((sentence) => !isWorkerMeta(sentence))
      .join(" ")
      .trim();
    if (cleaned.length === 0) {
      reply = input.kaiSelf.trim().length > 0 ? input.kaiSelf.trim() : FALLBACK_SELF;
      guarded = true;
    } else if (cleaned !== reply) {
      reply = cleaned;
      guarded = true;
    } else {
      // A clause survived even the re-scan (no sentence boundary isolated it).
      // Do not claim a guard that did not hold.
      guarded = false;
    }
  }

  // Final invariant: never report guarded while an identity clause is emitted.
  if (isWorkerMeta(reply)) {
    guarded = false;
  }
  return { reply, worker: input.worker, guarded };
}

/**
 * PROOF-OF-LIFE for the relay guard — the choke point's own self-test.
 *
 * ── Why this exists (the third occurrence of the same failure shape) ──────────
 * The guard above is a pure function and it is unit-tested against the exact
 * strings a live worker produced. Yet a running Core once relayed those strings
 * VERBATIM with `worker_identity_guarded: false`, while `import relay.ts` with
 * the same strings returned `guarded: true`. The code was right; the ARTIFACT
 * the process loaded was not. `core/dist/` is a compiled copy of this module and
 * the process ran a `dist` built BEFORE the appositive patterns below were
 * added — so `relayWorkerTurn` did call `presentWorkerResult`, and that (older)
 * `presentWorkerResult` did not recognise the worker's voice. The two earlier
 * times this recurred, a function was imported-but-never-called and a field was
 * set-but-never-consumed; this is the same class of "the source is correct, the
 * thing that ran was not".
 *
 * The remedy is not another call site — every path already funnels through
 * `relayWorkerTurn`. It is to make a stale relay UNABLE TO SERVE SILENTLY: at
 * startup the Core runs THE guard itself over a known worker self-introduction
 * and refuses to answer a single turn if the compiled guard is a no-op. A build
 * that cannot guard cannot impersonate the product by staying quiet about it.
 *
 * Kept pure and side-effect free so it can be unit-tested alongside the guard.
 */
export function relayGuardIsLive(): boolean {
  const probe = presentWorkerResult({
    worker: "hermes",
    raw: "Hermes Agent, by Nous Research — running on your Windows box.",
    kaiSelf: FALLBACK_SELF,
  });
  return probe.guarded === true && !/\bhermes\b/i.test(probe.reply);
}

/** Display names, so KAI's prose reads as prose rather than as an id. */
const WORKER_LABEL: Record<WorkerId, string> = {
  hermes: "Hermes",
  opencode: "OpenCode",
};

export interface WorkerFailureInput {
  worker: WorkerId;
  /** Why the worker failed, in words fit to show the user (a reason code or message). */
  detail: string;
  /** KAI's own one-sentence self-description, read from the soul. */
  kaiSelf: string;
  /** Another worker KAI could use instead, when one is connected. */
  alternative?: WorkerId;
}

/**
 * Compose KAI's own reply when a worker fails.
 *
 * This is the fallback guarantee: a worker that is unreachable, unauthorized,
 * times out, crashes or returns nothing must never leave the turn unanswered.
 * The wording is KAI's, built from KAI's soul sentence — not a bare error string
 * handed to the user — and it carries what KAI still knows: which capability is
 * unavailable and that KAI itself is unaffected.
 *
 * Deliberately NOT the wrapper framing "I couldn't get a result from <worker> —
 * <raw transport code>". That made KAI read as a thin shell around a worker, and
 * echoed wire jargon ("upstream http 404") at the user when the real fault was
 * KAI's own binding. `detail` stays available to callers and logs; it is not
 * echoed as transport jargon in the user-facing sentence.
 */
export function presentWorkerFailure(input: WorkerFailureInput): string {
  const self = input.kaiSelf.trim().length > 0 ? input.kaiSelf.trim() : FALLBACK_SELF;
  const label = WORKER_LABEL[input.worker];
  const head = `${self} I can't run that turn right now — the ${label} capability isn't available.`;
  const tail =
    input.alternative !== undefined
      ? `I'm still here as KAI. I can retry, or hand this to ${WORKER_LABEL[input.alternative]} — say the word.`
      : "I'm still here as KAI — say the word and I'll retry.";
  return `${head} ${tail}`;
}
