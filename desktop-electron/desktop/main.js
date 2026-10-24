'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const Tools = require('./tools');
const Browser = require('./browser');
const LLM = require('./llm');
const Keys = require('./keys');
const Pdf = require('./pdf');
const Compat = require('./core-compat');
const { createCoreStreamHandler } = require('./core-stream');
const { createCoreSupervisor } = require('./core-supervisor');

const APP_ID = 'com.kai.kai2';
const ROOT = path.join(__dirname, '..');

// ── KAI2 data isolation ───────────────────────────────────────────────────────
// KAI2 must never read or write another application's data. Its own namespace is set
// explicitly rather than left to the product name, so a rename or an upstream
// change cannot silently merge KAI2's chats with OpenGhost's or with the existing
// KAI install (which lives under %LOCALAPPDATA%\KAI — a different root entirely).
const KAI2_DATA = path.join(app.getPath('appData'), 'KAI2');
try {
  fs.mkdirSync(KAI2_DATA, { recursive: true });
  app.setPath('userData', KAI2_DATA);
} catch (err) {
  // A failure here is fatal for data safety: refuse to start rather than fall back to
  // a shared directory and risk writing into another app's store.
  dialog.showErrorBox('KAI2', 'Cannot create the KAI2 data directory:\n' + KAI2_DATA + '\n\n' + String(err));
  app.exit(1);
}
// Windows takes the .ico; macOS and Linux take the .png.
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const TITLE_BAR = { height: 36 };
// The theme picked in Settings → Appearance. The window is painted before the page loads,
// so these colors repeat --chat-bg and --titlebar-symbols from styles.css.
const THEMES = {
 choices: ['system', 'light', 'dark'],
 dark: { background: '#191919', symbols: '#9a9a9a' },
 light: { background: '#ffffff', symbols: '#5c5c5c' },
};
const STORE_KEY = /^[a-z0-9-]+(\/[a-z0-9-]+)?$/;

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
app.setAppUserModelId(APP_ID);
// Windows and Linux show no menu bar: copying, pasting and undo work in the page by themselves. macOS delivers Cmd+C, Cmd+V,
// Cmd+A, Cmd+Z, Cmd+Q, Cmd+H and Cmd+M only through the menu at the top of the screen, so there the app keeps the standard
// app, edit and window menus.
Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);

const themeFile = () => path.join(app.getPath('userData'), 'theme.json');

function readTheme() {
 try {
  const { choice } = JSON.parse(fs.readFileSync(themeFile(), 'utf8'));
  if (THEMES.choices.includes(choice)) return choice;
 } catch {}
 return 'dark';
}

// 'system' lets the page and the sites in the built-in browser follow the computer; light and dark hold them to one look.
nativeTheme.themeSource = readTheme();
const look = () => THEMES[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

function createShortcut() {
 const link = path.join(app.getPath('desktop'), 'KAI2.lnk');
 const ok = shell.writeShortcutLink(link, 'create', {
  target: process.execPath,
  args: `"${ROOT}"`,
  cwd: ROOT,
  icon: ICON,
  iconIndex: 0,
  appUserModelId: APP_ID,
  description: 'KAI2',
 });
 console.log(ok ? `Shortcut: ${link}` : 'Could not create the shortcut');
}

const storeDir = () => path.join(app.getPath('userData'), 'store');
const writes = new Map();

function storeFile(key) {
 if (typeof key !== 'string' || !STORE_KEY.test(key)) throw new Error(`Bad store key: ${key}`);
 return path.join(storeDir(), `${key}.json`);
}

async function readStore(key) {
 try {
  return JSON.parse(await fs.promises.readFile(storeFile(key), 'utf8'));
 } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
}

function writeStore(key, value) {
 const file = storeFile(key), data = JSON.stringify(value);
 const next = (writes.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.promises.writeFile(temp, data, 'utf8');
  await fs.promises.rename(temp, file);
 });
 writes.set(file, next);
 next.finally(() => { if (writes.get(file) === next) writes.delete(file); }).catch(() => {});
 return next;
}

