// The rendering corpus: every pure renderer the UI uses, fed representative +
// adversarial inputs. The contract per case: never throws, never returns empty
// for non-empty input, escapes hostile HTML, is byte-stable, and stays within
// a time budget on large inputs.
//
//   cd app && node --test tests/render-corpus.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

// The markdown renderer reads `window.LinkChip` (an optional browser
// enhancement) at call time. A bare object documents that seam: without the
// enhancement every link renders as a plain `<a>`.
(globalThis as Record<string, unknown>).window ??= {};

import { blocks, inline } from "../src/chat/vendor/markdown.ts";
import { describeToolActivity, describeToolCall } from "../src/chat/tool-card.ts";
import { deriveSessionTitle, sessionDisplayTitle } from "../src/chat/title.ts";
import { buildSessionViews, summariseSessions } from "../src/chat/sessions-model.ts";
import { describeTool } from "../src/views/tools.ts";
import { credentialKeys, serverStatus, serverTarget } from "../src/views/mcp.ts";
import { filterActivity, groupColor, relativeTime } from "../src/views/activity.ts";
import type { McpServerSummary } from "../src/workspace/types.ts";
import type { WorkspaceEventRow } from "../src/workspace/store.ts";

// ── markdown ────────────────────────────────────────────────────────────────

const MARKDOWN_CASES: Array<{ name: string; input: string }> = [
  { name: "empty", input: "" },
  { name: "plain", input: "hello world" },
  { name: "headings", input: "# One\n## Two\n### Three" },
  { name: "nested-list", input: "- a\n  - b\n    - c\n1. one\n2. two" },
  { name: "fence-lang", input: "```ts\nconst x: number = 1;\n```" },
  { name: "fence-bare", input: "```\nplain\n```" },
  { name: "fence-unclosed", input: "```py\ndef f():\n  still code" },
  { name: "table", input: "| a | b |\n|---|---|\n| 1 | 2 |" },
  { name: "quote", input: "> cited\n> twice" },
  { name: "math", input: "inline $x^2$ and display $$\\sum_{i} i$$" },
  { name: "links", input: "[kai](https://example.com) ![alt](https://example.com/x.png)" },
  { name: "inline-code", input: "use `rm -rf` carefully" },
  { name: "script-injection", input: "<script>alert(1)</script>" },
  { name: "img-injection", input: '<img src=x onerror="alert(1)">' },
  { name: "event-handler", input: '<div onclick="evil()">text</div>' },
  { name: "crlf-bom", input: "\uFEFFfirst\r\nsecond\rthird" },
  { name: "astral", input: "emoji 🎉 flag 🇩🇪 math 𝔘 zalgo c̶o̶m̶b̶" },
  { name: "long-word", input: "a".repeat(10000) },
  { name: "many-blocks", input: Array.from({ length: 500 }, (_, i) => `# H${i}\ntext ${i}`).join("\n") },
  { name: "live-partial-fence", input: "text\n```ts\nconst x = " },
  { name: "js-link", input: "[click](javascript:alert(1))" },
  { name: "data-link", input: "[img](data:text/html,<script>alert(1)</script>)" },
  { name: "vbscript-link", input: "[x](vbscript:msgbox(1))" },
  { name: "autolink-js", input: "javascript:alert(1)" },
  { name: "unclosed-link", input: "[half](https://example.com" },
  { name: "unclosed-bold", input: "this is **bold without end" },
  { name: "unclosed-table", input: "| a | b |\n| 1 | 2" },
  { name: "nested-fence", input: "````\n```\ninner\n```\n````" },
  { name: "fence-info-xss", input: '```<img src=x onerror=y>\ncode\n```' },
  { name: "math-unclosed", input: "value $x^2 and more" },
  { name: "math-evil", input: "$\\htmlData{<img src=x onerror=y>}$" },
  { name: "checklist", input: "- [ ] todo\n- [x] done" },
  { name: "visual-marker", input: "▦ diagram\n{\"kind\":\"x\"}" },
];

test("markdown blocks: every corpus case renders without throwing", () => {
  for (const c of MARKDOWN_CASES) {
    const live = c.name === "live-partial-fence";
    const out = blocks(c.input, { live });
    assert.ok(Array.isArray(out), `${c.name}: array`);
    if (c.input.length > 0) assert.ok(out.join("").length > 0, `${c.name}: non-empty`);
  }
});

