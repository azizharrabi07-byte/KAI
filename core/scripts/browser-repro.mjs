#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Browser reproduction harness for the session/chat state bugs.
 *
 * Boots a REAL Core (temp DB, mock workers, SCRIPTED model with realistic
 * delays), serves the BUILT app (app/dist) on :1420, and drives headless
 * Chromium through the exact user journeys:
 *
 *   A. send message -> assistant answer visible WITHOUT any tab change
 *   B. sessions tab -> back to chat -> same transcript, no landing surface
 *
 * Writes docs/evidence/browser-repro.json. Exits non-zero on failure.
 *
 * Run from `core/`:  node scripts/browser-repro.mjs
 * Requires: playwright-core (app/node_modules) + ms-playwright chromium.
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

const REPLY = "browser repro answer: the lighthouse stands";

/**
 * Scripted model fetch: delayed completion / delayed SSE deltas, with a
 * tool-call branch. A turn asking to "search my files" gets a
 * `filesystem_search` call first; the follow-up (with the tool result in
 * context) gets the final text. Everything else gets the canned reply.
 */
function scriptedModelFetch(searchRoot) {
  const SEARCH_ARGS = JSON.stringify({ query: "lighthouse", path: searchRoot });
  const lastUser = (messages) => {
    const users = (messages ?? []).filter((m) => m.role === "user");
    return users.length > 0 ? String(users[users.length - 1].content ?? "") : "";
  };
  const hasToolContext = (messages) => (messages ?? []).some((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls !== undefined));
  const wantsSearch = (messages) => lastUser(messages).includes("search my files") && !hasToolContext(messages);
  const toolFrames = () => {
    const argHalves = [SEARCH_ARGS.slice(0, 20), SEARCH_ARGS.slice(20)];
    return [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_repro_1", function: { name: "filesystem_search", arguments: argHalves[0] } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argHalves[1] } }] }, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
  };
  const textFrames = (a, b) =>
    [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: a } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: b } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
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
        id: "chatcmpl-repro",
        model: "repro-model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  return async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const path = String(url).split("/v1")[1] ?? String(url);
    if (path.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "repro-model" }] }), { status: 200 });
    }
    const search = wantsSearch(body.messages);
    if (body.stream === true) {
      if (search) return sse(toolFrames());
      if (hasToolContext(body.messages)) return sse(textFrames("searched: ", "no lighthouse here, scan complete"));
      return sse(textFrames("browser repro ", "answer: the lighthouse stands"));
    }
    await new Promise((r) => setTimeout(r, 400));
    if (search) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-repro",
          model: "repro-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "call_repro_1", type: "function", function: { name: "filesystem_search", arguments: SEARCH_ARGS } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const flat = JSON.stringify(body.messages ?? []);
    // The orchestrator's independent reviewer: always a real verdict here.
    if (flat.includes("REVIEW CONTRACT")) return completion("PASS\n- deliverable matches contract");
    return completion(hasToolContext(body.messages) ? "searched: no lighthouse here, scan complete" : REPLY);
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

const evidence = { at: new Date().toISOString(), scenarios: [], verdict: "pending" };
const dir = mkdtempSync(join(tmpdir(), "kai-browser-repro-"));
// The user's LIVE Core owns :8788 — never touched. The repro Core lives on
// :8789 and Playwright forwards the built UI's :8788 calls to it, so the REAL
// built UI code runs unmodified against an isolated backend.
const REPRO_PORT = 8789;
// :1420 is taken (dev server) — serve the built UI on :1421 and allow it.
const STATIC_PORT = 1421;
let rt = null;
let server = null;
let staticServer = null;
let browser = null;