async function removeStore(key) {
 const file = storeFile(key);
 await (writes.get(file) || Promise.resolve()).catch(() => {});
 await fs.promises.rm(file, { force: true });
}

function external(url) {
 if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

function createWindow() {
 const win = new BrowserWindow({
  width: 1280,
  height: 840,
  minWidth: 760,
  minHeight: 540,
  show: false,
  title: 'KAI2',
  icon: ICON,
  backgroundColor: look().background,
  // Linux window managers draw their own title bar; Windows and macOS get the app's own.
  ...(process.platform === 'linux' ? {} : {
   titleBarStyle: 'hidden',
   titleBarOverlay: { color: look().background, symbolColor: look().symbols, height: TITLE_BAR.height },
  }),
  webPreferences: {
   preload: path.join(__dirname, 'preload.js'),
   contextIsolation: true,
   sandbox: true,
   spellcheck: true,
   webviewTag: true,
  },
 });
 win.once('ready-to-show', () => win.show());
 win.webContents.on('will-attach-webview', (event, prefs, params) => {
  if (!Browser.guard(win.webContents, prefs, params)) event.preventDefault();
 });
 win.webContents.on('did-attach-webview', (event, guest) => Browser.adopt(win.webContents, guest));
 win.webContents.setWindowOpenHandler(({ url }) => {
  external(url);
  return { action: 'deny' };
 });
 win.webContents.on('will-navigate', (event, url) => {
  if (url === win.webContents.getURL()) return;
  event.preventDefault();
  external(url);
 });
 win.webContents.on('before-input-event', (event, input) => {
  if (input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  // Cmd on macOS, Ctrl elsewhere.
  const command = input.meta || input.control;
  if (key === 'f12' || (command && input.shift && key === 'i') || (input.meta && input.alt && key === 'i')) {
   win.webContents.toggleDevTools();
   event.preventDefault();
  } else if (key === 'f5' || (command && !input.shift && key === 'r')) {
   win.webContents.reload();
   event.preventDefault();
  }
 });
 win.loadFile(path.join(ROOT, 'index.html'));
 return win;
}

ipcMain.handle('folder:pick', async event => {
 if (!fromApp(event)) return null;
 const win = BrowserWindow.fromWebContents(event.sender);
 const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
 if (result.canceled || !result.filePaths.length) return null;
 const folder = result.filePaths[0];
 await fs.promises.mkdir(folder, { recursive: true });
 return { path: folder, name: path.basename(folder) || folder };
});

// (folder:reveal was removed: it was unreferenced by the UI and let the renderer ask
// the main process to open ANY path with the OS default handler — a local .exe included.)
ipcMain.handle('folder:chats', event => fromApp(event) ? Tools.CHATS : null);
ipcMain.handle('folder:release', (event, folder) => fromApp(event) && Tools.release(folder));
ipcMain.handle('store:read', (event, key) => fromApp(event) ? readStore(key) : null);
ipcMain.handle('store:write', (event, key, value) => fromApp(event) ? writeStore(key, value) : null);
ipcMain.handle('store:remove', (event, key) => fromApp(event) ? removeStore(key) : null);
// The page sends its background once it opens and whenever the theme changes: the title bar buttons sit on it,
// and the window shows it wherever the page has not painted yet, as while resizing.
ipcMain.on('window:titlebar', (event, color, symbols) => {
 const win = BrowserWindow.fromWebContents(event.sender);
 const hex = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
 if (!win || !hex(color)) return;
 win.setBackgroundColor(color);
 if (process.platform === 'linux' || typeof win.setTitleBarOverlay !== 'function') return;
 win.setTitleBarOverlay({ color, symbolColor: hex(symbols) ? symbols : look().symbols, height: TITLE_BAR.height });
});

const fromApp = event => event.sender.getType() === 'window' && event.senderFrame?.url.startsWith('file:');

// Answers whether the app ends up dark: for 'system' only this side knows what the computer uses right now.
ipcMain.handle('theme:set', (event, choice) => {
 if (fromApp(event) && THEMES.choices.includes(choice) && nativeTheme.themeSource !== choice) {
  nativeTheme.themeSource = choice;
  fs.promises.writeFile(themeFile(), JSON.stringify({ choice })).catch(() => {});
 }
 return nativeTheme.shouldUseDarkColors;
});
// ── KAI2: OpenGhost's tool executor is DISABLED ───────────────────────────────
// This is the cutover that prevents the failure the owner named first: two systems
// managing tools, state and permissions. OpenGhost's renderer used to reach a shell,
// git and a browser through `tool:run`; KAI owns tool execution, policy and approval
// now. These handlers refuse rather than executing anything, so even a leftover
// renderer path — or a future regression that reintroduces a tool call — cannot act.
//
// The refusals are typed and truthful: the UI must show that the capability is not
// available through KAI2, never a silent no-op that looks like a completed action.
const KAI2_TOOL_DISABLED = {
  error: 'tool_execution_disabled',
  reason:
    'KAI2 runs tools through KAI Core, which owns policy, approval and evidence. ' +
    'OpenGhost\'s local executor is disabled; no tool was run.',
};

ipcMain.handle('tool:run', () => KAI2_TOOL_DISABLED);
ipcMain.handle('tool:cancel', () => ({ ok: true, reason: KAI2_TOOL_DISABLED.reason }));
// The environment dump is KAI's to disclose, not the renderer's to request.
ipcMain.handle('tool:environment', () => null);
// The environment dump is also KAI's to disclose, not the renderer's to request.
// ── KAI2: the Core proxy ──────────────────────────────────────────────────────
// The renderer cannot call KAI Core directly: it runs from a `file://` origin, and
// Core's origin allowlist (KAI_CORE_ALLOWED_ORIGINS) correctly refuses that — verified
// 403 for `file://` and 200 for an allowed origin. The fix is NOT to widen Core's
// policy; it is to stop the sandboxed renderer from being the one that talks to Core.
// The main process has no origin, so it proxies, and the renderer only ever sees
// frames. That also means the renderer never holds a Core credential or a base URL it
// could be tricked into sending elsewhere.
const KAI2_CORE_DEFAULT = 'http://127.0.0.1:8788';

ipcMain.handle('kai:core-url', () => process.env.KAI2_CORE_URL || KAI2_CORE_DEFAULT);

/**
 * Owner-only Core routes (the policy mode, the Doer), reached through the main process.
 *
 * The renderer holds neither the Core URL nor the host token, so it cannot attest on
 * its own: a compromised page can ASK for a mode change but cannot authorise one, and
 * the token never crosses the IPC boundary. That is what keeps the frontend from being
 * an independent permission authority.
 *
 * No token means this Core was ADOPTED (somebody else started it), so an owner action
 * is reported as unavailable rather than attempted with a credential Core never
 * accepted.
 */
async function coreOwnerRequest(pathname, init) {
  const token = coreSupervisor.token();
  if (!token) {
    return {
      ok: false,
      status: 0,
      body: {
        error: true,
        reason: 'KAI2 did not start this Core, so only the process that did can authorise an owner action on it.',
      },
    };
  }
  const base = String(process.env.KAI2_CORE_URL || KAI2_CORE_DEFAULT).replace(/\/+$/, '');
  try {
    const res = await fetch(base + pathname, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-kai-host-token': token, ...(init.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      // The credential was presented and refused: this Core belongs to another starter.
      return {
        ok: false,
        status: res.status,
        body: {
          error: true,
          reason: 'This Core was started by another program, so only that program can authorise an owner action on it.',
        },
      };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: true, reason: String(err && err.message ? err.message : err) } };
  }
}
ipcMain.handle('kai:policy:mode', () => coreOwnerRequest('/policy/mode', { method: 'GET' }));
ipcMain.handle('kai:policy:mode:set', (_event, payload) =>
  coreOwnerRequest('/policy/mode', { method: 'POST', body: JSON.stringify(payload || {}) }));
// One catalog read for the slash commands. Read-only, and only ever
// these three paths: a command surface must not become a general API proxy.
// Tasks & Schedule: three real reads merged for one panel. No new store, no
// renderer-side state — every field comes from Core.
ipcMain.handle('kai:dashboard', async () => {
  const get = (p) => coreOwnerRequest(p, { method: 'GET' }).catch((e) => ({ ok: false, body: { reason: String((e && e.message) || e) } }));
  const [state, schedules, activity, work] = await Promise.all([
    get('/state'),
    get('/schedules'),
    get('/activity/tools?limit=40'),
    get('/work-items'),
  ]);
  return {
    ok: true,
    body: {
      state: state.body || null,
      schedules: schedules.body || null,
      activity: activity.body || null,
      work: work.body || null,
    },
  };
});

// Create a real work item (a TODO KAI owns). `objective` is the only required field;
// success criteria are passed through so completion can be judged, not claimed.
ipcMain.handle('kai:todo:create', (_event, objective, criteria) =>
  coreOwnerRequest('/work-items', {
    method: 'POST',
    body: JSON.stringify({
      objective: String(objective || ''),
      ...(Array.isArray(criteria) && criteria.length ? { successCriteria: criteria.map(String) } : {}),
      // STAGES. Core turns each subtask into a child work item, which is what the
      // plan runner walks. Criteria alone left the plan a single flat item with
      // nothing to execute.
      ...(Array.isArray(criteria) && criteria.length ? { subtasks: criteria.map(String) } : {}),
    }),
  }));

// Create a real schedule entry at the authoritative source. `runAt` is an ISO
// instant the caller computed; Core stores it and the dashboard reads it back.
ipcMain.handle('kai:schedule:create', (_event, title, runAt) =>
  coreOwnerRequest('/schedules', {
    method: 'POST',
    body: JSON.stringify({
      title: String(title || ''),
      kind: 'once',
      action: 'mission.create',
      runAt: String(runAt || ''),
      payload: { title: String(title || '') },
    }),
  }));

// Run a plan: Core executes its stages in order through the real worker boundary.
ipcMain.handle('kai:todo:run', (_event, id, approvalId) =>
  coreOwnerRequest(`/work-items/${encodeURIComponent(String(id))}/plan/run`, {
    method: 'POST',
    body: JSON.stringify(approvalId ? { approvalId: String(approvalId) } : {}),
  }));

// Edit a task's own metadata. Core validates and persists; the panel re-reads.
ipcMain.handle('kai:todo:edit', (_event, id, objective) =>
  coreOwnerRequest(`/work-items/${encodeURIComponent(String(id))}/edit`, {
    method: 'POST',
    body: JSON.stringify({ objective: String(objective || '') }),
  }));

// Select the stage-review policy. Core authorizes the change (settings.update is
// security-relevant), so this may park for approval — which is correct.
ipcMain.handle('kai:review:policy', (_event, mode) =>
  mode === undefined
    ? coreOwnerRequest('/settings', { method: 'GET' })
    : coreOwnerRequest('/settings', {
        method: 'POST',
        body: JSON.stringify({ 'orchestration.review': String(mode).toUpperCase() }),
      }));

// Run a terminal command through the REAL boundary. `shell.run` is DESTRUCTIVE, so
// Core parks it for an owner approval; approving re-issues it and the durable
// activity record then carries the actual exitCode/stdout/stderr.
ipcMain.handle('kai:shell:run', (_event, command, approvalId) =>
  coreOwnerRequest('/tools/shell.run/invoke', {
    method: 'POST',
    body: JSON.stringify({
      // `shell.run` takes a PROGRAM plus an argument list — it does not parse a
      // shell string, which is why `echo hi` alone was ENOENT. cmd /c runs it.
      input: { command: 'cmd.exe', args: ['/c', String(command || '')] },
      ...(approvalId ? { approvalId: String(approvalId) } : {}),
    }),
  }));

// The canonical turns of a conversation. The renderer uses this to recover an
// answer Core produced but never streamed — the backend is the source of truth.
ipcMain.handle('kai:session:turns', (_event, id, limit) =>
  coreOwnerRequest(`/sessions/${encodeURIComponent(String(id))}/turns?limit=${Number(limit) || 6}`, { method: 'GET' }));

// Cancel a scheduled task at the authoritative source.
ipcMain.handle('kai:schedule:cancel', (_event, id) =>
  coreOwnerRequest(`/schedules/${encodeURIComponent(String(id))}/cancel`, { method: 'POST', body: '{}' }));

// The real tool invocations, read-only. Same shape as every other owner read.
ipcMain.handle('kai:activity', (_event, limit) =>
  coreOwnerRequest(`/activity/tools?limit=${Number(limit) || 50}`, { method: 'GET' }));

ipcMain.handle('kai:catalog', async () => {
  const [tools, workers, employees] = await Promise.all([
    coreOwnerRequest('/tools', { method: 'GET' }).catch((e) => ({ ok: false, body: { reason: String(e && e.message || e) } })),
    coreOwnerRequest('/agents', { method: 'GET' }).catch((e) => ({ ok: false, body: { reason: String(e && e.message || e) } })),
    coreOwnerRequest('/employees', { method: 'GET' }).catch((e) => ({ ok: false, body: { reason: String(e && e.message || e) } })),
  ]);
  return { ok: true, body: { tools, workers, employees } };
});

ipcMain.handle('kai:summary:daily', (_event, from, to) => {
  const qs = new URLSearchParams();
  if (typeof from === 'string' && from) qs.set('from', from);
  if (typeof to === 'string' && to) qs.set('to', to);
  const suffix = qs.toString() ? `?${qs}` : '';
  return coreOwnerRequest(`/summary/daily${suffix}`, { method: 'GET' });
});
ipcMain.handle('kai:approvals:list', () => coreOwnerRequest('/approvals', { method: 'GET' }));
ipcMain.handle('kai:approvals:decide', (_event, id, approved, scope) =>
  coreOwnerRequest(`/approvals/${encodeURIComponent(String(id))}/decide`, {
    method: 'POST',
    // "always" is a PERSISTENT policy grant: it is forwarded explicitly and only
    // when asked for, so a one-off decision can never widen into a standing rule.
    body: JSON.stringify({ approved: approved === true, ...(scope === 'always' ? { scope: 'always' } : {}) }),
  }));
ipcMain.handle('kai:doer', () => coreOwnerRequest('/doer', { method: 'GET' }));
ipcMain.handle('kai:doer:set', (_event, state) =>
  coreOwnerRequest('/doer', { method: 'POST', body: JSON.stringify({ state }) }));
// Monster Mode: how far KAI carries a mission by itself. Core enforces it; this
// only reads and writes the switch, and reports whatever Core answered.
ipcMain.handle('kai:monster', () => coreOwnerRequest('/monster', { method: 'GET' }));
ipcMain.handle('kai:monster:set', (_event, state) =>
  coreOwnerRequest('/monster', { method: 'POST', body: JSON.stringify({ state }) }));

// ── Core compatibility ────────────────────────────────────────────────────────
// A reachable Core is NOT proof that the right Core is answering. The running build is
// compared against `desktop/core-expected.json` (see scripts/stamp-core-expectation.mjs)
// and a mismatch refuses the turn BEFORE any request is sent, rather than answering from
// code that is not the code under review.
const coreGate = Compat.createCoreGate({
  resolveBase: () => process.env.KAI2_CORE_URL || KAI2_CORE_DEFAULT,
  env: process.env,
  readFile: (name, enc) => fs.readFileSync(path.join(__dirname, name), enc),
});

// ── Core lifecycle ────────────────────────────────────────────────────────────
// KAI2 owns its Core: adopt one that is already running, otherwise start it. This is what
// makes KAI2 the primary application rather than a client that depends on another app
// having started a Core first. It never starts a second Core (only one may run) and never
// stops a Core it did not start.
/**
 * The host token, encrypted at rest with the OS keychain.
 *
 * It is a bearer credential for owner-only Core routes (the policy mode, the Doer,
 * deciding an approval), so it must never sit in a plain file on disk — which is why
 * `safeStorage` is used rather than the ordinary JSON store this app keeps elsewhere.
 *
 * When the OS keychain is unavailable, NOTHING is written and the token is not
 * remembered: owner controls then degrade to "unavailable" on the next run, which is
 * the safe direction. A plaintext token would be a worse failure than a missing one.
 */
function hostTokenPath() {
  return path.join(app.getPath('userData'), 'core-host-token.bin');
}

/**
 * The install-wide owner credential, from the Windows Credential Manager.
 *
 * This is the SAME entry the desktop app and the Hermes `kai-guard` hook use
 * (`kai-host-token.com.aziz.kai`). KAI2 used to mint its own token for the Core it
 * spawns, which meant the guard authenticated correctly and was still refused: two
 * different owner credentials for one install. Reading this first makes ONE credential
 * authorise both owner routes and the worker tool-call boundary.
 *
 * The value stays inside this process: it is never logged and never crosses IPC.
 */
function readKeychainHostToken() {
  try {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      'Add-Type -TypeDefinition @"',
      'using System; using System.Runtime.InteropServices;',
      'public class KH {',
      '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
      '  public struct C { public uint Flags; public uint Type; public string TargetName; public string Comment;',
      '    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
      '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
      '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
      '  public static extern bool CredReadW(string t, uint ty, uint f, out IntPtr c);',
      '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);',
      '}',
      '"@ | Out-Null',
      "$p=[IntPtr]::Zero",
      "if (-not [KH]::CredReadW('kai-host-token.com.aziz.kai',1,0,[ref]$p)) { exit 0 }",
      '$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[type][KH+C])',
      '$b=New-Object byte[] $c.CredentialBlobSize',
      '[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize)',
      '[KH]::CredFree($p)',
      '$t=[Text.Encoding]::Unicode.GetString($b).Trim([char]0)',
      'if ($t.Length -eq 0) { $t=[Text.Encoding]::UTF8.GetString($b).Trim([char]0) }',
      'if ($t.Length -gt 0) { [Console]::Out.Write($t) }',
    ].join('\n');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const token = String(out || '').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null; // absent or unreadable is simply "we have no keychain token"
  }
}

