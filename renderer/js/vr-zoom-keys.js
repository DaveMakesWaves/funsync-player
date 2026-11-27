// VR zoom on one key (Buck Nakkidd, Discord #feature-requests, 2026-11-27:
// "sucks having to let go of device just to zoom in or out"; Dave: "make a
// setting where users can choose a non coliding hotkey for these").
//
// While a VR video is open in the player (and the editor is closed), the
// zoom-in and zoom-out keys zoom it with no Ctrl: bare = and - by default
// (Shift allowed, so the "+" key works where it is Shift+=), plus the numpad's
// + and -. Ctrl+= / Ctrl+- / Ctrl+0 and Ctrl+scroll are unchanged.
//
// Settings > Keyboard > VR zoom keys binds them (`player.vrZoomKeys`, each
// `{code, mods}` as KeyCapture gives it, or null for none). A key the player
// already uses, a key for moving around or the system, a Ctrl shortcut (the
// menu's) or the other zoom key is refused with the reason (`vrZoomKeyClash`).
// Pure: the Settings rows and the keyboard handler share it.

export const VR_ZOOM_KEYS_SETTING = 'player.vrZoomKeys';
export const VR_ZOOM_ACTIONS = Object.freeze(['in', 'out']);
export const VR_ZOOM_KEY_DEFAULTS = Object.freeze({
  in: Object.freeze({ code: 'Equal', mods: Object.freeze({}) }),
  out: Object.freeze({ code: 'Minus', mods: Object.freeze({}) }),
});

// Always zoom too, whatever is bound (nothing else in the player uses them).
const NUMPAD_STEPS = { NumpadAdd: 1, NumpadSubtract: -1 };

// Moving around, typing and the system: never a zoom key, with any modifier.
const SYSTEM_CODES = new Set([
  'Escape', 'Tab', 'Enter', 'NumpadEnter', 'Space', 'Backspace', 'Delete', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen', 'Pause', 'ContextMenu',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

// The player's own keys (renderer/js/keyboard.js), bare or with Shift or Alt:
// its letters, chapters / speed (, . < >) and the help overlay (?).
const PLAYER_CODES = new Set([
  ...'ABDEFGHIJKLMNOPQRSVXZ'.split('').map((c) => `Key${c}`),
  'Comma', 'Period', 'Slash',
]);
// Alt+1/2/3 open Library / Playlists / Categories.
const ALT_NAV_CODES = new Set(['Digit1', 'Digit2', 'Digit3']);

/** {shift, ctrl, alt} booleans from a KeyCapture binding's mods. */
function modsOf(binding) {
  const m = binding?.mods || {};
  return { shift: !!m.shift, ctrl: !!m.ctrl, alt: !!m.alt };
}

function isBinding(b) {
  return !!b && typeof b === 'object' && typeof b.code === 'string' && b.code !== '';
}

/**
 * The bindings in use: the saved ones, the defaults where nothing is saved,
 * none where the user removed one (null).
 * @param {unknown} raw the `player.vrZoomKeys` setting
 * @returns {{ in: {code: string, mods: object}|null, out: {code: string, mods: object}|null }}
 */
export function readVRZoomKeys(raw) {
  const saved = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const action of VR_ZOOM_ACTIONS) {
    if (!(action in saved)) out[action] = VR_ZOOM_KEY_DEFAULTS[action];
    else out[action] = isBinding(saved[action]) ? { code: saved[action].code, mods: modsOf(saved[action]) } : null;
  }
  return out;
}

/** The same key and modifiers. */
export function sameVRZoomKey(a, b) {
  if (!isBinding(a) || !isBinding(b) || a.code !== b.code) return false;
  const ma = modsOf(a);
  const mb = modsOf(b);
  return ma.shift === mb.shift && ma.ctrl === mb.ctrl && ma.alt === mb.alt;
}

/**
 * Why `binding` cannot be a zoom key, or null when it can.
 * @param {{code: string, mods?: object}} binding
 * @param {{ other?: {code: string, mods?: object}|null }} [o] the other zoom key
 * @returns {null|'system'|'menu'|'player'|'same'}
 */
export function vrZoomKeyClash(binding, { other = null } = {}) {
  if (!isBinding(binding)) return 'system';
  const m = modsOf(binding);
  if (SYSTEM_CODES.has(binding.code)) return 'system';
  if (m.ctrl || binding.mods?.meta) return 'menu';
  if (PLAYER_CODES.has(binding.code)) return 'player';
  if (m.alt && ALT_NAV_CODES.has(binding.code)) return 'player';
  if (other && sameVRZoomKey(binding, other)) return 'same';
  return null;
}

/**
 * The zoom step a keydown asks for: +1 in, -1 out, 0 not a zoom key. Ctrl and
 * Alt must match the binding; Shift must when the binding has it, and is
 * otherwise allowed (the "+" key is Shift+= on many layouts).
 * @param {KeyboardEvent} e
 * @param {{ in: object|null, out: object|null }} keys readVRZoomKeys()
 * @returns {1|-1|0}
 */
export function vrZoomStepFor(e, keys) {
  if (!e || e.metaKey) return 0;
  if (!e.ctrlKey && !e.altKey && NUMPAD_STEPS[e.code]) return NUMPAD_STEPS[e.code];
  for (const [action, step] of [['in', 1], ['out', -1]]) {
    const b = keys?.[action];
    if (!isBinding(b) || b.code !== e.code) continue;
    const m = modsOf(b);
    if (m.ctrl !== !!e.ctrlKey || m.alt !== !!e.altKey) continue;
    if (m.shift && !e.shiftKey) continue;
    return step;
  }
  return 0;
}
