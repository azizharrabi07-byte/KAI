// KAI — MAIN WINDOW ACCEPTANCE HARNESS (the 345x9 test).
//
// One call, no external state: launch the real release app detached, measure the
// OS window rectangles of every kai.exe window, identify which one is the main
// application window, drive the island's real "Open KAI" action, re-measure, and
// capture a screenshot per webview. Writes a JSON evidence file and prints it.
//
//   node docs/evidence/kai-window-acceptance.mjs
//
// Nothing here is simulated: every number is read from the launched product.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const APP = "C:/Users/DELL/Desktop/kai/app/target/release/kai.exe";
const CORE = "http://127.0.0.1:8788";
const PORT = 9222;
const UDD = "C:/Users/DELL/.hermes/profiles/kai/cache/scratch/wv2-accept";
const OUTDIR = "C:/Users/DELL/Desktop/kai/docs/evidence";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const evidence = { harness: "kai-window-acceptance", at: new Date().toISOString(), steps: [] };
const say = (s) => { evidence.steps.push(s); console.log("· " + s); };

function ps(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
  });
}

// Every top-level OS window owned by a kai.exe process, with its real rectangle.
function measureWindows() {
  const script = `
$procs = Get-Process kai -ErrorAction SilentlyContinue
if (-not $procs) { '[]'; exit }
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$ids = @{}
foreach ($p in $procs) { $ids[[uint32]$p.Id] = $true }
$list = New-Object System.Collections.ArrayList
$cb = [W2+EnumWindowsProc]{
  param($h,$l)
  $pp = [uint32]0
  [void][W2]::GetWindowThreadProcessId($h,[ref]$pp)
  if ($ids.ContainsKey($pp)) {
    $t = New-Object System.Text.StringBuilder 512; [void][W2]::GetWindowText($h,$t,512)
    $c = New-Object System.Text.StringBuilder 256; [void][W2]::GetClassName($h,$c,256)
    $r = New-Object W2+RECT; [void][W2]::GetWindowRect($h,[ref]$r)
    $w = $r.R - $r.L; $hh = $r.B - $r.T
    if ($w -gt 0 -and $hh -gt 0) {
      $o = [ordered]@{ pid=$pp; hwnd=('0x{0:X}' -f [int64]$h); class=$c.ToString(); title=$t.ToString();
        visible=[W2]::IsWindowVisible($h); x=$r.L; y=$r.T; width=$w; height=$hh; size="$w x $hh" }
      [void]$list.Add((New-Object psobject -Property $o))
    }
  }
  return $true
}
[void][W2]::EnumWindows($cb,[IntPtr]::Zero)
$list | Sort-Object -Property width -Descending | ConvertTo-Json -Depth 3
`;
  const raw = ps(script).trim();
  try { const j = JSON.parse(raw); return Array.isArray(j) ? j : [j]; } catch { return []; }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await res.json()).filter((t) => t.type === "page");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}