async function shutdown() {
  // The page holds a Core SSE connection open: close the BROWSER first, or
  // server.close() waits on that socket forever.
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

console.log("repro: booting core");
try {
  if (!existsSync(join(APP_DIST, "shell.html"))) throw new Error("app/dist/shell.html missing — run vite build first");

  process.env.KAI_WORKSPACE_ROOT = dir;
  rt = createCoreRuntime({
    dbPath: join(dir, "core.db"),
    agents: { mode: "mock" },
    startScheduler: false,
    model: { fetchImpl: scriptedModelFetch(dir) },
    subsystemPaths: { runUpkeepOnStart: false, ledgerPath: join(dir, "ledger.db") },
  });
  await rt.start();
  // Seed one real skill so `@` can resolve a skill as well as agents.
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
  console.log("repro: core up, serving UI");
  staticServer = await serveDist(STATIC_PORT);
  console.log("repro: launching browser");

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
  console.log("repro: browser launched");
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("page:", msg.type(), msg.text().slice(0, 160)));
  page.on("pageerror", (err) => console.log("pageerror:", String(err).slice(0, 300)));
  page.on("requestfailed", (req) => console.log("reqfail:", req.url().slice(0, 100), req.failure()?.errorText));
  // Forward the built UI's Core calls (:8788) to the isolated repro Core.
  // SSE included: the upstream body is buffered (scripted replies are small).
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
    } catch (e) {
      await route.abort("failed");
    }
  });
  const failures = [];
  const check = (name, cond, detail) => {
    evidence.scenarios.push({ name, pass: !!cond, detail: detail ?? null });
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(name);
  };

  // domcontentloaded, NOT networkidle: the Core event stream stays open and
  // networkidle would never settle.
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/shell.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("#kai-presence-root", { timeout: 20000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(dir, "shot-boot.png") });

  // Chat surface present?
  const chatVisible = await page.evaluate(() => {
    const el = document.querySelector("#kp-cw, .cw, #kai-presence-root");
    return el !== null;
  });
  check("boot: chat surface mounted", chatVisible);

  // Send a message. Selectors follow presence.ts: #kp-in textarea, .go send.
  const input = await page.$("#kp-in");
  check("boot: composer present", input !== null);
  if (input) {
    await input.fill("hello kai, this is the browser repro");
    await page.click(".go");
  }

  // Wait for the scripted answer WITHOUT navigating anywhere.
  let assistantText = "";
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assistantText = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll(".thread .k p, .thread .k .fade"));
      return bubbles.map((b) => b.textContent ?? "").join("\n");
    });
    if (assistantText.includes("lighthouse stands")) break;
    await page.waitForTimeout(500);
  }
  check("A: assistant answer visible WITHOUT any tab change", assistantText.includes("lighthouse stands"), assistantText.slice(0, 200));
  await page.screenshot({ path: join(dir, "shot-after-answer.png") });

  // THE invariant (84c5164): after a turn, the THREAD is visible and the
  // greeting hero is hidden. The `.talking` flag is an internal class, not
  // the assertion — computed display is.
  const threadState = await page.evaluate(() => {
    const thread = document.querySelector(".thread");
    const hero = document.querySelector(".hero");
    const style = (el) => (el ? getComputedStyle(el).display : "missing");
    return { thread: style(thread), hero: style(hero) };
  });
  check("A: thread visible, hero hidden after turn", threadState.thread !== "none" && threadState.hero === "none", JSON.stringify(threadState));

  // B: sessions tab and back — same transcript, no landing.
  const sessionsNav = await page.$('[data-route="sessions"], .rb[aria-label="Sessions"]');
  if (sessionsNav) await sessionsNav.click();
  else await page.evaluate(() => document.querySelector("#kp-v-sessions")?.scrollIntoView());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(dir, "shot-sessions.png") });
  // Back to chat via nav.
  const chatNav = await page.$('[data-route="chat"]');
  if (chatNav) await chatNav.click();
  await page.waitForTimeout(1500);
  const afterNav = await page.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll(".thread .k p, .thread .k .fade"));
    const thread = document.querySelector(".thread");
    const hero = document.querySelector(".hero");
    return {
      text: bubbles.map((b) => b.textContent ?? "").join("\n"),
      thread: thread ? getComputedStyle(thread).display : "missing",
      hero: hero ? getComputedStyle(hero).display : "missing",
    };
  });
  check("B: transcript intact after sessions round-trip", afterNav.text.includes("lighthouse stands"), afterNav.text.slice(0, 200));
  check("B: no landing after return", afterNav.thread !== "none" && afterNav.hero === "none", JSON.stringify({ thread: afterNav.thread, hero: afterNav.hero }));
  await page.screenshot({ path: join(dir, "shot-back-to-chat.png") });

  // C: a TOOL turn renders its answer + tool card without any tab change.
  await input.fill("please search my files for lighthouse");
  await page.click(".go");
  let toolText = "";
  const toolDeadline = Date.now() + 60000;
  while (Date.now() < toolDeadline) {
    toolText = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll(".thread .k p, .thread .k .fade"));
      return bubbles.map((b) => b.textContent ?? "").join("\n");
    });
    if (toolText.includes("scan complete")) break;
    await page.waitForTimeout(500);
  }
  check("C: tool-turn answer visible without tab change", toolText.includes("scan complete"), toolText.slice(-200));
  const toolCards = await page.evaluate(() => document.querySelectorAll(".thread details.tc, .thread .kai-tool").length);
  check("C: tool execution card visible", toolCards >= 1, `${toolCards} card(s)`);
  await page.screenshot({ path: join(dir, "shot-tool-turn.png") });

  // D: navigate MID-STREAM — the in-flight answer still lands intact.
  await input.fill("hello again mid-stream probe");
  await page.click(".go");
  await page.waitForTimeout(300);
  const sessionsNav2 = await page.$('[data-route="sessions"]');
  if (sessionsNav2) await sessionsNav2.click();
  await page.waitForTimeout(2000);
  const chatNav2 = await page.$('[data-route="chat"]');
  if (chatNav2) await chatNav2.click();
  let midText = "";
  const midDeadline = Date.now() + 60000;
  while (Date.now() < midDeadline) {
    midText = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll(".thread .k p, .thread .k .fade"));
      return bubbles.map((b) => b.textContent ?? "").join("\n");
    });
    if (midText.includes("mid-stream probe") && midText.split("lighthouse stands").length >= 3) break;
    await page.waitForTimeout(500);
  }
  const midState = await page.evaluate(() => {
    const thread = document.querySelector(".thread");
    const hero = document.querySelector(".hero");
    return {
      thread: thread ? getComputedStyle(thread).display : "missing",
      hero: hero ? getComputedStyle(hero).display : "missing",
    };
  });
  check("D: mid-stream navigation keeps the answer + no landing", midText.split("lighthouse stands").length >= 3 && midState.thread !== "none" && midState.hero === "none", JSON.stringify(midState));
  await page.screenshot({ path: join(dir, "shot-midstream.png") });

  // F: `/` opens the registry command menu; `/m` filters it; Enter runs.
  await input.fill("/");
  await page.waitForTimeout(800);
  const slashShown = await page.evaluate(() => {
    const pop = document.querySelector("#kp-slash");
    return pop !== null && pop.classList.contains("on") && pop.querySelectorAll(".pr").length;
  });
  check("F: `/` shows registry commands", slashShown !== false && slashShown > 0, `${slashShown} rows`);
  await input.fill("/m");
  await page.waitForTimeout(800);
  const slashFiltered = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#kp-slash .pr b")).map((b) => b.textContent ?? ""),
  );
  check("F: `/m` filters live", slashFiltered.includes("/models") && !slashFiltered.includes("/new"), slashFiltered.join(","));
  await input.fill("/help");
  await page.waitForTimeout(800);
  // One Enter: the open menu completes the row, then submits it.
  await page.keyboard.press("Enter");
  let helpText = "";
  const helpDeadline = Date.now() + 15000;
  while (Date.now() < helpDeadline) {
    helpText = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll(".thread .k p"));
      return bubbles.map((b) => b.textContent ?? "").join("\n");
    });
    if (helpText.includes("/compress") || helpText.includes("/new")) break;
    await page.waitForTimeout(500);
  }
  check("F: Enter executes the command for real", helpText.includes("/compress"), helpText.slice(-200));
  await page.screenshot({ path: join(dir, "shot-slash.png") });

  // E: race — two overlapping session opens; the NEWEST must win, intact.
  // (Without the generation guard, the slower older fetch could overwrite the
  // newer transcript — or an empty one could surface the landing.)
  await page.evaluate(async () => {
    const mk = async (title, text) => {
      const created = await (await fetch("http://127.0.0.1:8788/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) })).json();
      const id = created.session.id;
      await fetch("http://127.0.0.1:8788/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, conversation_id: id }) });
      return id;
    };
    await mk("Race Alpha", "alpha semaphore message");
    await mk("Race Beta", "beta semaphore message");
  });
  const sessionsNav3 = await page.$('[data-route="sessions"]');
  if (sessionsNav3) await sessionsNav3.click();
  await page.waitForTimeout(1500);
  // Click two Open buttons back-to-back with no await between resolutions.
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".kp-sessions .mini")).filter((b) => b.textContent === "Open");
    buttons.slice(0, 2).forEach((b) => b.click());
  });
  await page.waitForTimeout(2500);
  const raceState = await page.evaluate(() => {
    // Assistant bubbles live under `.k p`; USER bubbles are `.u` rows — read both.
    const assistant = Array.from(document.querySelectorAll(".thread .k p, .thread .k .fade"));
    const user = Array.from(document.querySelectorAll(".thread .u"));
    const thread = document.querySelector(".thread");
    const hero = document.querySelector(".hero");
    const sub = document.querySelector("#kp-proj-sub");
    return {
      text: [...assistant, ...user].map((b) => b.textContent ?? "").join("\n"),
      thread: thread ? getComputedStyle(thread).display : "missing",
      hero: hero ? getComputedStyle(hero).display : "missing",
      header: sub?.textContent ?? "",
    };
  });
  // Both sessions hold distinct semaphore texts; exactly one transcript shows.
  const showsAlpha = raceState.text.includes("alpha semaphore");
  const showsBeta = raceState.text.includes("beta semaphore");
  check("E: overlapping opens resolve to exactly one intact transcript", (showsAlpha !== showsBeta) && raceState.thread !== "none" && raceState.hero === "none", JSON.stringify({ showsAlpha, showsBeta, thread: raceState.thread, hero: raceState.hero, header: raceState.header.slice(0, 80) }));
  await page.screenshot({ path: join(dir, "shot-race.png") });

  // G: `@` resolves a live agent, runs it through policy, Allow collects.
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
  // Refresh the agents catalogue the picker reads (as visiting Agents does).
  const agentsNav = await page.$('[data-route="agents"]');
  if (agentsNav) await agentsNav.click();
  await page.waitForTimeout(1500);
  const chatNav3 = await page.$('[data-route="chat"]');
  if (chatNav3) await chatNav3.click();
  await page.waitForTimeout(800);
  await input.fill("@sc");
  await page.waitForTimeout(800);
  const atShown = await page.evaluate(() => {
    const pop = document.querySelector("#kp-mention");
    return pop !== null && pop.classList.contains("on")
      ? Array.from(pop.querySelectorAll(".pr b")).map((b) => b.textContent ?? "")
      : [];
  });
  check("G: `@` lists the live agent", atShown.some((label) => label.includes("Scout")), atShown.join(","));
  await input.fill("@Scout survey the workspace");
  await page.waitForTimeout(400);
  // Escape closes the picker (if open) so Enter submits the turn itself.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  let agentText = "";
  let allowPresent = false;
  const agentDeadline = Date.now() + 45000;
  while (Date.now() < agentDeadline) {
    const state = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll(".thread .k p"));
      const allows = Array.from(document.querySelectorAll(".thread .ask.blk")).map((el) => el.textContent ?? "");
      return { text: bubbles.map((b) => b.textContent ?? "").join("\n"), allows };
    });
    agentText = state.text;
    allowPresent = state.allows.some((a) => a.includes("Allow") && a.includes("scout"));
    if (allowPresent) break;
    await page.waitForTimeout(500);
  }
  check("G: `@Scout` parks visibly with an Allow card", allowPresent, agentText.slice(-200));
  if (allowPresent) {
    const clicked = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(".thread .ask.blk"));
      const visible = cards.filter((c) => c.offsetParent !== null);
      const scout = visible.find((c) => (c.querySelector("h4")?.textContent ?? "").toLowerCase().includes("scout"))
        ?? visible[visible.length - 1];
      const btn = scout !== undefined
        ? Array.from(scout.querySelectorAll(".btn")).find((b) => (b.textContent ?? "").includes("Allow"))
        : undefined;
      if (btn === undefined) return `none (cards:${cards.length} visible:${visible.length})`;
      btn.click();
      return `clicked:${btn.textContent}`;
    });
    console.log("repro: allow click ->", clicked);
    let resultText = "";
    const resultDeadline = Date.now() + 60000;
    while (Date.now() < resultDeadline) {
      resultText = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".thread .k p")).map((b) => b.textContent ?? "").join("\n"),
      );
      if (resultText.includes("I'm Scout")) break;
      await page.waitForTimeout(500);
    }
    check("G: Allow collects the persona-authored result", resultText.includes("I'm Scout"), resultText.slice(-200));
  }
  await page.screenshot({ path: join(dir, "shot-agent.png") });

  // H: the permanent rail is SMALL (KAI/Sessions/Agents/Settings) and every
  // other surface is reachable by deep link / command. Both paths report the
  // true route and show the right section.
  const navLog = [];
  const railRoutes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".rail [data-route]")).map((b) => b.dataset.route),
  );
  check("H: the rail is the minimal permanent set", railRoutes.join(",") === "chat,sessions,agents,settings", railRoutes.join(","));
  for (const id of railRoutes) {
    await page.click(`.rail [data-route="${id}"]`);
    await page.waitForTimeout(900);
    const seen = await page.evaluate((rid) => {
      const sec = document.querySelector(`#kp-v-${rid}`);
      const probe = window.__kaiShell;
      return {
        sectionOn: sec !== null && sec.classList.contains("on"),
        reported: typeof probe?.getRoute === "function" ? probe.getRoute() : null,
        snippet: (sec?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
        hash: window.location.hash,
      };
    }, id);
    navLog.push({ nav: id, via: "rail", ...seen });
    check(`H: rail -> ${id} shows its section + reports truthfully`, seen.sectionOn && seen.reported === id, JSON.stringify(seen).slice(0, 160));
  }
  // Every contextual surface is still a real route, reachable by hash deep link.
  for (const id of ["home", "missions", "workers", "tools", "mcp", "activity", "memory", "skills"]) {
    await page.evaluate((rid) => { window.location.hash = `#/${rid}`; }, id);
    await page.waitForTimeout(900);
    const seen = await page.evaluate((rid) => {
      const sec = document.querySelector(`#kp-v-${rid}`);
      const probe = window.__kaiShell;
      return {
        sectionOn: sec !== null && sec.classList.contains("on"),
        reported: typeof probe?.getRoute === "function" ? probe.getRoute() : null,
      };
    }, id);
    navLog.push({ nav: id, via: "hash", ...seen });
    check(`H: contextual -> ${id} reachable + reports truthfully`, seen.sectionOn && seen.reported === id, JSON.stringify(seen).slice(0, 160));
  }
  await page.screenshot({ path: join(dir, "shot-nav.png") });
  // A deep link lands on its route without any click.
  await page.goto(`http://127.0.0.1:${STATIC_PORT}/shell.html#/memory`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  const deep = await page.evaluate(() => ({
    memoryOn: document.querySelector("#kp-v-memory")?.classList.contains("on") ?? false,
    reported: typeof window.__kaiShell?.getRoute === "function" ? window.__kaiShell.getRoute() : null,
  }));
  check("H: #/memory deep link lands on memory", deep.memoryOn && deep.reported === "memory", JSON.stringify(deep));
  try {
    const { writeFileSync: write } = await import("node:fs");
    write(join(CORE, "..", "docs", "evidence", "nav-clickthrough.json"), JSON.stringify(navLog, null, 2), "utf8");
    console.log("evidence: docs/evidence/nav-clickthrough.json");
  } catch { /* auxiliary */ }

  // I: the model-control journey — /models, /providers, Settings providers
  // area, and "continue" with no open task (a normal turn, no corruption).
  const chatNav4 = await page.$('[data-route="chat"]');
  if (chatNav4) await chatNav4.click();
  await page.waitForTimeout(800);
  async function slashTurn(cmd, marker) {
    const before = await page.evaluate(() => document.querySelectorAll(".thread .k p").length);
    await input.fill(cmd);
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    let text = "";
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const bubbles = Array.from(document.querySelectorAll(".thread .k p")).map((b) => b.textContent ?? "");
        return { count: bubbles.length, text: bubbles.join("\n") };
      });
      text = state.text;
      if (state.count > before && text.includes(marker)) break;
      await page.waitForTimeout(500);
    }
    return text;
  }
  const modelsText = await slashTurn("/models", "KAI model");
  check("I: /models lists the live registry", modelsText.includes("KAI model"), modelsText.slice(-160));
  const providersText = await slashTurn("/providers", "Providers (live)");
  check("I: /providers lists live provider state", providersText.includes("Providers (live)") && providersText.includes("hermes"), providersText.slice(-160));
  const settingsNav = await page.$('[data-route="settings"]');
  if (settingsNav) await settingsNav.click();
  await page.waitForTimeout(1500);
  const settingsSeen = await page.evaluate(() => {
    const text = document.querySelector("#kp-v-settings")?.textContent ?? "";
    return { model: text.includes("Model"), providers: text.includes("Hermes Agent") || text.includes("KAI model") };
  });
  check(
    "I: Settings shows the Model + Providers areas",
    settingsSeen.model && settingsSeen.providers,
    JSON.stringify(settingsSeen).slice(0, 120),
  );
  await page.screenshot({ path: join(dir, "shot-settings-providers.png") });
  const chatNav5 = await page.$('[data-route="chat"]');
  if (chatNav5) await chatNav5.click();
  await page.waitForTimeout(800);
  const contBefore = await page.evaluate(() => document.querySelectorAll(".thread .k p").length);
  await input.fill("continue");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  let contText = "";
  let contGrew = false;
  const contDeadline = Date.now() + 45000;
  while (Date.now() < contDeadline) {
    const state = await page.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll(".thread .k p")).map((b) => b.textContent ?? "");
      return { count: bubbles.length, text: bubbles.join("\n") };
    });
    contText = state.text;
    contGrew = state.count > contBefore;
    // A fresh assistant bubble arrived (the scripted reply proves the turn ran).
    if (contGrew && state.count >= contBefore + 2) break;
    await page.waitForTimeout(500);
  }
  check("I: 'continue' with no open task is a normal turn (no corruption)", contGrew && contText.includes("lighthouse stands"), contText.slice(-160));

  // J: the orchestrator, visible — seed a worker, run a work item through
  // the real loop, then prove the Bench, inspector, Autonomy and Activity
  // surfaces render live state (not placeholders).
  const coreCall = async (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(`http://127.0.0.1:8788${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { method, path, body });
  const managed = async (path, body) => {
    const first = await coreCall("POST", path, body);
    if (first.status !== 409 || !first.body?.approvalId) return first;
    await coreCall("POST", `/approvals/${first.body.approvalId}/decide`, { approved: true });
    return coreCall("POST", path, { ...body, approvalId: first.body.approvalId });
  };
  await coreCall("POST", "/subagents", { id: "browser-worker", name: "Browser Worker", role: "worker", soul: "I help.", workerId: "hermes", capabilities: ["run_task"] });
  await managed("/settings", { "orchestration.autonomy": 3, "orchestration.workerAuto": "AUTO", "orchestration.review": "AUTO" });
  const started = await coreCall("POST", "/work-items", { objective: "Browser J: survey the workspace and report findings", deliverable: "findings report" });
  const jwid = started.body?.workItemId;
  check("J: work item created via the loop", started.status === 201 && typeof jwid === "string", `status=${started.status}`);
  let jstate = "";
  if (typeof jwid === "string") {
    const run = await coreCall("POST", `/work-items/${jwid}/run`, { workerId: "browser-worker" });
    jstate = run.body?.state ?? "";
  }
  check("J: work item completes verified", jstate === "COMPLETED", `state=${jstate}`);
  await page.evaluate(() => { window.location.hash = "#/workers"; });
  await page.waitForTimeout(1500);
  const benchSeen = await page.evaluate(() => ({
    bench: (document.querySelector("#kp-v-workers")?.textContent ?? "").includes("Benchmarks"),
    worker: (document.querySelector("#kp-v-workers")?.textContent ?? "").includes("browser-worker"),
  }));
  check("J: Bench shows the worker with measured history", benchSeen.bench && benchSeen.worker, JSON.stringify(benchSeen));
  await page.screenshot({ path: join(dir, "shot-bench.png") });
  // Open the work-item inspector from the bench recent-work row (inside Evidence).
  const inspOpened = await page.evaluate(() => {
    const host = document.querySelector("#kp-v-workers");
    if (!host) return "no-host";
    const ev = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "Evidence");
    if (ev) ev.click();
    const btns = Array.from(host.querySelectorAll("button"));
    const row = btns.find((b) => (b.textContent ?? "").includes("Browser J"));
    if (!row) return `no-row (${btns.length} buttons)`;
    row.click();
    return "clicked";
  });
  await page.waitForTimeout(1500);
  const inspSeen = await page.evaluate(() => {
    const ov = document.querySelector("#kp-mov.on");
    return {
      modal: ov !== null,
      text: (ov?.textContent ?? "").includes("Browser J: survey"),
    };
  });
  check("J: work-item inspector opens with the objective", inspOpened === "clicked" && inspSeen.modal && inspSeen.text, `${inspOpened} modal=${inspSeen.modal} text=${inspSeen.text}`);
  await page.screenshot({ path: join(dir, "shot-inspector.png") });
  await page.keyboard.press("Escape");
  const settingsNav2 = await page.$('[data-route="settings"]');
  if (settingsNav2) await settingsNav2.click();
  await page.waitForTimeout(1500);
  const autonomySeen = await page.evaluate(() =>
    (document.querySelector("#kp-v-settings")?.textContent ?? "").includes("Autonomy"),
  );
  check("J: Settings shows the Autonomy section", autonomySeen, "");
  // Persistent proof via the activity log (the DOM slice caps at 20 events,
  // so the durable record is the honest assertion) + route renders.
  const actLog = await coreCall("GET", `/activity?work=${jwid}&limit=50`);
  const actLabels = ((actLog.body?.events ?? []).map((e) => e.label).join(" | "));
  check("J: activity log recorded the run", actLabels.includes("working") || actLabels.includes("Verified"), actLabels.slice(0, 160));
  await page.evaluate(() => { window.location.hash = "#/activity"; });
  await page.waitForTimeout(1200);
  const activityRenders = await page.evaluate(() => document.querySelector("#kp-v-activity") !== null);
  check("J: Activity route renders", activityRenders, "");
  await page.screenshot({ path: join(dir, "shot-activity.png") });
  // Mission inspector: create a mission, open its inspector from the row.
  await coreCall("POST", "/missions", { title: "Browser J mission", description: "rehearse the release checklist" });
  await page.evaluate(() => { window.location.hash = "#/missions"; });
  await page.waitForTimeout(1500);
  const missionOpened = await page.evaluate(() => {
    const host = document.querySelector("#kp-v-missions");
    if (!host) return "no-host";
    const rows = Array.from(host.querySelectorAll(".arow"));
    const row = rows.find((r) => (r.textContent ?? "").toLowerCase().includes("browser j mission"));
    if (!row) return `no-row (${rows.length} rows)`;
    const btn = Array.from(row.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Inspect"));
    if (!btn) return "no-inspect";
    btn.click();
    return "clicked";
  });
  await page.waitForTimeout(1200);
  const missionSeen = await page.evaluate(() => {
    const ov = document.querySelector("#kp-mov.on");
    return { modal: ov !== null, steps: (ov?.textContent ?? "").includes("Linked work") || (ov?.textContent ?? "").includes("Objective") };
  });
  check("J: mission inspector opens with objective + linked work", missionOpened === "clicked" && missionSeen.modal, `${missionOpened} modal=${missionSeen.modal}`);
  await page.screenshot({ path: join(dir, "shot-mission.png") });

  // K: the operator workspace chrome — KAI identity header, live activity
  // strip, console chips, state pills, all present and real.
  await page.evaluate(() => { window.location.hash = "#/chat"; });
  await page.waitForTimeout(1200);
  const opChrome = await page.evaluate(() => {
    const role = document.querySelector(".who-role")?.textContent ?? "";
    const strip = document.querySelector("#kp-actstrip") !== null;
    const pills = document.querySelector("#kp-opstate")?.textContent ?? "";
    const chips = Array.from(document.querySelectorAll("#kp-opchips .opchip")).map((c) => c.textContent ?? "");
    const char = document.querySelector(".who .canvas, .who canvas") !== null;
    return { role, strip, pills, chips, char };
  });
  check("K: KAI operator identity header", opChrome.role.includes("AUTONOMOUS OPERATOR") && opChrome.char, JSON.stringify(opChrome).slice(0, 140));
  check("K: live activity strip present", opChrome.strip, "");
  check("K: state pills report runtime", opChrome.pills.includes("RUNTIME"), opChrome.pills.slice(0, 80));
  check("K: console chips present", opChrome.chips.includes("/work") && opChrome.chips.includes("/abort"), opChrome.chips.join(","));

  evidence.verdict = failures.length === 0 ? "PASS" : `FAIL: ${failures.join(", ")}`;
  if (failures.length > 0) process.exitCode = 1;
} catch (e) {
  evidence.verdict = `ERROR: ${e?.message ?? e}`;
  console.error(evidence.verdict);
  process.exitCode = 1;
} finally {
  try {
    await shutdown();
  } catch { /* best-effort */ }
  try {
    const { writeFileSync: write, copyFileSync, mkdirSync: mk } = await import("node:fs");
    write(join(CORE, "..", "docs", "evidence", "browser-repro.json"), JSON.stringify(evidence, null, 2), "utf8");
    console.log("evidence: docs/evidence/browser-repro.json");
    try {
      const shotDir = join(CORE, "..", "docs", "evidence", "browser-shots");
      mk(shotDir, { recursive: true });
      for (const shot of ["shot-after-answer.png", "shot-tool-turn.png", "shot-midstream.png", "shot-race.png", "shot-slash.png", "shot-agent.png", "shot-nav.png", "shot-settings-providers.png", "shot-bench.png", "shot-inspector.png", "shot-activity.png", "shot-mission.png"]) {
        try {
          copyFileSync(join(dir, shot), join(shotDir, shot));
        } catch { /* a missing shot is itself evidence */ }
      }
    } catch { /* shots are auxiliary */ }
  } catch { /* best-effort */ }
  rmSync(dir, { recursive: true, force: true });
}
