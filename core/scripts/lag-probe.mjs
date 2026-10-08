#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Lag probe for the built shell UI (READ-ONLY measurement, no app changes).
 *
 * Setup mirrors core/scripts/browser-repro.mjs — do NOT modify that file:
 * temp DB, scripted model, serve app/dist on :1421, Playwright route-forward
 * :8788 -> :8789, headless Chromium (playwright-core + ms-playwright chromium,
 * default viewport just like browser-repro.mjs which sets no viewport).
 *
 * Every latency is timed with performance.now() INSIDE page.evaluate
 * (5 samples each, median reported):
 *
 *   (a) composer input keystroke-to-paint
 *   (b) Ctrl+K palette open time
 *   (c) `/` popup filter time for 3 keystrokes
 *   (d) `@` picker filter time
 *   (e) stream first-delta latency after send
 *   (f) full short-turn time
 *   (g) tool-card render count/time on a tool turn
 *   (h) session switch time (sessions tab + back)
 *   (i) rail route switch time
 *
 * Plus a request watch: no /providers or /tasks polling may fire while typing
 * (provider calls happen on demand, not per keystroke).
 *
 * Writes docs/evidence/lag-probe.json. Exits non-zero on missing verdict file
 * only if the harness itself errors (budget misses are verdict, not crash).
 *
 * Run from `core/`:  node scripts/lag-probe.mjs
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createRequire } from "node:module";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIST = join(CORE, "..", "app", "dist");

const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const REPLY_A = "lag probe answer alpha";
const REPLY_B = "lag probe answer beta";

