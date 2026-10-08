// Convert a point inside the island page into screen coordinates and drive the
// REAL Windows cursor there (the island reads GetCursorPos, not DOM mousemove),
// then optionally click.
//
//   node ui-click.mjs "<css selector>" [--click] [--shot out.png] [--wait ms]
//   node ui-click.mjs --xy <cssX> <cssY> [--click]
//
// The conversion is done from measured values at run time:
//   window rect   -> win-input.ps1 -Action rect   (physical pixels, physical origin)
//   viewport      -> document.documentElement.clientWidth  (CSS pixels)
//   factor        = window physical width / viewport CSS width
// so it stays correct whatever the display scaling does.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PS = join(HERE, "win-input.ps1");

function ps(action, extra = []) {
  const out = execFileSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS, "-Action", action, ...extra,
  ], { encoding: "utf8" });
  return JSON.parse(out.trim());
}

function cdp(args) {
  const out = execFileSync("node", [join(HERE, "cdp.mjs"), ...args], { encoding: "utf8" });
  return out.trim();
}

function evalJs(expr, target) {
  const args = ["eval", expr];
  if (target) args.push("--target", target);
  return JSON.parse(cdp(args));
}

/** The HWND rect for the window we are driving: the island, or the settings window. */
function windowRect(target) {
  if (target === "settings") {
    const list = ps("windows");
    const win = list.find((w) => w.title.includes("Settings") && w.width > 0);
    if (!win) throw new Error("settings window not found in the kai process");
    return win;
  }
  return ps("rect");
}

function currentViewport(target) {
  return evalJs("JSON.stringify({w:document.documentElement.clientWidth,h:document.documentElement.clientHeight})", target);
}

function toScreen(cssX, cssY, target) {
  const rect = windowRect(target);
  const vp = currentViewport(target);
  const factor = rect.width / vp.w;
  return {
    x: Math.round(rect.left + cssX * factor),
    y: Math.round(rect.top + cssY * factor),
    factor,
    rect,
    vp,
  };
}

const argv = process.argv.slice(2);
const doClick = argv.includes("--click");
const targetIdx = argv.indexOf("--target");
const targetName = targetIdx >= 0 ? argv[targetIdx + 1] : "island";
const shotIdx = argv.indexOf("--shot");
const shot = shotIdx >= 0 ? argv[shotIdx + 1] : null;
const shotTargetIdx = argv.indexOf("--shot-target");
const shotTarget = shotTargetIdx >= 0 ? argv[shotTargetIdx + 1] : targetName;
const waitIdx = argv.indexOf("--wait");
const wait = waitIdx >= 0 ? Number(argv[waitIdx + 1]) : 700;

let cssX;
let cssY;
let label;

if (argv[0] === "--xy") {
  cssX = Number(argv[1]);
  cssY = Number(argv[2]);
  label = `(${cssX},${cssY})`;
} else {
  const selector = argv[0];
  const box = evalJs(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)});` +
    ` if (!e) return JSON.stringify(null); const r = e.getBoundingClientRect();` +
    ` return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2, text: (e.textContent||"").trim().slice(0,40)}); })()`,
    targetName,
  );
  if (!box) {
    console.error(`selector matched nothing: ${selector}`);
    process.exit(1);
  }
  cssX = box.x;
  cssY = box.y;
  label = `"${box.text}"`;
}

const target = toScreen(cssX, cssY, targetName);
console.log(`target ${label}  css=(${cssX.toFixed(1)},${cssY.toFixed(1)})  screen=(${target.x},${target.y})` +
  `  factor=${target.factor.toFixed(4)}  window=${target.rect.left},${target.rect.top} ${target.rect.width}x${target.rect.height}` +
  `  viewport=${target.vp.w}x${target.vp.h}`);

const move = ps("move", ["-X", String(target.x), "-Y", String(target.y)]);
console.log("cursor:", JSON.stringify(move));

await new Promise((r) => setTimeout(r, wait));

if (doClick) {
  const clicked = ps("click", ["-X", String(target.x), "-Y", String(target.y)]);
  console.log("click:", JSON.stringify(clicked));
  await new Promise((r) => setTimeout(r, wait));
}

if (shot) {
  console.log(cdp(["shot", shot, "--target", shotTarget]));
}
