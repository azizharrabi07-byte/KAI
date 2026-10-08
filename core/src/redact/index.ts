// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The canonical redaction boundary.
 *
 * ONE implementation. Every place KAI turns text or a payload into something a
 * human, a log or another process can see goes through here — the event bus
 * (before persistence AND before delivery), KAI's own identity documents
 * (agent/soul.ts), and anything added later. A second redactor is how a
 * boundary rots: one of them is always a little more permissive, and the leak
 * lives in the gap. `agent/soul.ts` therefore does not own an implementation
 * anymore; it re-exports this one.
 *
 * ── Why precision-first, not breadth-first ───────────────────────────────────
 * The previous soul-only implementation treated any unbroken 32+ hex or 40+
 * base64-ish run as a secret. That is safe but wrong: a git SHA, a UUID, an
 * ETag, a long URL segment and a base64 test fixture are all "long opaque
 * runs", and mangling them means redaction shows up in ordinary notes and
 * transcripts where nothing secret was ever present. Redaction that fires on
 * ordinary content trains people to distrust it.
 *
 * So the patterns below name the SHAPES a credential actually takes — vendor
 * prefixes, Bearer/pem/`key=value`/`--flag`/URL-userinfo — and only fall back
 * to a length heuristic at a floor deliberately ABOVE the shapes KAI must let
 * through (a 40-char git SHA-1, a 36-char UUID, ordinary URLs and paths). It is
 * still conservative where it counts: a genuinely long opaque blob is caught.
 *
 * ── The marker is idempotent ─────────────────────────────────────────────────
 * Every replacement is the fixed marker `[redacted]`, and no value class in any
 * pattern accepts `[` or `]`, so running the redactor over its own output is a
 * no-op. That matters because a payload can pass through this boundary more
 * than once (persist → replay → SSE), and a marker that grows or mutates would
 * make a persisted event differ from the one the UI sees.
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 * The precision patterns (vendor prefixes, Bearer, PEM, key=value, `--flag`,
 * URL userinfo) are adapted from the redaction in milind-soni/OpenMausBot
 * (Apache-2.0, commit caba935), `shared/redact.ts` / `server/redact.ts`. Nothing
 * was copied: upstream masks with `«redacted N chars»`, this uses KAI's marker,
 * and the breadth fallback is KAI's own, tuned per the note above.
 */

/** The one marker. Fixed-length so re-redaction is byte-for-byte stable. */
export const REDACTED = "[redacted]";

/** Matches the marker itself, for the idempotency guard. */
const MARKER = /^\[redacted\]$/;

/**
 * Masks a *whole* value. Returns the input unchanged when it is already the
 * marker — the belt to the patterns' braces on idempotency.
 */
export function mask(value: string): string {
  return MARKER.test(value) ? value : REDACTED;
}

// ── Content-shaped secrets ───────────────────────────────────────────────────
// High precision on purpose. Only shapes that are unmistakably credentials
// match; a generic "long hex/base64" heuristic is handled separately, last.

/** A PEM private key block, body and all. Matched first so its base64 body
 * can never be mistaken for an ordinary long run. */
const PEM_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;

/** Vendor-prefixed keys. Each prefix is a vendor's own marker, so the shape
 * alone is enough; the length floors only reject obvious non-keys. */
const KEY_PREFIXES: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  /\bxai-[A-Za-z0-9_-]{20,}/g, // xai (grok)
  /\bgsk_[A-Za-z0-9]{20,}/g, // groq
  /\bcsk-[A-Za-z0-9]{20,}/g, // cerebras
  /\bhf_[A-Za-z0-9]{30,}/g, // hugging face
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // jwt
];

/** `Authorization: Bearer <token>` — the token, keeping the scheme readable. */
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

/**
 * `key=value` / `key: value` / `key="value"` where the key is secret-shaped.
 * The value must be a single token of some length: prose after a colon
 * ("password: leave blank") has spaces and does not match, so real text is
 * left alone.
 */
const KEY_VALUE =
  /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key|credential)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\3/gi;

/**
 * `X_KEY=value`, `xai_key=value`: an assignment to a name that ENDS in `key`
 * is a credential whatever the value looks like, so no length floor. The
 * separator before `key` is what keeps `hotkey=` and `keyboard=` out.
 */
const KEY_SUFFIX_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_-]*[_-]key)s?(=)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;

