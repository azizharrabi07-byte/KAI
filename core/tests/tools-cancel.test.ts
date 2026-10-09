// SPDX-License-Identifier: MIT
// Copyright (c) 2026 KAI contributors. MIT licensed (see repository LICENSE).

/**
 * Stop really stops. An AbortSignal through the run → registry → exec chain
 * kills the whole process TREE (not just the direct child), records a real
 * cancelled exit, emits nothing further for that execution, and never reports
 * the turn as complete.
 *
 *   cd core && node --test tests/tools-cancel.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shellRun, setCommandStreamSink } from "../src/tools/workspace.ts";

function pidAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV"], {
        windowsHide: true,
        encoding: "utf8",
      });
      return out.split("\n").some((line) => line.includes(`"${pid}"`));
    }
    execSync(`kill -0 ${pid}`);
    return true;
  } catch {
    return false;
  }
}

test("abort kills the process TREE: neither the child nor its grandchild survives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kai-cancel-"));
  try {
    const selfFile = join(dir, "self.pid");
    const childFile = join(dir, "child.pid");
    // Parent writes both pids, then sleeps; the grandchild sleeps forever.
    // Paths are JSON-encoded into the -e program so backslashes survive.
    const program = [
      "const fs=require('fs');",
      "const {spawn}=require('child_process');",
      `fs.writeFileSync(${JSON.stringify(selfFile)},String(process.pid));`,
      `const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});`,
      `fs.writeFileSync(${JSON.stringify(childFile)},String(c.pid));`,
      "setInterval(()=>{},1000);",
    ].join("");
    const controller = new AbortController();
    const events: string[] = [];
    setCommandStreamSink((event) => {
      events.push(event.type);
    });
    try {
      const run = shellRun(
        { command: process.execPath, args: ["-e", program], cwd: process.cwd(), timeoutMs: 60_000 },
        controller.signal,
      );
      // Let the tree start, then stop it for real.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      controller.abort();
      const result = await run;
      assert.equal(result.cancelled, true, "the result says cancelled");
      assert.equal(result.exitCode, null, "no exit code on a kill");
      assert.equal(result.timedOut, false, "a kill is not a timeout");
    } finally {
      setCommandStreamSink(null);
    }
    const selfPid = Number(readFileSync(selfFile, "utf8"));
    const childPid = Number(readFileSync(childFile, "utf8"));
    assert.ok(Number.isInteger(selfPid) && selfPid > 0, "parent pid recorded");
    assert.ok(Number.isInteger(childPid) && childPid > 0, "grandchild pid recorded");
    // Give the OS a beat to reap, then check the tree is really gone.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(pidAlive(selfPid), false, `parent process ${selfPid} must be dead`);
    assert.equal(pidAlive(childPid), false, `grandchild process ${childPid} must be dead`);
    assert.ok(events.includes("command.exit"), "a real exit event was recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abort-before-start runs nothing: no process, no start event", async () => {
  const controller = new AbortController();
  controller.abort();
  const seen: string[] = [];
  setCommandStreamSink((event) => {
    seen.push(event.type);
  });
  try {
    const result = await shellRun(
      { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd() },
      controller.signal,
    );
    assert.equal(result.cancelled, true);
    assert.equal(result.exitCode, null);
  } finally {
    setCommandStreamSink(null);
  }
  assert.ok(!seen.includes("command.started"), "no child was ever started");
});

test("nothing is emitted for the execution after its cancelled exit", async () => {
  const controller = new AbortController();
  const mine: string[] = [];
  let myId = "";
  setCommandStreamSink((event) => {
    if (myId === "" || event.commandExecutionId === myId) mine.push(event.type);
  });
  try {
    const run = shellRun(
      {
        command: process.execPath,
        args: ["-e", "let i=0;const t=setInterval(()=>{process.stdout.write('tick'+(i++)+'\\n');},50);setTimeout(()=>{clearInterval(t);},30000);"],
        cwd: process.cwd(),
        timeoutMs: 60_000,
      },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    controller.abort();
    await run;
    const exitIndex = mine.lastIndexOf("command.exit");
    assert.ok(exitIndex >= 0, "exit was recorded");
    assert.deepEqual(
      mine.slice(exitIndex + 1),
      [],
      "no stdout/stderr chunks leak after the cancelled exit",
    );
  } finally {
    setCommandStreamSink(null);
  }
});

test("registry invoke with an aborted signal settles CANCELLED without executing", async () => {
  const { createToolRegistry } = await import("../src/tools/registry.ts");
  const { createPolicyEngine } = await import("../src/policies/gate.ts");
  const { createWorkspaceTools } = await import("../src/tools/workspace.ts");
  const registry = createToolRegistry({ policy: createPolicyEngine({ rules: [] }) });
  for (const tool of createWorkspaceTools()) registry.register(tool);
  const started: string[] = [];
  setCommandStreamSink((event) => {
    if (event.type === "command.started") started.push(event.commandExecutionId);
  });
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await registry.invoke(
      "shell.run",
      { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd() },
      { signal: controller.signal, source: "test" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "CANCELLED");
  } finally {
    setCommandStreamSink(null);
  }
  assert.equal(started.length, 0, "the tool body never ran");
});
