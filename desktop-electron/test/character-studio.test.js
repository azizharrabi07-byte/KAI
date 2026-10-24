'use strict';
/**
 * character-studio.test.js — the character model and the state bridge.
 *
 * These are the two pure modules behind KAI's 3D character: `character-config.js`
 * (what the owner can change, what is persisted, what an invalid value becomes) and
 * `state-bridge.js` (which real state becomes which face, and when a one-shot may
 * fire). The renderer itself is verified against a real WebGL surface; this suite
 * pins the rules that must never drift:
 *
 *   • an invalid or outdated stored character falls back to KAI's default instead of
 *     reaching a shader;
 *   • every numeric value is clamped to the range the renderer accepts;
 *   • a preset name is only kept while it still describes the config;
 *   • the straight and curly styles differ in the values that actually bend strands;
 *   • a repeated state never re-fires an entrance animation;
 *   • an unknown state is reported, never invented;
 *   • idle carries no state tint, so the saved palette is exactly what renders.
 */

const test = require('node:test');
const assert = require('node:assert');

const Config = require('../avatar3d/src/character-config.js');
const State = require('../avatar3d/src/state-bridge.js');

function memoryStore(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    get written() {
      return value;
    },
  };
}

// ── The stored character ───────────────────────────────────────────────────────

test('nothing stored yields KAI\'s default character', () => {
  const config = Config.loadConfig(memoryStore(null));
  assert.deepStrictEqual(config, Config.normalizeConfig(Config.DEFAULT_CONFIG));
  assert.strictEqual(config.preset, 'kai-official');
  assert.strictEqual(config.palette.tip, '#7dd3fc');
});

test('a saved character round-trips exactly', () => {
  const store = memoryStore();
  const chosen = Config.withPalette(Config.withHairStyle(Config.DEFAULT_CONFIG, 'curly'), 'rose');
  const raw = Config.saveConfig(chosen, store);
  assert.deepStrictEqual(Config.loadConfig(store), Config.normalizeConfig(chosen));
  assert.strictEqual(JSON.parse(raw).version, Config.CONFIG_VERSION);
});

test('malformed JSON falls back to the default instead of throwing', () => {
  assert.deepStrictEqual(Config.loadConfig(memoryStore('{not json')), Config.normalizeConfig(Config.DEFAULT_CONFIG));
  assert.deepStrictEqual(Config.loadConfig(memoryStore('[1,2,3]')), Config.normalizeConfig(Config.DEFAULT_CONFIG));
  assert.deepStrictEqual(Config.loadConfig(memoryStore('null')), Config.normalizeConfig(Config.DEFAULT_CONFIG));
});

test('an outdated or hand-edited character is normalized, never trusted', () => {
  const stale = {
    version: 0,
    furStyle: 'not-a-style',
    fur: { length: 999, density: -4, clumping: 'wide', curliness: null, roughness: 0.5, specular: 12 },
    palette: { id: 'nope', base: 'red', tip: '#ABCDEF', accent: '#1234567' },
    motion: { personality: 'chaotic', speed: 40, intensity: -2, wind: 'breeze', accentStrength: 3, reducedMotion: 'yes' },
    render: { quality: 'ultra' },
  };
  const config = Config.normalizeConfig(stale);
  const limits = Config.LIMITS;
  assert.strictEqual(config.version, Config.CONFIG_VERSION);
  assert.strictEqual(config.furStyle, Config.DEFAULT_CONFIG.furStyle);
  assert.strictEqual(config.fur.length, limits.length.max);
  assert.strictEqual(config.fur.density, limits.density.min);
  assert.strictEqual(config.fur.clumping, Config.DEFAULT_CONFIG.fur.clumping);
  assert.strictEqual(config.fur.specular, limits.specular.max);
  assert.strictEqual(config.palette.base, Config.DEFAULT_CONFIG.palette.base);
  assert.strictEqual(config.palette.tip, '#abcdef');
  assert.strictEqual(config.palette.accent, Config.DEFAULT_CONFIG.palette.accent);
  assert.strictEqual(config.motion.personality, Config.DEFAULT_CONFIG.motion.personality);
  assert.strictEqual(config.motion.speed, limits.speed.max);
  assert.strictEqual(config.motion.intensity, limits.intensity.min);
  assert.strictEqual(config.motion.accentStrength, limits.accentStrength.max);
  assert.strictEqual(config.motion.reducedMotion, false);
  assert.strictEqual(config.render.quality, Config.DEFAULT_CONFIG.render.quality);
});

// ── Styles and presets ────────────────────────────────────────────────────────

test('straight and curly differ in the values that bend the strands', () => {
  const straight = Config.withHairStyle(Config.DEFAULT_CONFIG, 'straight');
  const curly = Config.withHairStyle(Config.DEFAULT_CONFIG, 'curly');
  assert.ok(straight.fur.curliness < 0.05, 'a straight coat has almost no curl');
  assert.ok(curly.fur.curliness > 0.8, 'a curly coat has strong curl geometry');
  assert.ok(curly.fur.clumping > straight.fur.clumping, 'curly locks gather into tufts');
  assert.notStrictEqual(straight.fur.length, curly.fur.length);
  // The colours are the owner's; a style never repaints the character.
  assert.deepStrictEqual(straight.palette, curly.palette);
});

