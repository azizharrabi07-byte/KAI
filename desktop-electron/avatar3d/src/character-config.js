// KAI3D — the character configuration model.
//
// ONE normalized description of how KAI's 3D character looks and moves. Everything
// that renders KAI (the welcome avatar, the Character Studio preview) reads this
// shape and nothing else; the renderer never keeps its own copy of a user choice.
//
// The file is pure: no DOM, no three.js, no storage side effects beyond the injected
// `store`. That is what lets `test/character-studio.test.js` prove validation,
// clamping, preset application and migration with a fake store.
//
// Every value below is a knob the vendored renderer actually consumes:
//   • fur.*  → uniforms of furSystem (uFurLength / updateDensity / uClumping /
//              uCurliness / uRoughness / uSpecular);
//   • palette.* → uBaseColor, uTipColor and the rim accent light;
//   • motion.*  → KAIStateController.setAnimationSpeed / setAnimationIntensity,
//              uWindStrength, and the state-accent blend strength.
// Nothing here is decorative: a control bound to this model moves the renderer.

export const CONFIG_VERSION = 1;
export const STORAGE_KEY = 'kai.character.v1';
/** Fired on `document` after a configuration is SAVED (never on a draft edit). */
export const CHANGE_EVENT = 'kai:character-changed';

/** The fur uniforms this model owns (a subset of LIMITS). */
/**
 * The largest sideways sweep a strand may have (length × curliness). Measured on the
 * real renderer: above this the outer locks cover the eyes; at or below it the face
 * stays open for every style, including the longest coat.
 */
export const MAX_CURL_SWEEP = 0.34;

export const FUR_KEYS = Object.freeze(['length', 'density', 'clumping', 'curliness', 'roughness', 'specular']);
/** The motion scalars this model owns (a subset of LIMITS). */
export const MOTION_KEYS = Object.freeze(['speed', 'intensity', 'wind', 'accentStrength']);

/** Every numeric range the renderer accepts. Also the clamp table. */
export const LIMITS = Object.freeze({
  length: { min: 0.06, max: 0.62 },
  density: { min: 0.12, max: 1.0 },
  clumping: { min: 0.0, max: 1.0 },
  curliness: { min: 0.0, max: 1.0 },
  roughness: { min: 0.06, max: 0.95 },
  specular: { min: 0.0, max: 2.0 },
  speed: { min: 0.5, max: 1.6 },
  intensity: { min: 0.4, max: 1.6 },
  wind: { min: 0.0, max: 1.5 },
  accentStrength: { min: 0.0, max: 1.0 },
});

/**
 * Grooming styles. Each one changes REAL strand geometry: `curliness` drives the
 * spiral in the strand vertex shader (0 → straight, ~0.8 → tight curl), `clumping`
 * bends locks toward their tuft centroid, `length` changes strand length and
 * `density` changes how many of the 60k follicles are drawn. These are not labels
 * over one mesh.
 */
export const HAIR_STYLES = Object.freeze([
  Object.freeze({
    id: 'straight',
    label: 'Straight',
    hint: 'Sleek, aligned strands with almost no wave.',
    fur: { length: 0.2, curliness: 0.02, clumping: 0.06 },
  }),
  Object.freeze({
    id: 'soft',
    label: 'Soft velvet',
    hint: 'KAI’s default: short, plush and slightly waved.',
    fur: { length: 0.22, curliness: 0.16, clumping: 0.28 },
  }),
  Object.freeze({
    id: 'wavy',
    label: 'Wavy',
    hint: 'Longer locks with a visible, coherent wave.',
    fur: { length: 0.27, curliness: 0.42, clumping: 0.3 },
  }),
  Object.freeze({
    id: 'curly',
    label: 'Curly',
    hint: 'Tight spiral strands gathered into clumps.',
    fur: { length: 0.25, curliness: 0.82, clumping: 0.44 },
  }),
  Object.freeze({
    id: 'fluffy',
    label: 'Dense & fluffy',
    hint: 'Every follicle drawn, longer and voluminous.',
    fur: { length: 0.34, curliness: 0.3, clumping: 0.38, density: 1.0 },
  }),
  Object.freeze({
    id: 'short',
    label: 'Short groomed',
    hint: 'Clipped and tidy, close to the body.',
    fur: { length: 0.1, curliness: 0.04, clumping: 0.12, density: 0.62 },
  }),
]);