/**
 * `--token abc`, `--password=abc`: the flag names a secret, so the value is
 * whatever single token follows — never another flag.
 */
const SECRET_FLAG =
  /(--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)(?:=|\s+))(["']?)(?!-)([A-Za-z0-9._~+/=-]+)\2/gi;

/**
 * `scheme://user:secret@host` — the password in a URL's userinfo. The secret
 * class excludes `[`/`]` (so the marker is never rematched) and `«»` for the
 * same reason.
 */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:)([^\s/@'"«»[\]]+)(@)/gi;

/**
 * The breadth fallback, applied LAST so the precision patterns above always win.
 *
 * Floor is 41, chosen deliberately: it sits just ABOVE a 40-character git
 * SHA-1 / hex hash, a 36-character UUID and ordinary URL/path segments, so
 * those survive — and just BELOW the 45-character run KAI's existing identity
 * tests pin as "an opaque blob". Anything at or over 41 unbroken token
 * characters is treated as a secret because that is the smallest shape a
 * leaked key takes once it has no recognisable prefix.
 *
 * `/` is deliberately NOT in this class even though real base64 uses it: a run
 * that contains slashes is a path or a URL, not a token, and letting `/` in
 * turned `C:/Users/.../index.ts` into `C:/[redacted].ts`. Dropping it means a
 * slash-delimited path survives; a base64 blob with `/` is still covered by the
 * named patterns above, which is where real credentials carry their shape.
 */
const LONG_OPAQUE_RUN = /\b[A-Za-z0-9+]{41,}={0,2}\b/g;

/** Guards against handing the regex engine enormous inputs unchanged. */
const MIN_LENGTH = 8;

/**
 * Redacts credential-shaped content from a single string. Idempotent: running
 * it over its own output returns that output unchanged.
 */
export function redactText(text: string): string {
  if (text.length < MIN_LENGTH) return text;
  let out = text;

  // 1. Structural secrets first: a PEM body must not reach the prefix or
  //    fallback passes as though it were ordinary base64.
  out = out.replace(PEM_BLOCK, (_m, open: string, body: string, close: string) => `${open}\n${mask(body.trim())}\n${close}`);

  // 2. Named shapes.
  for (const re of KEY_PREFIXES) out = out.replace(re, (m) => mask(m));
  out = out.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`);
  out = out.replace(
    KEY_VALUE,
    (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`,
  );
  out = out.replace(
    KEY_SUFFIX_ASSIGNMENT,
    (_m, key: string, sep: string, quote: string, value: string) => `${key}${sep}${quote}${mask(value)}${quote}`,
  );
  out = out.replace(SECRET_FLAG, (_m, flag: string, quote: string, value: string) => `${flag}${quote}${mask(value)}${quote}`);
  out = out.replace(URL_USERINFO, (_m, lead: string, secret: string, at: string) => `${lead}${mask(secret)}${at}`);

  // 3. The length heuristic, last and only for what survived 1 and 2.
  out = out.replace(LONG_OPAQUE_RUN, REDACTED);

  return out;
}

// ── Deep redaction ───────────────────────────────────────────────────────────

/**
 * Names whose value is a credential. Matched case-insensitively as a
 * substring, so `ANTHROPIC_API_KEY` and `x-api-key` both qualify.
 */
const SECRET_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authorization",
  "auth_token",
  "credential",
];

/**
 * `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only a
 * standalone `key` or one that is a suffix (`API_KEY`, `consumer-key`,
 * `xai_key`) is a credential, which is how every real one is spelled.
 */
export function isSecretKeyName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

/** Depth cap: a provider payload can nest, but a credential does not live 12
 * levels down and unbounded recursion is how a redactor takes the process out. */
const MAX_DEPTH = 12;

function walk(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    // A secret-named string value is masked whole, whatever it looks like —
    // `{ api_key: "short" }` is a credential even when it does not match a
    // content shape. Other values get the content pass, which catches a
    // credential hidden under an ordinary-looking name.
    if (typeof child === "string" && isSecretKeyName(key)) {
      out[key] = mask(child);
      continue;
    }
    out[key] = walk(child, depth + 1);
  }
  return out;
}

/**
 * Redacts every string in a structured value, returning a fresh copy. Handles
 * arbitrary payloads (the bus's KaiEvent payload, a RuntimeEvent, an env map)
 * without mutating the caller's object.
 */
export function redactSecrets(value: unknown): unknown {
  return walk(value, 0);
}