test("markdown blocks: hostile HTML is escaped, never passed through", () => {
  // Executable forms only: escaped text (`&lt;img … onerror=&quot;…`) still
  // CONTAINS the substring, inertly — asserting on it would be the test lying.
  for (const name of ["script-injection", "img-injection", "event-handler"]) {
    const html = blocks(MARKDOWN_CASES.find((c) => c.name === name)!.input).join("");
    assert.ok(!html.includes("<script"), `${name}: no script tag`);
    assert.ok(!html.includes("<img"), `${name}: no raw img tag`);
    assert.ok(!html.includes('onerror="'), `${name}: no live event handler`);
    assert.ok(!html.includes('onclick="'), `${name}: no live click handler`);
  }
});

test("markdown blocks: byte-stable across runs", () => {
  for (const c of MARKDOWN_CASES) {
    const a = blocks(c.input).join("");
    const b = blocks(c.input).join("");
    assert.equal(a, b, `${c.name}: stable`);
  }
});

test("markdown blocks: large input stays within budget", () => {
  const big = `${"# Title\n\nSome prose with `code` and **bold**.\n\n"}`.repeat(2000);
  const start = Date.now();
  const out = blocks(big).join("");
  const ms = Date.now() - start;
  assert.ok(ms < 5000, `500KB renders in ${ms}ms`);
  assert.ok(out.length > big.length, "output is real HTML, not dropped");
});

test("markdown inline: formatting renders, hostile input escapes", () => {
  const html = inline("**bold** *it* `code` [t](https://e.com)");
  assert.ok(html.length > 0);
  const evil = inline('<script>alert(1)</script>');
  assert.ok(!evil.includes("<script"));
  assert.ok(!inline('<img src=x onerror="y">').includes("<img"));
});