async function loadHostToken() {
  // Keychain FIRST: it is the credential the guard and the desktop app already share.
  const shared = readKeychainHostToken();
  if (shared !== null) return shared;
  try {
    if (typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
      return null;
    }
    return safeStorage.decryptString(await fs.promises.readFile(hostTokenPath()));
  } catch {
    return null; // absent or undecryptable is simply "we have no token"
  }
}

async function saveHostToken(token) {
  try {
    if (typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
      return;
    }
    await fs.promises.mkdir(path.dirname(hostTokenPath()), { recursive: true });
    await fs.promises.writeFile(hostTokenPath(), safeStorage.encryptString(token));
  } catch {
    // Reported as unavailable later rather than surfaced here: failing to persist must
    // not stop the Core from starting.
  }
}

const coreSupervisor = createCoreSupervisor({
  // KAI2 owns the Core it starts, so it mints the credential that Core will accept and
  // remembers it — the same arrangement the desktop app uses. An adopted Core is sent
  // the same token; if it belongs to somebody else, Core refuses it and the UI says so.
  loadToken: loadHostToken,
  saveToken: saveHostToken,
  coreDir: process.env.KAI2_CORE_DIR,
  port: Number(process.env.KAI2_CORE_PORT) || undefined,
});

/** Adopt-or-spawn, then report which happened. Safe to call repeatedly. */
ipcMain.handle('kai:core:ensure', async () => {
  const supervised = await coreSupervisor.ensure();
  // A fresh Core means any cached verdict is about the old process.
  const verdict = await coreGate.refresh();
  return { ...supervised, verdict: { ...verdict, description: Compat.describeVerdict(verdict) } };
});

