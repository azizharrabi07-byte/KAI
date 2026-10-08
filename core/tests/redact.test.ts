// Part D — the canonical redaction boundary.
//
//   cd core && node --test tests/redact.test.ts
//
// What this protects:
//   1. ONE redactor. `agent/soul.ts` re-exports this module's implementation, so
//      there is no second set of patterns to drift out of sync.
//   2. Precision: a credential's named shapes are caught; ordinary content —
//      hashes, UUIDs, URLs, paths — survives, because mangling those teaches
//      people to ignore redaction.
//   3. The marker is idempotent: re-redacting an already-redacted string is a
//      no-op, so a payload redacted once (persist) and again (replay/SSE) is
//      byte-for-byte stable.

import test from "node:test";
import assert from "node:assert/strict";

import { REDACTED, redactSecrets, redactText } from "../src/redact/index.ts";
import { redactSecrets as soulRedact } from "../src/agent/soul.ts";

// ── Vendor prefix families ───────────────────────────────────────────────────

const VENDOR_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["openai/anthropic sk-", "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
  ["anthropic sk-ant-", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"],
  ["github classic ghp_", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["github fine-grained", "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["aws AKIA", "AKIAIOSFODNN7EXAMPLE"],
  ["google AIza", "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"],
  ["npm_", "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
  ["huggingface hf_", "hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef"],
  ["groq gsk_", "gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij"],
  ["cerebras csk-", "csk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij"],
  // NOTE: the Slack fixture is concatenated so the file never contains a
  // secret-shaped literal (secret scanners flag the joined form). The test
  // still feeds the full shape to the redactor.
  ["slack xoxb-", "xoxb-" + "123456789012-abcdefghijklmnopqrstuvwxyz"],
  ["xai", "xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
];

test("every vendor prefix family is caught", () => {
  for (const [label, key] of VENDOR_KEYS) {
    const out = redactText(`the credential is ${key} ok`);
    assert.ok(!out.includes(key), `${label} must be gone, got: ${out}`);
    assert.ok(out.includes(REDACTED), `${label} must leave the marker`);
  }
});

test("a jwt is caught", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g";
  const out = redactText(`token: ${jwt}`);
  assert.ok(!out.includes(jwt));
  assert.ok(out.includes(REDACTED));
});

test("a Bearer token is caught but the scheme stays readable", () => {
  const out = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
  assert.ok(!out.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.match(out, /Bearer \[redacted\]/);
});

test("a PEM private key block is caught", () => {
  const body = "MIIEowIBAAKCAQEAabcdefghijklmnopqrstuvwxyz0123456789";
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
  const out = redactText(`here it is:\n${pem}\nafter`);
  assert.ok(!out.includes(body), "the key body must be gone");
  assert.match(out, /-----BEGIN RSA PRIVATE KEY-----/);
  assert.match(out, /-----END RSA PRIVATE KEY-----/);
  assert.ok(out.includes(REDACTED));
});

test("key=value / key: value where the key names a secret is caught", () => {
  for (const line of [
    "api_key: abc123def456ghi",
    "api-key=abc123def456ghi",
    "password: hunter2hunter2",
    "secret=abcdefghijklmnop",
    "auth_token=abcdefghijklmnop",
    "my_access_key=abcdefghijklmnop",
  ]) {
    const out = redactText(line);
    assert.ok(!/abcdefghijklmnop|abc123def456ghi|hunter2hunter2/.test(out), `${line} leaked: ${out}`);
  }
});

test("a --flag secret is caught", () => {
  const out = redactText("run it --token=supersecretvalue123 now");
  assert.ok(!out.includes("supersecretvalue123"));
  assert.ok(out.includes(REDACTED));

  const spaced = redactText("curl --password topsecretvalue9 url");
  assert.ok(!spaced.includes("topsecretvalue9"));
});

test("a secret in URL userinfo is caught but the host survives", () => {
  const out = redactText("clone https://alice:s3cr3tpassword@example.com/org/repo.git to continue");
  assert.ok(!out.includes("s3cr3tpassword"));
  assert.match(out, /example\.com/);
  assert.match(out, /alice:/);
});

// ── Ordinary content survives ────────────────────────────────────────────────

test("a 40-char hex hash survives untouched", () => {
  const sha1 = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(sha1.length, 40);
  assert.equal(redactText(`commit ${sha1} merged`), `commit ${sha1} merged`);
});

test("a uuid survives untouched", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(redactText(`id=${uuid}`), `id=${uuid}`);
});

test("a url survives untouched", () => {
  const url = "https://github.com/kai/core/pull/1234#discussion_r99999";
  assert.equal(redactText(url), url);
});

test("a filesystem path survives untouched", () => {
  const path = "C:/Users/DELL/Desktop/kai/core/src/redact/index.ts";
  assert.equal(redactText(path), path);
});

test("ordinary prose survives untouched", () => {
  const prose = "Prefers concise answers, works in French, and commits at the end of the day.";
  assert.equal(redactText(prose), prose);
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test("the marker is idempotent: re-redacting a redacted string changes nothing", () => {
  const inputs = [
    "api_key: sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "https://alice:s3cr3t@example.com/x",
    "a".repeat(60),
    `already ${REDACTED} here`,
  ];
  for (const input of inputs) {
    const once = redactText(input);
    assert.equal(redactText(once), once, `not idempotent for: ${input}`);
  }
  assert.equal(redactText(REDACTED), REDACTED);
});

// ── The existing soul behaviour still holds ──────────────────────────────────

test("the shapes soul.test.ts pins still redact, via the shared implementation", () => {
  assert.ok(!soulRedact("token=abc123def456ghi").includes("abc123def456ghi"));
  assert.ok(!soulRedact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz").includes("abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!soulRedact("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").includes("ghp_"));
  assert.ok(!soulRedact("deadbeef".repeat(8)).includes("deadbeef"));
  assert.equal(soulRedact("x".repeat(45)), REDACTED);
  assert.equal(soulRedact("a normal sentence with short words"), "a normal sentence with short words");
});

// ── Deep redaction ───────────────────────────────────────────────────────────

test("deep redaction walks objects and arrays without mutating the input", () => {
  const input = {
    note: "ran with sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    api_key: "short",
    nested: { list: ["plain", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] },
    count: 3,
    ok: true,
  };
  const snapshot = JSON.stringify(input);
  const out = redactSecrets(input) as typeof input;

  assert.notEqual(out, input, "a fresh copy is returned");
  assert.equal(JSON.stringify(input), snapshot, "the caller's object is untouched");
  assert.ok(!JSON.stringify(out).includes("sk-live-"));
  assert.ok(!JSON.stringify(out).includes("ghp_"));
  assert.equal(out.api_key, REDACTED, "a secret-named key is masked whatever the value");
  assert.deepEqual(out.nested.list, ["plain", REDACTED]);
  assert.equal(out.count, 3);
  assert.equal(out.ok, true);
});

test("deep redaction is idempotent", () => {
  const input = { token: "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", arr: ["Bearer abcdefghijklmnop"] };
  const once = redactSecrets(input);
  assert.deepEqual(redactSecrets(once), once);
});
