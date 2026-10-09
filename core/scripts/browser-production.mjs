#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Production-path browser harness: the REAL main window (built app shell) against
 * a REAL isolated Core (temp DB, mock workers, SCRIPTED model) over REAL SSE —
 * no route-interception buffering, the page talks to the test Core directly via
 * window.__KAI_CORE_BASE_URL__.
 *
 *   A. format answer -> rich .kai-md elements in the MAIN window (h1/ul/code/table/quote/link)
 *   B. tool with delayed result -> running card BEFORE completion, real .tout body after
 *   C. sequential tools -> tool1, result, tool2, result, answer — in DOM order
 *   D. long command -> running, live chunks, exit stamped last (via real shell.run)
 *   E. scroll up mid-run -> no yank; Jump-to-latest appears and works
 *   F. 1200-chunk flood -> bounded DOM, measured event-to-render latency
 *   G. Stop mid-stream -> aborted UI state, task CANCELLED in-process, no failure card
 *   (H-J workers: scripts/worker-honesty.mjs. K-L memory: tests/memory-scope.test.ts.
 *    M-O gate/resume: tests/orch-gate-authority.test.ts + scripts/orch-e2e.mjs.)
 *
 * Writes docs/evidence/browser-production.json + docs/evidence/browser-shots/prod-*.png.
 * Exits non-zero on failure. Run from `core/`: node scripts/browser-production.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createRequire } from "node:module";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIST = join(CORE, "..", "app", "dist");
const EVIDENCE = join(CORE, "..", "docs", "evidence");
const SHOTS = join(EVIDENCE, "browser-shots");

const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const REPRO_PORT = 8789;
const STATIC_PORT = 1422;
const CORE_URL = `http://127.0.0.1:${REPRO_PORT}`;

const dir = mkdtempSync(join(tmpdir(), "kai-browser-prod-"));
const stage = join(dir, "workspace");
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "auth-flow.txt"), "login calls refreshTokens() without a lock; concurrent refresh duplicates sessions; the lighthouse keeper signs every rotation\n", "utf8");
writeFileSync(join(stage, "loader.txt"), "loader drops tool records on reload when history exceeds 200 turns\n", "utf8");
process.env.KAI_WORKSPACE_ROOT = stage;