/** Where the Core is, whether it is ours, and whether KAI2 could start it. */
ipcMain.handle('kai:core:status', () => coreSupervisor.status());
// The gate lives in the same function as the fetch on purpose: this is the only path a
// turn can take, so it is the only place the check has to hold.
const coreStream = createCoreStreamHandler({
  gate: coreGate,
  resolveBase: () => process.env.KAI2_CORE_URL || KAI2_CORE_DEFAULT,
});

/** Run the check on demand. Retry is exactly this call again. */
ipcMain.handle('kai:compat:check', async () => {
  const verdict = await coreGate.refresh();
  return { ...verdict, description: Compat.describeVerdict(verdict) };
});

/** The last verdict without a round-trip, so the UI can render immediately on load. */
ipcMain.handle('kai:compat:status', () => {
  const verdict = coreGate.current();
  return verdict ? { ...verdict, description: Compat.describeVerdict(verdict) } : null;
});

// Turns that are streaming right now, so the renderer's Stop can abort the REAL
// request in flight (and the Core work behind it), not only its own UI.
const liveStreams = new Map();
ipcMain.on('kai:stream:start', (event, requestId, text, thinking) => {
  if (!fromApp(event) || typeof requestId !== 'string' || requestId.length > 128) return;
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, requestId, payload);
  };
  const controller = new AbortController();
  liveStreams.set(requestId, controller);
  // The handler owns the gate → fetch → frames sequence. A refusal happens here, before
  // anything reaches Core.
  coreStream.handle({ requestId, text, thinking, send, signal: controller.signal })
    .catch(err => {
      // A stopped turn is not a proxy failure.
      if (controller.signal.aborted) return;
      send('kai:stream:error', 'KAI2 failed to proxy the turn: ' + String(err && err.message ? err.message : err));
    })
    .finally(() => {
      if (liveStreams.get(requestId) === controller) liveStreams.delete(requestId);
    });
});
ipcMain.on('kai:stream:abort', (event, requestId) => {
  if (!fromApp(event) || typeof requestId !== 'string') return;
  const controller = liveStreams.get(requestId);
  if (controller) controller.abort();
});
ipcMain.on('browser:shown', (event, value) => { if (fromApp(event)) Browser.setShown(value); });
ipcMain.handle('pdf:read', (event, source) => fromApp(event) ? Pdf.read(source) : { text: '', reason: 'unreadable' });
LLM.register(fromApp);
Keys.register(fromApp);

