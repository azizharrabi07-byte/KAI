// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The owner bridge contract, checked ACROSS the language boundary.
 *
 * `app/src/core/bridge.ts` calls a Tauri command that `app/src-tauri/src/owner_call.rs`
 * implements. Nothing at compile time connects the two: the command name and every
 * argument name are plain strings on the JS side and plain identifiers on the Rust
 * side, so a rename on either side breaks owner authorization at RUNTIME — in the
 * one path that must never silently fail.
 *
 * These tests read both sources and assert they agree. They are cheap, they need no
 * Tauri build, and they fail on exactly the mistake that would otherwise only show
 * up when a user clicks Approve in the real app.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUST = readFileSync(join(ROOT, "src-tauri", "src", "owner_call.rs"), "utf8");
const LIB = readFileSync(join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");
const BRIDGE = readFileSync(join(ROOT, "src", "core", "bridge.ts"), "utf8");

/** The arguments the TypeScript side sends for one command. */
function tsArgs(command: string): string[] {
  const start = BRIDGE.indexOf(`"${command}"`);
  assert.ok(start >= 0, `bridge.ts never calls ${command}`);
  const open = BRIDGE.indexOf("{", start);
  assert.ok(open >= 0, `${command}: no argument object`);
  // Walk to the matching brace so a nested object cannot truncate the slice.
  let depth = 0;
  let end = open;
  for (let i = open; i < BRIDGE.length; i += 1) {
    if (BRIDGE[i] === "{") depth += 1;
    else if (BRIDGE[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = BRIDGE.slice(open + 1, end);
  // Two shapes: `key: value` and the shorthand `{ key }` a conditional spread uses
  // (`...(cond ? { body } : {})`). Missing the second made this test report a
  // mismatch that was really a parser gap.
  const named = [...body.matchAll(/(?:^|[,{\s])([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)].map((m) => m[1] as string);
  // A bare key in a comma-separated list (`{ method, path, ...`), including inside
  // a conditional spread's shorthand object (`? { body } : {}`).
  const shorthand = [...body.matchAll(/(?:^|[,{\s])([a-zA-Z_][a-zA-Z0-9_]*)\s*(?=[,}])/g)].map((m) => m[1] as string);
  return [...named, ...shorthand];
}

/** The parameter names of the Rust command. */
function rustParams(command: string): string[] {
  const start = RUST.indexOf(`pub async fn ${command}(`);
  assert.ok(start >= 0, `owner_call.rs never defines ${command}`);
  const open = RUST.indexOf("(", start);
  const close = RUST.indexOf(")", open);
  const list = RUST.slice(open + 1, close);
  return list
    .split(",")
    .map((part) => part.split(":")[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

test("the owner bridge's command name and arguments agree across Rust and TypeScript", () => {
  const command = "core_owner_call";

  // The Rust command exists and is registered, or the call would 404 at runtime.
  assert.match(RUST, new RegExp(`pub async fn ${command}\\(`), "owner_call.rs must define the command");
  assert.match(
    LIB,
    new RegExp(`\\b${command}\\b`),
    "lib.rs must register the command in generate_handler, or the webview call fails at runtime",
  );

  const rust = rustParams(command).sort();
  const ts = [...new Set(tsArgs(command))].sort();

  assert.deepEqual(
    ts,
    rust,
    `bridge.ts sends {${ts.join(", ")}} but owner_call.rs takes (${rust.join(", ")}) — a rename on either side breaks owner authorization at runtime`,
  );
});

test("the owner bridge never accepts a URL, only a Core path", () => {
  // The Rust side is the enforcement point; this asserts the guard is still there
  // and still applied to the value the webview sends.
  assert.match(RUST, /fn is_core_path\(/, "the path guard must exist");
  assert.match(RUST, /!is_core_path\(&path\)/, "the guard must be applied to the incoming path");
  // A URL-shaped input must be rejected: a scheme, an authority, or a traversal.
  assert.match(RUST, /starts_with\("\/\/"\)/, "a protocol-relative URL must be refused");
  assert.match(RUST, /contains\(":\/\/"\)/, "a scheme must be refused");
  assert.match(RUST, /contains\("\.\."\)/, "a traversal must be refused");
});

test("the owner token is attached in Rust and never handed to JavaScript", () => {
  // The token comes from the OS credential store inside the command…
  assert.match(RUST, /secrets::host_token\(\)/, "the credential must be read in Rust");
  assert.match(RUST, /x-kai-host-token/, "the credential must be sent as the host-token header");
  // …and the bridge's declared return type carries only a status and a body.
  assert.match(
    BRIDGE,
    /coreOwnerCall:[\s\S]{0,400}call<\{ status: number; body: unknown \}>/,
    "the bridge must return only { status, body } — a token in the return value would land in the webview",
  );
  assert.ok(
    !/host_token|hostToken|KAI_HOST_TOKEN/.test(BRIDGE),
    "bridge.ts must never mention the credential: a token in JavaScript is a token in devtools",
  );
});

test("the frontend sends the credential-bearing calls through the bridge, not plain fetch", () => {
  const client = readFileSync(join(ROOT, "src", "core", "kai-core.ts"), "utf8");
  // Every owner-gated mutation the Core exposes must go through ownerRequest.
  for (const method of ["createGoal", "challengeGoal", "planGoal", "approvePlan", "rejectPlan", "setGoalState", "setDoer"]) {
    const start = client.indexOf(`async ${method}(`);
    assert.ok(start >= 0, `kai-core.ts must implement ${method}`);
    const body = client.slice(start, start + 600);
    assert.match(body, /ownerRequest\(/, `${method} must use ownerRequest so the Rust side attaches the credential`);
  }
  // Reads may stay on the plain request path.
  const listStart = client.indexOf("async listGoals(");
  assert.ok(listStart >= 0);
  assert.match(client.slice(listStart, listStart + 400), /await request\(/, "reads may use the plain request path");
});