test('every fur preset is a complete, renderable character', () => {
  const seen = new Set();
  for (const preset of Config.FUR_PRESETS) {
    const config = Config.configFromPreset(preset.id);
    assert.ok(config, `preset ${preset.id} builds a config`);
    assert.strictEqual(config.preset, preset.id);
    assert.strictEqual(config.furStyle, preset.style);
    assert.ok(Config.HAIR_STYLES.some(style => style.id === preset.style));
    assert.ok(Config.PALETTES.some(palette => palette.id === preset.palette));
    for (const key of Config.FUR_KEYS) {
      const value = config.fur[key];
      assert.ok(value >= Config.LIMITS[key].min && value <= Config.LIMITS[key].max, `${preset.id}.${key} in range`);
    }
    const signature = JSON.stringify(config.fur);
    assert.ok(!seen.has(signature), `preset ${preset.id} renders differently from the others`);
    seen.add(signature);
  }
});

test('editing a preset makes the character honestly custom', () => {
  const official = Config.configFromPreset('kai-official');
  assert.strictEqual(official.preset, 'kai-official');
  const edited = Config.withColor(official, 'tip', '#00ff88');
  assert.strictEqual(edited.preset, 'custom');
  assert.strictEqual(edited.palette.id, 'custom');
  assert.strictEqual(edited.palette.tip, '#00ff88');
  // …and picking a named palette back reports that palette again.
  assert.strictEqual(Config.withPalette(edited, 'mint').palette.id, 'mint');
});

test('the coat cannot grow into the face: length × curl stays inside the budget', () => {
  const longest = Config.withFurValue(Config.withFurValue(Config.DEFAULT_CONFIG, 'length', 1), 'curliness', 1);
  assert.strictEqual(longest.fur.length, Config.LIMITS.length.max);
  assert.ok(longest.fur.length * longest.fur.curliness <= Config.MAX_CURL_SWEEP + 1e-6);
  // A genuinely curly coat at a normal length is untouched.
  const curly = Config.withHairStyle(Config.DEFAULT_CONFIG, 'curly');
  assert.strictEqual(Config.normalizeConfig(curly).fur.curliness, curly.fur.curliness);
});

test('a motion edit can never land in the fur block', () => {
  const config = Config.withFurValue(Config.DEFAULT_CONFIG, 'speed', 1.5);
  assert.strictEqual(config.fur.speed, undefined);
  assert.strictEqual(config.motion.speed, Config.DEFAULT_CONFIG.motion.speed);
  const motion = Config.withMotionValue(Config.DEFAULT_CONFIG, 'speed', 1.5);
  assert.strictEqual(motion.motion.speed, 1.5);
  assert.strictEqual(motion.motion.personality, 'custom');
});

test('a personality writes its own motion group only', () => {
  const playful = Config.withPersonality(Config.DEFAULT_CONFIG, 'playful');
  const preset = Config.PERSONALITIES.find(p => p.id === 'playful');
  for (const [key, value] of Object.entries(preset.motion)) assert.strictEqual(playful.motion[key], value);
  assert.strictEqual(playful.motion.reducedMotion, false);
  assert.deepStrictEqual(playful.fur, Config.DEFAULT_CONFIG.fur);
});

// ── The state bridge ──────────────────────────────────────────────────────────

test('every real KAI2 state maps, and listening maps to the idle face on purpose', () => {
  for (const state of State.KAI2_STATES) {
    const avatar = State.avatarStateFor(state);
    assert.ok(avatar, `${state} maps`);
    assert.ok(State.AVATAR_STATES.includes(avatar));
  }
  assert.strictEqual(State.avatarStateFor('listening'), 'idle');
  assert.strictEqual(State.avatarStateFor('WAITING_APPROVAL'), 'waiting_for_approval');
  assert.strictEqual(State.avatarStateFor('offline'), 'offline');
});

test('an unknown state is reported, never invented', () => {
  assert.strictEqual(State.avatarStateFor('researching'), null);
  assert.strictEqual(State.avatarStateFor(''), null);
  assert.strictEqual(State.avatarStateFor(null), null);
  const gate = new State.AvatarStateGate('idle');
  const result = gate.next('researching');
  assert.strictEqual(result.unknown, true);
  assert.strictEqual(result.state, 'idle');
  assert.strictEqual(result.changed, false);
});

test('a repeated state never re-fires an entrance animation', () => {
  const gate = new State.AvatarStateGate('idle');
  const first = gate.next('success');
  assert.strictEqual(first.changed, true);
  assert.strictEqual(first.shot, 'success');
  for (let i = 0; i < 5; i++) {
    const again = gate.next('success');
    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.shot, null);
  }
  // Leaving and coming back IS a new one-shot.
  gate.next('idle');
  const second = gate.next('success');
  assert.strictEqual(second.changed, true);
  assert.strictEqual(second.shot, 'success');
});