const STYLE_BY_ID = new Map(HAIR_STYLES.map((style) => [style.id, style]));

/** Named palettes. The first is KAI's own deep-navy / sky-blue identity. */
export const PALETTES = Object.freeze([
  Object.freeze({ id: 'sky-navy', label: 'Sky navy', hint: 'KAI’s own navy fur with a sky-blue tip.', base: '#111b2e', tip: '#7dd3fc', accent: '#38bdf8' }),
  Object.freeze({ id: 'arctic', label: 'Arctic', hint: 'Cold white tips on a blue-black base.', base: '#0b1220', tip: '#e0f2fe', accent: '#7dd3fc' }),
  Object.freeze({ id: 'mint', label: 'Mint', hint: 'A calm green-blue for a quieter KAI.', base: '#0a1a16', tip: '#6ee7b7', accent: '#2dd4bf' }),
  Object.freeze({ id: 'rose', label: 'Rose', hint: 'Warm rose tips, still dark at the root.', base: '#1a1018', tip: '#f9a8d4', accent: '#f472b6' }),
  Object.freeze({ id: 'amber', label: 'Amber', hint: 'A warm amber accent for a focused KAI.', base: '#1a1408', tip: '#fde68a', accent: '#f59e0b' }),
  Object.freeze({ id: 'violet', label: 'Violet', hint: 'Deep violet with a lilac tip.', base: '#140f24', tip: '#c4b5fd', accent: '#8b5cf6' }),
  Object.freeze({ id: 'mono', label: 'Mono', hint: 'Graphite and silver, no colour cast.', base: '#111214', tip: '#d4d4d8', accent: '#a1a1aa' }),
]);

const PALETTE_BY_ID = new Map(PALETTES.map((palette) => [palette.id, palette]));

/** Personality presets — real motion values, one per temperament. */
export const PERSONALITIES = Object.freeze([
  Object.freeze({ id: 'calm', label: 'Calm', hint: 'Slow, small movements. KAI stays out of the way.', motion: { speed: 0.85, intensity: 0.85, wind: 0.25, accentStrength: 0.5 } }),
  Object.freeze({ id: 'focused', label: 'Focused', hint: 'Steady and restrained; movement only when working.', motion: { speed: 0.95, intensity: 0.8, wind: 0.2, accentStrength: 0.65 } }),
  Object.freeze({ id: 'expressive', label: 'Expressive', hint: 'Full-amplitude motion, clearly readable faces.', motion: { speed: 1.1, intensity: 1.25, wind: 0.5, accentStrength: 0.75 } }),
  Object.freeze({ id: 'playful', label: 'Playful', hint: 'Brisk, bouncy and a little dramatic.', motion: { speed: 1.25, intensity: 1.35, wind: 0.8, accentStrength: 0.85 } }),
  Object.freeze({ id: 'minimal', label: 'Minimal', hint: 'Almost still; the pose changes, the body does not.', motion: { speed: 0.7, intensity: 0.5, wind: 0.1, accentStrength: 0.35 } }),
]);

const PERSONALITY_BY_ID = new Map(PERSONALITIES.map((p) => [p.id, p]));

/**
 * Named fur presets: each one is a COMPLETE group (grooming + fur + palette), never
 * an arbitrary subset, so picking one always gives a coherent character.
 */
