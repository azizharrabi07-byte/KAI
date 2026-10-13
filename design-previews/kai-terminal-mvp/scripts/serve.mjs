// SPDX-License-Identifier: MIT
// A zero-dependency static server for the prototype.
//
// No framework, no install step, no network: `node scripts/serve.mjs` and open
// the printed URL. That is what makes this preview independent enough to delete
// without touching the production app.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT ?? 5188);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const target = path === "/" ? "/index.html" : path;
  const file = join(ROOT, normalize(target).replace(/^(\.\.[/\\])+/, ""));
  // Containment: never serve outside the prototype directory.
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`KAI terminal MVP (DEMO) → http://127.0.0.1:${PORT}`);
});
