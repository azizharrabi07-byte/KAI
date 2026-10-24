'use strict';
/**
 * kai-bridge.js — the ONE integration seam between the reused OpenGhost renderer
 * and KAI Core.
 *
 * ── Why this file exists, and why it is this small
 * OpenGhost ships its own complete agent stack: its own system prompt
 * (`agent-prompt.js`), its own tool schemas and executor (`agent-tools.js`), its own
 * approval policy and cards, and four provider clients. KAI has its own authoritative
 * runtime, policy, approvals and outcome verification. Running both is the failure the
 * owner named first: two systems managing tools, state and permissions.
 *
 * The renderer reaches a model in exactly one place — `Chat.request` calls
 * `Providers.stream(config, options)`. So the whole cutover is to replace THAT
 * function. Everything else in the renderer (streaming typography, markdown, code,
 * tex, diagrams, sidebar, history, settings) keeps working untouched, and OpenGhost's
 * agent loop never runs because it is driven by the tool calls this seam never
 * returns.
 *
 * ── What it returns
 * `tool_calls` and `tool_results` describe the REAL executions Core streamed back for
 * this turn (the same events the activity strip renders), shaped the way the chat model
 * keeps them: an assistant `tool_calls` list and one result per call. `Chat.request`
 * records them into the message, and the timeline itself is persisted per conversation
 * (`chat-store.js`, `window.KAI2Activity`) so opening the chat after a reload shows what
 * KAI actually did.
 *
 * This does NOT restart OpenGhost's loop: `Chat.request` returns no calls to `Chat.loop`,
 * because Core already ran them. Running them again would be a second authority
 * executing every tool twice.
 *
 * ── Honesty rules
 * - A failure is reported as a failure. It is never rendered as an assistant answer.
 * - Nothing is invented: `usage` is whatever Core sent, or null.
 * - No OpenGhost provider client is reachable through this seam.
 */
