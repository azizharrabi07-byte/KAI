// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Real-browser tests for the CDP transport. Plain `node --test`, no deps.
 *   Run from `core/`:  node --test tests/browser-real.test.ts
 *
 * These drive a REAL Edge/Chrome over the Chrome DevTools Protocol and prove the
 * things the fake transport cannot:
 *
 *   a. a real browser launches, and `observe()` returns semantic element data
 *      (roles/names/values and backend-node refs) — not coordinates — while the
 *      hierarchy still prefers a semantic channel over pixels;
 *   b. `find` + `click` change the real DOM, the change is reported, and the
 *      strategy log shows a semantic strategy with ZERO screenshot calls;
 *   c. `revision()` moves on a real navigation and stays put when nothing happens;
 *   d. typing into an input and reading the value back round-trips;
 *   e. two targets are owned exclusively, keyed by the real CDP target id.
 *
 * If no browser can start on this machine, EVERY test is skipped with the reason
 * (never silently passed) — see `skipReason` below.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createCdpBrowserTransport,
  type CdpBrowserTransport,
} from "../src/capabilities/browser/cdp-transport.ts";
import {
  createBrowserCapability,
  type CallerContext,
} from "../src/capabilities/browser/capability.ts";
import {
  SEMANTIC_STRATEGIES,
  selectStrategy,
  type InteractionStrategy,
} from "../src/capabilities/browser/interaction.ts";
import type { Result, SemanticElement, TargetInfo } from "../src/capabilities/browser/transport.ts";

const AGENT_A: CallerContext = { ownerId: "agent-A" };
const AGENT_B: CallerContext = { ownerId: "agent-B" };

type Capability = ReturnType<typeof createBrowserCapability>;

