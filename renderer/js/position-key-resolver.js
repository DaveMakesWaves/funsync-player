// Pure functions for the editor's custom position-key bindings.
//
// Lifecycle: settings hold a `customPositionKeys: [{code, mods, position}]`
// array. The script editor's key handler calls `buildResolverMap()` once
// per settings change to get a Map<serializedKey, position>, then does an
// O(1) lookup on each keydown via `lookupBinding()`. Override semantics
// (custom wins over default) are implemented at the caller — the resolver
// just answers "what position does this exact key combo map to in the
// user's custom map?".
//
// Serialization format: `Ctrl:Alt:Shift:<code>` — modifiers sorted into
// canonical order so the same (code, mods) always serializes the same
// way regardless of how the source object was constructed.

/**
 * Canonical reserved-key block-list. Bindings that match an entry here
 * (with the listed modifier shape) are rejected by the UI. Custom keys
 * with the right modifier can still bind; e.g. `KeyR` alone is reserved
 * but `Shift+KeyR` is free.
 *
 * Modifier requirement: `mods` field on each entry specifies what
 * modifier shape triggers the reservation. `null` means "any modifier
 * combo is reserved" (used for purely structural keys like Escape).
 * `{}` means "only the bare key is reserved" (modifier combos are free).
 */
export const RESERVED_EDITOR_KEYS = [
  // Structural / navigation — reserved with any modifier combo
  { code: 'Escape', mods: null },
  { code: 'Tab', mods: null },
  { code: 'Enter', mods: null },
  { code: 'Space', mods: null },
  { code: 'Delete', mods: null },
  { code: 'Backspace', mods: null },
  { code: 'ArrowUp', mods: null },
  { code: 'ArrowDown', mods: null },
  { code: 'ArrowLeft', mods: null },
  { code: 'ArrowRight', mods: null },
  { code: 'Home', mods: null },
  { code: 'End', mods: null },
  { code: 'PageUp', mods: null },
  { code: 'PageDown', mods: null },
  // Function keys — Electron / OS shortcuts overlap here
  ...['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12']
    .map((code) => ({ code, mods: null })),
  // Editor commands (bare key) — modifier combos are free
  { code: 'KeyR', mods: {} },  // recording toggle
  { code: 'KeyQ', mods: {} },  // alternating-insert
  { code: 'KeyB', mods: {} },  // bookmark add
  { code: 'KeyW', mods: {} },  // waveform toggle
  { code: 'KeyE', mods: {} },  // editor toggle
  { code: 'KeyD', mods: {} },  // device simulator
  // Editor commands (Ctrl+letter) — bare keys are free for typing
  { code: 'KeyZ', mods: { ctrl: true } },  // undo
  { code: 'KeyY', mods: { ctrl: true } },  // redo
  { code: 'KeyC', mods: { ctrl: true } },  // copy
  { code: 'KeyV', mods: { ctrl: true } },  // paste
  { code: 'KeyX', mods: { ctrl: true } },  // cut
  { code: 'KeyA', mods: { ctrl: true } },  // select all
  { code: 'KeyI', mods: { ctrl: true } },  // invert
  { code: 'KeyS', mods: { ctrl: true } },  // save
];

/**
 * Canonical default position-key map. Mirrors `numpadMap` in
 * script-editor.js plus the Shift+0 / Minus / NumpadSubtract top-keys.
 * Exposed here so the UI can list defaults and detect "your custom
 * binding overrides default key 5 (50 → 75)".
 *
 * Each entry's `mods` field is normalized to `{shift, ctrl, alt}` booleans.
 */
export const DEFAULT_POSITION_KEYS = [
  // Number row 0-9 → 0-90
  { code: 'Digit0', mods: {}, position: 0 },
  { code: 'Digit1', mods: {}, position: 10 },
  { code: 'Digit2', mods: {}, position: 20 },
  { code: 'Digit3', mods: {}, position: 30 },
  { code: 'Digit4', mods: {}, position: 40 },
  { code: 'Digit5', mods: {}, position: 50 },
  { code: 'Digit6', mods: {}, position: 60 },
  { code: 'Digit7', mods: {}, position: 70 },
  { code: 'Digit8', mods: {}, position: 80 },
  { code: 'Digit9', mods: {}, position: 90 },
  // Numpad 0-9 → 0-90
  { code: 'Numpad0', mods: {}, position: 0 },
  { code: 'Numpad1', mods: {}, position: 10 },
  { code: 'Numpad2', mods: {}, position: 20 },
  { code: 'Numpad3', mods: {}, position: 30 },
  { code: 'Numpad4', mods: {}, position: 40 },
  { code: 'Numpad5', mods: {}, position: 50 },
  { code: 'Numpad6', mods: {}, position: 60 },
  { code: 'Numpad7', mods: {}, position: 70 },
  { code: 'Numpad8', mods: {}, position: 80 },
  { code: 'Numpad9', mods: {}, position: 90 },
  // Top of range (added 2026-05-30)
  { code: 'Digit0', mods: { shift: true }, position: 100 },
  { code: 'Numpad0', mods: { shift: true }, position: 100 },
  { code: 'Minus', mods: {}, position: 100 },
  { code: 'NumpadSubtract', mods: {}, position: 100 },
];