/** Scripted model: fast SSE deltas (2 x 150ms) + 400ms non-stream delay. */
function scriptedModelFetch() {
  const textFrames = (a, b) =>
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: a } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: b } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
  const SEARCH_ARGS = JSON.stringify({ query: "lagtool", path: "/tmp/lag" });
  const lastUser = (messages) => {
    const users = (messages ?? []).filter((m) => m.role === "user");
    return users.length > 0 ? String(users[users.length - 1].content ?? "") : "";
  };
  const hasToolContext = (messages) =>
    (messages ?? []).some((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls !== undefined));
  const wantsSearch = (messages) => lastUser(messages).includes("search my files") && !hasToolContext(messages);
  const toolFrames = () => {
    const halves = [SEARCH_ARGS.slice(0, 20), SEARCH_ARGS.slice(20)];
    return [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_lag_1", function: { name: "filesystem_search", arguments: halves[0] } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: halves[1] } }] }, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
  };
  const sse = (frames) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          for (const chunk of frames.split("\n\n").filter(Boolean)) {
            await new Promise((r) => setTimeout(r, 150));
            controller.enqueue(new TextEncoder().encode(`${chunk}\n\n`));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const completion = (text) =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-lag",
        model: "lag-model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  return async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const path = String(url).split("/v1")[1] ?? String(url);
    if (path.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "lag-model" }] }), { status: 200 });
    }
    const search = wantsSearch(body.messages);
    if (body.stream === true) {
      if (search) return sse(toolFrames());
      if (hasToolContext(body.messages)) return sse(textFrames("searched: ", "lag tool scan complete"));
      const marker = lastUser(body.messages).includes("beta") ? REPLY_B : REPLY_A;
      const [a, b] = [marker.slice(0, 10), marker.slice(10)];
      return sse(textFrames(a, b));
    }
    await new Promise((r) => setTimeout(r, 400));
    if (search) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-lag",
          model: "lag-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_lag_1", type: "function", function: { name: "filesystem_search", arguments: SEARCH_ARGS } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return completion(hasToolContext(body.messages) ? "searched: lag tool scan complete" : REPLY_A);
  };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function serveDist(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = join(APP_DIST, urlPath === "/" ? "shell.html" : urlPath.slice(1));
    if (!existsSync(file)) file = join(APP_DIST, "shell.html");
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("nope");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const round2 = (n) => Math.round(n * 100) / 100;

const BUDGETS = {
  input_ms: 50,
  palette_ms: 200,
  autocomplete_ms: 100,
  first_delta_ms: 3000,
  session_switch_ms: 1000,
  route_switch_ms: 1000,
};

const metrics = {};
const notes = [];
const requestLog = [];
let typingWindow = null; // {start,end} epoch ms for the keystroke pollution check
const typedRequests = [];

const evidence = { at: new Date().toISOString(), metrics: {}, budgets: BUDGETS, verdict: "pending", notes: [] };

const dir = mkdtempSync(join(tmpdir(), "kai-lag-probe-"));
const REPRO_PORT = 8789;
const STATIC_PORT = 1421;
let rt = null;
let server = null;
let staticServer = null;
let browser = null;

async function shutdown() {
  if (browser) {
    try {
      await browser.close();
    } catch { /* already gone */ }
    browser = null;
  }
  if (server) await new Promise((r) => server.close(() => r()));
  if (rt) await rt.stop();
  if (staticServer) await new Promise((r) => staticServer.close(() => r()));
}

console.log("lag: booting core");
try {
  if (!existsSync(join(APP_DIST, "shell.html"))) throw new Error("app/dist/shell.html missing — run vite build first");

  process.env.KAI_WORKSPACE_ROOT = dir;
  rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    model: { fetchImpl: scriptedModelFetch() },
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  await rt.skills.register({
    id: "deep-research",
    source: "user",
    markdown: [
      "---",
      "name: Deep Research",
      "description: Deep evidence-based research workflow.",
      "purpose: Investigate a question thoroughly and report with evidence.",
      "tools: filesystem.search, filesystem.read",
      "constraints: Read-only, cite what you read",
      "tags: [research]",
      "---",
      "",
      "# Deep Research",
      "1. Search broadly. 2. Read the hits. 3. Report with citations.",
    ].join("\n"),
  });
  const kaiServer = createKaiServer(
    loadConfig({
      ...process.env,
      KAI_CORE_PORT: String(REPRO_PORT),
      KAI_CORE_ALLOWED_ORIGINS: `http://localhost:1420,http://127.0.0.1:1420,http://127.0.0.1:${STATIC_PORT},http://localhost:${STATIC_PORT}`,
    }),
    { core: rt },
  );
  await new Promise((resolve, reject) => {
    kaiServer.once("error", reject);
    kaiServer.listen(REPRO_PORT, "127.0.0.1", () => resolve());
  });
  server = kaiServer;
  staticServer = await serveDist(STATIC_PORT);

  const require = createRequire(join(CORE, "..", "app", "package.json"));
  const { chromium } = require("playwright-core");
  const pwRoot = join(process.env.USERPROFILE ?? "", "AppData", "Local", "ms-playwright");
  const exeCandidates = [
    join(pwRoot, "chromium-1243", "chrome-win64", "chrome.exe"),
    join(pwRoot, "chromium_headless_shell-1243", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
  ];
  const executablePath = exeCandidates.find((p) => existsSync(p));
  if (!executablePath) throw new Error("no chromium found");
  browser = await chromium.launch({ executablePath, headless: true });
  // Same resolution logic as browser-repro.mjs: default viewport (no override).
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("page:", msg.type(), msg.text().slice(0, 160)));
  page.on("pageerror", (err) => console.log("pageerror:", String(err).slice(0, 300)));

  // Request watch: every Core-bound request, timestamped. Typing-window
  // pollution is checked against this log at the end.
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("127.0.0.1:8788")) return;
    const rec = { t: Date.now(), method: req.method(), path: url.split("127.0.0.1:8788")[1] ?? url };
    requestLog.push(rec);
    if (typingWindow && rec.t >= typingWindow.start && rec.t <= typingWindow.end) typedRequests.push(rec);
  });

  await page.route("http://127.0.0.1:8788/**", async (route) => {
    const req = route.request();
    const upstream = `http://127.0.0.1:${REPRO_PORT}${req.url().slice("http://127.0.0.1:8788".length)}`;
    try {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers())) {
        if (!["host", "content-length"].includes(k.toLowerCase())) headers[k] = v;
      }
      const upstreamRes = await fetch(upstream, {
        method: req.method(),
        headers,
        body: ["POST", "PUT", "PATCH"].includes(req.method()) ? req.postDataBuffer() ?? undefined : undefined,
      });
      const body = Buffer.from(await upstreamRes.arrayBuffer());
      const resHeaders = {};
      upstreamRes.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) resHeaders[k] = v;
      });
      await route.fulfill({ status: upstreamRes.status, headers: resHeaders, body });
    } catch {
      await route.abort("failed");
    }
  });

  await page.goto(`http://127.0.0.1:${STATIC_PORT}/shell.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#kai-presence-root", { timeout: 20000 });
  await page.waitForTimeout(3000);
  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  const input = await page.$("#kp-in");
  if (!input) throw new Error("composer #kp-in missing");

  // Seed one live agent so `@` resolves (same as repro G, but via API only).
  await page.evaluate(async () => {
    const post = async (path, body) => {
      const r = await fetch(`http://127.0.0.1:8788${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const spec = { id: "scout", name: "Scout", role: "researcher", soul: "I am careful.", workerId: "opencode" };
    let created = await post("/subagents", spec);
    if (created.status === 409 && created.body.approvalId) {
      await post(`/approvals/${created.body.approvalId}/decide`, { approved: true });
      created = await post("/subagents", { ...spec, approvalId: created.body.approvalId });
    }
    window.__scoutReady = created.status === 201;
  });
  // Visit Agents once so the picker's catalogue is loaded, then back to chat.
  const agentsNav0 = await page.$('[data-route="agents"]');
  if (agentsNav0) await agentsNav0.click();
  await page.waitForTimeout(1500);
  const chatNav0 = await page.$('[data-route="chat"]');
  if (chatNav0) await chatNav0.click();
  await page.waitForTimeout(800);

  const mark = (name, samples, unit = "ms") => {
    metrics[name] = { median: round2(median(samples)), samples: samples.map(round2), unit, n: samples.length };
    console.log(`lag ${name}: median ${median(samples).toFixed(2)}${unit} [${samples.map((s) => s.toFixed(1)).join(", ")}]`);
  };

  // (a) composer keystroke-to-paint: one char per sample, handler + 2x rAF.
  {
    const samples = await page.evaluate(async () => {
      const el = document.querySelector("#kp-in");
      el.focus();
      el.value = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const out = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        el.value += "x";
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "x", inputType: "insertText" }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        out.push(performance.now() - t0);
      }
      el.value = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return out;
    });
    mark("composer_keystroke_to_paint_ms", samples);
  }

  // Typing pollution window: real keystrokes, watched for /providers /tasks.
  {
    typingWindow = { start: Date.now(), end: Date.now() + 30000 };
    await page.evaluate(() => {
      const el = document.querySelector("#kp-in");
      el.focus();
      el.value = "";
    });
    await input.fill("");
    for (const ch of "hello providers check") {
      await page.keyboard.type(ch, { delay: 30 });
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(500);
    typingWindow.end = Date.now();
    await input.fill("");
    await page.waitForTimeout(300);
  }

  // (b) Ctrl+K palette open: dispatch real keydown on document, 2x rAF paint.
  {
    const samples = await page.evaluate(async () => {
      const isOpen = () => document.querySelector("#kp-ov")?.classList.contains("on") ?? false;
      const out = [];
      for (let i = 0; i < 5; i++) {
        if (isOpen()) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
        const t0 = performance.now();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        out.push(performance.now() - t0);
        const opened = isOpen();
        out[out.length - 1] = opened ? out[out.length - 1] : -1;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
      }
      return out;
    });
    if (samples.some((s) => s < 0)) notes.push("palette failed to open on at least one sample (selector #kp-ov.on)");
    mark("palette_open_ms", samples.filter((s) => s >= 0));
    const rows = await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
      const n = document.querySelectorAll("#kp-pal-list .pal-row").length;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return n;
    });
    metrics.palette_row_count = { median: rows, samples: [rows], unit: "rows", n: 1 };
  }

  // (c) `/` popup filter for 3 keystrokes: /m -> /mo -> /mod, 5 rounds.
  {
    const perKey = { k1: [], k2: [], k3: [] };
    const roundMeds = [];
    const rounds = await page.evaluate(async () => {
      const el = document.querySelector("#kp-in");
      const roundsOut = [];
      for (let r = 0; r < 5; r++) {
        const seq = ["/m", "/mo", "/mod"];
        const ts = [];
        el.focus();
        el.value = "";
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await new Promise((rr) => setTimeout(rr, 60));
        for (const text of seq) {
          const t0 = performance.now();
          el.value = text;
          el.dispatchEvent(new KeyboardEvent("keydown", { key: text.slice(-1), bubbles: true, cancelable: true }));
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text.slice(-1), inputType: "insertText" }));
          await new Promise((rr) => requestAnimationFrame(() => requestAnimationFrame(rr)));
          ts.push(performance.now() - t0);
        }
        const rows = document.querySelectorAll("#kp-slash .pr").length;
        roundsOut.push({ ts, rows });
        el.value = "";
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((rr) => setTimeout(rr, 120));
      }
      return roundsOut;
    });
    for (const rd of rounds) {
      perKey.k1.push(rd.ts[0]);
      perKey.k2.push(rd.ts[1]);
      perKey.k3.push(rd.ts[2]);
      roundMeds.push(median(rd.ts));
    }
    mark("slash_filter_per_keystroke_ms", [...perKey.k1, ...perKey.k2, ...perKey.k3]);
    metrics.slash_filter_k1_ms = { median: round2(median(perKey.k1)), samples: perKey.k1.map(round2), unit: "ms", n: 5 };
    metrics.slash_filter_k2_ms = { median: round2(median(perKey.k2)), samples: perKey.k2.map(round2), unit: "ms", n: 5 };
    metrics.slash_filter_k3_ms = { median: round2(median(perKey.k3)), samples: perKey.k3.map(round2), unit: "ms", n: 5 };
    metrics.slash_row_count = { median: median(rounds.map((r) => r.rows)), samples: rounds.map((r) => r.rows), unit: "rows", n: 5 };
    await input.fill("");
  }

  // (d) `@` picker filter: @s -> @sc -> @sco, 5 rounds.
  {
    const all = [];
    const rounds = await page.evaluate(async () => {
      const el = document.querySelector("#kp-in");
      const roundsOut = [];
      for (let r = 0; r < 5; r++) {
        const seq = ["@s", "@sc", "@sco"];
        const ts = [];
        el.focus();
        el.value = "";
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await new Promise((rr) => setTimeout(rr, 60));
        for (const text of seq) {
          const t0 = performance.now();
          el.value = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text.slice(-1), inputType: "insertText" }));
          await new Promise((rr) => requestAnimationFrame(() => requestAnimationFrame(rr)));
          ts.push(performance.now() - t0);
        }
        const labels = Array.from(document.querySelectorAll("#kp-mention .pr b")).map((b) => b.textContent ?? "");
        roundsOut.push({ ts, labels });
        el.value = "";
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((rr) => setTimeout(rr, 120));
      }
      return roundsOut;
    });
    for (const rd of rounds) all.push(...rd.ts);
    mark("mention_filter_per_keystroke_ms", all);
    const lastLabels = rounds[rounds.length - 1].labels;
    metrics.mention_labels = { median: lastLabels.length, samples: rounds.map((r) => r.labels.length), unit: "rows", n: 5 };
    notes.push(`@ picker labels (last round): ${lastLabels.join(", ").slice(0, 160) || "(none)"}`);
    await input.fill("");
  }

  // (e)+(f) stream first-delta + full short turn, 5 turns alternating alpha/beta.
  {
    const firstDeltas = [];
    const fullTurns = [];
    for (let i = 0; i < 5; i++) {
      const probe = i % 2 === 0 ? "alpha ping" : "beta ping";
      const before = await page.evaluate(() => document.querySelectorAll(".thread .k p").length);
      const tSend = await page.evaluate(() => performance.now());
      await input.fill(`lag probe ${probe} ${i}`);
      await page.click(".go");
      // First delta: any NEW assistant bubble text beyond `before`.
      let tFirst = null;
      const deadline1 = Date.now() + 30000;
      while (Date.now() < deadline1) {
        const st = await page.evaluate((b) => {
          const bubbles = Array.from(document.querySelectorAll(".thread .k p")).map((x) => x.textContent ?? "");
          return { count: bubbles.length, extra: bubbles.slice(b).join("\n") };
        }, before);
        if (st.extra.trim().length > 0) {
          tFirst = await page.evaluate(() => performance.now());
          break;
        }
        await page.waitForTimeout(100);
      }
      if (tFirst === null) throw new Error(`no first delta on turn ${i}`);
      firstDeltas.push(tFirst - tSend);
      // Full turn: expected marker text present.
      const want = i % 2 === 0 ? REPLY_A : REPLY_B;
      const deadline2 = Date.now() + 60000;
      for (;;) {
        const text = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".thread .k p")).map((b) => b.textContent ?? "").join("\n"),
        );
        if (text.includes(want)) break;
        if (Date.now() > deadline2) throw new Error(`short turn ${i} never completed`);
        await page.waitForTimeout(200);
      }
      const tDone = await page.evaluate(() => performance.now());
      fullTurns.push(tDone - tSend);
      await page.waitForTimeout(400);
    }
    mark("stream_first_delta_ms", firstDeltas);
    mark("short_turn_full_ms", fullTurns);
  }

  // (g) tool-card render count/time on a tool turn.
  {
    const before = await page.evaluate(() => document.querySelectorAll(".thread .k p").length);
    const tSend = await page.evaluate(() => performance.now());
    await input.fill("please search my files for lighthouse lag");
    await page.click(".go");
    let tCard = null;
    let cardCount = 0;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => ({
        cards: document.querySelectorAll(".thread details.tc, .thread .kai-tool").length,
        now: performance.now(),
      }));
      if (st.cards >= 1) {
        tCard = st.now;
        cardCount = st.cards;
        break;
      }
      await page.waitForTimeout(150);
    }
    if (tCard === null) {
      notes.push("tool card never rendered (0 cards) — checked .thread details.tc, .thread .kai-tool");
      metrics.tool_card_ms = { median: null, samples: [], unit: "ms", n: 0, note: "no card rendered" };
    } else {
      mark("tool_card_ms", [tCard - tSend]);
    }
    // Wait for the tool turn's answer, then count final cards.
    const done = Date.now() + 60000;
    for (;;) {
      const text = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".thread .k p")).map((b) => b.textContent ?? "").join("\n"),
      );
      if (text.includes("lag tool scan complete")) break;
      if (Date.now() > done) {
        notes.push("tool-turn answer never completed");
        break;
      }
      await page.waitForTimeout(300);
    }
    const finalCards = await page.evaluate(() => document.querySelectorAll(".thread details.tc, .thread .kai-tool").length);
    metrics.tool_card_count = { median: finalCards, samples: [cardCount, finalCards], unit: "cards", n: 2 };
  }

  // (h) session switch: sessions tab leg + back-to-chat leg, 5 round trips.
  {
    // Ensure at least two sessions exist with distinct content.
    await page.evaluate(async () => {
      const mk = async (title, text) => {
        const created = await (await fetch("http://127.0.0.1:8788/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) })).json();
        const id = created.session.id;
        await fetch("http://127.0.0.1:8788/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, conversation_id: id }) });
        return id;
      };
      if (window.__lagSeeded !== true) {
        await mk("Lag One", "lag session one semaphore");
        await mk("Lag Two", "lag session two semaphore");
        window.__lagSeeded = true;
      }
    });
    const toSessions = [];
    const toChat = [];
    for (let i = 0; i < 5; i++) {
      let t0 = await page.evaluate(() => performance.now());
      const sNav = await page.$('[data-route="sessions"]');
      if (sNav) await sNav.click();
      await page.waitForFunction(() => document.querySelector("#kp-v-sessions")?.classList.contains("on") ?? false, null, { timeout: 10000 });
      toSessions.push((await page.evaluate(() => performance.now())) - t0);
      await page.waitForTimeout(300);
      t0 = await page.evaluate(() => performance.now());
      const cNav = await page.$('[data-route="chat"]');
      if (cNav) await cNav.click();
      await page.waitForFunction(
        () => {
          const thread = document.querySelector(".thread");
          return thread !== null && getComputedStyle(thread).display !== "none";
        },
        null,
        { timeout: 10000 },
      );
      toChat.push((await page.evaluate(() => performance.now())) - t0);
      await page.waitForTimeout(300);
    }
    mark("session_tab_open_ms", toSessions);
    mark("session_back_to_chat_ms", toChat);
    mark("session_roundtrip_ms", toSessions.map((s, i) => s + toChat[i]));
  }

  // (i) rail route switch: every route once + 5-sample median on chat<->settings.
  {
    const routes = ["home", "chat", "sessions", "missions", "agents", "workers", "tools", "mcp", "activity", "memory", "skills", "settings"];
    const oneShot = {};
    for (const id of routes) {
      const btn = await page.$(`[data-route="${id}"]`);
      if (!btn) {
        oneShot[id] = null;
        continue;
      }
      const t0 = await page.evaluate(() => performance.now());
      await btn.click();
      try {
        await page.waitForFunction(
          (rid) => document.querySelector(`#kp-v-${rid}`)?.classList.contains("on") ?? false,
          id,
          { timeout: 10000 },
        );
        oneShot[id] = round2((await page.evaluate(() => performance.now())) - t0);
      } catch {
        oneShot[id] = null;
      }
      await page.waitForTimeout(200);
    }
    metrics.rail_route_each_ms = { median: null, samples: [], unit: "ms", n: 0, per_route: oneShot };
    const chatBtn = await page.$('[data-route="chat"]');
    if (chatBtn) await chatBtn.click();
    await page.waitForTimeout(500);
    const reps = [];
    for (let i = 0; i < 5; i++) {
      let t0 = await page.evaluate(() => performance.now());
      const sBtn = await page.$('[data-route="settings"]');
      await sBtn.click();
      await page.waitForFunction(() => document.querySelector("#kp-v-settings")?.classList.contains("on") ?? false, null, { timeout: 10000 });
      reps.push((await page.evaluate(() => performance.now())) - t0);
      await page.waitForTimeout(250);
      t0 = await page.evaluate(() => performance.now());
      const cBtn = await page.$('[data-route="chat"]');
      await cBtn.click();
      await page.waitForFunction(
        () => {
          const thread = document.querySelector(".thread");
          return thread !== null && getComputedStyle(thread).display !== "none";
        },
        null,
        { timeout: 10000 },
      );
      reps.push((await page.evaluate(() => performance.now())) - t0);
      await page.waitForTimeout(250);
    }
    mark("rail_route_switch_ms", reps);
    // Back to chat for a clean end state.
    const cEnd = await page.$('[data-route="chat"]');
    if (cEnd) await cEnd.click();
    await page.waitForTimeout(500);
  }

  // Request-pollution verdict: any /providers or /tasks during typing?
  const typedHits = typedRequests.filter((r) => r.path.startsWith("/providers") || r.path.startsWith("/tasks"));
  const typedPaths = [...new Set(typedRequests.map((r) => `${r.method} ${r.path}`))].slice(0, 20);
  const allPaths = [...new Set(requestLog.map((r) => `${r.method} ${r.path}`))].slice(0, 40);
  evidence.request_watch = {
    typing_request_count: typedRequests.length,
    typing_requests: typedPaths,
    providers_or_tasks_during_typing: typedHits.map((r) => `${r.method} ${r.path}`),
    all_routes_seen: allPaths,
  };
  if (typedHits.length === 0) {
    notes.push(`no /providers or /tasks traffic during typing (${typedRequests.length} typed-window requests; on-demand only — no regression)`);
  } else {
    notes.push(`REGRESSION: ${typedHits.length} provider/task request(s) fired DURING typing: ${typedHits.map((r) => `${r.method} ${r.path}`).join(", ")}`);
  }

  // Verdict vs budgets.
  const fails = [];
  const check = (label, metricName, budget) => {
    const m = metrics[metricName];
    if (!m || m.median === null || m.median === undefined) {
      fails.push(`${label}: no data`);
      return;
    }
    if (m.median > budget) fails.push(`${label}: ${m.median}ms > ${budget}ms`);
  };
  check("composer input", "composer_keystroke_to_paint_ms", BUDGETS.input_ms);
  check("palette open", "palette_open_ms", BUDGETS.palette_ms);
  check("slash filter", "slash_filter_per_keystroke_ms", BUDGETS.autocomplete_ms);
  check("mention filter", "mention_filter_per_keystroke_ms", BUDGETS.autocomplete_ms);
  check("first delta", "stream_first_delta_ms", BUDGETS.first_delta_ms);
  check("session switch (roundtrip)", "session_roundtrip_ms", BUDGETS.session_switch_ms);
  check("rail route switch", "rail_route_switch_ms", BUDGETS.route_switch_ms);
  if (typedHits.length > 0) fails.push("provider/task polling during typing");

  evidence.metrics = metrics;
  evidence.viewport = viewport;
  evidence.resolution_note = "default Playwright viewport (same as browser-repro.mjs: no viewport override)";
  evidence.notes = notes;
  evidence.verdict = fails.length === 0 ? "PASS" : `FAIL: ${fails.join("; ")}`;
  if (fails.length > 0) process.exitCode = 1;
  console.log(`lag verdict: ${evidence.verdict}`);
} catch (e) {
  evidence.verdict = `ERROR: ${e?.message ?? e}`;
  console.error(evidence.verdict);
  process.exitCode = 1;
} finally {
  try {
    await shutdown();
  } catch { /* best-effort */ }
  try {
    const { writeFileSync: write, mkdirSync: mk } = await import("node:fs");
    mk(join(CORE, "..", "docs", "evidence"), { recursive: true });
    write(join(CORE, "..", "docs", "evidence", "lag-probe.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence: docs/evidence/lag-probe.json");
  } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}