test('only success and error fire indicator one-shots', () => {
  for (const state of ['thinking', 'working', 'waiting_approval', 'offline']) {
    const gate = new State.AvatarStateGate('idle');
    const result = gate.next(state);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.shot, null, `${state} has no one-shot`);
  }
  assert.strictEqual(new State.AvatarStateGate('idle').next('error').shot, 'error');
});

test('a replay is explicit and opt-in (used by the motion preview only)', () => {
  const gate = new State.AvatarStateGate('idle');
  gate.next('thinking');
  const replay = gate.next('thinking', { replay: true });
  assert.strictEqual(replay.changed, true);
  assert.strictEqual(replay.state, 'thinking');
});

test('the states the app cannot signal are documented, not guessed', () => {
  assert.deepStrictEqual(State.UNMAPPED_AVATAR_STATES, ['paused']);
  assert.strictEqual(State.avatarStateFor('paused'), 'paused');
});

// ── Tool activity (the bridge's real events) ─────────────────────────────────

const Activity = require('../avatar3d/src/activity.js');

test('a real tool start means "working", and a repeated frame changes nothing', () => {
  const tools = new Activity.ToolActivityState();
  const start = Activity.toToolEvent({ key: 'call-1', phase: 'tool_start', status: '' });
  assert.strictEqual(start.kind, 'started');
  assert.strictEqual(tools.update(start), true);
  assert.strictEqual(tools.face(), 'working');
  // The bridge re-emits a row as it updates: the face must not restart.
  assert.strictEqual(tools.update(start), false);
  assert.strictEqual(tools.update(Activity.toToolEvent({ key: 'call-2', phase: 'tool_start', status: '' })), false);
  assert.strictEqual(tools.update(Activity.toToolEvent({ key: 'call-1', phase: 'tool_done', status: 'EXECUTED' })), false);
  assert.strictEqual(tools.face(), 'working', 'call-2 is still running');
  assert.strictEqual(tools.update(Activity.toToolEvent({ key: 'call-2', phase: 'tool_done', status: 'EXECUTED' })), true);
  assert.strictEqual(tools.face(), null);
});

test('an approval request asks for the approval face', () => {
  const tools = new Activity.ToolActivityState();
  tools.update(Activity.toToolEvent({ key: 'call-1', phase: 'tool_start', status: '' }));
  const approval = Activity.toToolEvent({ key: 'call-1', phase: 'tool_approval_required', status: 'APPROVAL_REQUIRED' });
  assert.strictEqual(approval.kind, 'approval');
  tools.update(approval);
  assert.strictEqual(tools.face(), 'waiting_for_approval');
});

test('a denied tool is a person\'s decision; only a real failure is a failure', () => {
  assert.strictEqual(Activity.toToolEvent({ key: 'k', phase: 'tool_done', status: 'DENIED' }).kind, 'finished');
  assert.strictEqual(Activity.toToolEvent({ key: 'k', phase: 'tool_error', status: 'FAILED' }).kind, 'failed');
  assert.strictEqual(Activity.toToolEvent({ key: 'k', phase: 'tool_done', status: 'INVALID' }).kind, 'failed');
  assert.strictEqual(Activity.toToolEvent({ key: 'k', phase: 'tool_done', status: 'NOT_FOUND' }).kind, 'failed');
  assert.strictEqual(Activity.toToolEvent({ key: 'k', phase: 'tool_done', status: 'EXECUTED' }).kind, 'finished');
});

test('a completion is never a celebration, and malformed rows are ignored', () => {
  const tools = new Activity.ToolActivityState();
  tools.update(Activity.toToolEvent({ key: 'k', phase: 'tool_start' }));
  const done = Activity.toToolEvent({ key: 'k', phase: 'tool_done', status: 'EXECUTED' });
  assert.ok(!('celebration' in done));
  tools.update(done);
  assert.strictEqual(tools.face(), null);
  assert.strictEqual(Activity.toToolEvent({}), null);
  assert.strictEqual(Activity.toToolEvent({ key: 'k' }), null);
  assert.strictEqual(Activity.toToolEvent({ phase: 'tool_start' }), null);
  assert.strictEqual(Activity.toToolEvent(null), null);
});

test('the adapter tolerates a missing bridge and unsubscribes cleanly', () => {
  assert.strictEqual(Activity.subscribeToolActivity(null, () => {}), null);
  assert.strictEqual(Activity.subscribeToolActivity({}, () => {}), null);
  let off = null;
  const api = { onActivity: (listener) => { off = () => { off.called = true; }; listener({ key: 'k', phase: 'tool_start' }); return off; } };
  const seen = [];
  const unsubscribe = Activity.subscribeToolActivity(api, (entry) => seen.push(entry.phase));
  assert.deepStrictEqual(seen, ['tool_start']);
  unsubscribe();
  assert.strictEqual(off.called, true);
});