/**
 * Serialize a (code, mods) pair into a canonical string key.
 * Modifier order is fixed (Ctrl → Alt → Shift) so logically-equivalent
 * shapes always produce the same string regardless of source order.
 *
 * @param {{code: string, mods?: {shift?: boolean, ctrl?: boolean, alt?: boolean}}} binding
 * @returns {string}
 */
export function serializeBinding(binding) {
  if (!binding || typeof binding.code !== 'string' || binding.code === '') return '';
  const m = binding.mods || {};
  let s = '';
  if (m.ctrl) s += 'Ctrl:';
  if (m.alt) s += 'Alt:';
  if (m.shift) s += 'Shift:';
  return s + binding.code;
}

/**
 * Parse the serialized form back into `{code, mods}`. Used by the help
 * overlay to render a user-friendly label.
 *
 * @param {string} serialized
 * @returns {{code: string, mods: {shift: boolean, ctrl: boolean, alt: boolean}}}
 */
export function parseBinding(serialized) {
  const mods = { shift: false, ctrl: false, alt: false };
  let rest = String(serialized || '');
  while (rest.startsWith('Ctrl:') || rest.startsWith('Alt:') || rest.startsWith('Shift:')) {
    if (rest.startsWith('Ctrl:')) { mods.ctrl = true; rest = rest.slice(5); }
    else if (rest.startsWith('Alt:')) { mods.alt = true; rest = rest.slice(4); }
    else { mods.shift = true; rest = rest.slice(6); }
  }
  return { code: rest, mods };
}

/**
 * Build the runtime resolver Map from a raw settings array. Drops
 * malformed entries, clamps positions to 0-100, last-wins on duplicates.
 *
 * @param {Array<{code: string, mods?: object, position: number}>} entries
 * @returns {Map<string, number>}
 */
export function buildResolverMap(entries) {
  const map = new Map();
  if (!Array.isArray(entries)) return map;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.code !== 'string' || entry.code === '') continue;
    const position = clampPosition(entry.position);
    if (position === null) continue;
    const key = serializeBinding(entry);
    if (!key) continue;
    map.set(key, position);  // last-wins per SCOPE §5 edge #1
  }
  return map;
}

/**
 * Look up the position for a given (code, mods). Returns null if no
 * binding exists. The caller falls through to default-key handling
 * (and from there to editor command handling) on null.
 *
 * @param {Map<string, number>} resolverMap
 * @param {{code: string, mods?: object}} pressed
 * @returns {number|null}
 */
export function lookupBinding(resolverMap, pressed) {
  if (!(resolverMap instanceof Map)) return null;
  const key = serializeBinding(pressed);
  if (!key) return null;
  return resolverMap.has(key) ? resolverMap.get(key) : null;
}

/**
 * Check whether a (code, mods) pair is on the reserved-key block-list.
 * `mods: null` entries match any modifier combo. `mods: {}` entries
 * match only the bare key (no modifiers). `mods: { ctrl: true }`
 * matches only when ctrl is pressed (other mods absent).
 *
 * @param {string} code
 * @param {{shift?: boolean, ctrl?: boolean, alt?: boolean}} mods
 * @returns {{ reserved: boolean, reason: string|null }}
 */
export function isReservedKey(code, mods) {
  const m = normalizeMods(mods);
  for (const entry of RESERVED_EDITOR_KEYS) {
    if (entry.code !== code) continue;
    if (entry.mods === null) {
      return { reserved: true, reason: 'structural' };
    }
    if (modsEqual(normalizeMods(entry.mods), m)) {
      return { reserved: true, reason: 'editor-command' };
    }
  }
  return { reserved: false, reason: null };
}

/**
 * Look up whether a binding collides with an existing entry (duplicate)
 * or overrides a default (which is allowed but warned).
 *
 * @param {{code: string, mods?: object}} candidate
 * @param {Array<{code: string, mods?: object, position: number}>} existing
 *   The user's current custom bindings (excluding the candidate).
 * @returns {{ kind: 'duplicate'|'override-default'|null, defaultPosition: number|null }}
 */
export function detectConflict(candidate, existing) {
  const key = serializeBinding(candidate);
  if (!key) return { kind: null, defaultPosition: null };

  // Duplicate within the user's custom list wins highest priority.
  if (Array.isArray(existing)) {
    for (const e of existing) {
      if (serializeBinding(e) === key) {
        return { kind: 'duplicate', defaultPosition: null };
      }
    }
  }

  // Override of a default key — still allowed, just warned.
  for (const d of DEFAULT_POSITION_KEYS) {
    if (serializeBinding(d) === key) {
      return { kind: 'override-default', defaultPosition: d.position };
    }
  }

  return { kind: null, defaultPosition: null };
}

// --- Internals ---

function clampPosition(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeMods(m) {
  const x = m || {};
  return {
    shift: !!x.shift,
    ctrl: !!x.ctrl,
    alt: !!x.alt,
  };
}

function modsEqual(a, b) {
  return a.shift === b.shift && a.ctrl === b.ctrl && a.alt === b.alt;
}