export const FUR_PRESETS = Object.freeze([
  Object.freeze({
    id: 'kai-official',
    label: 'KAI Official',
    hint: 'Navy velvet with the sky-blue tip.',
    style: 'soft',
    fur: { length: 0.22, density: 0.82, clumping: 0.28, curliness: 0.16, roughness: 0.72, specular: 0.35 },
    palette: 'sky-navy',
  }),
  Object.freeze({
    id: 'midnight-velvet',
    label: 'Midnight Velvet',
    hint: 'Darker base, denser pile, cyan glow.',
    style: 'soft',
    fur: { length: 0.24, density: 0.88, clumping: 0.32, curliness: 0.14, roughness: 0.7, specular: 0.38 },
    palette: 'sky-navy',
  }),
  Object.freeze({
    id: 'cyber-sky',
    label: 'Cyber Sky',
    hint: 'Pale ice tips over a slate base.',
    style: 'straight',
    fur: { length: 0.2, density: 0.8, clumping: 0.25, curliness: 0.06, roughness: 0.74, specular: 0.3 },
    palette: 'arctic',
  }),
  Object.freeze({
    id: 'obsidian-cyan',
    label: 'Obsidian Cyan',
    hint: 'Near-black fur with an electric cyan tip.',
    style: 'wavy',
    fur: { length: 0.22, density: 0.85, clumping: 0.3, curliness: 0.3, roughness: 0.75, specular: 0.32 },
    palette: 'sky-navy',
  }),
  Object.freeze({
    id: 'cloud-curl',
    label: 'Curly Cloud',
    hint: 'Tight curls everywhere. A different silhouette.',
    style: 'curly',
    fur: { length: 0.26, density: 0.9, clumping: 0.5, curliness: 0.85, roughness: 0.66, specular: 0.42 },
    palette: 'violet',
  }),
  Object.freeze({
    id: 'plush-fluff',
    label: 'Dense Fluff',
    hint: 'Every strand, longest pile, soft and rounded.',
    style: 'fluffy',
    fur: { length: 0.34, density: 1.0, clumping: 0.34, curliness: 0.28, roughness: 0.8, specular: 0.28 },
    palette: 'mint',
  }),
  Object.freeze({
    id: 'groomed-short',
    label: 'Short Groomed',
    hint: 'Cropped, tidy, more of the body visible.',
    style: 'short',
    fur: { length: 0.1, density: 0.64, clumping: 0.12, curliness: 0.04, roughness: 0.58, specular: 0.5 },
    palette: 'mono',
  }),
]);

const PRESET_BY_ID = new Map(FUR_PRESETS.map((preset) => [preset.id, preset]));

