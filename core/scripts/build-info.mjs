// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).
//
// Stamp a build identity, so "which Core is answering?" has a deterministic answer.
//
// The id is a SHA-256 over the SOURCE tree (core/src/**.ts plus the configs that
// shape the build), not over a compiled directory. That choice is deliberate:
//
//   * dist/ and bundle/ are TWO artifacts emitted from one source (the bundle leaves
//     the tests out). Hashing the emitted output would give them different ids, so
//     "does the shipped Core match the reviewed build?" could never be answered by
//     comparing them.
//   * Hashing the source means the id changes when the CODE changes, and only then.
//     Not a timestamp: identical source must give an identical id, and any edit must
//     give a different one.
//
// THE ALGORITHM IS NOT DEFINED HERE. It lives in `src/source-hash.ts` and is
// imported from there, so this build stamp and the running Core's boot self-check
// compute the SAME id with the SAME code. A second copy of the hash in this script
// is exactly how "the stamp says one build, the running source is another, and
// nothing noticed" happens — so there is only one implementation, and this script
// is a caller of it.
//
// The stamp is written next to whichever compiled output exists, so both dist and
// bundle report the same build. `npm run build` and `npm run bundle` each call this.
//
// Node runs this file directly and strips the types from the imported `.ts` — the
// same mechanism `npm test` already relies on to run the TypeScript suites.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { computeSourceBuildId } from "../src/source-hash.ts";

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "..");

// The id is a content hash of the CURRENT source tree, computed by the ONE shared
// implementation. No local hashing code may live here.
const sourceBuildId = computeSourceBuildId(core);
const buildId = sourceBuildId;

let gitCommit = "unknown";
try {
  gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: core, encoding: "utf8" }).trim();
} catch {
  // Not a checkout, or git is unavailable. "unknown" is the honest answer.
}

const pkg = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
// The protocol version has ONE source of truth: the compiled identity module when
// present, otherwise the source it is compiled from.
let protocolVersion = 1;
for (const candidate of [join(core, "dist", "identity.js"), join(core, "bundle", "identity.js")]) {
  if (!existsSync(candidate)) continue;
  const mod = await import(pathToFileURL(candidate).href);
  if (typeof mod.PROTOCOL_VERSION === "number") protocolVersion = mod.PROTOCOL_VERSION;
  break;
}

const info = {
  service: "kai-core",
  coreVersion: pkg.version,
  buildId,
  gitCommit,
  protocolVersion,
  // The same value as buildId, under an explicit name: this id IS a hash of the
  // SOURCE tree, and saying so in the stamp keeps that readable without the code.
  sourceBuildId,
};

// ONLY the directories this run can actually vouch for. `npm run build` compiles
// dist/ and does NOT touch bundle/, so stamping bundle/ there would leave a stamp
// describing code the directory does not contain - which is exactly how a stale
// Control plane once served a port while claiming to be the build under review.
// `npm run bundle` recompiles bundle/ and stamps it itself.
const targetsArg = process.argv.find((a) => a.startsWith("--targets="));
const targets = (targetsArg === undefined ? "dist" : targetsArg.slice("--targets=".length))
  .split(",")
  .map((d) => d.trim())
  .filter((d) => d === "dist" || d === "bundle");

const written = [];
for (const dir of targets) {
  const target = join(core, dir);
  if (!existsSync(target)) continue;
  writeFileSync(join(target, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  written.push(dir);
}

console.log(
  `[kai-core] stamped build ${buildId} commit ${gitCommit.slice(0, 8)} protocol ${protocolVersion}` +
    ` -> ${written.join(", ") || "nothing (no compiled output found)"}`,
);
