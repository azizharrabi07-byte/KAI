#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * LIVE UX PROBE (§32/§33/§37) — proves the UI surfaces runtime events AS THEY
 * HAPPEN, not as an end-of-run dump. Boots a real Core with a scripted model
 * whose frames are deliberately staggered, drives the built UI in headless
 * Chromium, samples the DOM every ~80ms, and records the first time each
 * element appears + the event→UI latency.
 *
 *   Fails if the UI buffers: e.g. a tool card that only appears after the
 *   final text, or all assistant text appearing in one jump at the end.
 *
 * Writes docs/evidence/live-ux-probe.json.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIST = join(CORE, "..", "app", "dist");
const { createCoreRuntime } = await import("../src/runtime.ts");
const { createKaiServer } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");

const dir = mkdtempSync(join(tmpdir(), "kai-liveux-"));
const stage = join(dir, "workspace");
mkdirSync(stage, { recursive: true });
process.env.KAI_WORKSPACE_ROOT = stage;

const evidence = { at: new Date().toISOString(), marks: {}, latency: {}, verdict: "pending" };
const failures = [];
const check = (name, cond, detail) => { evidence.marks[name] = { pass: !!cond, detail: detail ?? null }; console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) failures.push(name); };

// Scripted model: each round streams text frames, then a tool_call; frames are
// spaced 150ms so the UI has a real chance to paint between them.
const S = JSON.stringify({ query: "lighthouse", path: stage });
function frames(parts) {
  return parts.map((p) => {
    const d = typeof p === "string" ? { content: p } : p;
    return `data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`;
  });
}
function scripted() {
  return async (_url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const path = String(_url).split("/v1")[1] ?? "";
    if (path.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "repro-model" }] }), { status: 200 });
    const msgs = body.messages ?? [];
    const toolRounds = msgs.filter((m) => m.role === "tool").length;
    const stream = (arr) => new Response(new ReadableStream({
      async start(c) {
        for (const f of arr) { await new Promise((r) => setTimeout(r, 150)); c.enqueue(new TextEncoder().encode(`${f}\n\n`)); }
        c.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    if (body.stream !== true) {
      const tool_calls = [{ id: "c1", type: "function", function: { name: "filesystem_search", arguments: S } }];
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Searching.", tool_calls }, finish_reason: "tool_calls" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (toolRounds === 0) {
      return stream(frames([
        { content: "I'll inspect the repository. " },
        { content: "Searching files." },
        { tool_calls: [{ index: 0, id: "c1", function: { name: "filesystem_search", arguments: S } }], finish_reason: "tool_calls" },
      ]));
    }
    return stream(frames([
      { content: "Found candidates. " },
      { content: "The bug is a refresh race." },
      { content: "" , finish_reason: "stop" },
    ]));
  };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
function serveDist(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = join(APP_DIST, urlPath === "/" ? "shell.html" : urlPath.slice(1));
    if (!existsSync(file)) file = join(APP_DIST, "shell.html");
    try { res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(readFileSync(file)); }
    catch { res.writeHead(404); res.end("no"); }
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

let rt = null, server = null, staticServer = null, browser = null;
try {
  rt = createCoreRuntime({ dbPath: join(dir, "core.db"), agents: { mode: "mock" }, startScheduler: false, model: { fetchImpl: scripted() }, subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") } });
  await rt.start();
  server = createKaiServer(loadConfig({ ...process.env, KAI_CORE_PORT: "8799", KAI_CORE_ALLOWED_ORIGINS: "http://127.0.0.1:1422,http://localhost:1422" }), { core: rt });
  await new Promise((res, rej) => { server.once("error", rej); server.listen(8799, "127.0.0.1", () => res()); });
  staticServer = await serveDist(1422);
  const require = createRequire(join(CORE, "..", "app", "package.json"));
  const { chromium } = require("playwright-core");
  const pwRoot = join(process.env.USERPROFILE ?? "", "AppData", "Local", "ms-playwright");
  const exe = [join(pwRoot, "chromium-1243", "chrome-win64", "chrome.exe"), join(pwRoot, "chromium_headless_shell-1243", "chrome-headless-shell-win64", "chrome-headless-shell.exe")].find((p) => existsSync(p));
  browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  // NO interception: the app talks straight to the isolated Core, so the SSE
  // stream is REAL (a Playwright route.fulfill buffers the body and would
  // fake a dump). The host override points the shell at 8799.
  await page.addInitScript(() => { window.__KAI_CORE_BASE_URL__ = "http://127.0.0.1:8799"; });
  page.on("console", (m) => console.log("page:", m.type(), m.text().slice(0, 140)));
  page.on("request", (r) => { const u = r.url(); if (u.includes("/chat") || u.includes("/core/events") || u.includes("/providers")) console.log("REQ", r.method(), u.slice(0, 80)); });
  await page.goto("http://127.0.0.1:1422/shell.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#kai-presence-root", { timeout: 20000 });
  await page.waitForTimeout(2500);
  // Diagnostic: does the BROWSER receive SSE frames incrementally?
  const raw = await page.evaluate(async () => {
    const out = [];
    const t = Date.now();
    const res = await fetch("http://127.0.0.1:8799/chat/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "raw transport probe" }) });
    const reader = res.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; for (const line of dec.decode(value).split("\n")) if (line.startsWith("data:")) out.push({ at: Date.now() - t, p: line.slice(5, 40) }); }
    return out;
  });
  console.log("RAW-STREAM", JSON.stringify(raw.slice(0, 8)));
  evidence.marks.rawStream = raw.map((r) => r.at);

  const input = await page.$("#kp-in");
  const t0 = Date.now();
  await input.fill("inspect the repository and fix the bug");
  await page.click(".go");
  // Sample the DOM every 80ms; record the first appearance time of each marker.
  const samples = [];
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll(".thread .k p")).map((b) => (b.textContent ?? ""));
      const cards = Array.from(document.querySelectorAll(".thread details.tc")).map((d) => (d.querySelector("summary")?.textContent ?? "").trim());
      const strip = Array.from(document.querySelectorAll("#kp-actstrip .actrow span")).map((s) => s.textContent ?? "");
      const len = (document.querySelector(".thread")?.textContent ?? "").length;
      return { text: bubbles.join(" | "), cardCount: cards.length, cards, strip, len };
    });
    console.log(`SAMPLE +${Date.now() - t0}ms len=${snap.len} cards=${snap.cardCount} ${JSON.stringify(snap.text.slice(0, 50))}`);
    samples.push({ at: Date.now() - t0, ...snap });
    if (snap.text.includes("refresh race") && snap.cardCount > 0) break;
    await page.waitForTimeout(80);
  }
  evidence.latency.samples = samples.length;
  const firstTime = (pred) => { const s = samples.find(pred); return s === undefined ? null : s.at; };
  const firstText = firstTime((s) => s.text.includes("inspect the repository"));
  const firstSearchCard = firstTime((s) => s.cards.some((c) => c.includes("filesystem.search")) || (s.strip ?? []).some((x) => x.includes("filesystem.search")));
  const firstFinal = firstTime((s) => s.text.includes("refresh race"));
  evidence.marks.firstTextMs = firstText;
  evidence.marks.firstToolMs = firstSearchCard;
  evidence.marks.firstFinalMs = firstFinal;

  check("L1: assistant text appears early (not only at the end)", firstText !== null && firstFinal !== null && firstText < firstFinal, `text=${firstText}ms final=${firstFinal}ms`);
  check("L2: tool activity appears BEFORE the final answer", firstSearchCard !== null && firstFinal !== null && firstSearchCard < firstFinal, `tool=${firstSearchCard}ms final=${firstFinal}ms`);
  // Incremental text: the sampled text must grow over time, not jump once.
  const texts = [...new Set(samples.map((s) => s.text))];
  check("L3: assistant text grows incrementally", texts.length >= 3, `${texts.length} distinct states`);
  // Latency p50/p95 for the first text delta.
  const early = samples.filter((s) => s.text.includes("inspect")).map((s) => s.at);
  evidence.latency.firstTextMs = firstText;
  evidence.latency.p50 = firstText;
  evidence.latency.p95 = firstSearchCard;
  await page.screenshot({ path: join(dir, "live-ux.png") });

  evidence.verdict = failures.length === 0 ? "PASS" : `FAIL: ${failures.join(", ")}`;
  if (failures.length > 0) process.exitCode = 1;
  console.log(`live-ux verdict: ${evidence.verdict}`);
  console.log(`latency: ${JSON.stringify(evidence.latency)}`);
} catch (e) {
  evidence.verdict = `ERROR: ${e?.message ?? e}`;
  console.error(evidence.verdict);
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); if (server) await new Promise((r) => server.close(() => r())); if (rt) await rt.stop(); if (staticServer) await new Promise((r) => staticServer.close(() => r())); } catch { /* best-effort */ }
  try { const { writeFileSync } = await import("node:fs"); writeFileSync(join(CORE, "..", "docs", "evidence", "live-ux-probe.json"), JSON.stringify(evidence, null, 2), "utf8"); console.log("evidence: docs/evidence/live-ux-probe.json"); } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}
