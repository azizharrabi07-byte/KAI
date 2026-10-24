// The Hermes key is resolved in ONE place, and the resolution is what makes a
// hand-started Core able to talk: `loadConfig()` sees only the environment, so
// without this fallback the chat relay sent no Authorization header at all while the
// agent adapter (which did fall back) ran worker tasks fine — same Core, same server,
// two answers to "do we have a key?".
//
//   cd core && node --test tests/hermes-key.test.ts
//
// Every case passes its own `env` and `home`, so the suite never reads (or depends on)
// this machine's real `~/.hermes/.env` and never prints a key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHermesKey, withResolvedHermesKey } from "../src/agents/hermes-key.ts";
import { loadConfig } from "../src/config.ts";

/** A throwaway home directory; the caller removes it. */
function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "kai-hermes-key-"));
  return {
    home,
    cleanup: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // A leftover temp directory is not a test failure.
      }
    },
  };
}

/** Writes `<home>/.hermes/.env` with the given lines. */
function writeHermesEnv(home: string, lines: string[]): void {
  const dir = join(home, ".hermes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), `${lines.join("\n")}\n`, "utf8");
}

test("the caller's key wins over both the environment and the file", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["API_SERVER_KEY=from-the-file"]);

  assert.equal(
    resolveHermesKey("from-the-app", { KAI_HERMES_KEY: "from-env", API_SERVER_KEY: "also-env" }, home),
    "from-the-app",
  );
});

test("KAI_HERMES_KEY beats API_SERVER_KEY in the environment", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);

  assert.equal(resolveHermesKey(undefined, { KAI_HERMES_KEY: "preferred", API_SERVER_KEY: "other" }, home), "preferred");
  assert.equal(resolveHermesKey(undefined, { API_SERVER_KEY: "only-one" }, home), "only-one");
});

test("an empty environment still resolves the key from ~/.hermes/.env", (t) => {
  // THE regression. Without this the chat relay has no key and every /chat turn fails
  // with a 401 that reads exactly like a rejected credential.
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["# a comment", "SOMETHING_ELSE=1", "API_SERVER_KEY=resolved-from-the-install"]);

  assert.equal(resolveHermesKey(undefined, {}, home), "resolved-from-the-install");
});

test("quotes around the value are stripped", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, [`API_SERVER_KEY="quoted-secret"`]);

  assert.equal(resolveHermesKey(undefined, {}, home), "quoted-secret");
});

test("no key anywhere resolves to undefined, and never throws", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);

  assert.equal(resolveHermesKey(undefined, {}, home), undefined, "no file, no env");
  writeHermesEnv(home, ["SOMETHING_ELSE=1"]);
  assert.equal(resolveHermesKey(undefined, {}, home), undefined, "a file without the key");
  assert.equal(resolveHermesKey("", {}, home), undefined, "an empty explicit key is not a key");
});

test("withResolvedHermesKey fills a missing key and never replaces a present one", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["API_SERVER_KEY=from-the-install"]);

  // What a terminal-started Core looks like: the environment has no key at all.
  const bare = loadConfig({});
  assert.equal(bare.hermes.apiKey, undefined, "the fixture must start with no key");
  const filled = withResolvedHermesKey(bare, {}, home);
  assert.equal(filled.hermes.apiKey, "from-the-install");
  assert.equal(filled.hermes.baseUrl, bare.hermes.baseUrl, "nothing else in the config moves");

  // What the desktop-app-spawned Core looks like: the app passed its own key. The
  // install's file must never override it.
  const appSpawned = loadConfig({ KAI_HERMES_KEY: "from-the-app" });
  const untouched = withResolvedHermesKey(appSpawned, {}, home);
  assert.equal(untouched.hermes.apiKey, "from-the-app");

  // Nothing anywhere: the config is returned as-is rather than guessing.
  const empty = tempHome();
  t.after(empty.cleanup);
  const nothing = withResolvedHermesKey(loadConfig({}), {}, empty.home);
  assert.equal(nothing.hermes.apiKey, undefined);
});

// -- A targeted profile --------------------------------------------------------
//
// The profile is where the worker's hooks live. Targeting `/p/<profile>` while reading
// the DEFAULT profile's key (or the reverse) is the mismatch that makes a boundary look
// installed but never fire, so both halves are pinned here.

