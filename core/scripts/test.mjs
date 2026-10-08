#!/usr/bin/env node
/**
 * KAI Core test runner.
 *
 * Why this exists rather than a plain `node --test <glob>`:
 *
 * 1. Glob portability. `node --test tests/` is rejected by Node 26 (it treats the
 *    directory as a module specifier), and a glob like `tests/*.test.ts` is only
 *    expanded if the *shell* expands it — npm on Windows runs scripts through
 *    cmd.exe, which does not. So this script discovers the files itself.
 * 2. Live-auth suites. Some pre-existing suites talk to the real local agent
 *    servers and read the key from `API_SERVER_KEY` / `KAI_HERMES_KEY`. Without it
 *    they fail with an authorization error, which reads like a regression instead
 *    of a missing prerequisite. This runner loads the key from the Hermes install's
 *    `.env` when it is present — the same secret the app already uses — and never
 *    prints it. If the file is absent the suites are run anyway and their failures
 *    are honest rather than hidden.
 *
 * Usage:  node scripts/test.mjs [--with-dist]
 *   runs every *.test.ts under core/tests and core/src (straight from TypeScript)
 *   plus, with --with-dist, every compiled test under core/dist
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, match) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match(entry.name)) out.push(full);
  }
  return out.sort();
}

/** The key lives in the Hermes install, not in this repository. */
function loadApiKey() {
  if (process.env.API_SERVER_KEY || process.env.KAI_HERMES_KEY) return "already set";
  const candidates = [
    join(homedir(), ".hermes", ".env"),
    process.env.HERMES_HOME ? join(process.env.HERMES_HOME, ".env") : null,
  ].filter(Boolean);

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*API_SERVER_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) {
        process.env.API_SERVER_KEY = m[1].replace(/^["']|["']$/g, "");
        return `loaded from ${file}`;
      }
    }
  }
  return "not found (live-auth suites will fail with 401)";
}

const tsTests = [
  ...walk(join(CORE, "tests"), (n) => n.endsWith(".test.ts")),
  ...walk(join(CORE, "src"), (n) => n.endsWith(".test.ts")),
];
const distTests = process.argv.includes("--with-dist")
  ? walk(join(CORE, "dist"), (n) => n.endsWith(".test.js"))
  : [];

if (tsTests.length === 0 && distTests.length === 0) {
  console.error("no test files found");
  process.exit(1);
}

const files = [...tsTests, ...distTests];
console.log(`kai-core tests: ${tsTests.length} from TypeScript, ${distTests.length} from dist`);
console.log(`api key: ${loadApiKey()}`);
for (const f of files) console.log(`  ${relative(CORE, f)}`);
console.log("");

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  cwd: CORE,
  env: process.env,
});
process.exit(result.status ?? 1);