export const DEFAULT_CONFIG = deepFreeze({
  version: CONFIG_VERSION,
  preset: 'kai-official',
  furStyle: 'soft',
  fur: { length: 0.22, density: 0.82, clumping: 0.28, curliness: 0.16, roughness: 0.72, specular: 0.35 },
  palette: { id: 'sky-navy', base: '#111b2e', tip: '#7dd3fc', accent: '#38bdf8' },
  motion: { personality: 'calm', speed: 0.85, intensity: 0.85, wind: 0.25, accentStrength: 0.5, reducedMotion: false },
  render: { quality: 'auto' },
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function cloneConfig(config) {
  return {
    ...config,
    fur: { ...config.fur },
    palette: { ...config.palette },
    motion: { ...config.motion },
    render: { ...config.render },
  };
}

// ── Value validation ──────────────────────────────────────────────────────────

const HEX = /^#[0-9a-f]{6}$/i;

/** Returns a lower-case #rrggbb string, or `fallback` when the input is not a colour. */
export function sanitizeHex(value, fallback) {
  return typeof value === 'string' && HEX.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

export function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampIn(key, value, fallback) {
  const limit = LIMITS[key];
  if (!limit) return fallback;
  return Math.round(clampNumber(value, limit.min, limit.max, fallback) * 1000) / 1000;
}

function pick(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

// ── Normalization / migration ─────────────────────────────────────────────────

/**
 * Turns anything (a stored string, a partial object, a hand-edited file, a future
 * version) into a config the renderer can always draw. Unknown or out-of-range
 * values fall back to KAI's defaults instead of reaching a shader.
 */
export function normalizeConfig(raw) {
  const config = cloneConfig(DEFAULT_CONFIG);
  const source = raw && typeof raw === 'object' ? raw : {};

  config.furStyle = pick(source.furStyle, [...STYLE_BY_ID.keys()], DEFAULT_CONFIG.furStyle);

  const fur = source.fur && typeof source.fur === 'object' ? source.fur : {};
  for (const key of ['length', 'density', 'clumping', 'curliness', 'roughness', 'specular']) {
    config.fur[key] = clampIn(key, fur[key], DEFAULT_CONFIG.fur[key]);
  }
  // Length × curl is the sideways sweep of a strand. Past this budget the outer locks
  // close over the eyes and the face stops being readable, so the curl gives way as the
  // coat grows (it is the value the renderer uses, shown back in the slider).
  if (config.fur.length * config.fur.curliness > MAX_CURL_SWEEP) {
    config.fur.curliness = Math.round((MAX_CURL_SWEEP / config.fur.length) * 1000) / 1000;
  }

  const palette = source.palette && typeof source.palette === 'object' ? source.palette : {};
  const namedPalette = typeof palette.id === 'string' ? PALETTE_BY_ID.get(palette.id) : undefined;
  config.palette = {
    // The id is kept only while the colours still match that palette; a custom mix
    // is reported as custom instead of claiming a preset it no longer is.
    id: namedPalette ? palette.id : 'custom',
    base: sanitizeHex(palette.base, namedPalette ? namedPalette.base : DEFAULT_CONFIG.palette.base),
    tip: sanitizeHex(palette.tip, namedPalette ? namedPalette.tip : DEFAULT_CONFIG.palette.tip),
    accent: sanitizeHex(palette.accent, namedPalette ? namedPalette.accent : DEFAULT_CONFIG.palette.accent),
  };

  const motion = source.motion && typeof source.motion === 'object' ? source.motion : {};
  config.motion = {
    personality: pick(motion.personality, [...PERSONALITY_BY_ID.keys()], DEFAULT_CONFIG.motion.personality),
    speed: clampIn('speed', motion.speed, DEFAULT_CONFIG.motion.speed),
    intensity: clampIn('intensity', motion.intensity, DEFAULT_CONFIG.motion.intensity),
    wind: clampIn('wind', motion.wind, DEFAULT_CONFIG.motion.wind),
    accentStrength: clampIn('accentStrength', motion.accentStrength, DEFAULT_CONFIG.motion.accentStrength),
    reducedMotion: motion.reducedMotion === true,
  };

  const render = source.render && typeof source.render === 'object' ? source.render : {};
  config.render = { quality: pick(render.quality, ['auto', 'high', 'light'], DEFAULT_CONFIG.render.quality) };

  // The preset name is a claim about the whole config. Keep it only when it still
  // describes the values; otherwise the character is honestly "custom".
  config.preset = typeof source.preset === 'string' && PRESET_BY_ID.has(source.preset) && presetMatches(config, source.preset)
    ? source.preset
    : 'custom';

  config.version = CONFIG_VERSION;
  return config;
}

/** Parses a stored JSON string. Returns null when there is nothing usable. */
export function parseConfig(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  // Arrays and primitives are not a character: they must fall back to the default
  // rather than being normalized into an empty one.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return normalizeConfig(data);
}

// ── Applying presets and edits ────────────────────────────────────────────────

export function paletteById(id) {
  return PALETTE_BY_ID.get(id) || null;
}

/** Builds the full config for a named fur preset. Unknown ids return null. */
export function configFromPreset(id) {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) return null;
  const config = cloneConfig(DEFAULT_CONFIG);
  const style = STYLE_BY_ID.get(preset.style);
  config.preset = preset.id;
  config.furStyle = preset.style;
  config.fur = { ...DEFAULT_CONFIG.fur, ...(style ? style.fur : {}), ...preset.fur };
  const palette = PALETTE_BY_ID.get(preset.palette) || paletteById(DEFAULT_CONFIG.palette.id);
  config.palette = { id: palette.id, base: palette.base, tip: palette.tip, accent: palette.accent };
  return normalizeConfig(config);
}

/** True when `config` still renders exactly like the named preset. */
export function presetMatches(config, id) {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) return false;
  const style = STYLE_BY_ID.get(preset.style);
  const palette = PALETTE_BY_ID.get(preset.palette);
  if (config.furStyle !== preset.style) return false;
  if (!palette || config.palette.base !== palette.base || config.palette.tip !== palette.tip) return false;
  const fur = { ...DEFAULT_CONFIG.fur, ...(style ? style.fur : {}), ...preset.fur };
  for (const key of Object.keys(fur)) {
    if (Math.abs((config.fur[key] ?? 0) - fur[key]) > 0.0005) return false;
  }
  return true;
}

/** Applies a grooming style's geometry to an existing config, keeping palette + motion. */
export function withHairStyle(config, styleId) {
  const style = STYLE_BY_ID.get(styleId);
  if (!style) return cloneConfig(config);
  const next = cloneConfig(config);
  next.furStyle = style.id;
  Object.assign(next.fur, style.fur);
  next.preset = 'custom';
  return normalizeConfig(next);
}

export function withPalette(config, paletteId) {
  const palette = PALETTE_BY_ID.get(paletteId);
  if (!palette) return cloneConfig(config);
  const next = cloneConfig(config);
  next.palette = { id: palette.id, base: palette.base, tip: palette.tip, accent: palette.accent };
  next.preset = 'custom';
  return next;
}

/** `key` is one of the LIMITS keys except the motion ones. */
export function withFurValue(config, key, value) {
  if (!FUR_KEYS.includes(key)) return cloneConfig(config);
  const next = cloneConfig(config);
  next.fur[key] = clampIn(key, value, next.fur[key]);
  next.preset = 'custom';
  // Normalized here too: the curl budget is a property of the model, not of one caller.
  return normalizeConfig(next);
}

/** `channel` is base | tip | accent. */
export function withColor(config, channel, value) {
  if (channel !== 'base' && channel !== 'tip' && channel !== 'accent') return cloneConfig(config);
  const next = cloneConfig(config);
  const hex = sanitizeHex(value, next.palette[channel]);
  if (next.palette[channel] === hex) return next;
  next.palette[channel] = hex;
  const named = PALETTES.find((palette) => palette.base === next.palette.base && palette.tip === next.palette.tip && palette.accent === next.palette.accent);
  next.palette.id = named ? named.id : 'custom';
  next.preset = 'custom';
  return next;
}

export function withPersonality(config, id) {
  const personality = PERSONALITY_BY_ID.get(id);
  if (!personality) return cloneConfig(config);
  const next = cloneConfig(config);
  next.motion = { ...next.motion, personality: personality.id, ...personality.motion };
  return next;
}

/** `key` is speed | intensity | wind | accentStrength | reducedMotion. */
export function withMotionValue(config, key, value) {
  const next = cloneConfig(config);
  if (key === 'reducedMotion') {
    next.motion.reducedMotion = Boolean(value);
    return next;
  }
  if (!MOTION_KEYS.includes(key)) return next;
  next.motion[key] = clampIn(key, value, next.motion[key]);
  next.motion.personality = 'custom';
  return next;
}


export function withQuality(config, quality) {
  const next = cloneConfig(config);
  next.render.quality = pick(quality, ['auto', 'high', 'light'], next.render.quality);
  return next;
}

export function personalityById(id) {
  return PERSONALITY_BY_ID.get(id) || null;
}

export function hairStyleById(id) {
  return STYLE_BY_ID.get(id) || null;
}

export function furPresetById(id) {
  return PRESET_BY_ID.get(id) || null;
}

export function sameConfig(a, b) {
  return JSON.stringify(normalizeConfig(a)) === JSON.stringify(normalizeConfig(b));
}

export function isDefaultConfig(config) {
  return sameConfig(config, DEFAULT_CONFIG);
}

// ── Persistence ───────────────────────────────────────────────────────────────

/** The two Storage methods this module needs (injectable, so tests need no browser). */
export function defaultStore() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Reads the saved character, or KAI's default when nothing valid is stored. */
export function loadConfig(store = defaultStore()) {
  if (!store) return cloneConfig(DEFAULT_CONFIG);
  let raw = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return cloneConfig(DEFAULT_CONFIG);
  }
  return parseConfig(raw) || cloneConfig(DEFAULT_CONFIG);
}

/** Persists a config and returns the serialized string (useful for evidence/tests). */
export function saveConfig(config, store = defaultStore()) {
  const normalized = normalizeConfig(config);
  const raw = JSON.stringify(normalized);
  if (store) {
    try {
      store.setItem(STORAGE_KEY, raw);
    } catch {
      // A full or disabled store must not break the character: the avatar still
      // runs on the in-memory config for this session.
    }
  }
  return raw;
}

/**
 * Saves and announces the change. `document` is optional so this module stays
 * usable in a test process.
 */
export function commitConfig(config, { store = defaultStore(), doc = typeof document !== 'undefined' ? document : null } = {}) {
  const normalized = normalizeConfig(config);
  saveConfig(normalized, store);
  if (doc) {
    try {
      doc.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { config: cloneConfig(normalized) } }));
    } catch {
      // No CustomEvent (headless): the save itself already happened.
    }
  }
  return normalized;
}

/** A short human sentence for the studio header. */
export function describeConfig(config) {
  const style = hairStyleById(config.furStyle);
  const preset = furPresetById(config.preset);
  const personality = personalityById(config.motion.personality);
  const palette = PALETTES.find((p) => p.id === config.palette.id) || PALETTES.find((p) => p.base === config.palette.base && p.tip === config.palette.tip);
  const parts = [
    preset ? preset.label : 'Custom',
    `${style ? style.label : config.furStyle} fur`,
    palette ? palette.label : 'Custom palette',
    personality ? `${personality.label} motion` : 'Custom motion',
  ];
  return parts.join(' · ');
}