if (process.argv.includes('--create-shortcut')) {
 app.whenReady().then(() => {
  createShortcut();
  app.quit();
 });
} else if (!app.requestSingleInstanceLock()) {
 app.quit();
} else {
 let win = null;
 app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
 });
 app.whenReady().then(() => {
  // KAI2 owns the Core: adopt a running one, otherwise start it. This is what makes KAI2
  // the primary application rather than a client that needs another app to have started a
  // Core first. Deliberately not awaited — a cold start must not delay the window — and a
  // failure is not fatal here: the renderer re-checks compatibility as it loads and the
  // notice carries a Retry action that calls the same supervisor.
  coreSupervisor
    .ensure()
    .then(async () => {
      // A Core we just spawned answers only once it has finished booting, so the FIRST
      // compat check races it and caches "unreachable" — which then shows as a scary
      // notice and an offline avatar until somebody presses Retry. Retry a few times so a
      // launched app settles on the truth instead of a stale verdict.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const verdict = await coreGate.refresh();
        if (verdict.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    })
    .catch(() => {});
  Browser.setup();
  Keys.load();
  win = createWindow();
  win.on('closed', () => {
   win = null;
   Tools.cancelAll();
   LLM.cancelAll();
   Pdf.cancelAll();
  });
 });
 app.on('window-all-closed', () => app.quit());
 app.on('before-quit', event => {
  Tools.cancelAll();
  if (!writes.size) return;
  event.preventDefault();
  Promise.allSettled([...writes.values()]).then(() => app.quit());
 });
}
