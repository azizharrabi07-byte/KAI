(() => {
'use strict';

// kai-activity.js — what KAI is doing, from Core's OWN events.
//
// The data is not produced here. `kai-bridge.js` records one entry per REAL tool
// execution Core reported on the turn's stream (name, arguments, the registry's own
// status, timestamps, the approval that parked it, and a server-redacted bounded result
// preview), and this element only renders it. So a row exists because Core did
// something, never because the assistant said it would.
//
// Nothing is inferred: a tool shown as done carries Core's terminal status, a tool that
// was refused says refused, and one waiting on a person says waiting. There is no timer
// that invents progress and no row that appears from prose.
//
// It is a compact strip by default — one line, so routine chat is not cluttered — and
// expands into the full timeline on click, in place, without moving the page.

const LIMIT = 200;

/** Core's phase/status -> the word a person reads, and its tone. */
function describe(entry) {
  switch (entry.status) {
    case 'EXECUTED':
      return { label: I18n.t('activity.done'), tone: 'ok' };
    case 'APPROVAL_REQUIRED':
      return { label: I18n.t('activity.waiting'), tone: 'warn' };
    case 'DENIED':
      return { label: I18n.t('activity.denied'), tone: 'bad' };
    case 'INVALID':
    case 'FAILED':
    case 'NOT_FOUND':
      return { label: I18n.t('activity.failed'), tone: 'bad' };
    default:
      break;
  }
  if (entry.phase === 'tool_start') return { label: I18n.t('activity.running'), tone: 'live' };
  if (entry.phase === 'tool_error') return { label: I18n.t('activity.failed'), tone: 'bad' };
  if (entry.phase === 'tool_approval_required') return { label: I18n.t('activity.waiting'), tone: 'warn' };
  return { label: I18n.t('activity.planned'), tone: 'idle' };
}

function clockOf(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function durationOf(entry) {
  const from = Date.parse(entry.startedAt || '');
  const to = Date.parse(entry.completedAt || '');
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return '';
  const ms = to - from;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STYLE = `
:host { display: block; padding: 0 16px 6px; font: 500 12px/1.45 var(--ui-font, system-ui, sans-serif); }
:host([hidden]) { display: none; }
.wrap { max-width: 760px; margin: 0 auto; }
.bar {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 10px; border: 0; border-radius: 10px; cursor: pointer;
  background: transparent; color: var(--fg-secondary); text-align: left;
  font: inherit;
}
.bar:hover { background: var(--row-hover-bg); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--fg-tertiary); }
.dot.ok { background: rgb(var(--success-rgb)); }
.dot.warn { background: rgb(var(--warn-rgb)); }
.dot.bad { background: rgb(var(--danger-rgb)); }
.dot.live { background: rgb(var(--success-rgb)); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } }
.name { color: var(--fg-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
.state { color: var(--fg-secondary); }
.spacer { flex: 1; }
.count { color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
.list { display: none; max-height: 320px; overflow-y: auto; margin: 4px 0 0; padding: 4px; border-radius: 12px; background: var(--row-active-bg); box-shadow: var(--card-lift); }
:host([open]) .list { display: block; }
.row { padding: 7px 9px; border-radius: 9px; }
.row + .row { border-top: 1px solid var(--fg-quaternary); border-radius: 0; }
.row-head { display: flex; align-items: baseline; gap: 8px; }
.row-name { color: var(--fg-primary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-state { flex: none; }
.row-state.ok { color: rgb(var(--success-rgb)); }
.row-state.warn { color: rgb(var(--warn-rgb)); }
.row-state.bad { color: rgb(var(--danger-rgb)); }
.row-state.live, .row-state.idle { color: var(--fg-secondary); }
.row-meta { color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
.row-body { margin-top: 4px; color: var(--fg-secondary); }
.row-body code { display: block; margin-top: 3px; padding: 5px 7px; border-radius: 7px; background: var(--pass-bg); color: var(--fg-primary);
  font: 400 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
.empty { padding: 10px; color: var(--fg-secondary); }
`;

class KaiActivity extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
      <div class="wrap">
        <button class="bar" type="button" aria-expanded="false">
          <span class="dot"></span>
          <span class="name"></span>
          <span class="state"></span>
          <span class="spacer"></span>
          <span class="count"></span>
        </button>
        <div class="list" role="log" aria-live="polite"></div>
      </div>`;
    this.bar = this.shadowRoot.querySelector('.bar');
    this.dot = this.shadowRoot.querySelector('.dot');
    this.head = this.shadowRoot.querySelector('.name');
    this.state = this.shadowRoot.querySelector('.state');
    this.count = this.shadowRoot.querySelector('.count');
    this.list = this.shadowRoot.querySelector('.list');
    this.entries = [];
    this.unsubscribe = null;
    this.onClick = () => this.toggle();
  }

  connectedCallback() {
    this.bar.addEventListener('click', this.onClick);
    // Only rendered when there is something REAL to show: an empty strip on every chat
    // would be furniture, not information.
    this.hidden = true;
    // This element is declared in the page body, so it is upgraded BEFORE the bridge
    // script runs. Attach now when the bridge is already there, otherwise wait to be
    // told — polling for it would be a busy-wait for a fact that is announced once.
    this.onReady = () => this.attach();
    if (this.attach()) return;
    document.addEventListener('kai2:ready', this.onReady, { once: true });
  }

  /** Subscribe to the bridge's timeline. Returns false when it is not there yet. */
  attach() {
    const bridge = window.KAI2;
    if (!bridge || typeof bridge.activity !== 'function') return false;
    this.entries = bridge.activity();
    if (typeof bridge.onActivity === 'function') {
      this.unsubscribe = bridge.onActivity((entry) => {
        if (entry === null) {
          // The active conversation changed. Re-read rather than keep rendering the last
          // one's commands, and collapse: a strip left open would be showing history the
          // user did not ask for in a conversation that has none.
          this.entries = bridge.activity();
          this.removeAttribute('open');
          this.bar.setAttribute('aria-expanded', 'false');
          this.render();
          return;
        }
        const at = this.entries.findIndex((e) => e.key === entry.key);
        if (at >= 0) this.entries[at] = entry;
        else this.entries.push(entry);
        while (this.entries.length > LIMIT) this.entries.shift();
        this.render();
      });
    }
    this.render();
    return true;
  }

  disconnectedCallback() {
    this.bar.removeEventListener('click', this.onClick);
    if (this.onReady) document.removeEventListener('kai2:ready', this.onReady);
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
  }

  toggle() {
    const open = !this.hasAttribute('open');
    if (open) this.setAttribute('open', '');
    else this.removeAttribute('open');
    this.bar.setAttribute('aria-expanded', String(open));
    if (open) this.render();
  }

  render() {
    const entries = this.entries;
    if (entries.length === 0) {
      this.hidden = true;
      return;
    }
    this.hidden = false;
    const latest = entries[entries.length - 1];
    const info = describe(latest);
    this.dot.className = `dot ${info.tone}`;
    this.head.textContent = latest.name || latest.toolId || 'tool';
    this.state.textContent = info.label;
    this.count.textContent = I18n.t('activity.count', { n: entries.length });
    this.bar.setAttribute('aria-label', I18n.t('activity.label', { name: latest.name || latest.toolId, state: info.label }));
    if (this.hasAttribute('open')) this.renderList();
  }

  renderList() {
    this.list.textContent = '';
    for (const entry of this.entries.slice(-60).reverse()) {
      const info = describe(entry);
      const row = document.createElement('div');
      row.className = 'row';
      const head = document.createElement('div');
      head.className = 'row-head';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = entry.name || entry.toolId || 'tool';
      const state = document.createElement('span');
      state.className = `row-state ${info.tone}`;
      state.textContent = info.label;
      const meta = document.createElement('span');
      meta.className = 'row-meta';
      meta.textContent = [clockOf(entry.startedAt), durationOf(entry)].filter(Boolean).join(' · ');
      head.append(name, state, meta);
      row.append(head);

      const body = document.createElement('div');
      body.className = 'row-body';
      if (entry.arguments) {
        const args = document.createElement('code');
        args.textContent = entry.arguments;
        body.append(args);
      }
      if (entry.approvalId) {
        const line = document.createElement('div');
        line.textContent = I18n.t('activity.approval', { id: entry.approvalId });
        body.append(line);
      }
      if (entry.error) {
        const line = document.createElement('div');
        line.textContent = `${entry.error.code}: ${entry.error.message}`;
        body.append(line);
      }
      if (entry.resultPreview) {
        const out = document.createElement('code');
        out.textContent = entry.resultTruncated ? `${entry.resultPreview}\n…` : entry.resultPreview;
        body.append(out);
      }
      if (body.childNodes.length > 0) row.append(body);
      this.list.append(row);
    }
  }
}

if (!customElements.get('kai-activity')) customElements.define('kai-activity', KaiActivity);
})();
