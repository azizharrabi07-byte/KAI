// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * KAI's own-brain regression suite — the two defects that stopped a real
 * generative turn from coming back from KAI's OWN model provider.
 *
 * DEFECT 1. opencode-go refuses a routed request without `x-opencode-session`:
 *
 *     POST {base}/chat/completions, no routing header  -> HTTP 400 MissingSessionID
 *     same request + x-opencode-session + UA           -> HTTP 200 with a completion
 *
 *   while `GET /models` succeeds either way, so the endpoint reads "reachable"
 *   while every real turn fails. The first test asserts on the OUTGOING request
 *   headers (a stub fetch), so it fails if the header is not sent — the header,
 *   not a mocked success, is what is under test. It also proves the id is STABLE
 *   (never random per request) and that a NON-opencode endpoint is unaffected.
 *
 * DEFECT 2. KAI_HOME was resolved twice — the Core's data under `%LOCALAPPDATA%\KAI`
 *   and the model resolver under `homedir()/.kai` — so a fresh install could not
 *   find `<KAI_HOME>/model/credentials.json` and the provider stayed "unconfigured"
 *   until a human set KAI_HOME and copied the file. The KAI_HOME tests below assert
 *   the one rule, and boot a real Core against a temp KAI_HOME with NO env var set
 *   to prove `<KAI_HOME>/model/credentials.json` is what configures KAI.
 *
 *   cd core && node --test tests/model-provider.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createKaiModelProvider,
  createOpenAICompatibleProvider,
  isOpencodeGateway,
  kaiSessionId,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
} from "../src/model/index.ts";
import { defaultKaiHome as modelDefaultKaiHome, resolveModelSettings } from "../src/model/config.ts";
import { defaultKaiHome as identityDefaultKaiHome } from "../src/agent/kai-home.ts";
import { createCoreRuntime } from "../src/runtime.ts";

const GATEWAY = "https://opencode.ai/zen/go/v1";

function tempRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `kai-model-${name}-`));
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A stub fetch that records exactly what the provider put on the wire. Headers are
 * lower-cased so an assertion cannot pass on casing alone.
 */