(function () {
  const DEFAULT_BASE = 'http://127.0.0.1:8788';

  /** Where KAI Core lives. Overridable at runtime for an isolated test instance. */
  function baseUrl() {
    return (window.KAI2_CORE_URL || localStorage.getItem('kai2.coreUrl') || DEFAULT_BASE).replace(/\/+$/, '');
  }

  /**
   * The thinking level the user chose, named the way Core names it.
   *
   * The settings UI stores one of `none | low | high | max` under its own key, and
   * shows `none` as "Instant"; Core's name for that level is `instant`. The other
   * three are the same word on both sides, so only that one is translated.
   *
   * An unrecognised value is sent as NOTHING rather than guessed at: Core refuses an
   * unknown level, and silently substituting one would show the user a setting the
   * request never carried.
   */
  function thinkingLevel() {
    let stored = null;
    try {
      stored = localStorage.getItem('deepseek.effort');
    } catch (_) {
      stored = null; // a locked-down storage is "no preference", not a failure
    }
    if (stored === 'none') return 'instant';
    return stored === 'low' || stored === 'high' || stored === 'max' ? stored : undefined;
  }

  // ── Core compatibility ────────────────────────────────────────────────────────
  // `Chat.request` reaching Core is not the same as reaching the RIGHT Core. A stale
  // process left running from an earlier build answers everything happily, and the
  // reply describes code that is not running. So before the composer is usable, KAI2
  // asks the main process which Core is actually answering and whether it is the build
  // this KAI2 expects.
  //
  // The renderer never decides this itself and never sees the Core URL. The main process
  // owns the verdict (desktop/core-compat.js) and refuses the turn there too, so this is
  // a faithful report of an enforced decision — not the enforcement itself.
  const compat = { checked: false, ok: false, verdict: null };

  function compatBridge() {
    return window.openghost && window.openghost.kai && window.openghost.kai.compat;
  }

  /** Update the blocking notice. Returns the verdict so callers can branch on it. */
  function renderCompat(verdict) {
    compat.checked = true;
    compat.ok = Boolean(verdict && verdict.ok === true && verdict.state === 'compatible');
    compat.verdict = verdict || null;
    const host = document.getElementById('kai-core-compat');
    if (!host) return verdict;
    const text = host.querySelector('#kai-core-compat-text');
    const button = host.querySelector('button');
    if (compat.ok) {
      // Compatible: say WHICH build, and say what could NOT be verified here, so
      // "compatible" is never mistaken for "fully verified".
      const d = (verdict && verdict.detail) || {};
      const unverified = d.artifactMatchesSource === null ? ' (artifact/source match could not be checked here)' : '';
      const line = 'KAI Core ' + (d.buildId || 'build unknown') + ' · protocol ' + (d.protocolVersion != null ? d.protocolVersion : '?') + unverified;
      host.dataset.state = 'compatible';
      if (text) text.textContent = line;
      // `hidden` alone is not enough: the element carries an inline `display`, which wins
      // over the UA's `[hidden] { display: none }`. Set the display explicitly.
      host.style.display = 'none';
      return verdict;
    }
    host.dataset.state = verdict && verdict.state ? verdict.state : 'unknown';
    if (text) text.textContent = (verdict && verdict.description) || 'KAI2 could not verify the running KAI Core.';
    if (button) button.hidden = false;
    host.style.display = 'flex';
    return verdict;
  }

  /** Ask the main process to check, then reflect the result in the UI. */
  async function checkCompat() {
    const bridge = compatBridge();
    if (!bridge || typeof bridge.check !== 'function') {
      // No main process (browser dev outside Electron). There is no gate in that mode,
      // and saying so is better than implying a check happened.
      return renderCompat({
        ok: false,
        state: 'malformed',
        reason: 'no compatibility gate is reachable (the renderer is not running inside KAI2)',
        description: 'KAI2 cannot verify the KAI Core build outside the desktop application.',
      });
    }
    let verdict;
    try {
      verdict = await bridge.check();
    } catch (err) {
      verdict = {
        ok: false,
        state: 'unreachable',
        reason: String(err && err.message ? err.message : err),
        description: 'KAI Core compatibility could not be checked: ' + String(err && err.message ? err.message : err),
      };
    }
    return renderCompat(verdict);
  }

  /**
   * The blocking notice. It is part of the DOM next to the composer so it is visible
   * where the user is about to type, and it carries the Retry action — resolving the
   * problem (starting or rebuilding the Core) must not require restarting KAI2.
   */
  function installCompatNotice() {
    if (document.getElementById('kai-core-compat')) return;
    const host = document.createElement('div');
    host.id = 'kai-core-compat';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.hidden = true;
    host.style.cssText = [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',
      'bottom:96px',
      'z-index:60',
      'max-width:min(680px,calc(100vw - 48px))',
      'padding:10px 12px',
      'border-radius:10px',
      'border:1px solid var(--border,#444)',
      'background:var(--surface,#1e1e1e)',
      'color:var(--fg,#e8e8e8)',
      'font:13px/1.45 system-ui,sans-serif',
      'display:flex',
      'gap:10px',
      'align-items:flex-start',
    ].join(';');
    // Start hidden: the inline `display:flex` above would otherwise show an empty notice
    // before the first verdict arrives.
    host.style.display = 'none';
    const text = document.createElement('span');
    text.id = 'kai-core-compat-text';
    text.style.cssText = 'flex:1 1 auto;white-space:pre-wrap';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.style.cssText = [
      'flex:0 0 auto',
      'padding:4px 10px',
      'border-radius:8px',
      'border:1px solid var(--border,#444)',
      'background:transparent',
      'color:inherit',
      'font:inherit',
      'cursor:pointer',
    ].join(';');
    retry.addEventListener('click', () => {
      retry.disabled = true;
      checkCompat().finally(() => { retry.disabled = false; });
    });
    host.appendChild(text);
    host.appendChild(retry);
    (document.body || document.documentElement).appendChild(host);
  }

  /**
   * A hard failure the renderer must show as an error.
   * `Chat.request`'s caller already distinguishes a thrown error from a reply.
   */
  function failure(message) {
    const error = new Error(message);
    error.kai = true;
    return error;
  }

  /**
   * Send one turn to KAI Core and stream it back.
   *
   * Signature-compatible with OpenGhost's `Providers.stream(config, options)`, where
   * options = { messages, tools, signal, session, onContent }. `config` is ignored:
   * KAI owns model selection, so the renderer cannot pick a provider behind KAI's back.
   */
  async function stream(_config, options) {
    const opts = options || {};
    const messages = Array.isArray(opts.messages) ? opts.messages : [];

    // The turn text is the last REAL user message. The history stays in the renderer; KAI's
    // own conversation/session is addressed by id, so nothing is duplicated into Core.
    //
    // OpenGhost appends APP NOTES after the user's turn, as `role:'user'` messages that begin
    // "This note comes from the app, not from the user:" (see `notes()` in chat.js — the day
    // and permission mode, the browser's contents). Taking the last user message therefore
    // sent the NOTE and dropped the question, and the model answered "I don't have the tools
    // needed to process the note you've provided". OpenGhost itself tells these apart by the
    // same prefix test, so we use it too.
    const APP_NOTE_PREFIXES = [
      'This note comes from the app, not from the user:',
      'This message comes from the app, not from the user:',
    ];
    let text = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
      if (APP_NOTE_PREFIXES.some((prefix) => m.content.startsWith(prefix))) continue; // an app note, not the user's turn
      text = m.content;
      break;
    }
    if (!text.trim()) throw failure('KAI: nothing to send (no user message in the turn).');

    // ── The Core must be the build KAI2 expects ─────────────────────────────────
    // The main process refuses an incompatible turn as well; refusing here too makes the
    // failure immediate and specific instead of surfacing as a generic transport error,
    // and guarantees the renderer never even asks for a turn to be sent.
    if (!compat.checked) await checkCompat();
    if (!compat.ok) {
      // A negative verdict can be STALE in the one case that matters: KAI2's own cold
      // start checks the port while the Core it just launched is still booting, caches
      // "unreachable", and would then refuse every turn until somebody pressed Retry.
      // Re-check once before refusing, so a verdict from before the Core was ready never
      // blocks work that would succeed now.
      await checkCompat();
    }
    if (!compat.ok) {
      throw failure((compat.verdict && compat.verdict.description) || 'KAI2 cannot verify the running KAI Core, so the turn was not sent.');
    }


    // ── Transport ───────────────────────────────────────────────────────────────
    // Preferred: the main process proxies to Core. The renderer is a `file://` page,
    // and Core's origin allowlist correctly refuses that (403), so the page must not
    // be the caller. The IPC path also keeps the Core URL out of the sandboxed page.
    const bridge = window.openghost && window.openghost.kai;
    let content = '';
    let done = null;
    // What this conversation already had before the turn. Only entries this turn TOUCHES
    // (new, or updated in place) may become this reply's tool records.
    const before = activitySnapshot();

    function consumeFrame(rawFrame) {
      let payload;
      try { payload = JSON.parse(rawFrame); } catch (_) { return; } // never render a bad frame as text
      // A real tool execution. Kept as activity, never appended to the reply text.
      // No `return`: one frame may carry a tool event AND a delta or the terminal `done`,
      // and dropping those would lose the tail of the answer.
      if (payload.tool_event && typeof payload.tool_event === 'object') recordToolEvent(payload.tool_event);
      if (typeof payload.delta === 'string' && payload.delta) {
        content += payload.delta;
        if (typeof opts.onContent === 'function') opts.onContent(payload.delta, { content });
      }
      if (payload.done === true) {
        done = payload;
        // The terminal frame carries the turn's authoritative text when the answer
        // was NOT streamed as deltas — a model-provider timeout after the tool calls
        // puts its real explanation in `reply`, and a settled turn puts its final
        // answer there too. Nothing used to read it, so the user saw an empty
        // reply after ten successful browser calls while Core held the answer.
        // Only fills an otherwise-empty reply: streamed text is never overwritten.
        const final = typeof payload.reply === 'string' ? payload.reply.trim() : '';
        if (final && content.trim().length === 0) {
          content = final;
          if (typeof opts.onContent === 'function') opts.onContent(final, { content });
        }
      }
    }

    if (bridge && typeof bridge.stream === 'function') {
      // chat.js aborts `signal` on Stop. That must reach the main process, which owns the
      // HTTP request to Core and aborts it there — closing the stream locally would leave
      // Core (and any tool it is running) working for a turn nobody is waiting for.
      const aborted = () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return error;
      };
      if (opts.signal && opts.signal.aborted) throw aborted();
      await new Promise((resolve, reject) => {
        let settled = false;
        let cancel = null;
        const cleanup = () => { try { opts.signal?.removeEventListener('abort', onAbort); } catch (_) {} };
        const settle = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
        function onAbort() {
          if (settled) return;
          settled = true;
          try { cancel?.(); } catch (_) {}
          reject(aborted());
        }
        if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
        cancel = bridge.stream(text, {
          thinking: thinkingLevel(),
          onFrame: consumeFrame,
          onEnd: () => settle(resolve),
          onError: (message) => settle(reject, failure(message || 'KAI Core failed.')),
        });
      });
      // An empty reply is a failure whether or not a terminal frame arrived. It used
      // to throw only when `done` was missing, so a turn that ended with `{done:true}`
      // and no text returned `content:''` — the turn rendered as nothing at all while
      // the tools had really run. Core's own error, when it sent one, is the message.
      if (content.trim().length === 0) {
        const why = done && (done.reason || done.error);
        throw failure(why
          ? `KAI Core ended the turn without an answer: ${why}`
          : 'KAI Core ended the stream without sending anything.');
      }
      const tools = turnTools(before);
      return {
        content,
        tool_calls: tools.calls,
        tool_results: tools.results,
        finishReason: (done && done.finish_reason) || 'stop',
        usage: (done && done.usage) || null,
        kai: done ? { provider: done.provider, model: done.model, conversationId: done.conversation_id, toolIterations: done.tool_iterations } : null,
      };
    }

    // Fallback: a direct fetch, for running the renderer outside Electron (browser
    // dev), where there is no main process to proxy.
    // No conversation_id is forwarded on purpose. OpenGhost keeps the whole history in
    // the renderer; Core keeping a SECOND copy under the same id made the model echo
    // its own earlier replies (the repeated identity lines). One history, one owner.
    // The thinking level rides the turn so the Core applies it to the REAL
    // request; absent means "no preference", never a substituted default.
    const thinking = thinkingLevel();
    const body = thinking ? { text, thinking } : { text };

    let response;
    try {
      response = await fetch(baseUrl() + '/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw failure('KAI Core is unreachable at ' + baseUrl() + ' — start the KAI2 Core and try again.');
    }
    if (!response.ok) {
      // Core answers 503 {error:"brain_unavailable"} when no provider is configured.
      // Report THAT rather than showing an empty reply as if the model answered.
      throw failure('KAI Core refused the turn: HTTP ' + response.status);
    }
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) throw failure('KAI Core returned no readable stream.');

    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        if (frame.startsWith('data:')) consumeFrame(frame.slice(5).trim());
      }
    }
    if (content.length === 0 && done === null) {
      throw failure('KAI Core ended the stream without sending anything.');
    }

    const tools = turnTools(before);
    const final = {
      content,
      // What Core REALLY ran this turn, in the chat model's own shape. It is carried into
      // the message by Chat.request; Chat.loop is given no calls, so nothing runs twice.
      tool_calls: tools.calls,
      tool_results: tools.results,
      finishReason: (done && done.finish_reason) || 'stop',
      usage: (done && done.usage) || null,
      // Provenance the renderer may show, so the answer's source is auditable.
      kai: done
        ? { provider: done.provider, model: done.model, conversationId: done.conversation_id, toolIterations: done.tool_iterations }
        : null,
    };
    return final;
  }

  /** OpenGhost uses `complete` for titling, compaction and stats. KAI does not need
   *  the renderer to do any of that, and a second model call here would be a second
   *  authority — so it refuses loudly rather than silently calling a provider. */
  async function complete() {
    throw failure('KAI2: side model calls are disabled — KAI Core owns model selection.');
  }

  /** The live model list comes from KAI, not from OpenGhost's provider registry. */
  async function models() {
    const res = await fetch(baseUrl() + '/models', { headers: { accept: 'application/json' } });
    if (!res.ok) throw failure('KAI Core did not answer /models: HTTP ' + res.status);
    return res.json();
  }

  /**
   * The composer refuses to send when `config.ready` is false, and that flag is
   * `!!model && this.connected(provider)` — an OpenGhost provider/key check. KAI owns
   * model selection, so the renderer must not gate a turn on a local API key it no
   * longer uses. Without this the seam is never reached: Enter just opens Settings.
   *
   * Only identity/readiness is overridden. The rest of the config (effort, vision,
   * windows) is left as OpenGhost computed it, because the renderer still uses it.
   */
  function patchSettings() {
    if (!window.Settings || !window.Settings.prototype || typeof window.Settings.prototype.configFor !== 'function') {
      setTimeout(patchSettings, 0);
      return;
    }
    const original = window.Settings.prototype.configFor;
    window.Settings.prototype.configFor = function configFor(id) {
      const base = original.call(this, id);
      return Object.assign({}, base, {
        provider: 'kai',
        model: 'kai',
        name: 'KAI',
        key: '',
        // KAI Core decides availability — but only once it has been shown to BE the Core
        // this KAI2 expects. While compatibility is unknown or failed, the composer is not
        // ready, so a turn cannot be submitted to a Core we cannot vouch for.
        ready: compat.ok,
      });
    };
  }

  // ── Live activity, from Core's own events ────────────────────────────────────
  //
  // Core streams a `tool_event` frame for every REAL tool execution: the tool's name,
  // the arguments the model sent, the registry's own status, the timestamps, the
  // approval that parked it, and a SERVER-REDACTED, bounded result preview. Those
  // frames already arrive at this bridge — they were parsed and thrown away, which is
  // why KAI2 could not show what KAI was doing.
  //
  // Nothing here is synthesised. An entry exists only because Core sent an event for a
  // real invocation, keyed by Core's own `invocationId` (falling back to the model's
  // `toolCallId`), so a repeated frame UPDATES one row instead of inventing a second.
  // A tool is never shown as executed until Core's terminal status says so.
  const ACTIVITY_LIMIT = 200;
  /**
   * Activity is kept per CONVERSATION, never in one global list.
   *
   * A single shared list was the bug behind "a command appears in every new chat":
   * the strip rendered whatever happened last, so a new conversation opened showing
   * the previous one's shell command. Activity belongs to the session that produced
   * it, and a new session starts with none.
   */
  const activityBySession = new Map();
  let currentSession = '';
  const activityListeners = new Set();
  // Which conversations may be written down, and which have already been read back.
  // A protected chat is never persisted: its activity would otherwise sit in the clear
  // beside a message store that is sealed.
  const persistBySession = new Map();
  const hydrating = new Set();
  const hydrated = new Set();
  // A monotonic stamp on every event this run recorded. It is how a turn tells what it
  // touched apart from what hydration restored from disk while the turn was running —
  // object identity alone would count rehydrated history as this reply's tool calls.
  let activitySeq = 0;

  function activityBucket() {
    const key = currentSession;
    let bucket = activityBySession.get(key);
    if (bucket === undefined) {
      bucket = [];
      activityBySession.set(key, bucket);
    }
    return bucket;
  }

  function activityEntry(event) {
    const error = event.error && typeof event.error === 'object' ? event.error : null;
    return {
      // Internal, not part of the rendered row: who recorded this entry, and when.
      __seq: (activitySeq += 1),
      // `toolCallId` is the model-side call id, and Core's own contract says it is there
      // to MATCH A REQUEST TO ITS OUTCOME: a `tool_start` has no `invocationId` yet (the
      // registry mints that only once the call reaches the boundary), so keying on
      // `invocationId` first would render one invocation as two rows.
      key: String(event.toolCallId || event.invocationId || ''),
      toolId: typeof event.toolId === 'string' ? event.toolId : '',
      name: typeof event.toolName === 'string' ? event.toolName : '',
      // Core's phase: tool_start | tool_done | tool_error | tool_approval_required.
      phase: typeof event.type === 'string' ? event.type : '',
      // The registry's own verdict: EXECUTED | DENIED | APPROVAL_REQUIRED | INVALID | FAILED | NOT_FOUND.
      status: typeof event.status === 'string' ? event.status : '',
      arguments: typeof event.arguments === 'string' ? event.arguments.slice(0, 4_000) : '',
      startedAt: typeof event.startedAt === 'string' ? event.startedAt : null,
      completedAt: typeof event.completedAt === 'string' ? event.completedAt : null,
      approvalId: typeof event.approvalId === 'string' ? event.approvalId : null,
      error: error ? { code: String(error.code || ''), message: String(error.message || '').slice(0, 500) } : null,
      // Already redacted and bounded by Core (chat/result-preview.ts); used verbatim.
      resultPreview: typeof event.resultPreview === 'string' ? event.resultPreview : null,
      resultTruncated: event.resultTruncated === true,
    };
  }

  function notify(entry) {
    for (const listener of activityListeners) {
      try {
        listener(entry);
      } catch (_) {
        // a listener must never break a turn
      }
    }
  }

  function recordToolEvent(event) {
    if (!event || typeof event !== 'object') return;
    const entry = activityEntry(event);
    if (entry.key.length === 0) return; // no correlation id: not a row we can keep honest
    const bucket = activityBucket();
    const at = bucket.findIndex((existing) => existing.key === entry.key);
    if (at >= 0) bucket[at] = entry;
    else bucket.push(entry);
    while (bucket.length > ACTIVITY_LIMIT) bucket.shift();
    persistSession(currentSession);
    notify(entry);
  }

  // ── Which REAL tool calls this turn produced ────────────────────────────────
  //
  // The chat model keeps a tool exchange as an assistant `tool_calls` list followed by
  // one `role:'tool'` result per call. Core already ran the tools, so these are a record
  // of what happened, not a request to run anything: `Chat.request` stores them in the
  // message and hands `Chat.loop` no calls.
  //
  // The record is confined to what THIS turn touched. Taking the whole conversation
  // bucket would replay the same calls into every later reply, and Core's own start/done
  // pair is one entry (keyed by `toolCallId`), so one call yields exactly one row.
  const TERMINAL_STATUS = new Set(['EXECUTED', 'DENIED', 'INVALID', 'FAILED', 'NOT_FOUND']);

  function activitySnapshot() {
    return { session: currentSession, seq: activitySeq };
  }

  function isTerminal(entry) {
    return TERMINAL_STATUS.has(entry.status) || entry.phase === 'tool_done' || entry.phase === 'tool_error';
  }

  /**
   * What the tool's result says, in one honest line.
   * A denial stays a denial; a failure names its code; a truncated preview says so.
   * Tool output lives here only — it is never appended to the assistant's prose.
   */
  function outcomeOf(entry) {
    if (entry.status === 'DENIED') {
      return `Denied: ${(entry.error && entry.error.message) || 'Core refused this call under the current policy.'}`;
    }
    if (entry.phase === 'tool_error' || (entry.status !== 'EXECUTED' && TERMINAL_STATUS.has(entry.status))) {
      const code = entry.error && entry.error.code ? `${entry.error.code}: ` : '';
      return `Failed: ${code}${(entry.error && entry.error.message) || 'KAI Core reported no result.'}`;
    }
    if (entry.resultPreview) return entry.resultTruncated ? `${entry.resultPreview}\n[truncated by KAI Core]` : entry.resultPreview;
    return entry.resultTruncated ? 'Done; the output was truncated by KAI Core.' : 'Done.';
  }

  function turnTools(snapshot) {
    const bucket = activityBySession.get(snapshot.session) || [];
    const calls = [], results = [];
    for (const entry of bucket) {
      if (!(entry.__seq > snapshot.seq)) continue; // history, including what hydration restored
      if (!isTerminal(entry)) continue; // still running or waiting: no result to report yet
      const name = entry.name || entry.toolId || 'tool';
      calls.push({ id: entry.key, type: 'function', function: { name, arguments: entry.arguments || '{}' } });
      results.push({ tool_call_id: entry.key, name, status: entry.status, phase: entry.phase, content: outcomeOf(entry) });
    }
    return { calls, results };
  }

  // ── Persistence, so a reload shows what really happened ─────────────────────
  //
  // `chat-store.js` owns the per-session record (`window.KAI2Activity`), backed by the
  // same store as the chats themselves. The bridge writes after every event — a reload
  // half-way through a turn still shows the row — and reads once per session, merging
  // what is on disk under what this run has already seen (live wins).
  function activityStore() {
    const api = window.KAI2Activity;
    return api && typeof api.read === 'function' && typeof api.save === 'function' ? api : null;
  }

  function mayPersist(session) {
    return persistBySession.get(session) !== false;
  }

  function persistSession(session) {
    if (!session || !mayPersist(session) || hydrating.has(session)) return;
    const api = activityStore(), entries = activityBySession.get(session);
    if (!api || !entries || !entries.length) return;
    try {
      Promise.resolve(api.save(session, entries)).catch(() => {});
    } catch (_) {
      // storage is best effort; the live strip does not depend on it
    }
  }

  /** One stored entry, bounded exactly like a live one. Invalid rows are dropped. */
  function storedEntry(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !raw.key) return null;
    const error = raw.error && typeof raw.error === 'object' ? raw.error : null;
    return {
      // Restored rows are history, never this turn's work, whatever the stored stamp says.
      __seq: 0,
      key: raw.key.slice(0, 200),
      toolId: typeof raw.toolId === 'string' ? raw.toolId : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      phase: typeof raw.phase === 'string' ? raw.phase : '',
      status: typeof raw.status === 'string' ? raw.status : '',
      arguments: typeof raw.arguments === 'string' ? raw.arguments.slice(0, 4_000) : '',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
      approvalId: typeof raw.approvalId === 'string' ? raw.approvalId : null,
      error: error ? { code: String(error.code || ''), message: String(error.message || '').slice(0, 500) } : null,
      resultPreview: typeof raw.resultPreview === 'string' ? raw.resultPreview : null,
      resultTruncated: raw.resultTruncated === true,
    };
  }

  function hydrateSession(session) {
    if (!session || !mayPersist(session) || hydrated.has(session) || hydrating.has(session)) return;
    const api = activityStore();
    if (!api) return;
    hydrated.add(session);
    let reading;
    try {
      reading = api.read(session);
    } catch (_) {
      return;
    }
    hydrating.add(session);
    Promise.resolve(reading).then((saved) => {
      if (!Array.isArray(saved) || !saved.length) return;
      const merged = [];
      for (const raw of saved) {
        const entry = storedEntry(raw);
        if (entry) merged.push(entry);
      }
      for (const live of activityBySession.get(session) || []) {
        const at = merged.findIndex((entry) => entry.key === live.key);
        if (at >= 0) merged[at] = live; // what this run saw is newer than what was stored
        else merged.push(live);
      }
      while (merged.length > ACTIVITY_LIMIT) merged.shift();
      activityBySession.set(session, merged);
    }).catch(() => {}).then(() => {
      hydrating.delete(session);
      // The merge may have added stored rows under events that arrived meanwhile, so the
      // full merged bucket is written back once, not the truncated live part.
      persistSession(session);
      if (currentSession === session) notify(null);
    });
  }

  // ── The access mode, and the Doer switch ─────────────────────────────────────
  //
  // KAI2's three modes are a VIEW of Core's policy mode, not a second permission
  // system. The mode that actually authorises anything lives in Core (durable, owner
  // authenticated), and this layer can only ASK Core to change it: the renderer never
  // holds the host token, so a compromised page cannot grant itself authority.
  //
  // The two directions are asymmetric, exactly as Core is: RAISING authority must be
  // requested and then approved by the owner; LOWERING it applies at once and is never
  // blocked, because making safety the slow path is the wrong way round.
  // Auto maps to `auto-read`, NOT `normal`. Core documents `auto-read` as "as normal,
  // and additionally an action covered by an exact, narrow, already-granted scope runs
  // without a NEW card" — which is precisely the point of Auto: a task the owner has
  // already authorized must not re-ask at every step. `normal` re-asks by design, which
  // is why Auto felt identical to Ask.
  const MODE_TO_CORE = { ask: 'ask-all', auto: 'auto-read', full: 'elevated' };
  const MODE_FROM_CORE = { 'ask-all': 'ask', normal: 'auto', 'auto-read': 'auto', elevated: 'full' };
  const MODE_RANK = { 'ask-all': 0, normal: 1, 'auto-read': 2, elevated: 3 };

  function ownerBridge() {
    return (window.openghost && window.openghost.kai) || null;
  }

  function modeResult(out, fallback) {
    const body = (out && out.body) || {};
    if (out && out.ok && body.error !== true) {
      return { ok: true, state: body.state || null, pending: (body.state || {}).pending || null, reason: body.reason || '' };
    }
    if (body.approvalRequired) {
      return { ok: false, pendingApproval: body.approvalId || null, reason: 'This needs your approval before it can take effect.' };
    }
    return { ok: false, reason: body.reason || fallback };
  }

  const policyBridge = {
    /** KAI2's name -> Core's name, so a UI can show exactly what is in force. */
    names: MODE_TO_CORE,
    async read() {
      const bridge = ownerBridge();
      if (!bridge || !bridge.policy) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      try {
        const out = await bridge.policy.mode();
        const body = (out && out.body) || {};
        if (!out || !out.ok) return { ok: false, reason: body.reason || 'Core did not answer.' };
        return {
          ok: true,
          core: body.mode,
          mode: MODE_FROM_CORE[body.mode] || null,
          pending: (body.state || {}).pending || null,
          state: body.state || null,
        };
      } catch (err) {
        return { ok: false, reason: String(err && err.message ? err.message : err) };
      }
    },
    /**
     * Ask Core for a mode. `threadId` scopes an elevation, because Core refuses a
     * global `elevated` BY DESIGN: "Full access" is granted for one conversation, never
     * for the whole machine.
     */
    async apply(mode, threadId) {
      const target = MODE_TO_CORE[mode];
      if (!target) return { ok: false, reason: 'that is not one of KAI2\u2019s modes' };
      const bridge = ownerBridge();
      if (!bridge || !bridge.policy) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      const current = await policyBridge.read();
      if (!current.ok) return current;
      if (MODE_RANK[target] <= MODE_RANK[current.core]) {
        return modeResult(await bridge.policy.setMode({ action: 'downgrade', to: target }), 'Core refused the mode change.');
      }
      const scope = target === 'elevated' ? { kind: 'thread', id: threadId } : { kind: 'global' };
      // Only a NARROW scope needs an id. A global scope is complete as `{kind:"global"}`,
      // and demanding an id there would block every ordinary elevation.
      if (scope.kind !== 'global' && scope.id === undefined) {
        return { ok: false, reason: 'Full access is granted per conversation, and no conversation is open.' };
      }
      return modeResult(await bridge.policy.setMode({ action: 'request', to: target, scope }), 'Core refused the request.');
    },

    /**
     * Confirm the elevation Core is holding. The request id comes from Core's own
     * pending state, never from the renderer, so a caller cannot confirm an
     * elevation it did not ask for.
     */
    async confirm() {
      const bridge = ownerBridge();
      if (!bridge || !bridge.policy) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      const current = await policyBridge.read();
      const pending = current && current.pending;
      if (!pending || !pending.requestId) return { ok: false, reason: 'nothing is waiting for approval' };
      return modeResult(
        await bridge.policy.setMode({ action: 'confirm', to: pending.to, scope: pending.scope, requestId: pending.requestId }),
        'Core refused the confirmation.',
      );
    },

    /** Cancel the pending elevation and leave the mode as it was. */
    async cancel() {
      const bridge = ownerBridge();
      if (!bridge || !bridge.policy) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      const current = await policyBridge.read();
      const pending = current && current.pending;
      if (!pending || !pending.requestId) return { ok: false, reason: 'nothing is waiting' };
      return modeResult(
        await bridge.policy.setMode({ action: 'cancel', requestId: pending.requestId, to: pending.to }),
        'Core refused the cancellation.',
      );
    },
  };

  const doerBridge = {
    async read() {
      const bridge = ownerBridge();
      if (!bridge || !bridge.doer) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      try {
        const out = await bridge.doer.get();
        const body = (out && out.body) || {};
        return out && out.ok ? { ok: true, state: body.state || null } : { ok: false, reason: body.reason || 'Core did not answer.' };
      } catch (err) {
        return { ok: false, reason: String(err && err.message ? err.message : err) };
      }
    },
    async set(state) {
      const bridge = ownerBridge();
      if (!bridge || !bridge.doer) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      try {
        return modeResult(await bridge.doer.set(state), 'Core refused the change.');
      } catch (err) {
        return { ok: false, reason: String(err && err.message ? err.message : err) };
      }
    },
  };

  const monsterBridge = {
    async read() {
      const bridge = ownerBridge();
      if (!bridge || !bridge.monster) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      try {
        const out = await bridge.monster.get();
        const body = (out && out.body) || {};
        return out && out.ok
          ? { ok: true, state: body.state || null, limits: body.limits || null }
          : { ok: false, reason: body.reason || 'Core did not answer.' };
      } catch (err) {
        return { ok: false, reason: String(err && err.message ? err.message : err) };
      }
    },
    async set(state) {
      const bridge = ownerBridge();
      if (!bridge || !bridge.monster) return { ok: false, reason: 'KAI2 has no bridge to Core.' };
      try {
        const out = await bridge.monster.set(state);
        const body = (out && out.body) || {};
        if (!out || !out.ok) return { ok: false, reason: body.reason || 'Core refused the change.', pendingApproval: Boolean(body.pendingApproval || body.approvalId) };
        const next = (body.monster && body.monster.state) || state;
        return { ok: true, state: next, limits: (body.monster && body.monster.limits) || null };
      } catch (err) {
        return { ok: false, reason: String(err && err.message ? err.message : err) };
      }
    },
  };

  function install() {
    if (!window.Providers) {
      // providers.js has not run yet; retry after the current script pass.
      setTimeout(install, 0);
      return;
    }
    window.Providers.stream = stream;
    window.Providers.complete = complete;
    window.Providers.models = models;
    // `available` gates the composer. KAI is available whenever Core answers, so this
    // is a function-backed flag rather than a key check.
    try {
      Object.defineProperty(window.Providers, 'available', { value: true, configurable: true, writable: true });
    } catch (_) {
      window.Providers.available = true;
    }
    window.KAI2 = {
      baseUrl,
      stream,
      models,
      installed: true,
      // The verdict, and the two ways to act on it: re-check (Retry), or read the last
      // one. `compat()` is read-only state, not a bypass.
      compat: () => ({ checked: compat.checked, ok: compat.ok, verdict: compat.verdict }),
      /** Create a real work item: a TODO KAI will own and report on. */
      todoCreate: async (objective, criteria) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.todoCreate) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.todoCreate(objective, criteria); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** Create a real schedule entry at Core. */
      scheduleCreate: async (title, runAt) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.scheduleCreate) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.scheduleCreate(title, runAt); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** The canonical turns of a conversation (for answer recovery). */
      sessionTurns: async (id, limit) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.sessionTurns) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.sessionTurns(id, limit); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** Read or set the stage-review policy (ASK / AUTO / OFF). */
      reviewPolicy: async (mode) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.reviewPolicy) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.reviewPolicy(mode); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** Run a terminal command through Core (parks for approval). */
      shellRun: async (command, approvalId) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.shellRun) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.shellRun(command, approvalId); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** Run a plan: executes its stages in order. */
      todoRun: async (id, approvalId) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.todoRun) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.todoRun(id, approvalId); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** Edit a task's title at Core. */
      todoEdit: async (id, objective) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.todoEdit) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.todoEdit(id, objective); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** Cancel a scheduled task at Core. */
      scheduleCancel: async (id) => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.scheduleCancel) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.scheduleCancel(id); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },
      /** Tasks & Schedule: current work, planned work, recent execution. */
      dashboard: async () => {
        const owner = window.openghost && window.openghost.kai;
        if (!owner || !owner.dashboard) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try { return await owner.dashboard(); }
        catch (err) { return { ok: false, body: { reason: String(err && err.message ? err.message : err) } }; }
      },

      checkCompat,
      policy: policyBridge,
      doer: doerBridge,
      monster: monsterBridge,
      /**
       * Pending approvals, read and decided through the main process (the only side
       * holding the owner credential). The renderer can answer a real record; it can
       * never manufacture one.
       */
      approvals: {
        async list() {
          const bridge = window.openghost && window.openghost.kai;
          if (!bridge || !bridge.approvals) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
          try {
            return await bridge.approvals.list();
          } catch (err) {
            return { ok: false, body: { reason: String(err && err.message ? err.message : err) } };
          }
        },
        async decide(id, approved, scope) {
          const bridge = window.openghost && window.openghost.kai;
          if (!bridge || !bridge.approvals) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
          try {
            return await bridge.approvals.decide(id, approved, scope);
          } catch (err) {
            return { ok: false, body: { reason: String(err && err.message ? err.message : err) } };
          }
        },
      },
      /** The real tool invocations KAI made, newest first. Named distinctly from
       *  `activity` below, which is the local call bucket — a duplicate key would
       *  silently shadow one of them. */
      toolActivity: async (limit) => {
        const bridge = window.openghost && window.openghost.kai;
        if (!bridge || !bridge.toolActivity) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try {
          return await bridge.toolActivity(limit);
        } catch (err) {
          return { ok: false, body: { reason: String(err && err.message ? err.message : err) } };
        }
      },
      /** What KAI can actually call, who can do the work, and which agents exist. */
      catalog: async () => {
        const bridge = window.openghost && window.openghost.kai;
        if (!bridge || !bridge.catalog) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try {
          return await bridge.catalog();
        } catch (err) {
          return { ok: false, body: { reason: String(err && err.message ? err.message : err) } };
        }
      },
      /** The evidence-backed day report, built by Core from real history. */
      dailySummary: async (from, to) => {
        const bridge = window.openghost && window.openghost.kai;
        if (!bridge || !bridge.summary) return { ok: false, body: { reason: 'KAI2 has no bridge to Core.' } };
        try {
          return await bridge.summary.daily(from, to);
        } catch (err) {
          return { ok: false, body: { reason: String(err && err.message ? err.message : err) } };
        }
      },
      // The live activity timeline for the CURRENT conversation: only real Core tool
      // events, newest last. Read-only copies, so a caller cannot mutate what the
      // timeline believes happened.
      activity: () => activityBucket().map(({ __seq, ...entry }) => ({ ...entry })),
      /**
       * Which conversation new events belong to, and what the strip shows. Called by the
       * chat layer whenever the active conversation changes — a new chat therefore shows
       * NO activity rather than the previous conversation's commands.
       *
       * `options.persist === false` is for a protected chat: its activity is kept in
       * memory only, never written beside a message store that is sealed. The saved
       * activity of a session is read once, when it is first selected after a reload.
       */
      setSession: (id, options) => {
        const next = typeof id === 'string' ? id : '';
        if (options && options.persist === false) persistBySession.set(next, false);
        else persistBySession.set(next, true);
        const changed = next !== currentSession;
        currentSession = next;
        if (!(options && options.persist === false)) hydrateSession(next);
        if (!changed) return;
        // `null` means "the session changed, re-read" — not "here is an event".
        notify(null);
      },
      /**
       * Drop a conversation's activity for good: memory and stored copy. Used when a chat
       * is deleted, or becomes protected (its activity must not outlive in the clear).
       */
      forgetActivity: (id) => {
        const key = typeof id === 'string' ? id : '';
        if (!key) return;
        activityBySession.delete(key);
        hydrated.delete(key);
        const api = activityStore();
        if (api && typeof api.clear === 'function') {
          try {
            Promise.resolve(api.clear(key)).catch(() => {});
          } catch (_) {
            // nothing to undo: the in-memory copy is already gone
          }
        }
        if (currentSession === key) notify(null);
      },
      onActivity: (listener) => {
        activityListeners.add(listener);
        return () => activityListeners.delete(listener);
      },
    };
    installCompatNotice();
    patchSettings();
    // The bridge is the last thing to install, and elements declared in the page body
    // are upgraded BEFORE these scripts run — so a component that needs `KAI2` has to
    // be told when it exists rather than assuming it was first.
    document.dispatchEvent(new CustomEvent('kai2:ready'));
    // Answer "which Core is answering?" before the first turn, not after it. A failure
    // here is expected and handled (the notice is shown); it must not abort setup.
    // A Core this app just spawned answers only once it has booted, so the FIRST check
    // races it and would cache "unreachable" — showing a scary notice and an offline
    // avatar until somebody pressed Retry. Retry on a bounded backoff so a launch settles
    // on the truth. Each attempt is cheap (one GET /identity).
    void (async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          await checkCompat();
        } catch (_) {
          // a transport failure is just this attempt failing; try again
        }
        if (compat.ok) return;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    })();
  }

  install();
})();