function mustOk<T>(result: Result<T>): T {
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `expected success, got ${result.error.code}: ${result.error.message}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── A local static fixture under the OS temp dir ──────────────────────────────
//
// It carries the exact semantics the tests assert: a named button, a named
// textbox whose value is mirrored into a visible <output> by a real input
// listener, a combobox and a link. The button's handler mutates the DOM, which is
// what proves click->verify happens against real state.

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>KAI CDP Fixture</title></head>
<body>
  <h1>Fixture</h1>
  <label for="q">Search</label>
  <input id="q" type="text" aria-label="Search" value=""
         oninput="document.getElementById('echo').textContent = this.value">
  <button id="go" type="button"
          onclick="document.getElementById('result').textContent = 'clicked:ready'">Submit</button>
  <select id="pick" aria-label="Pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <a id="lnk" href="#about">About</a>
  <p id="result"></p>
  <output id="echo"></output>
</body></html>`;

const fixtureDir = mkdtempSync(join(tmpdir(), "kai-cdp-test-"));
const fixturePath = join(fixtureDir, "fixture.html");
writeFileSync(fixturePath, FIXTURE_HTML, "utf8");
const FIXTURE_URL = pathToFileURL(fixturePath).href;

/** A second, distinct document so navigation is observable. */
const SECOND_URL = `data:text/html,${encodeURIComponent(
  "<html><head><title>Second Page</title></head><body><h1>Two</h1></body></html>",
)}`;

// ── Launch ONE browser for the whole file; skip with a reason if it will not ──

let transport: CdpBrowserTransport | null = null;
let skipReason: string | false = false;

try {
  const created = await createCdpBrowserTransport({ headless: true, launchTimeoutMs: 30_000 });
  if (created.ok) {
    transport = created.value;
  } else {
    skipReason = `no real browser available over CDP: ${created.error.code}: ${created.error.message}`;
  }
} catch (error) {
  skipReason = `no real browser available over CDP: ${error instanceof Error ? error.message : String(error)}`;
}

after(async () => {
  if (transport !== null) await transport.close();
});

function theTransport(): CdpBrowserTransport {
  assert.ok(transport !== null, `the CDP browser transport must be up (${String(skipReason)})`);
  return transport;
}

function freshCapability(): Capability {
  return createBrowserCapability({ transport: theTransport() });
}

/** Opens the fixture (or a given url) as AGENT_A and returns the target id. */
async function open(capability: Capability, ctx: CallerContext = AGENT_A, url: string = FIXTURE_URL): Promise<string> {
  const opened = mustOk(await capability.invoke("open", { url }, ctx)) as { target: TargetInfo };
  return opened.target.targetId;
}

// ── a. launch + semantic observation ─────────────────────────────────────────

test(
  "a. a real browser launches and observe() returns semantic roles/names (not coordinates)",
  { skip: skipReason },
  async () => {
    const browser = theTransport();

    // The declared affordances are the honest CDP set, and the ladder picks a
    // SEMANTIC rung (native_api), never pixels — while still reporting that
    // screenshots are available as a fallback.
    assert.deepEqual(browser.affordances(), {
      nativeApi: true,
      dom: true,
      accessibility: true,
      semanticUi: false,
      screenshot: true,
    });
    const decision = selectStrategy(browser.affordances());
    assert.equal(decision.strategy, "native_api");
    assert.equal(decision.fallbackToPixels, false);
    assert.ok(SEMANTIC_STRATEGIES.includes(decision.strategy as InteractionStrategy));

    const capability = freshCapability();
    const targetId = await open(capability);
    try {
      const inspection = mustOk(await capability.observe(AGENT_A, { targetId }));
      const page = inspection.page;

      assert.equal(inspection.decision.strategy, "native_api");
      assert.equal(inspection.decision.fallbackToPixels, false);
      assert.ok(page.revision >= 1, "a fresh page has a positive revision");
      assert.match(page.url, /^file:/);
      assert.equal(page.title, "KAI CDP Fixture");

      assert.ok(page.elements !== undefined && page.elements.length > 0, "expected real semantic elements");
      const button = page.elements.find((element) => element.role === "button" && element.name === "Submit");
      assert.ok(button !== undefined, `expected a button named "Submit"; saw ${JSON.stringify(page.elements)}`);
      // A ref is a real backend node id the browser assigned — never a coordinate.
      assert.match(button.ref, /^ax:\d+$/);

      const textbox = page.elements.find((element) => element.role === "textbox");
      assert.ok(textbox !== undefined, "expected a textbox in the fixture");
      assert.equal(textbox.name, "Search");
      assert.equal((button as unknown as Record<string, unknown>).x, undefined, "an observation carries no coordinates");

      // Real page text, straight from the DOM.
      assert.match(page.text ?? "", /Fixture/);
    } finally {
      mustOk(await capability.invoke("close_tab", { targetId }, AGENT_A));
    }
  },
);

// ── b. find + click over a semantic strategy, no screenshot ───────────────────

test(
  "b. find + click changes real DOM state over a semantic strategy, with no screenshot",
  { skip: skipReason },
  async () => {
    const browser = theTransport();
    const shotsBefore = browser.stats().screenshots;
    const capability = freshCapability();
    const targetId = await open(capability);
    try {
      const found = mustOk(await capability.invoke("find", { targetId, query: "Submit" }, AGENT_A)) as {
        matches: SemanticElement[];
        count: number;
        strategy: InteractionStrategy;
      };
      assert.ok(found.count >= 1, "the Submit button must be findable by name");
      assert.equal(found.strategy, "native_api");
      assert.equal(found.matches[0].role, "button");
      const ref = found.matches[0].ref;

      const clicked = mustOk(await capability.invoke("click", { targetId, ref }, AGENT_A)) as {
        changed: boolean;
        strategy: InteractionStrategy;
      };
      assert.equal(clicked.changed, true, "the click changed the page and the transport reported it");
      assert.equal(clicked.strategy, "native_api");

      // Cheap semantic verification: re-read real DOM text, no screenshot.
      const read = mustOk(await capability.invoke("read", { targetId }, AGENT_A)) as { text: string | null };
      assert.match(read.text ?? "", /clicked:ready/);

      // Every decision in the audit trail is semantic; none fell to pixels.
      const log = capability.strategyLog();
      assert.ok(log.length > 0);
      for (const entry of log) {
        assert.ok(
          SEMANTIC_STRATEGIES.includes(entry.strategy as InteractionStrategy),
          `unexpected non-semantic strategy in the log: ${entry.strategy}`,
        );
        assert.equal(entry.fallbackToPixels, false);
      }

      // And the pixel channel was never even touched.
      assert.equal(browser.stats().screenshots, shotsBefore, "no screenshot may be captured while semantics exist");
    } finally {
      mustOk(await capability.invoke("close_tab", { targetId }, AGENT_A));
    }
  },
);

// ── c. revision moves on navigation, stays put otherwise ─────────────────────

test(
  "c. revision() advances on navigation and does not change when nothing happens",
  { skip: skipReason },
  async () => {
    const browser = theTransport();
    const capability = freshCapability();
    const targetId = await open(capability);
    try {
      mustOk(await capability.invoke("wait", { targetId }, AGENT_A));
      await sleep(200);

      const first = mustOk(await browser.revision(targetId));
      const second = mustOk(await browser.revision(targetId));
      assert.equal(second, first, "a re-read with no action must not move the revision");

      const navigated = mustOk(
        await capability.invoke("navigate", { targetId, url: SECOND_URL }, AGENT_A),
      ) as { revision: number };
      assert.ok(navigated.revision > first, `revision should advance on navigation (${first} -> ${navigated.revision})`);

      await sleep(250);
      const third = mustOk(await browser.revision(targetId));
      const fourth = mustOk(await browser.revision(targetId));
      assert.equal(fourth, third, "the revision must settle once the navigation is done");
      assert.ok(third > first, "the post-navigation revision is strictly greater");

      const read = mustOk(await capability.invoke("read", { targetId }, AGENT_A)) as { title: string };
      assert.equal(read.title, "Second Page");
    } finally {
      mustOk(await capability.invoke("close_tab", { targetId }, AGENT_A));
    }
  },
);

// ── d. type + read back ──────────────────────────────────────────────────────

test(
  "d. type into an input and read the value back",
  { skip: skipReason },
  async () => {
    const capability = freshCapability();
    const targetId = await open(capability);
    try {
      mustOk(await capability.invoke("wait", { targetId }, AGENT_A));

      const before = mustOk(await capability.observe(AGENT_A, { targetId }));
      const textbox = before.page.elements?.find((element) => element.role === "textbox");
      assert.ok(textbox !== undefined, "expected a textbox in the fixture");

      const typed = mustOk(
        await capability.invoke("type", { targetId, ref: textbox.ref, text: "hello kai" }, AGENT_A),
      ) as { changed: boolean };
      assert.equal(typed.changed, true, "typing is a state change");

      const after = mustOk(await capability.observe(AGENT_A, { targetId }));
      const again = after.page.elements?.find((element) => element.ref === textbox.ref);
      assert.ok(again !== undefined, "the textbox should still be observable at the same ref");
      assert.equal(again.value, "hello kai", "the value read back must be what was typed");
      // The fixture mirrors the value into <output id="echo"> via a real input
      // listener, so the page text proves the DOM really received the typing.
      assert.match(after.page.text ?? "", /hello kai/);
    } finally {
      mustOk(await capability.invoke("close_tab", { targetId }, AGENT_A));
    }
  },
);

// ── e. exclusive ownership of two real targets ───────────────────────────────

test(
  "e. two targets are owned exclusively, keyed by the real CDP target id",
  { skip: skipReason },
  async () => {
    const browser = theTransport();
    const capability = freshCapability();
    const first = await open(capability);
    const second = await open(capability);
    try {
      assert.notEqual(first, second, "two opens are two distinct CDP targets");

      // Both ids are real: the browser reports them back.
      const listed = mustOk(await browser.listTargets());
      const ids = listed.map((info) => info.targetId);
      assert.ok(ids.includes(first), "target one must be a real, listed CDP target");
      assert.ok(ids.includes(second), "target two must be a real, listed CDP target");

      // AGENT_A holds exactly both leases; AGENT_B holds none.
      const leases = capability.leases();
      assert.equal(leases.filter((lease) => lease.ownerId === "agent-A").length, 2);
      assert.equal(capability.activeTarget("agent-A"), second, "the last opened target is the active one");

      // B may not drive A's target, and the refusal names both owners.
      const denied = await capability.invoke("navigate", { targetId: first, url: SECOND_URL }, AGENT_B);
      assert.equal(denied.ok, false);
      if (!denied.ok) {
        assert.equal(denied.error.code, "POLICY_DENIED");
        assert.match(denied.error.message, /agent-A/);
        assert.match(denied.error.message, /agent-B/);
      }

      // A still owns it: A's own action succeeds.
      const owned = mustOk(await capability.invoke("read", { targetId: first }, AGENT_A)) as { targetId: string };
      assert.equal(owned.targetId, first);
    } finally {
      mustOk(await capability.invoke("close_tab", { targetId: first }, AGENT_A));
      mustOk(await capability.invoke("close_tab", { targetId: second }, AGENT_A));
    }
  },
);
