'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('openghost', {
 desktop: true,
 platform: process.platform,
 // Where a dropped or picked file lives on disk, so the agent can open it again later.
 pathOf: file => {
  try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
 },
 // A PDF's text, by its place on the disk or by its bytes; the viewer that reads it lives in the main process.
 readPdf: source => ipcRenderer.invoke('pdf:read', source),
 pickFolder: () => ipcRenderer.invoke('folder:pick'),
 // Where chats started without a project folder keep their own folders, and letting go of one that stayed empty.
 chatsFolder: () => ipcRenderer.invoke('folder:chats'),
 releaseFolder: folder => ipcRenderer.invoke('folder:release', folder),
 setTitleBar: (color, symbols) => ipcRenderer.send('window:titlebar', color, symbols),
 setTheme: choice => ipcRenderer.invoke('theme:set', choice),
 store: {
  read: key => ipcRenderer.invoke('store:read', key),
  write: (key, value) => ipcRenderer.invoke('store:write', key, value),
  remove: key => ipcRenderer.invoke('store:remove', key),
 },
 tools: {
  run: (id, name, args, cwd) => ipcRenderer.invoke('tool:run', id, name, args, cwd),
  cancel: id => ipcRenderer.invoke('tool:cancel', id),
  environment: () => ipcRenderer.invoke('tool:environment'),
 },
 browser: {
  onEvent: callback => ipcRenderer.on('browser:event', (event, data) => callback(data)),
  shown: value => ipcRenderer.send('browser:shown', value),
 },
 // ── KAI2 ──────────────────────────────────────────────────────────────────────
 // The chat turns go to KAI Core, and they go through here rather than from the
 // renderer: a `file://` page is correctly refused by Core's origin allowlist, and
 // keeping the call in the main process means the sandboxed page never holds a Core
 // URL it could be induced to post to. Handlers receive raw SSE frames.
 kai: {
  coreUrl: () => ipcRenderer.invoke('kai:core-url'),
  // Core lifecycle: KAI2 adopts a running Core, or starts one. This is what lets KAI2 be
  // the primary application instead of depending on another app having started a Core.
  core: {
   ensure: () => ipcRenderer.invoke('kai:core:ensure'),
   status: () => ipcRenderer.invoke('kai:core:status'),
  },
  // Whether the Core that is answering is the build KAI2 expects. `check` performs a
  // fresh GET /identity; `status` is the last verdict with no round-trip. Both return a
  // verdict the UI renders verbatim, so "which Core am I talking to" is never a guess.
  compat: {
   check: () => ipcRenderer.invoke('kai:compat:check'),
   status: () => ipcRenderer.invoke('kai:compat:status'),
  },
  stream: (text, handlers) => {
   const requestId = Date.now() + '-' + Math.random().toString(36).slice(2);
   const onFrame = (_event, id, raw) => { if (id === requestId) handlers.onFrame(raw); };
   const onEnd = (_event, id) => { if (id === requestId) { done(); handlers.onEnd(); } };
   const onError = (_event, id, message) => { if (id === requestId) { done(); handlers.onError(message); } };
   const done = () => {
    ipcRenderer.removeListener('kai:stream:frame', onFrame);
    ipcRenderer.removeListener('kai:stream:end', onEnd);
    ipcRenderer.removeListener('kai:stream:error', onError);
   };
   ipcRenderer.on('kai:stream:frame', onFrame);
   ipcRenderer.on('kai:stream:end', onEnd);
   ipcRenderer.on('kai:stream:error', onError);
   ipcRenderer.send('kai:stream:start', requestId, text, handlers.thinking);
   // The bridge calls this when its AbortSignal fires: stop listening AND abort the
   // turn in the main process, which aborts Core's request (and any tool behind it).
   return () => {
    done();
    ipcRenderer.send('kai:stream:abort', requestId);
   };
  },
  // Owner-only Core controls. The renderer can READ the effective state and REQUEST a
  // change; it never holds the token, so it cannot authorise one itself.
  policy: {
   mode: () => ipcRenderer.invoke('kai:policy:mode'),
   setMode: payload => ipcRenderer.invoke('kai:policy:mode:set', payload),
  },
  doer: {
   get: () => ipcRenderer.invoke('kai:doer'),
   set: state => ipcRenderer.invoke('kai:doer:set', state),
  },
  monster: {
   get: () => ipcRenderer.invoke('kai:monster'),
   set: state => ipcRenderer.invoke('kai:monster:set', state),
  },
  // Pending approvals: the OWNER decides them here, through the main process, which is
  // the only side holding the credential. The renderer can read the queue and answer it;
  // it cannot manufacture an approval.
  approvals: {
   list: () => ipcRenderer.invoke('kai:approvals:list'),
   decide: (id, approved, scope) => ipcRenderer.invoke('kai:approvals:decide', id, approved, scope),
  },
  // The day's work summary. Rendering it never consumes the once-a-day offer.
  // Read-only catalog for the slash commands (/tools, /workers, /agents).
  catalog: () => ipcRenderer.invoke('kai:catalog'),
  toolActivity: (limit) => ipcRenderer.invoke('kai:activity', limit),
  dashboard: () => ipcRenderer.invoke('kai:dashboard'),
  todoCreate: (objective, criteria) => ipcRenderer.invoke('kai:todo:create', objective, criteria),
  todoEdit: (id, objective) => ipcRenderer.invoke('kai:todo:edit', id, objective),
  todoRun: (id, approvalId) => ipcRenderer.invoke('kai:todo:run', id, approvalId),
  shellRun: (command, approvalId) => ipcRenderer.invoke('kai:shell:run', command, approvalId),
  reviewPolicy: (mode) => ipcRenderer.invoke('kai:review:policy', mode),
  sessionTurns: (id, limit) => ipcRenderer.invoke('kai:session:turns', id, limit),
  scheduleCancel: (id) => ipcRenderer.invoke('kai:schedule:cancel', id),
  scheduleCreate: (title, runAt) => ipcRenderer.invoke('kai:schedule:create', title, runAt),
  summary: {
   daily: (from, to) => ipcRenderer.invoke('kai:summary:daily', from, to),
  },
 },
 llm: {
  start: (id, request) => ipcRenderer.send('llm:start', id, request),
  abort: id => ipcRenderer.send('llm:abort', id),
  onEvent: callback => ipcRenderer.on('llm:event', (event, data) => callback(data)),
  models: (provider, key) => ipcRenderer.invoke('llm:models', provider, key),
 },
 // The keys come from the main process's memory, read before the window opened, so asking for them never waits on the disk.
 keys: {
  read: () => ipcRenderer.sendSync('keys:read'),
  write: (provider, key) => ipcRenderer.invoke('keys:write', provider, key),
 },
 auth: {
  login: () => ipcRenderer.invoke('auth:login'),
  cancel: () => ipcRenderer.invoke('auth:cancel'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  status: () => ipcRenderer.invoke('auth:status'),
  limits: () => ipcRenderer.invoke('auth:limits'),
 },
});