function captureFetch(reply: () => Response): { impl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const raw = init.headers ?? {};
    if (raw instanceof Headers) raw.forEach((value, key) => (headers[key.toLowerCase()] = value));
    else if (Array.isArray(raw)) for (const [key, value] of raw) headers[String(key).toLowerCase()] = String(value);
    else for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = String(value);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return reply();
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function completion(text: string, model = "deepseek-v4.1-flash"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// ── DEFECT 1 — the routing header ─────────────────────────────────────────────

test("opencode-go: the outgoing chat request carries x-opencode-session and the opencode user-agent", async () => {
  const { impl, calls } = captureFetch(() => completion("pong"));
  const provider = createOpenAICompatibleProvider({
    id: "opencode-go",
    baseUrl: GATEWAY,
    apiKey: "test-key",
    model: "deepseek-v4.1-flash",
    fetchImpl: impl,
  });

  const result = await provider.chat({ messages: [{ role: "user", content: "ping" }] });
  assert.equal(result.text, "pong");
  assert.equal(calls.length, 1, "one request reached the endpoint");
  assert.equal(calls[0].url, `${GATEWAY}/chat/completions`);

  // THE REGRESSION ASSERTION: the header the gateway requires is on the wire.
  const session = calls[0].headers[OPENCODE_SESSION_HEADER];
  assert.equal(typeof session, "string", `${OPENCODE_SESSION_HEADER} must be sent — this is what answers 400 MissingSessionID`);
  assert.ok((session as string).length > 0, "the routing id is not empty");
  assert.match(session as string, /^kai-[0-9a-f]{32}$/, "KAI owns the id and it is shaped as KAI's");
  assert.equal(calls[0].headers["user-agent"], OPENCODE_USER_AGENT);
  assert.equal(calls[0].headers["authorization"], "Bearer test-key", "the key still rides in the authorization header");
});

test("the routing id is STABLE: same id on every request and on every provider instance, never random per request", async () => {
  const first = captureFetch(() => completion("one"));
  const providerA = createOpenAICompatibleProvider({
    id: "opencode-go",
    baseUrl: GATEWAY,
    apiKey: "test-key",
    model: "deepseek-v4.1-flash",
    fetchImpl: first.impl,
  });
  await providerA.chat({ messages: [{ role: "user", content: "one" }] });
  await providerA.chat({ messages: [{ role: "user", content: "two" }] });
  assert.equal(first.calls.length, 2);
  assert.equal(
    first.calls[0].headers[OPENCODE_SESSION_HEADER],
    first.calls[1].headers[OPENCODE_SESSION_HEADER],
    "a random per-request id would lose the gateway's warm routing",
  );

  // A second provider (a new process installs a new one) resolves the same id,
  // because it is derived from this install rather than from a clock or a random.
  const second = captureFetch(() => completion("three"));
  const providerB = createOpenAICompatibleProvider({
    id: "opencode-go",
    baseUrl: GATEWAY,
    apiKey: "test-key",
    model: "deepseek-v4.1-flash",
    fetchImpl: second.impl,
  });
  await providerB.chat({ messages: [{ role: "user", content: "three" }] });
  assert.equal(
    second.calls[0].headers[OPENCODE_SESSION_HEADER],
    first.calls[0].headers[OPENCODE_SESSION_HEADER],
    "the id survives a new provider instance (a restart)",
  );
  assert.equal(kaiSessionId(), kaiSessionId(), "derivation is deterministic");
  assert.notEqual(kaiSessionId(), kaiSessionId("another-install"), "a deployment can pin its own id");
});

test("the streamed path carries the same routing header", async () => {
  const { impl, calls } = captureFetch(
    () =>
      new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const provider = createOpenAICompatibleProvider({
    id: "opencode-go",
    baseUrl: GATEWAY,
    apiKey: "test-key",
    model: "deepseek-v4.1-flash",
    fetchImpl: impl,
  });
  let text = "";
  for await (const chunk of provider.stream({ messages: [{ role: "user", content: "ping" }] })) {
    if (!chunk.done) text += chunk.delta;
  }
  assert.equal(text, "hi");
  assert.match(calls[0].headers[OPENCODE_SESSION_HEADER] ?? "", /^kai-[0-9a-f]{32}$/);
  assert.equal(calls[0].headers["user-agent"], OPENCODE_USER_AGENT);
});

test("a non-opencode OpenAI-compatible endpoint gets NO routing headers (the client stays provider-agnostic)", async () => {
  const { impl, calls } = captureFetch(() => completion("ok", "gpt-oss"));
  const provider = createOpenAICompatibleProvider({
    id: "local-llm",
    baseUrl: "https://llm.example.test/v1",
    apiKey: "test-key",
    model: "gpt-oss",
    fetchImpl: impl,
    // A caller with its own required header can still set it.
    headers: { "x-tenant": "kai" },
  });
  await provider.chat({ messages: [{ role: "user", content: "ping" }] });
  assert.equal(calls[0].headers[OPENCODE_SESSION_HEADER], undefined, "no gateway header leaks to a third-party endpoint");
  assert.equal(calls[0].headers["user-agent"], undefined);
  assert.equal(calls[0].headers["x-tenant"], "kai", "a caller-supplied header still lands");

  assert.equal(isOpencodeGateway(GATEWAY), true);
  assert.equal(isOpencodeGateway("https://opencode.ai"), true);
  assert.equal(isOpencodeGateway("https://llm.example.test/v1"), false);
  assert.equal(isOpencodeGateway("not a url"), false);
});

// ── DEFECT 2 — ONE KAI_HOME ───────────────────────────────────────────────────

test("KAI_HOME is resolved by ONE rule: the model resolver and the identity layer agree", () => {
  // Same function, not a second copy of the same rule: this is what makes the
  // credential root and the identity root impossible to drift apart again.
  assert.equal(modelDefaultKaiHome, identityDefaultKaiHome);

  // KAI_HOME (env) wins...
  assert.equal(identityDefaultKaiHome({ KAI_HOME: "  D:\\KAI_HOME  " } as NodeJS.ProcessEnv, "C:\\home"), join("D:\\KAI_HOME"));
  // ...then the Core's own data root on Windows — the same root the database lives in...
  assert.equal(
    identityDefaultKaiHome({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } as NodeJS.ProcessEnv, "C:\\home"),
    join("C:\\Users\\x\\AppData\\Local", "KAI"),
  );
  // ...and only then the dot-directory fallback.
  assert.equal(identityDefaultKaiHome({} as NodeJS.ProcessEnv, "C:\\home"), join("C:\\home", ".kai"));
  assert.equal(modelDefaultKaiHome({} as NodeJS.ProcessEnv, "C:\\home"), join("C:\\home", ".kai"));
});

test("the resolver reads <kaiHome>/model/credentials.json from the home it is GIVEN, and re-derives no default", () => {
  const root = tempRoot("resolver");
  try {
    mkdirSync(join(root, "model"), { recursive: true });
    writeFileSync(
      join(root, "model", "credentials.json"),
      JSON.stringify({ id: "opencode-go", baseUrl: "https://example.test/v1", apiKey: "kai-home-key", name: "deepseek-v4.1-flash" }),
      "utf8",
    );

    // An EMPTY environment: a resolver that re-derived `homedir()/.kai` would find
    // nothing here, so a configured result proves the passed home was the source.
    const resolved = resolveModelSettings({}, {} as NodeJS.ProcessEnv, root);
    assert.equal(resolved.apiKey, "kai-home-key");
    assert.equal(resolved.baseUrl, "https://example.test/v1");
    assert.equal(resolved.name, "deepseek-v4.1-flash");
    assert.equal(resolved.id, "opencode-go");

    // The file is only read from its ONE documented location: a copy elsewhere is
    // not consulted.
    const other = tempRoot("resolver-other");
    try {
      const elsewhere = resolveModelSettings({}, {} as NodeJS.ProcessEnv, other);
      assert.equal(elsewhere.apiKey, undefined, "no credential is invented for a home that has none");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh install: a real Core configured ONLY by <runtime KAI_HOME>/model/credentials.json, with no env var", async () => {
  const root = tempRoot("fresh-install");
  // The one thing a fresh install must not need. Everything else (LOCALAPPDATA,
  // the DB, the identity tree) is derived.
  const saved = {
    KAI_HOME: process.env.KAI_HOME,
    KAI_MODEL_API_KEY: process.env.KAI_MODEL_API_KEY,
    KAI_MODEL_URL: process.env.KAI_MODEL_URL,
    KAI_MODEL_NAME: process.env.KAI_MODEL_NAME,
    KAI_MODEL_ID: process.env.KAI_MODEL_ID,
  };
  delete process.env.KAI_HOME;
  delete process.env.KAI_MODEL_API_KEY;
  delete process.env.KAI_MODEL_URL;
  delete process.env.KAI_MODEL_NAME;
  delete process.env.KAI_MODEL_ID;

  let runtime: ReturnType<typeof createCoreRuntime> | undefined;
  try {
    mkdirSync(join(root, "model"), { recursive: true });
    writeFileSync(
      join(root, "model", "credentials.json"),
      JSON.stringify({ id: "opencode-go", baseUrl: GATEWAY, apiKey: "fresh-install-key", name: "deepseek-v4.1-flash" }),
      "utf8",
    );

    const { impl, calls } = captureFetch(() => completion("from KAI's own credential file"));
    runtime = createCoreRuntime({
      dbPath: join(root, "core", "kai-core.db"),
      agents: { mode: "mock" },
      startScheduler: false,
      // identityRoot IS a KAI_HOME: the same root the runtime hands to the model
      // resolver (the `?` this test exists for).
      subsystemPaths: { identityRoot: root, runUpkeepOnStart: false },
      model: { fetchImpl: impl },
    });

    // What GET /independence reports as `configured` (provider.capabilities().chat).
    const described = runtime.brain.describe();
    assert.equal(described.provider, "opencode-go");
    assert.equal(described.model, "deepseek-v4.1-flash");
    assert.equal(runtime.model.capabilities().chat, true, "the credential file under the runtime's KAI_HOME configured the provider");
    assert.equal(described.configured, true);

    // A real turn goes through the file's endpoint and key — proving WHICH file was read.
    const result = await runtime.brain.respond({ text: "hello", system: "you are KAI" });
    assert.equal(result.text, "from KAI's own credential file");
    assert.equal(calls[0].url, `${GATEWAY}/chat/completions`);
    assert.equal(calls[0].headers["authorization"], "Bearer fresh-install-key");
    assert.match(calls[0].headers[OPENCODE_SESSION_HEADER] ?? "", /^kai-[0-9a-f]{32}$/, "the routing header is sent on a real Core turn too");
  } finally {
    if (runtime !== undefined) await runtime.stop().catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("createKaiModelProvider hands the kaiHome through to the credential file", () => {
  const root = tempRoot("provider-home");
  try {
    mkdirSync(join(root, "model"), { recursive: true });
    writeFileSync(
      join(root, "model", "credentials.json"),
      JSON.stringify({ id: "opencode-go", baseUrl: GATEWAY, apiKey: "home-key", name: "deepseek-v4.1-flash" }),
      "utf8",
    );
    const withHome = createKaiModelProvider({}, { env: {} as NodeJS.ProcessEnv, kaiHome: root });
    assert.equal(withHome.capabilities().chat, true, "configured from the passed KAI_HOME");
    const withoutHome = createKaiModelProvider({}, { env: {} as NodeJS.ProcessEnv, kaiHome: join(root, "nope") });
    assert.equal(withoutHome.capabilities().chat, false, "and unconfigured when that home has no credential");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
