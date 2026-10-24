(() => {
'use strict';

// Settings → Character Studio.
//
// One page that owns KAI's 3D character: a live preview of the REAL renderer
// (`<kai-avatar>`, the same element the welcome surface mounts), the grooming and
// colour controls that element actually consumes, motion/personality, and the save
// semantics.
//
// DRAFT vs SAVED
//   • every control edits `this.draft` and pushes it to the preview at once;
//   • nothing reaches KAI's live avatar until "Save changes" (`KaiAvatar.commitConfig`
//     writes the store and fires `kai:character-changed`);
//   • "Discard" throws the draft away; "Restore default KAI" commits the defaults.
//
// The page renders every option from the character model (`window.KaiAvatar`), so a
// style, preset or palette that the renderer cannot draw is never offered.
//
// The motion preview drives THIS page's element only. It cannot touch
// `kai-character-state.js`, the bridge, or any task state.

const K = window.KaiAvatar;
const LIVE_STATE_EVENT = 'kai:character-state';

const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const t = (key, fallback) => (I18n.has(key) ? I18n.t(key) : fallback);

/** Human labels for the renderer's own limits (nothing is invented here). */
const SLIDERS = {
  length: { label: 'Length', format: v => `${Math.round(v * 50.8)} mm` },
  density: { label: 'Density', format: v => `${Math.round(v * 100)}%` },
  curliness: { label: 'Curl', format: v => `${Math.round(v * 100)}%` },
  clumping: { label: 'Clumping', format: v => `${Math.round(v * 100)}%` },
  roughness: { label: 'Roughness', format: v => v.toFixed(2) },
  specular: { label: 'Sheen', format: v => v.toFixed(2) },
  speed: { label: 'Animation speed', format: v => `${v.toFixed(2)}×` },
  intensity: { label: 'Expressiveness', format: v => `${v.toFixed(2)}×` },
  wind: { label: 'Fur wind', format: v => v.toFixed(2) },
  accentStrength: { label: 'State tint', format: v => `${Math.round(v * 100)}%` },
};

const PREVIEW_STATES = ['idle', 'thinking', 'working', 'waiting_for_approval', 'success', 'error', 'offline'];
const PREVIEW_ACTIONS = [
  ['boop_reaction', 'Boop'],
  ['thinking_ponder', 'Ponder'],
  ['working_engage', 'Engage'],
  ['approval_alert', 'Ask approval'],
  ['success_celebration', 'Celebrate'],
  ['error_recoil', 'Recoil'],
  ['dance_groove', 'Dance'],
];
const STATE_LABELS = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  waiting_for_approval: 'Waiting for approval',
  success: 'Success',
  error: 'Error',
  offline: 'Offline',
};

class CharacterSettings {
  constructor(root) {
    if (!K) {
      console.error('Character Studio: kai-avatar3d.js is not loaded.');
      return;
    }
    this.root = root;
    this.saved = K.loadConfig();
    this.draft = K.cloneConfig(this.saved);
    this.previewState = null;
    this.liveState = (window.KaiCharacterState && window.KaiCharacterState.current) || 'idle';

    root.innerHTML = `
      <p class="settings-lead">${escapeHtml(t('settings.character.lead', 'Design the character KAI wears: its grooming, its colours and how it moves. The preview is the real renderer; nothing changes on your KAI until you save.'))}</p>
      <div class="character-studio">
        <div class="character-preview">
          <div class="character-stage">
            <kai-avatar interactive aria-label="${escapeHtml(t('settings.character.preview', 'Live preview of KAI’s character'))}"></kai-avatar>
            <span class="character-badge" data-live="loading"><i></i><span class="character-badge-text">Loading 3D…</span></span>
            <span class="character-state" hidden></span>
          </div>
          <div class="character-preview-bar">
            <span class="character-summary"></span>
            <span class="character-preview-actions">
              <button type="button" class="settings-button" data-view="reset">Reset view</button>
              <button type="button" class="settings-button" data-view="boop">Boop</button>
            </span>
          </div>
        </div>

        <div class="character-controls">
          <section class="character-block">
            <h3 class="character-title">Presets</h3>
            <p class="settings-hint">A preset sets the whole coat: grooming, fur and palette.</p>
            <div class="character-presets" role="group" aria-label="Fur presets"></div>
          </section>

          <section class="character-block">
            <h3 class="character-title">Fur &amp; hair</h3>
            <p class="settings-hint">The style changes the strands themselves — straight, waved and curly are different geometry, not a colour.</p>
            <div class="character-styles" role="group" aria-label="Hair style"></div>
            <div class="character-sliders" data-group="groom"></div>
          </section>

          <section class="character-block">
            <h3 class="character-title">Colours</h3>
            <p class="settings-hint">Your palette is what KAI shows at rest. A running turn tints it temporarily and then gives it back.</p>
            <div class="character-colors">
              <label class="character-color"><span>Root colour</span><input type="color" data-color="base"><output data-hex="base"></output></label>
              <label class="character-color"><span>Tip colour</span><input type="color" data-color="tip"><output data-hex="tip"></output></label>
              <label class="character-color"><span>Accent light</span><input type="color" data-color="accent"><output data-hex="accent"></output></label>
            </div>
            <div class="character-palettes" role="group" aria-label="Palettes"></div>
          </section>

          <section class="character-block">
            <h3 class="character-title">Fur properties</h3>
            <p class="settings-hint">Curl gives way as the coat grows, so the outer locks never close over the eyes.</p>
            <div class="character-sliders" data-group="coat"></div>
          </section>

          <section class="character-block">
            <h3 class="character-title">Motion &amp; personality</h3>
            <p class="settings-hint">One motion configuration for every state; a personality only changes its numbers.</p>
            <div class="character-personalities" role="group" aria-label="Personality"></div>
            <div class="character-sliders" data-group="motion"></div>
            <div class="settings-row character-toggle-row">
              <div class="settings-text">
                <span class="settings-label">Reduced motion</span>
                <p class="settings-hint">Paint still frames instead of animating. KAI keeps its pose; it stops moving.</p>
              </div>
              <div class="settings-control"><button type="button" class="character-switch" role="switch" aria-checked="false" data-reduced></button></div>
            </div>
          </section>

          <details class="character-advanced">
            <summary>Advanced</summary>
            <div class="character-block">
              <h3 class="character-title">Renderer</h3>
              <div class="settings-row">
                <div class="settings-text">
                  <span class="settings-label">Fur quality</span>
                  <p class="settings-hint">Auto uses the lightweight pipeline. High-fidelity adds the 60k-strand GPU pipeline and GPU fur physics when the machine supports it.</p>
                </div>
                <div class="settings-control"><select class="character-select" data-quality></select></div>
              </div>
              <p class="character-note" data-quality-note></p>
            </div>
            <div class="character-block">
              <h3 class="character-title">Motion preview</h3>
              <p class="settings-hint">Plays on this preview only. It never sends a task, changes a result or moves the worker.</p>
              <div class="character-actions-row" data-preview-states></div>
              <div class="character-actions-row" data-preview-actions></div>
              <p class="character-note" data-preview-note>Live state is shown above. A preview holds until live activity replaces it.</p>
            </div>
            <div class="character-block">
              <h3 class="character-title">Signals</h3>
              <p class="settings-hint" data-signals></p>
            </div>
          </details>
        </div>
      </div>

      <footer class="character-footer">
        <p class="character-status" role="status" aria-live="polite"></p>
        <div class="character-actions-row">
          <button type="button" class="settings-button" data-action="revert">Discard changes</button>
          <button type="button" class="settings-button" data-action="default">Restore default KAI</button>
          <button type="button" class="settings-button is-primary" data-action="save">Save changes</button>
        </div>
      </footer>`;

    this.avatar = root.querySelector('kai-avatar');
    this.badge = root.querySelector('.character-badge');
    this.badgeText = root.querySelector('.character-badge-text');
    this.stateChip = root.querySelector('.character-state');
    this.summary = root.querySelector('.character-summary');
    this.status = root.querySelector('.character-status');
    this.reducedSwitch = root.querySelector('[data-reduced]');
    this.qualityNote = root.querySelector('[data-quality-note]');

    this.buildPresets();
    this.buildStyles();
    this.buildPalettes();
    this.buildSliders();
    this.buildPersonalities();
    this.buildPreview();
    this.bind();

    this.avatar.setConfig(this.draft);
    this.status.textContent = 'Draft preview — save to wear this on KAI.';
    this.sync();
    this.watchAvatar();
    this.watchLiveState();
  }

  // ── Building the controls ───────────────────────────────────────────────────

  buildPresets() {
    const host = this.root.querySelector('.character-presets');
    this.presetButtons = K.FUR_PRESETS.map(preset => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'character-preset';
      button.dataset.preset = preset.id;
      button.innerHTML = `
        <span class="character-preset-swatch"></span>
        <span class="character-preset-text">
          <span class="character-preset-name">${escapeHtml(preset.label)}</span>
          <span class="character-preset-hint">${escapeHtml(preset.hint)}</span>
        </span>`;
      const palette = K.PALETTES.find(p => p.id === preset.palette);
      if (palette) button.querySelector('.character-preset-swatch').style.background = `linear-gradient(135deg, ${palette.tip} 0%, ${palette.base} 100%)`;
      button.addEventListener('click', () => {
        const next = K.configFromPreset(preset.id);
        if (!next) return;
        // A preset is a coat, not a personality: motion stays the owner's.
        next.motion = { ...this.draft.motion };
        this.draft = next;
        this.apply('Preset applied.');
      });
      host.append(button);
      return button;
    });
  }

  buildStyles() {
    const host = this.root.querySelector('.character-styles');
    this.styleButtons = K.HAIR_STYLES.map(style => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'character-style';
      button.dataset.style = style.id;
      button.innerHTML = `<span class="character-style-name">${escapeHtml(style.label)}</span><span class="character-style-hint">${escapeHtml(style.hint)}</span>`;
      button.addEventListener('click', () => {
        this.draft = K.withHairStyle(this.draft, style.id);
        this.apply('Hair style changed.');
      });
      host.append(button);
      return button;
    });
  }

  buildPalettes() {
    const host = this.root.querySelector('.character-palettes');
    this.paletteButtons = K.PALETTES.map(palette => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'character-palette';
      button.dataset.palette = palette.id;
      button.title = palette.hint;
      button.setAttribute('aria-label', palette.label);
      button.innerHTML = `<span style="background:${palette.base}"></span><span style="background:${palette.tip}"></span><span style="background:${palette.accent}"></span>`;
      button.addEventListener('click', () => {
        this.draft = K.withPalette(this.draft, palette.id);
        this.apply('Palette applied.');
      });
      host.append(button);
      return button;
    });
  }

  buildSliders() {
    this.sliders = {};
    const groups = { groom: ['length', 'density'], coat: ['clumping', 'curliness', 'roughness', 'specular'], motion: ['speed', 'intensity', 'wind', 'accentStrength'] };
    for (const [group, keys] of Object.entries(groups)) {
      const host = this.root.querySelector(`[data-group="${group}"]`);
      for (const key of keys) {
        const limit = K.LIMITS[key];
        const meta = SLIDERS[key];
        const row = document.createElement('label');
        row.className = 'character-slider';
        row.innerHTML = `
          <span class="character-slider-label">${escapeHtml(meta.label)}</span>
          <input type="range" min="${limit.min}" max="${limit.max}" step="0.01" data-slider="${key}">
          <output class="character-slider-value"></output>`;
        const input = row.querySelector('input');
        input.addEventListener('input', () => {
          const value = Number(input.value);
          this.draft = group === 'motion' ? K.withMotionValue(this.draft, key, value) : K.withFurValue(this.draft, key, value);
          this.apply(null, { keep: key });
        });
        host.append(row);
        this.sliders[key] = { input, output: row.querySelector('output'), format: meta.format };
      }
    }
  }

  buildPersonalities() {
    const host = this.root.querySelector('.character-personalities');
    this.personalityButtons = K.PERSONALITIES.map(personality => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'character-personality';
      button.dataset.personality = personality.id;
      button.innerHTML = `<span>${escapeHtml(personality.label)}</span><small>${escapeHtml(personality.hint)}</small>`;
      button.addEventListener('click', () => {
        this.draft = K.withPersonality(this.draft, personality.id);
        this.apply('Personality applied.');
      });
      host.append(button);
      return button;
    });
  }

  buildPreview() {
    const states = this.root.querySelector('[data-preview-states]');
    for (const state of PREVIEW_STATES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-button character-chip';
      button.textContent = STATE_LABELS[state] || state;
      button.dataset.state = state;
      button.addEventListener('click', () => this.previewState_(state));
      states.append(button);
    }
    const actions = this.root.querySelector('[data-preview-actions]');
    for (const [action, label] of PREVIEW_ACTIONS) {
      if (!Object.values(K.KAI_ACTIONS).includes(action)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-button character-chip';
      button.textContent = label;
      button.dataset.action = action;
      button.addEventListener('click', () => {
        this.avatar.previewAction(action);
        this.showChip(`Motion preview: ${label}`, 'preview');
      });
      actions.append(button);
    }
    const quality = this.root.querySelector('[data-quality]');
    for (const [value, label] of [['auto', 'Auto (lightweight)'], ['high', 'High fidelity (GPU)'], ['light', 'Lightweight']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      quality.append(option);
    }
    quality.addEventListener('change', () => {
      this.draft = K.withQuality(this.draft, quality.value);
      this.apply('Renderer quality changed.');
    });
    this.quality = quality;
    const unmapped = K.UNMAPPED_AVATAR_STATES;
    this.root.querySelector('[data-signals]').textContent =
      `Driven by kai:character-state (KAI2's real state): idle, listening, thinking, working, waiting_approval, error, success, offline. ` +
      `A tool Core actually runs is read from KAI2.onActivity (tool_start → working, approval → waiting, a failure → one recoil); ` +
      `a completed tool is never a celebration. ` +
      `Not signalled by the app today, so not animated: ${unmapped.join(', ') || 'none'}.`;
  }

  bind() {
    this.root.querySelectorAll('.character-color input').forEach(input => {
      input.addEventListener('input', () => {
        this.draft = K.withColor(this.draft, input.dataset.color, input.value);
        this.apply('Colour changed.', { keep: `color:${input.dataset.color}` });
      });
    });
    this.reducedSwitch.addEventListener('click', () => {
      const next = !this.draft.motion.reducedMotion;
      this.draft = K.withMotionValue(this.draft, 'reducedMotion', next);
      this.apply('Reduced motion turned ' + (next ? 'on' : 'off') + '.');
    });
    this.root.querySelector('[data-view="reset"]').addEventListener('click', () => this.avatar.resetView());
    this.root.querySelector('[data-view="boop"]').addEventListener('click', () => this.avatar.boop());
    this.root.querySelector('[data-action="save"]').addEventListener('click', () => this.save());
    this.root.querySelector('[data-action="revert"]').addEventListener('click', () => {
      this.draft = K.cloneConfig(this.saved);
      this.apply('Changes discarded.');
    });
    this.root.querySelector('[data-action="default"]').addEventListener('click', () => {
      this.draft = K.cloneConfig(K.DEFAULT_CONFIG);
      this.saved = K.commitConfig(this.draft);
      this.sync();
      this.status.textContent = 'KAI is back to its default character.';
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────

  apply(note = null, { keep = null } = {}) {
    // Normalize the DRAFT (not just the renderer's copy) so a clamped value — e.g. curl
    // as the coat grows — is what the controls show, instead of a value nothing uses.
    this.draft = K.normalizeConfig(this.draft);
    this.avatar.setConfig(this.draft);
    this.sync(keep);
    if (note) this.status.textContent = note;
  }

  save() {
    this.saved = K.commitConfig(this.draft);
    this.sync();
    this.status.textContent = 'Saved. Every KAI surface now wears this character.';
  }

  sync(keep = null) {
    const draft = this.draft;
    for (const button of this.presetButtons) {
      const on = draft.preset === button.dataset.preset;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const button of this.styleButtons) {
      const on = draft.furStyle === button.dataset.style;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const button of this.paletteButtons) {
      const on = draft.palette.id === button.dataset.palette;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const button of this.personalityButtons) {
      const on = draft.motion.personality === button.dataset.personality;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    for (const [key, row] of Object.entries(this.sliders)) {
      const value = key in draft.fur ? draft.fur[key] : draft.motion[key];
      if (keep !== key) row.input.value = String(value);
      row.output.textContent = row.format(Number(row.input.value));
    }
    this.root.querySelectorAll('.character-color input').forEach(input => {
      const channel = input.dataset.color;
      if (keep !== `color:${channel}`) input.value = draft.palette[channel];
      this.root.querySelector(`[data-hex="${channel}"]`).textContent = draft.palette[channel];
    });
    this.reducedSwitch.classList.toggle('is-on', draft.motion.reducedMotion);
    this.reducedSwitch.setAttribute('aria-checked', String(draft.motion.reducedMotion));
    if (this.quality) this.quality.value = draft.render.quality;
    this.qualityNote.textContent = this.avatar.gpuFurUnavailable
      ? 'This machine could not start the GPU fur pipeline; the lightweight fur is running instead.'
      : '';
    const dirty = !sameAsSaved(draft, this.saved);
    this.root.classList.toggle('is-dirty', dirty);
    this.summary.textContent = K.describeConfig(draft) + (dirty ? ' · unsaved changes' : '');
  }

  watchAvatar() {
    this.avatar.addEventListener('kai-avatar-ready', () => {
      this.setBadge('live', 'Live 3D');
      this.sync();
    });
    this.avatar.addEventListener('kai-avatar-unavailable', event => {
      const reason = event.detail && event.detail.reason ? event.detail.reason : 'WebGL is unavailable';
      this.setBadge('fallback', '2D fallback');
      this.badge.title = reason;
      this.status.textContent = `The 3D preview could not start (${reason}). KAI keeps its 2D face; the settings still save.`;
    });
    if (this.avatar.live) this.setBadge('live', 'Live 3D');
  }

  watchLiveState() {
    const paint = () => {
      this.liveState = (window.KaiCharacterState && window.KaiCharacterState.current) || 'idle';
      if (!this.previewState) this.showChip(`Live state: ${STATE_LABELS[this.liveState] || this.liveState}`, 'live');
    };
    document.addEventListener(LIVE_STATE_EVENT, event => {
      const state = event.detail && event.detail.state;
      this.previewState = null;
      if (state) this.liveState = state;
      paint();
    });
    // The element also reports what it was told; used when the app dispatches before this page existed.
    this.avatar.addEventListener('kai-avatar-state', event => {
      if (event.detail && event.detail.runtime) this.liveState = event.detail.runtime;
      if (!this.previewState) paint();
    });
    paint();
  }

  previewState_(state) {
    this.previewState = state;
    this.avatar.setState(state, { replay: true });
    this.showChip(`Motion preview: ${STATE_LABELS[state] || state}`, 'preview');
  }

  showChip(text, kind) {
    this.stateChip.hidden = false;
    this.stateChip.textContent = text;
    this.stateChip.dataset.kind = kind;
  }

  setBadge(kind, text) {
    this.badge.dataset.live = kind;
    this.badgeText.textContent = text;
  }
}

function sameAsSaved(a, b) {
  return K.sameConfig ? K.sameConfig(a, b) : JSON.stringify(a) === JSON.stringify(b);
}

window.CharacterSettings = CharacterSettings;
})();