let seq = 1;
function cdp(ws, method, params = {}) {
  const mine = seq++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === mine) { ws.removeEventListener("message", onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
}
const evalIn = (ws, expression) => cdp(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then((r) => (r.exceptionDetails ? { __error: r.exceptionDetails.text } : r.result.value));

const GEOM = `({ outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight,
  screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio, docTitle: document.title,
  win: document.body?.dataset?.window ?? null, rootKids: document.getElementById("root")?.childElementCount ?? -1,
  hasShellProbe: !!window.__kaiShell, route: window.__kaiShell ? window.__kaiShell.getRoute() : null,
  text: (document.body?.innerText || "").replace(/\\s+/g," ").slice(0, 200) })`;

async function measurePages() {
  const out = [];
  for (const t of await targets()) {
    const ws = await connect(t.webSocketDebuggerUrl);
    let geom;
    try { geom = await evalIn(ws, GEOM); } catch (e) { geom = { __error: String(e.message) }; }
    const which = t.url.includes("shell.html") ? "main" : t.url.includes("settings") ? "settings" : "island";
    let shot = null;
    try {
      const r = await cdp(ws, "Page.captureScreenshot", { format: "png" });
      const name = `${OUTDIR}/accept-${which}.png`;
      writeFileSync(name, Buffer.from(r.data, "base64"));
      shot = name;
    } catch { /* capture is best-effort */ }
    ws.close();
    out.push({ which, url: t.url, title: t.title, geom, screenshot: shot });
  }
  return out;
}

async function waitFor(cond, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await cond()) return true; } catch { }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function main() {
  try { rmSync(UDD, { recursive: true, force: true }); } catch { }
  mkdirSync(UDD, { recursive: true });

  const started = Date.now();
  const child = spawn(APP, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: UDD,
    },
  });
  child.unref();
  evidence.launch = { path: APP, pid: child.pid, at: new Date(started).toISOString() };
  say(`launched ${APP} pid=${child.pid}`);

  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).ok, 45000, "CDP port");
  say("CDP debug port answered");

  let identity = null;
  try { identity = await (await fetch(`${CORE}/identity`)).json(); } catch { }
  say(`Core /identity: ${identity ? `${identity.buildId} commit ${String(identity.gitCommit).slice(0, 7)} pid ${identity.pid} ${identity.freshness}` : "UNREACHABLE"}`);

  await sleep(3000);
  evidence.windowsAtLaunch = measureWindows();
  say(`windows at launch: ${evidence.windowsAtLaunch.map((w) => `${w.title || w.class} ${w.size} visible=${w.visible}`).join(" | ")}`);

  evidence.pagesAtLaunch = await measurePages();
  for (const p of evidence.pagesAtLaunch) say(`page ${p.which} ${p.url} outer=${p.geom?.outerW}x${p.geom?.outerH} inner=${p.geom?.innerW}x${p.geom?.innerH} dpr=${p.geom?.dpr}`);

  // Drive the island's REAL "Open KAI" (the same Tauri command the button calls).
  const island = (await targets()).find((t) => !t.url.includes("settings") && !t.url.includes("shell.html"));
  let openResult = null;
  if (island) {
    const ws = await connect(island.webSocketDebuggerUrl);
    try {
      openResult = await evalIn(ws, `window.__TAURI_INTERNALS__.invoke("open_main_window").then(()=>"ok").catch(e=>"ERR "+e)`);
    } catch (e) { openResult = "ERR " + e.message; }
    ws.close();
  } else { openResult = "no island target"; }
  evidence.openKai = { invokedIn: "island webview", result: openResult };
  say(`invoked open_main_window in the island webview → ${JSON.stringify(openResult)}`);

  await sleep(2500);
  evidence.windowsAfterOpen = measureWindows();
  say(`windows after Open KAI: ${evidence.windowsAfterOpen.map((w) => `${w.title || w.class} ${w.size} visible=${w.visible}`).join(" | ")}`);
  evidence.pagesAfterOpen = await measurePages();
  for (const p of evidence.pagesAfterOpen) say(`page ${p.which} outer=${p.geom?.outerW}x${p.geom?.outerH} inner=${p.geom?.innerW}x${p.geom?.innerH}`);

  const pick = (pages, which) => pages.find((p) => p.which === which)?.geom ?? null;
  const mainG = pick(evidence.pagesAfterOpen, "main");
  const islandG = pick(evidence.pagesAfterOpen, "island");
  evidence.acceptance = {
    question: "is the main window a real, large application window, and is 345x9 only the island's collapsed strip?",
    mainWindow: mainG ? `${mainG.outerW}x${mainG.outerH} (inner ${mainG.innerW}x${mainG.innerH}, dpr ${mainG.dpr})` : "NO MAIN WINDOW TARGET",
    islandWindow: islandG ? `${islandG.outerW}x${islandG.outerH} (inner ${islandG.innerW}x${islandG.innerH})` : "NO ISLAND TARGET",
    mainIsRealWindow: !!(mainG && mainG.outerW >= 900 && mainG.outerH >= 600),
    mainIs345x9: !!(mainG && mainG.outerW <= 350 && mainG.outerH <= 12),
    osWindows: evidence.windowsAfterOpen.map((w) => ({ title: w.title, class: w.class, size: w.size, visible: w.visible, at: `${w.x},${w.y}` })),
  };
  say(`ACCEPTANCE: main=${evidence.acceptance.mainWindow} island=${evidence.acceptance.islandWindow} mainIsRealWindow=${evidence.acceptance.mainIsRealWindow} mainIs345x9=${evidence.acceptance.mainIs345x9}`);

  const file = `${OUTDIR}/kai-window-acceptance.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`\nwrote ${file}`);
  console.log(`artifacts: ${evidence.pagesAfterOpen.map((p) => p.screenshot).filter(Boolean).join(", ")}`);
}

main().catch((err) => {
  evidence.fatal = String(err && err.message ? err.message : err);
  const file = `${OUTDIR}/kai-window-acceptance.json`;
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log("FATAL: " + evidence.fatal);
  console.log(`wrote ${file}`);
});
