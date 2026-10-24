// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).
//
// stamp-core-expectation.mjs — bind this KAI2 release to the Core build it expects.
//
// ── Why a script and not a hand-typed version
// A hand-typed expectation drifts. This reads the Core's OWN build stamp and records it,
// so "which Core does KAI2 expect?" has exactly one answer derived from the artifact
// itself — the same principle Core's own build-info.mjs follows (the id is a hash of the
// SOURCE, so `dist/` and `bundle/` built from one source share one id).
//
// ── Usage
//   node scripts/stamp-core-expectation.mjs <core-artifact-dir>
//   node scripts/stamp-core-expectation.mjs <core-artifact-dir> --mode track
//
// <core-artifact-dir> is a directory CONTAINING `build-info.json` — e.g.
//   C:\tmp\kai-exec\app\target\release\core
//   C:\tmp\kai-exec\core\bundle
//   C:\tmp\kai-exec\core\dist
//
// The written file is `desktop/core-expected.json`, read at runtime by
// `desktop/core-compat.js`. It records the expectation; it does NOT launch a Core.
//
// `--mode track` records a development expectation: any Core whose build identity is
// *verifiable* is accepted (a deliberately generated dev build is not rejected), and the
// UI still names the build it is talking to rather than staying silent.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith("--"));
const mode = args.includes("--mode")
  ? args[args.indexOf("--mode") + 1] === "track"
    ? "track"
    : "pinned"
  : "pinned";

if (!target) {
  console.error("usage: node scripts/stamp-core-expectation.mjs <core-artifact-dir> [--mode track|pinned]");
  console.error("  <core-artifact-dir> must contain build-info.json");
  process.exit(2);
}

// Accept either the artifact directory or the build-info.json path itself.
const stampedFrom = target.endsWith("build-info.json")
  ? resolve(target)
  : resolve(join(target, "build-info.json"));

let info;
try {
  info = JSON.parse(readFileSync(stampedFrom, "utf8"));
} catch (err) {
  console.error("cannot read a Core build stamp at: " + stampedFrom);
  console.error(String(err && err.message ? err.message : err));
  console.error("");
  console.error("Build the Core first (`npm run build` or `npm run bundle` in the Core repo),");
  console.error("then point this at the directory holding its build-info.json.");
  process.exit(1);
}

// Refuse to write a half-known expectation. "unknown" is a real value a Core can report,
// but it is not something KAI2 can pin to — pinning to it would defeat the check.
const buildId = typeof info.buildId === "string" ? info.buildId.trim() : "";
if (!buildId || buildId.toLowerCase() === "unknown") {
  console.error("the Core build stamp has no usable buildId (got " + JSON.stringify(info.buildId) + ")");
  console.error("a run straight from source has no build identity to pin to; build the Core first.");
  process.exit(1);
}

const protocolVersion = typeof info.protocolVersion === "number" ? info.protocolVersion : null;
if (protocolVersion === null) {
  console.error("the Core build stamp has no protocolVersion — refusing to write an expectation that cannot enforce one");
  process.exit(1);
}

const out = {
  service: "kai-core",
  mode,
  coreBuildId: buildId,
  protocolVersion,
  gitCommit: typeof info.gitCommit === "string" ? info.gitCommit : null,
  stampedAt: new Date().toISOString(),
  stampedFrom,
  note:
    mode === "track"
      ? "Development expectation: any Core with a verifiable build identity is accepted, and KAI2 still names the build it is talking to. Regenerate with `npm run stamp:core -- <dir> --mode track`."
      : "The Core build this KAI2 release expects. Regenerate with `npm run stamp:core -- <core-artifact-dir>` whenever the Core is rebuilt; a mismatch is refused rather than silently accepted. This file records WHICH Core KAI2 expects, it does not launch or supervise one.",
};

const outPath = join(appRoot, "desktop", "core-expected.json");
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log("stamped KAI2 -> Core expectation");
console.log("  mode            " + mode);
console.log("  coreBuildId     " + buildId);
console.log("  protocolVersion " + protocolVersion);
console.log("  gitCommit       " + (out.gitCommit || "(none)"));
console.log("  from            " + stampedFrom);
console.log("  written to      " + outPath);