const evidence = { at: new Date().toISOString(), scenarios: {}, perf: {} };
const failures = [];
const check = (name, cond, detail) => {
  evidence.scenarios[name] = { pass: !!cond, detail: detail ?? null };
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

let rt = null;
let server = null;
let staticServer = null;
let browser = null;
let eventsAbort = null;

async function shutdown() {
  try { eventsAbort?.abort(); } catch { /* tap may not exist yet */ }
  if (browser) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
  if (staticServer) await new Promise((r) => staticServer.close(() => r()));
  if (server) await new Promise((r) => server.close(() => r()));
  if (rt) await rt.stop();
}

// ── Scripted model ──────────────────────────────────────────────────────────

const FORMAT_MD = [
  "# Lighthouse report",
  "",
  "## Findings",
  "",
  "- keeper signs every rotation",
  "- [x] lock added around refresh",
  "- [ ] loader keeps 200-turn history",
  "",
  "| area | risk |",
  "|---|---|",
  "| auth | high |",
  "| loader | medium |",
  "",
  "> quoted keeper log line",
  "",
  "Run the check:",
  "",
  "```sh",
  "grep -r lighthouse .",
  "```",
  "",
  "Math: inline $x^2$ stays inline.",
  "",
  "See [the docs](https://example.com/keeper) for the rotation policy.",
].join("\n");

const lastUser = (messages) => {
  const users = (messages ?? []).filter((m) => m.role === "user");
  return users.length > 0 ? String(users[users.length - 1].content ?? "") : "";
};
const toolResults = (messages) => (messages ?? []).filter((m) => m.role === "tool");
const SEARCH_ARGS = () => JSON.stringify({ query: "lighthouse", path: stage });

function scriptedFetch() {
  const sseFrames = (parts, gapMs = 60) => parts;
  const sse = (textParts, toolCallParts = []) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = async (obj, gap) => {
            await new Promise((r) => setTimeout(r, gap));
            controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
          };
          for (const part of textParts) {
            await send({ choices: [{ index: 0, delta: { content: part } }] }, 60);
          }
          for (const tc of toolCallParts) {
            await send({ choices: [{ index: 0, delta: tc }] }, 60);
          }
          await send({ choices: [{ index: 0, delta: {}, finish_reason: toolCallParts.length > 0 ? "tool_calls" : "stop" }] }, 30);
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const completion = (text, toolCalls) =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-prod", model: "prod-model",
        choices: [{ index: 0, message: { role: "assistant", content: text, ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls !== undefined ? "tool_calls" : "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const chunkText = (text, n = 14) => {
    const out = [];
    const step = Math.max(1, Math.ceil(text.length / n));
    for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
    return out;
  };
  return async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const path = String(url).split("/v1")[1] ?? String(url);
    if (path.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "prod-model" }] }), { status: 200 });
    }
    const messages = body.messages ?? [];
    const text = lastUser(messages);
    const results = toolResults(messages);
    const stream = body.stream === true;
    // Two-tool journey: search -> read -> answer. Rounds are counted by tool
    // RESULTS present, never by sniffing result content (content sniffing once
    // let the script claim "both tools ran" after one — the exact false-
    // completion class the timeline exists to expose).
    if (text.includes("two tools")) {
      if (results.length === 0) {
        const tc = [{ index: 0, id: "call_prod_1", function: { name: "filesystem_search", arguments: SEARCH_ARGS() } }];
        if (stream) return sse([], [{ tool_calls: tc }]);
        return completion("", [{ id: "call_prod_1", type: "function", function: { name: "filesystem_search", arguments: SEARCH_ARGS() } }]);
      }
      if (results.length === 1) {
        const args = JSON.stringify({ path: join(stage, "auth-flow.txt") });
        const tc = [{ index: 0, id: "call_prod_2", function: { name: "filesystem_read", arguments: args } }];
        if (stream) return sse([], [{ tool_calls: tc }]);
        return completion("", [{ id: "call_prod_2", type: "function", function: { name: "filesystem_read", arguments: args } }]);
      }
      const done = "Both tools ran. The keeper signs every rotation — verified in the file.";
      if (stream) return sse(chunkText(done, 6));
      return completion(done);
    }
    const hasSearchResult = results.length > 0;
    // Single search journey.
    if (text.includes("search files") && !hasSearchResult) {
      const tc = [{ index: 0, id: "call_prod_1", function: { name: "filesystem_search", arguments: SEARCH_ARGS() } }];
      if (stream) return sse([], [{ tool_calls: tc }]);
      return completion("", [{ id: "call_prod_1", type: "function", function: { name: "filesystem_search", arguments: SEARCH_ARGS() } }]);
    }
    if (text.includes("search files") && hasSearchResult) {
      const done = "Search complete — the tool card above carries the real matches.";
      if (stream) return sse(chunkText(done, 6));
      return completion(done);
    }
    // Slow journey for the Stop test: many small deltas.
    if (text.includes("slow report")) {
      const done = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the slow report. `).join("");
      if (stream) return sse(chunkText(done, 40), []);
      return completion(done);
    }
    // Default: the format showcase.
    if (stream) return sse(chunkText(FORMAT_MD, 14));
    return completion(FORMAT_MD);
  };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveDist(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = join(APP_DIST, urlPath === "/" ? "shell.html" : urlPath.slice(1));
    if (!existsSync(file)) file = join(APP_DIST, "shell.html");
    try {
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end("nope");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendMessage(page, text) {
  await page.fill("#kp-in", text);
  await page.click(".go");
}

async function waitQuiet(page, ms = 1500) {
  // networkidle never settles (open SSE by design): wait for a quiet beat
  // after the scenario's own waitForSelector/waitForFunction instead.
  await sleep(ms);
}

try {
  if (!existsSync(join(APP_DIST, "shell.html"))) throw new Error("app/dist/shell.html missing — run vite build first");
  mkdirSync(SHOTS, { recursive: true });

  console.log("prod: booting core");
  rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    model: { fetchImpl: scriptedFetch() },
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  const taskMoves = [];
  const origMove = rt.tasks.move.bind(rt.tasks);
  rt.tasks.move = (id, state) => {
    taskMoves.push({ id, state, at: new Date().toISOString() });
    return origMove(id, state);
  };

  const kaiServer = createKaiServer(
    loadConfig({
      ...process.env,
      KAI_CORE_PORT: String(REPRO_PORT),
      KAI_CORE_ALLOWED_ORIGINS: `http://127.0.0.1:${STATIC_PORT},http://localhost:${STATIC_PORT}`,
    }),
    { core: rt },
  );
  await new Promise((resolve, reject) => {
    kaiServer.once("error", reject);
    kaiServer.listen(REPRO_PORT, "127.0.0.1", () => resolve());
  });
  server = kaiServer;
  staticServer = await serveDist(STATIC_PORT);

  console.log("prod: launching browser");
  const require = createRequire(join(CORE, "..", "app", "package.json"));
  const { chromium } = require("playwright-core");
  const pwRoot = join(process.env.USERPROFILE ?? "", "AppData", "Local", "ms-playwright");
  const exeCandidates = [
    join(pwRoot, "chromium-1243", "chrome-win64", "chrome.exe"),
    join(pwRoot, "chromium_headless_shell-1243", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  const executablePath = exeCandidates.find((p) => existsSync(p));
  if (!executablePath) throw new Error("no chromium found");
  console.log(`prod: browser at ${executablePath}`);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (err) => console.log("pageerror:", String(err).slice(0, 240)));
  const seenUrls = new Set();
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/core/events") || url.includes("/chat/stream")) {
      const key = `${req.method()} ${url}`;
      if (!seenUrls.has(key)) {
        seenUrls.add(key);
        console.log(`prod: page requested ${key}`);
      }
    }
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.text().includes("[kai-diag]")) {
      console.log(`console.${msg.type()}:`, msg.text().slice(0, 300));
    }
  });
  await page.addInitScript((url) => {
    window.__KAI_CORE_BASE_URL__ = url;
  }, CORE_URL);
  // networkidle never settles: the app holds Core SSE streams open by design.
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/shell.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#kp-in", { timeout: 20000 });

  // ── A. rich format in the MAIN window ─────────────────────────────────────
  await sendMessage(page, "format showcase");
  await page.waitForSelector(".kai-md h1", { timeout: 30000 });
  await waitQuiet(page);
  const md = await page.evaluate(() => {
    const host = document.querySelector(".thread .kai-md");
    if (!host) {
      const thread = document.querySelector(".thread .col");
      return {
        nullHost: true,
        children: thread ? [...thread.children].map((n) => `${n.tagName}.${(n.className ?? "").toString().slice(0, 40)}:${(n.textContent ?? "").slice(0, 80)}`) : [],
      };
    }
    return {
      h1: host.querySelectorAll("h1.md-h, h1").length,
      h2: host.querySelectorAll("h2").length,
      ul: host.querySelectorAll("ul").length,
      task: host.querySelectorAll("li.md-task").length,
      code: host.querySelectorAll(".md-code pre code").length,
      table: host.querySelectorAll("table").length,
      quote: host.querySelectorAll("blockquote").length,
      link: host.querySelectorAll('a[href="https://example.com/keeper"]').length,
      scriptTags: host.querySelectorAll("script").length,
    };
  });
  check("A headings/lists/code/table/quote/link render richly", md !== null && !md.nullHost && md.h1 >= 1 && md.h2 >= 1 && md.ul >= 1 && md.task >= 2 && md.code >= 1 && md.table >= 1 && md.quote >= 1 && md.link >= 1, JSON.stringify(md)?.slice(0, 600));
  check("A no script tags in rendered answer", md !== null && !md.nullHost && md.scriptTags === 0, JSON.stringify(md)?.slice(0, 300));
  // Server-side truth for the missing-answer diagnosis: every session + task moves.
  try {
    const sessions = rt.sessions.list({ limit: 20 });
    for (const s of sessions) {
      const turnsRes = await (await fetch(`${CORE_URL}/sessions/${encodeURIComponent(s.id)}/turns?limit=10`)).json();
      const turns = turnsRes?.turns ?? [];
      console.log(`prod: server session ${s.id} holds ${turns.length} turns: ${JSON.stringify(turns.map((t) => ({ role: t.role, len: (t.text ?? "").length })))}`);
    }
    if (sessions.length === 0) console.log("prod: server has NO sessions after scenario A");
    console.log(`prod: task moves so far: ${JSON.stringify(taskMoves.map((m) => m.state))}`);
  } catch (e) {
    console.log(`prod: server turn inspection failed: ${String(e).slice(0, 160)}`);
  }
  await page.screenshot({ path: join(SHOTS, "prod-a-format.png") });

  // ── B. tool card: running first, real body after ──────────────────────────
  await sendMessage(page, "search files please");
  await page.waitForSelector("details.tc", { timeout: 30000 });
  await waitQuiet(page);
  const cardB = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".thread details.tc")];
    const last = cards[cards.length - 1];
    if (!last) return null;
    const body = last.querySelector(".tout");
    return {
      cards: cards.length,
      all: cards.map((c) => (c.querySelector("summary")?.textContent ?? "").slice(0, 90)),
      summary: last.querySelector("summary")?.textContent?.slice(0, 120) ?? "",
      hasBody: body !== null,
      bodyText: (body?.textContent ?? "").slice(0, 300),
    };
  });
  check("B tool card carries a real result body", cardB !== null && cardB.hasBody === true && /auth-flow|lighthouse/i.test(cardB.bodyText), JSON.stringify(cardB)?.slice(0, 300));

  // ── C. sequential tools in DOM order ──────────────────────────────────────
  await sendMessage(page, "two tools please");
  await page.waitForFunction(() => document.querySelectorAll(".thread details.tc").length >= 3, null, { timeout: 60000 });
  await waitQuiet(page);
  // Document order across nesting: cards live inside per-turn hosts, so walk
  // the whole thread in document order, not just top-level children.
  const orderC = await page.evaluate(() => {
    const thread = document.querySelector(".thread .col");
    if (!thread) return [];
    const out = [];
    const walker = document.createTreeWalker(thread, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node !== null) {
      const el = node;
      if (el.tagName === "SUMMARY" && el.closest("details.tc")) {
        out.push(`card:${(el.textContent ?? "").slice(0, 60)}`);
      } else if (el.classList && el.classList.contains("kai-md") && el.textContent?.includes("Both tools ran")) {
        out.push(`final:${(el.textContent ?? "").slice(0, 60)}`);
      }
      node = walker.nextNode();
    }
    return out;
  });
  const idx = (pred) => orderC.map((s, i) => (pred(s) ? i : -1)).filter((i) => i >= 0);
  const searchIdx = idx((s) => s.includes("filesystem.search")).pop() ?? -1;
  const readIdx = idx((s) => s.includes("filesystem.read")).pop() ?? -1;
  const finalIdx = idx((s) => s.startsWith("final:")).pop() ?? -1;
  check(
    "C search card, then read card, then the final answer — in DOM order",
    searchIdx >= 0 && readIdx > searchIdx && finalIdx > readIdx,
    JSON.stringify({ searchIdx, readIdx, finalIdx, n: orderC.length }).slice(0, 200),
  );

  // ── D. live command card via a real shell.run ─────────────────────────────
  // Independent tap on the raw Core event stream: what the SERVER emitted,
  // regardless of what the page rendered. Distinguishes server loss from UI loss.
  const rawCommandFrames = [];
  eventsAbort = new AbortController();
  const eventsTap = (async () => {
    try {
      const res = await fetch(`${CORE_URL}/core/events`, { signal: eventsAbort.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            try {
              const o = JSON.parse(t.slice(5).trim());
              if (typeof o?.type === "string" && o.type.startsWith("command.")) {
                rawCommandFrames.push({ type: o.type, at: Date.now() });
              }
            } catch { /* non-JSON heartbeat */ }
          }
        }
      }
    } catch { /* aborted at shutdown */ }
  })();
  // shell.run is DESTRUCTIVE: the REAL path parks for approval first.
  async function approvedShellRun(input) {
    const parked = await rt.tools.invoke("shell.run", input, { source: "browser-production" });
    const approvalId = parked?.invocation?.approvalId;
    if (typeof approvalId !== "string" || approvalId.length === 0) {
      throw new Error(`shell.run did not park as expected: ${JSON.stringify(parked).slice(0, 200)}`);
    }
    rt.approvals.decide(approvalId, true);
    return rt.tools.invoke("shell.run", input, { source: "browser-production", approvalId });
  }
  const ticker = `let i=0;const t=setInterval(()=>{process.stdout.write('tick '+(++i)+'\\n');if(i>=25){clearInterval(t);}},60);`;
  const cmdPromise = approvedShellRun(
    { command: process.execPath, args: ["-e", ticker], cwd: stage, timeoutMs: 30000 },
  );
  // In-page second subscriber: does the PAGE's network see command frames?
  const pageTap = await page.evaluate((coreUrl) => {
    return fetch(`${coreUrl}/core/events`).then((res) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const seen = [];
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) return seen;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            try {
              const o = JSON.parse(t.slice(5).trim());
              if (typeof o?.type === "string" && o.type.startsWith("command.")) seen.push(o.type);
            } catch { /* heartbeat */ }
          }
        }
        if (seen.length >= 5) {
          reader.cancel().catch(() => undefined);
          return seen;
        }
        return pump();
      });
      return pump();
    }).catch((e) => [`tap-error:${String(e).slice(0, 80)}`]);
  }, CORE_URL);
  console.log(`prod: in-page tap saw: ${JSON.stringify(pageTap)}`);
  // Fixed window: the ticker runs ~1.5s; anything missing after 8s is a real gap.
  await sleep(8000);
  const cmdVis = await page.evaluate(() => {
    const thread = document.querySelector("section.thread");
    const cards = [...document.querySelectorAll(".thread details.cmd")];
    const summaries = [...document.querySelectorAll(".thread details.tc summary")].map((s) => (s.textContent ?? "").slice(0, 70));
    return {
      threadDisplay: thread ? getComputedStyle(thread).display : null,
      cmdCards: cards.length,
      st: cards.map((c) => c.querySelector(".st")?.textContent ?? null),
      summaries,
    };
  });
  console.log(`prod: cmd visibility: ${JSON.stringify(cmdVis)}`);
  const pills = await page.evaluate(() => ({
    opstate: document.querySelector("#kp-opstate")?.textContent ?? null,
    statusBar: document.querySelector("#kp-statusbar, .statusbar")?.textContent?.slice(0, 200) ?? null,
  }));
  console.log(`prod: pills: ${JSON.stringify(pills)}`);
  const runningSeen = await page.evaluate(() => {
    const st = [...document.querySelectorAll(".thread details.cmd .st")].pop();
    return st?.textContent ?? "";
  });
  const cmdResult = await cmdPromise;
  console.log(`prod: shell.run settled ok=${cmdResult.ok} ${JSON.stringify(cmdResult).slice(0, 200)}`);
  const cmdDom = await page.evaluate(() => ({
    cards: document.querySelectorAll(".thread details.cmd").length,
    anyCmd: document.querySelectorAll("details.cmd").length,
  }));
  console.log(`prod: cmd cards in DOM: ${JSON.stringify(cmdDom)}`);
  console.log(`prod: raw server command frames: ${JSON.stringify(rawCommandFrames.map((f) => f.type))}`);
  await page.waitForFunction(
    () => [...document.querySelectorAll(".thread details.cmd .st")].some((el) => /exit 0/.test(el.textContent ?? "")),
    null, { timeout: 30000 },
  );
  const cmdCard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".thread details.cmd")];
    const last = cards[cards.length - 1];
    return last
      ? { out: last.querySelector(".cmdout")?.textContent?.slice(-120) ?? "", st: last.querySelector(".st")?.textContent ?? "" }
      : null;
  });
  check("D command streams live and stamps exit last", cmdResult.ok === true && /exit 0/.test(cmdCard?.st ?? "") && /tick 25/.test(cmdCard?.out ?? ""), JSON.stringify({ runningSeen, st: cmdCard?.st }));
  await page.screenshot({ path: join(SHOTS, "prod-d-command.png") });

  // ── E. scrolled up mid-run: no yank, jump works ───────────────────────────
  const floodTicker = `for(let i=1;i<=1200;i++){process.stdout.write('flood line '+i+' with padding text to grow the stream\\n');}`;
  const floodPromise = approvedShellRun(
    { command: process.execPath, args: ["-e", floodTicker], cwd: stage, timeoutMs: 60000 },
  );
  await sleep(400);
  await page.evaluate(() => {
    const thread = document.querySelector("section.thread");
    if (thread) thread.scrollTop = 0;
  });
  await sleep(800);
  const scrollState = await page.evaluate(() => {
    const thread = document.querySelector("section.thread");
    const jump = document.querySelector(".thread .jump");
    return thread ? { top: thread.scrollTop, jumpVisible: jump !== null && !jump.hidden } : null;
  });
  check("E scrolled-away view is not yanked; jump appears", scrollState !== null && scrollState.top < 200 && scrollState.jumpVisible === true, JSON.stringify(scrollState));
  await page.click(".thread .jump");
  await sleep(400);
  const afterJump = await page.evaluate(() => {
    const thread = document.querySelector("section.thread");
    return thread ? thread.scrollHeight - thread.scrollTop - thread.clientHeight : null;
  });
  check("E jump-to-latest returns to bottom", afterJump !== null && afterJump < 120, `gap=${afterJump}`);
  const floodResult = await floodPromise;
  await page.waitForFunction(
    () => [...document.querySelectorAll(".thread details.cmd .st")].some((el) => /exit 0/.test(el.textContent ?? "")),
    null, { timeout: 30000 },
  );

  // ── F. flood bounds + responsiveness ──────────────────────────────────────
  const floodStats = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll(".thread details.cmd")];
    const last = cards[cards.length - 1];
    const out = last?.querySelector(".cmdout");
    const spans = out ? out.querySelectorAll("span").length : -1;
    const chars = out ? (out.textContent ?? "").length : -1;
    // Responsiveness: one rAF round-trip while the DOM is huge.
    const t0 = performance.now();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const rafMs = performance.now() - t0;
    return { spans, chars, rafMs: Math.round(rafMs * 10) / 10 };
  });
  evidence.perf.flood = floodStats;
  check("F 1200-chunk flood stays bounded + UI responsive", floodResult.ok === true && floodStats.chars <= 200_000 + 2000 && floodStats.rafMs < 500, JSON.stringify(floodStats));

  // ── G. Stop aborts the turn; task CANCELLED; no failure card ──────────────
  const badBefore = await page.evaluate(() => document.querySelectorAll(".thread .bad").length);
  // Mark BEFORE sending: the slow turn's whole lifecycle (UNDERSTANDING →
  // CANCELLED-or-otherwise) must fall inside the observation window. Marking
  // after the click once missed a fast CANCELLED that landed during the sleep.
  const markCount = taskMoves.length;
  await sendMessage(page, "slow report please");
  await page.waitForSelector("details.think button.mini", { timeout: 20000 });
  await sleep(900);
  await page.click("details.think button.mini");
  await sleep(400);
  const clickProof = await page.evaluate(() => ({
    // The handler flips the button text synchronously: proves the click LANDED.
    stopButtons: [...document.querySelectorAll("details.think button.mini")].map((b) => b.textContent),
    toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent?.slice(0, 60)),
  }));
  console.log(`prod: click proof: ${JSON.stringify(clickProof)}`);
  await sleep(1500);
  const stopState = await page.evaluate(() => ({
    badAfter: document.querySelectorAll(".thread .bad").length,
    thinkGone: document.querySelectorAll(".thread details.think").length,
  }));
  // The abort is async (TCP FIN -> server 'close' -> run abort -> settle):
  // poll for the slow turn's terminal move instead of sampling once.
  let terminal = null;
  for (let i = 0; i < 24 && terminal === null; i += 1) {
    await sleep(500);
    const after = taskMoves.slice(markCount).map((m) => m.state);
    if (after.includes("CANCELLED")) terminal = "CANCELLED";
    else if (after.includes("COMPLETED") || after.includes("PAUSED") || after.includes("BLOCKED")) {
      terminal = after.find((s) => s !== "UNDERSTANDING" && s !== "VERIFYING") ?? null;
    }
  }
  console.log(`prod: post-click terminal=${terminal} tail=${JSON.stringify(taskMoves.slice(-8).map((m) => m.state))}`);
  check("G stop leaves no failure card", stopState.badAfter === badBefore, JSON.stringify(stopState));
  check("G stopped run settles CANCELLED in-process (never completes into the void)", terminal === "CANCELLED", `terminal=${terminal}`);
  // The run is not wedged: a follow-up turn still answers.
  await sendMessage(page, "format showcase");
  await page.waitForSelector(".thread .kai-md h1", { timeout: 30000 });
  check("G composer usable after stop", true, "follow-up turn rendered");

  evidence.verdict = failures.length === 0 ? "pass" : "fail";
  writeFileSync(join(EVIDENCE, "browser-production.json"), JSON.stringify(evidence, null, 2));
  await shutdown();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (failures.length > 0) {
    console.error(`FAILURES: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("browser production: all scenarios passed");
} catch (error) {
  console.error("HARNESS ERROR:", error instanceof Error ? error.message : String(error));
  try {
    writeFileSync(join(EVIDENCE, "browser-production.json"), JSON.stringify(evidence, null, 2));
  } catch { /* evidence best-effort */ }
  await shutdown().catch(() => undefined);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch { /* best-effort */ }
  process.exit(1);
}