test("markdown blocks: malicious link schemes degrade to text, never href", () => {
  for (const name of ["js-link", "data-link", "vbscript-link"]) {
    const html = blocks(MARKDOWN_CASES.find((c) => c.name === name)!.input).join("");
    // Escaped literal text may still NAME the scheme inertly — what must never
    // exist is a live href carrying one, or a live tag/handler.
    assert.ok(!/href\s*=\s*"[^"]*javascript:/i.test(html), `${name}: no js href`);
    assert.ok(!/href\s*=\s*"data:/i.test(html), `${name}: no data href`);
    assert.ok(!/href\s*=\s*"vbscript:/i.test(html), `${name}: no vbscript href`);
    assert.ok(!html.includes("<script"), `${name}: no script tag`);
    assert.ok(!html.includes("<img"), `${name}: no raw img tag`);
  }
  // Safe links still link.
  const ok = blocks("[kai](https://example.com)").join("");
  assert.ok(ok.includes('href="https://example.com"'), "https links survive");
});

test("markdown blocks: malformed + incomplete streaming input never throws or leaks", () => {
  for (const name of ["unclosed-link", "unclosed-bold", "unclosed-table", "nested-fence", "fence-info-xss", "math-unclosed", "math-evil", "live-partial-fence"]) {
    const input = MARKDOWN_CASES.find((c) => c.name === name)!.input;
    for (const live of [false, true]) {
      const html = blocks(input, { live }).join("");
      assert.ok(!html.includes("<script"), `${name}/live=${live}: no script tag`);
      assert.ok(!html.includes("<img"), `${name}/live=${live}: no raw img tag`);
      assert.ok(!/on\w+\s*=\s*"/.test(html), `${name}/live=${live}: no event handler`);
    }
  }
  // An incomplete fence still renders its code block live (streaming must not
  // swallow it). Syntax highlighting inserts spans mid-text, so assert on the
  // code-block structure + the escaped code words, not a raw substring.
  const partial = blocks("text\n```ts\nconst x = ", { live: true }).join("");
  assert.ok(partial.includes("md-code"), "partial fence renders its code block live");
  assert.ok(partial.includes("const") && partial.includes("x ="), "partial fence code stays visible");
});

test("markdown blocks: checklists, markers and math shapes render", () => {
  const checks = blocks("- [ ] todo\n- [x] done").join("");
  assert.ok(checks.includes("md-task"), "checklist items marked");
  assert.ok(checks.includes("is-done"), "completed item marked");
  const marker = blocks("▦ diagram\nplain").join("");
  assert.ok(!marker.includes("<script"), "marker line is inert text");
  const math = blocks("inline $x^2$ end").join("");
  assert.ok(math.includes("md-imath"), "inline math renders");
});

// ── tool cards ──────────────────────────────────────────────────────────────

test("describeToolCall: canonical ids, statuses, hostile args", () => {
  const ok = describeToolCall({
    toolName: "filesystem_search",
    toolId: "filesystem.search",
    status: "EXECUTED",
    arguments: JSON.stringify({ query: "lighthouse", path: "C:\\x" }),
    result: { matches: [1, 2] },
  });
  assert.equal(ok.name, "filesystem.search");
  assert.equal(ok.glyph, "✓");
  assert.match(ok.detail, /lighthouse/);

  const parked = describeToolCall({
    toolName: "shell_run",
    status: "APPROVAL_REQUIRED",
    arguments: "{}",
    approvalId: "apr_1",
  });
  assert.equal(parked.glyph, "…");
  assert.match(parked.detail, /apr_1/);

  const hostile = describeToolCall({
    toolName: "<img src=x onerror=y>",
    status: "FAILED",
    arguments: "<script>alert(1)</script>",
  });
  assert.equal(hostile.glyph, "✕");
  assert.ok(!JSON.stringify(hostile).includes("<script>"));

  const huge = describeToolCall({ toolName: "t", status: "EXECUTED", arguments: "z".repeat(200000) });
  assert.ok(huge.detail.length < 10000, "giant args do not explode the card");
});

test("describeToolActivity: known ids read as actions, unknown ids are named, never blank", () => {
  assert.equal(describeToolActivity("filesystem.search", "filesystem_search"), "searching files");
  assert.equal(describeToolActivity("mcp.echo.echo", "mcp_echo_echo"), "calling MCP echo.echo");
  const weird = describeToolActivity(undefined, "");
  assert.ok(weird.length > 0);
});

// ── titles ──────────────────────────────────────────────────────────────────

test("session titles: degenerate inputs, caps, pass-through", () => {
  assert.equal(deriveSessionTitle(null), null);
  assert.equal(deriveSessionTitle("   "), null);
  // A bare pleasantry is not a topic — the caller keeps Core's title.
  assert.equal(deriveSessionTitle("hello"), null);
  for (const input of ["plan my trip to paris", "a".repeat(500), "line one\nline two", "  spaced  ", "🎉 party time"]) {
    const derived = deriveSessionTitle(input);
    assert.ok(derived !== null && derived.length >= 2 && derived.length <= 68, JSON.stringify(input));
  }
  // A real stored title passes through untouched (escaping is the sink's job —
  // the DOM layer sets textContent, never innerHTML, for titles).
  const kept = sessionDisplayTitle("<script>x</script>", null);
  assert.deepEqual(kept, { title: "<script>x</script>", derived: false });
  // A generic placeholder derives from the first user turn, or says so plainly.
  assert.deepEqual(sessionDisplayTitle("New session", "plan my trip"), { title: "Plan my trip", derived: true });
  assert.deepEqual(sessionDisplayTitle("New session", null), { title: "New session", derived: false });
  assert.deepEqual(sessionDisplayTitle(null, null), { title: "New conversation", derived: false });
});

// ── session views ───────────────────────────────────────────────────────────

test("session views: empty, generic, archived and hostile rows", () => {
  const all = { query: "", sort: "recent" as const, includeArchived: true };
  assert.deepEqual(buildSessionViews([], all), []);
  assert.equal(summariseSessions([], 0), "No sessions yet");
  const views = buildSessionViews(
    [
      { id: "a", title: "New session", status: "ACTIVE", active: true, turnCount: 3, updatedAt: "2026-10-06T00:00:00Z" },
      { id: "b", title: "My trip", status: "ARCHIVED", active: false, turnCount: 0, updatedAt: "bad-date" },
    ] as never,
    all,
  );
  assert.equal(views.length, 2);
  assert.equal(views[0]!.id, "a", "the active session leads");
  assert.equal(views[1]!.title, "My trip");
  const hidden = buildSessionViews(
    [{ id: "b", title: "My trip", status: "ARCHIVED", active: false }] as never,
    { query: "", sort: "recent" as const, includeArchived: false },
  );
  assert.deepEqual(hidden, [], "archived sessions hide unless asked");
  const found = buildSessionViews(
    [{ id: "abc", title: "Lighthouse study", status: "ACTIVE", active: false }] as never,
    { query: "LIGHT", sort: "recent" as const, includeArchived: true },
  );
  assert.equal(found.length, 1, "search is case-insensitive");
  assert.ok(summariseSessions(views, 2).includes("active:"));
});

// ── tool + mcp + activity views ─────────────────────────────────────────────

test("describeTool: minimal and hostile descriptions", () => {
  const shown = describeTool({
    id: "filesystem.search",
    name: "Search",
    description: "d",
    permission: "read",
    schema: {},
  } as never);
  assert.ok(JSON.stringify(shown).length > 0);
  const hostile = describeTool({
    id: "<img src=x>",
    name: "<script>",
    description: "<b>",
    permission: "read",
    schema: {},
  } as never);
  assert.ok(!JSON.stringify(hostile).includes("<script>"));
  assert.ok(!JSON.stringify(hostile).includes("<img"));
});

const MCP_BASE: McpServerSummary = {
  name: "echo",
  transport: "stdio",
  command: "node",
  args: ["echo-mcp-server.mjs"],
  envKeys: [],
  enabled: true,
  hasRisk: true,
  connected: true,
  toolCount: 3,
  resourceCount: 2,
};

test("mcp view helpers: the full status matrix + data pass-through", () => {
  // serverStatus derives the chip from Core's declared facts only.
  assert.equal(serverStatus({ ...MCP_BASE, connected: true }).status, "CONNECTED");
  assert.equal(serverStatus({ ...MCP_BASE, connected: false, enabled: false }).status, "DISABLED");
  assert.equal(
    serverStatus({ ...MCP_BASE, connected: false, enabled: true, transport: "sse" }).status,
    "BLOCKED",
  );
  const enabled = serverStatus({ ...MCP_BASE, connected: false, enabled: true });
  assert.equal(enabled.status, "ENABLED");
  assert.equal(enabled.connectable, true);
  assert.ok(enabled.reason.length > 0);
  const norisk = serverStatus({ ...MCP_BASE, connected: false, enabled: true, hasRisk: false });
  assert.equal(norisk.status, "ENABLED");
  assert.match(norisk.reason, /no KAI risk/);
  // serverTarget/credentialKeys are DATA (pass-through); escaping is the sink's
  // job — the DOM layer sets textContent for these, never innerHTML.
  assert.equal(serverTarget(MCP_BASE), "node echo-mcp-server.mjs");
  assert.equal(serverTarget({ ...MCP_BASE, transport: "sse", url: "https://x/mcp" }), "https://x/mcp");
  assert.equal(serverTarget({ ...MCP_BASE, transport: "sse" }), "", "a remote with no url says nothing");
  assert.deepEqual(credentialKeys(MCP_BASE), []);
  assert.deepEqual(credentialKeys({ ...MCP_BASE, envKeys: ["DISCORD_TOKEN"] }), ["DISCORD_TOKEN"]);
  assert.deepEqual(
    credentialKeys({ ...MCP_BASE, transport: "sse", headerKeys: ["Authorization"] }),
    ["Authorization"],
  );
});

test("activity view helpers: unknown types, bad dates, filtering", () => {
  assert.ok(groupColor("something-never-seen").length > 0, "unknown types still get a colour");
  // A bad date says nothing rather than inventing a time — pinned, not fixed.
  assert.equal(relativeTime("not-a-date"), "");
  assert.ok(relativeTime(new Date(Date.now() + 60000).toISOString()).length > 0);
  assert.equal(relativeTime(new Date(Date.now() - 10000).toISOString()), "just now");
  const rows = [
    { id: "1", type: "tool", line: "searched files", text: "searched files", timestamp: "2026-10-06T00:00:00Z", worker: null },
    { id: "2", type: "approval", line: "parked shell", text: "parked shell", timestamp: "2026-10-06T00:01:00Z", worker: null },
  ] as unknown as WorkspaceEventRow[];
  assert.equal(filterActivity(rows, "all", "").length, 2);
  assert.equal(filterActivity(rows, "all", "parked").length, 1);
  assert.equal(filterActivity(rows, "approvals", "").length, 1);
  assert.equal(filterActivity(rows, "tools", "parked").length, 0);
});
