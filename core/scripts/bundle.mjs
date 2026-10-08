#!/usr/bin/env node
/**
 * Build the Core for shipping, into `core/bundle/`.
 *
 * Two things `tsc` alone does not do:
 *
 * 1. **Leave the tests out.** An installed app has no business carrying compiled
 *    test files. They were also actively harmful: with the bundle staged inside the
 *    app's build output, `node --test` in `app/` discovered them and reported the
 *    Core's live tests as app failures.
 * 2. **Write the `package.json` that makes the output ESM.** The sources are
 *    TypeScript modules and the compiled output is ESM, which Node decides from the
 *    nearest `package.json` — `"type": "module"`. In the repository that is
 *    `core/package.json`. In an installed app the resource lands beside `kai.exe`,
 *    where there is no package.json at all, so every `import` would be read as
 *    CommonJS and the Core would die on its first line. The file this script writes
 *    is what makes the same code run from either place.
 *
 * The Hermes key is never involved: the Core resolves it at runtime.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(CORE, "bundle");

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

// The local compiler, run through node: a `.cmd` shim is not spawnable without a
// shell on Windows, and shell:true would put the paths back in cmd's hands.
const tsc = join(CORE, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.error(`bundle: no TypeScript compiler at ${tsc} — run npm install in core/`);
  process.exit(1);
}

const compiled = spawnSync(process.execPath, [tsc, "-p", "tsconfig.bundle.json"], {
  cwd: CORE,
  stdio: "inherit",
});
if (compiled.error) {
  console.error(`bundle: could not run tsc: ${compiled.error.message}`);
  process.exit(1);
}
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

if (!existsSync(join(OUT, "server.js"))) {
  console.error("bundle: server.js was not emitted");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, "package.json"),
  `${JSON.stringify({ name: "@kai/core-bundle", private: true, type: "module", main: "server.js" }, null, 2)}\n`,
);
// Stamp the identity INTO THE SHIPPED ARTIFACT. Without this the bundled Core
// reports buildId "unknown", and "is the running Core the reviewed build?" — the
// question that cost a whole verification cycle — has no answer.
const stamped = spawnSync(process.execPath, [join(CORE, "scripts", "build-info.mjs"), "--targets=bundle"], { stdio: "inherit" });
if (stamped.status !== 0) {
  console.error("bundle: could not stamp build identity");
  process.exit(1);
}

// Ship the curated skill library beside the compiled Core, so the bundled
// Core seeds identically to a source checkout: every `*.md` in
// `core/skills-library/` (skills plus SOURCES.md provenance) lands in
// `<bundle>/skills-library/`, where `libraryDir()` resolves it from the
// `bundle/skills/` module layout.
{
  const src = join(CORE, "skills-library");
  const dest = join(OUT, "skills-library");
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(src).filter((entry) => entry.endsWith(".md")).sort()) {
    copyFileSync(join(src, file), join(dest, file));
  }
}

console.log("bundle: core/bundle/server.js is ready to run with `node`");
