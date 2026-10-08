// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Content hashing — the whole basis of the exact-byte binding.
 *
 * A skill revision is content-addressed by the SHA-256 of the exact bytes on
 * disk. The same hash is what an approval binds to, so the bytes the human
 * approved and the bytes installed are provably the same when the hashes match.
 *
 * Strings are hashed as their UTF-8 bytes, which is exactly what writing them
 * with encoding "utf8" produces — so hashing a string and hashing the file it
 * was written to give the same digest.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
