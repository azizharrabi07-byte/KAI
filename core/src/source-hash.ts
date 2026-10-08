// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * The ONE source-derived build id.
 *
 * This is a SHA-256 over the SOURCE tree (`core/src/**` plus the configs that
 * shape the build), not over a compiled directory. It lives here, in `src/`, so
 * that BOTH sides of the source-vs-artifact comparison use the identical
 * algorithm:
 *
 *   * `scripts/build-info.mjs` RECOMPUTES it while stamping an artifact, and
 *   * the running Core RECOMPUTES it at boot from the `core/src` beside it.
 *
 * If the two lived in separate files the hash could drift and the comparison
 * would be worthless — the exact "source != artifact, and nothing noticed"
 * failure this whole mechanism exists to make impossible. There is deliberately
 * no second implementation.
 *
 * Hashing the source (rather than the emitted output) is also what lets `dist/`
 * and `bundle/` — two artifacts of one source — be compared to each other: the
 * same source yields the same id for both.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Every file under `dir`, recursively, or an empty list when it is absent. */
function filesUnder(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Recompute the source-derived build id for the Core rooted at `coreDir`.
 *
 * Deterministic: the same source always returns the same id, and any edit to a
 * source file, `package.json` or `tsconfig.json` changes it. Paths are
 * normalised to forward slashes so a Windows and a POSIX checkout of the same
 * source agree.
 */
export function computeSourceBuildId(coreDir: string): string {
  const inputs = [
    ...filesUnder(join(coreDir, "src")),
    join(coreDir, "package.json"),
    join(coreDir, "tsconfig.json"),
  ].filter((path) => existsSync(path) && statSync(path).isFile());

  inputs.sort();
  const hash = createHash("sha256");
  for (const file of inputs) {
    hash.update(relative(coreDir, file).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}
