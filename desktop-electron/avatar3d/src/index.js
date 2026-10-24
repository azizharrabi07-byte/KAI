// KAI3D — the bundle entry.
//
// `kai-avatar3d.js` is built from this file into a classic script (the app has no
// bundler and loads every script with `<script src>`), so importing it registers
// `<kai-avatar>` and puts the public surface on `window.KaiAvatar`.
//
// The app's pages only ever use:
//   KaiAvatar.loadConfig / saveConfig / commitConfig   — the saved character
//   KaiAvatar.FUR_PRESETS / HAIR_STYLES / PALETTES / PERSONALITIES / LIMITS
//   KaiAvatar.isSupported()                            — 2D fallback decision
//   window.customElements 'kai-avatar'                 — the surface itself

import {
  CHANGE_EVENT,
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  FUR_PRESETS,
  HAIR_STYLES,
  LIMITS,
  PALETTES,
  PERSONALITIES,
  STORAGE_KEY,
  cloneConfig,
  commitConfig,
  configFromPreset,
  describeConfig,
  isDefaultConfig,
  loadConfig,
  normalizeConfig,
  sameConfig,
  saveConfig,
  withColor,
  withFurValue,
  withHairStyle,
  withMotionValue,
  withPalette,
  withPersonality,
  withQuality,
} from './character-config.js';
import { KaiAvatarElement } from './element.js';
import { AvatarStage, AvatarUnavailableError, isAvatarSupported } from './stage.js';
import { TOOL_KINDS, ToolActivityState, subscribeToolActivity, toToolEvent } from './activity.js';
import { attachMirror, blinkSource, flushMirrors, isMirrorReady, lookSource } from './mirror.js';
import {
  AVATAR_STATES,
  AvatarStateGate,
  INDICATOR_SHOTS,
  STATE_MAP,
  UNMAPPED_AVATAR_STATES,
  avatarStateFor,
  labelForState,
} from './state-bridge.js';
import { KAI_ACTIONS, KAI_STATES, KAI_STATE_METADATA, KAI_STATE_PALETTES } from './kaiState.js';

const api = {
  version: CONFIG_VERSION,
  storageKey: STORAGE_KEY,
  changeEvent: CHANGE_EVENT,
  elementName: 'kai-avatar',
  KaiAvatarElement,
  isSupported: isAvatarSupported,
  AvatarStage,
  AvatarUnavailableError,

  // Appearance model
  loadConfig,
  saveConfig,
  commitConfig,
  normalizeConfig,
  cloneConfig,
  describeConfig,
  isDefaultConfig,
  sameConfig,
  configFromPreset,
  DEFAULT_CONFIG,
  FUR_PRESETS,
  HAIR_STYLES,
  PALETTES,
  PERSONALITIES,
  LIMITS,
  withColor,
  withFurValue,
  withHairStyle,
  withMotionValue,
  withPalette,
  withPersonality,
  withQuality,

  // State vocabulary (already real; exposed for the studio readout + tests)
  KAI_STATES,
  KAI_ACTIONS,
  KAI_STATE_METADATA,
  KAI_STATE_PALETTES,
  AVATAR_STATES,
  STATE_MAP,
  UNMAPPED_AVATAR_STATES,
  INDICATOR_SHOTS,
  AvatarStateGate,
  avatarStateFor,
  labelForState,
  TOOL_KINDS,
  ToolActivityState,
  toToolEvent,
  subscribeToolActivity,

  // The shared frame source the small marks copy (see mirror.js).
  mirror: {
    attach: attachMirror,
    look: lookSource,
    blink: blinkSource,
    isReady: isMirrorReady,
    flush: flushMirrors,
  },
};

if (typeof window !== 'undefined') window.KaiAvatar = api;

export default api;