/** Writes `<home>/.hermes/profiles/<name>/.env` with the given lines. */
function writeProfileEnv(home: string, name: string, lines: string[]): void {
  const dir = join(home, ".hermes", "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), `${lines.join("\n")}\n`, "utf8");
}

test("a targeted profile's own key is used, not the default profile's", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["API_SERVER_KEY=default-profile-key"]);
  writeProfileEnv(home, "kai", ["API_SERVER_KEY=profile-key"]);

  assert.equal(resolveHermesKey(undefined, {}, home, "kai"), "profile-key");
});

test("KAI_HERMES_PROFILE selects the profile when no argument is passed", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["API_SERVER_KEY=default-profile-key"]);
  writeProfileEnv(home, "kai", ["API_SERVER_KEY=profile-key"]);

  assert.equal(resolveHermesKey(undefined, { KAI_HERMES_PROFILE: "kai" }, home), "profile-key");
});

test("the environment still wins over a profile file", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeProfileEnv(home, "kai", ["API_SERVER_KEY=profile-key"]);

  assert.equal(
    resolveHermesKey(undefined, { KAI_HERMES_KEY: "from-env", KAI_HERMES_PROFILE: "kai" }, home),
    "from-env",
  );
});

test("a profile with no key falls back to the install's env file", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["API_SERVER_KEY=default-profile-key"]);
  writeProfileEnv(home, "kai", ["SOMETHING_ELSE=1"]);

  assert.equal(resolveHermesKey(undefined, {}, home, "kai"), "default-profile-key");
});

test("a profile name that could escape profiles/ is refused, never followed", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["API_SERVER_KEY=default-profile-key"]);

  // If the traversal were honoured this would resolve a key from OUTSIDE profiles/.
  mkdirSync(join(home, ".hermes", "profiles"), { recursive: true });
  writeFileSync(join(home, "escaped.env"), "API_SERVER_KEY=escaped-key\n", "utf8");
  assert.equal(resolveHermesKey(undefined, { KAI_HERMES_PROFILE: "../escaped" }, home), "default-profile-key");
});

test("withResolvedHermesKey reads the key the targeted profile's route expects", (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  writeHermesEnv(home, ["API_SERVER_KEY=default-profile-key"]);
  writeProfileEnv(home, "kai", ["API_SERVER_KEY=profile-key"]);

  const config = withResolvedHermesKey(loadConfig({ KAI_HERMES_PROFILE: "kai" }), {}, home);
  assert.equal(config.hermes.profile, "kai");
  assert.equal(config.hermes.baseUrl, "http://127.0.0.1:8642/p/kai");
  assert.equal(config.hermes.apiKey, "profile-key");
});

test("a profile OWNS the route, even over an explicit base URL", () => {
  // This used to assert the opposite, and that assertion encoded a real defect: the URL
  // stayed on the default route while `resolveHermesKey` took the PROFILE key, so the
  // profile's credential was presented to the wrong route and the gateway answered 401
  // (`AGENT_AUTH_FAILED` on /v1/runs). Measured directly: the install key is 202 on
  // /v1/runs; the profile key is 202 only on /p/kai/v1/runs. The URL and the credential
  // must therefore always describe the same route.
  const config = loadConfig({ KAI_HERMES_PROFILE: "kai", KAI_HERMES_URL: "http://127.0.0.1:9000/worker" });
  assert.equal(config.hermes.baseUrl, "http://127.0.0.1:9000/worker/p/kai");
  assert.equal(config.hermes.profile, "kai");
});

test("an already profile-routed base URL is not routed twice", () => {
  const config = loadConfig({ KAI_HERMES_PROFILE: "kai", KAI_HERMES_URL: "http://127.0.0.1:8642/p/kai" });
  assert.equal(config.hermes.baseUrl, "http://127.0.0.1:8642/p/kai");
});

test("no profile leaves the default URL and profile untouched", () => {
  const config = loadConfig({});
  assert.equal(config.hermes.baseUrl, "http://127.0.0.1:8642");
  assert.equal(config.hermes.profile, undefined);
});

test("an unusable profile name is absent, not silently a different profile", () => {
  const config = loadConfig({ KAI_HERMES_PROFILE: "../kai" });
  assert.equal(config.hermes.profile, undefined);
  assert.equal(config.hermes.baseUrl, "http://127.0.0.1:8642");
});
