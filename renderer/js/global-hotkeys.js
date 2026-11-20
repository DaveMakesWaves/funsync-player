// Global hotkeys — the bridge between a key the user presses in Settings
// (a KeyCapture binding: `{code, mods}` from KeyboardEvent.code) and the
// Electron accelerator string the main process registers with
// `globalShortcut` (Eroto, EroScripts #316).
//
// Pure functions, no DOM, so the mapping is tested on its own. The settings
// store keeps ACCELERATORS (`player.globalShortcuts = {playPause: 'Ctrl+Alt+Shift+P'}`)
// because that is what main.js consumes and what a hand-edited config.json
// already holds; the binding form exists only for display and capture.

/** The actions main.js registers (electron/global-shortcuts.js). */
export const GLOBAL_HOTKEY_ACTIONS = ['playPause', 'orgasm', 'edge'];

// KeyboardEvent.code → accelerator key, for keys that are not a plain
// letter, digit or F-key. Anything absent here has no accelerator form and
// is refused, rather than saved and then failing to register.
const NAMED_KEYS = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop',
  AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute',
  PrintScreen: 'PrintScreen',
  // Never captured (Esc cancels a capture), but a hand-edited config can
  // hold it, and it must be judged like the other keys every app uses.
  Escape: 'Escape',
};
const CODE_FOR_NAMED = Object.fromEntries(Object.entries(NAMED_KEYS).map(([code, key]) => [key.toLowerCase(), code]));
// Electron also spells Escape 'Esc' (FT-013).
CODE_FOR_NAMED.esc = 'Escape';

const F_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/** The accelerator key for a KeyboardEvent.code, or null if it has none. */
function keyForCode(code) {
  if (typeof code !== 'string') return null;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `num${m[1]}`;
  if (F_KEY.test(code)) return code;
  return NAMED_KEYS[code] || null;
}

/**
 * The letter a letter key types on the active keyboard layout, as 'A'-'Z',
 * or null when it is not a letter key or no Latin letter is known (FT-012).
 *
 * KeyboardEvent.code names the PHYSICAL key by its US position: on German
 * QWERTZ the key labelled Z is 'KeyY'. Electron registers an accelerator
 * letter as that letter's virtual key, which the layout places, so building
 * the accelerator from the code bound the key labelled Y instead. The
 * layout's own letter for the key is what the user pressed and what Electron
 * must be given.
 *
 * Sources, in order: the Keyboard API layout map (`navigator.keyboard.
 * getLayoutMap()`), then the event's `key`, each used only when it is one
 * Latin letter a-z; otherwise null and the caller keeps the code. So a
 * Cyrillic or Greek layout keeps the US-position letter, which is what
 * Windows uses for those layouts' virtual keys too. Digits, F-keys and named
 * keys never come here: the code is right for them. Symbol keys (OEM) stay
 * a known limit.
 *
 * @param {string} code — KeyboardEvent.code
 * @param {{get: Function}|null} [layoutMap] — a KeyboardLayoutMap, if known
 * @param {string} [key] — KeyboardEvent.key of the same press
 * @returns {string|null}
 */
export function letterForCode(code, layoutMap, key) {
  if (typeof code !== 'string' || !/^Key[A-Z]$/.test(code)) return null;
  const latin = (s) => (typeof s === 'string' && /^[a-z]$/i.test(s) ? s.toUpperCase() : null);
  let fromMap = null;
  try { fromMap = latin(layoutMap?.get?.(code)); } catch { fromMap = null; }
  return fromMap || latin(key);
}

/**
 * `{code, mods}` → 'Ctrl+Alt+Shift+P', or null when the key has no
 * accelerator form (it could never register).
 */
export function bindingToAccelerator(binding) {
  const key = keyForCode(binding?.code);
  if (!key) return null;
  const mods = binding.mods || {};
  const parts = [];
  if (mods.ctrl) parts.push('Ctrl');
  if (mods.alt) parts.push('Alt');
  if (mods.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * Accelerator → `{code, mods}` for display in a KeyCapture. Accepts the
 * spellings Electron does (CommandOrControl, CmdOrCtrl, Control, Option…),
 * since config.json can be hand-edited. Anything it cannot read comes back
 * as `{code: <the accelerator>}`, which KeyCapture shows verbatim: the user
 * still sees what is saved instead of an empty box.
 */
export function acceleratorToBinding(accel) {
  if (typeof accel !== 'string' || !accel.trim()) return null;
  const raw = { code: accel.trim(), mods: {} };
  // A trailing '+' key ("Ctrl++") splits into an empty last part; Electron
  // spells it 'Plus', and anything else here is unreadable.
  const parts = accel.split('+').map((p) => p.trim());
  if (parts.some((p) => !p)) return raw;
  const mods = {};
  for (const p of parts.slice(0, -1)) {
    const m = p.toLowerCase();
    if (['ctrl', 'control', 'commandorcontrol', 'cmdorctrl'].includes(m)) mods.ctrl = true;
    else if (['alt', 'option', 'altgr'].includes(m)) mods.alt = true;
    else if (m === 'shift') mods.shift = true;
    else return raw; // Meta/Super/Cmd: KeyCapture cannot express it
  }
  const last = parts[parts.length - 1];
  // 'Plus' is Electron's name for '+', i.e. Shift on the '=' key (Electron
  // registers it as the OEM-plus key with Shift). Read as anything else it
  // came back raw and unjudged, so a saved 'Ctrl+Plus' (Ctrl+Shift+=, the
  // zoom-in chord every app uses) showed no warning (FT-013).
  if (last.toLowerCase() === 'plus') return { code: 'Equal', mods: { ...mods, shift: true } };
  let code = null;
  if (/^[A-Za-z]$/.test(last)) code = `Key${last.toUpperCase()}`;
  else if (/^[0-9]$/.test(last)) code = `Digit${last}`;
  else if (/^num[0-9]$/i.test(last)) code = `Numpad${last.slice(3)}`;
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(last)) code = last.toUpperCase();
  else if (last.toLowerCase() === 'return') code = 'Enter';
  else code = CODE_FOR_NAMED[last.toLowerCase()] || null;
  return code ? { code, mods } : raw;
}

// --- What may be bound (V73) -----------------------------------------------
//
// A global hotkey is system-wide. Windows RegisterHotKey (and X11's grab)
// hands the combination to FunSync alone, so while FunSync runs that
// combination stops reaching EVERY other program. The rule therefore asks
// one question: would some other app, or typing itself, lose this key?
//
//   1. F13-F24 and the media/volume keys are dedicated keys: allowed alone
//      or with any modifiers.
//   2. Cursor, editing and screenshot keys (Space, Tab, Enter, Backspace,
//      Delete, Insert, Home, End, PageUp/Down, arrows, PrintScreen, and
//      Escape from a hand-edited config) are
//      refused with ANY modifiers: every combination already means
//      something (select a word, jump to the line end, switch tab, IME
//      toggle on Ctrl+Space, Alt+PrintScreen screenshot...).
//   3. Everything else (letters, digits, symbols, numpad, F1-F12) needs TWO
//      of Ctrl, Alt and Shift. A key alone or with Shift types a character
//      or is an app's F-key (F2 rename, F5 refresh, Shift+F10 menu); Ctrl or
//      Alt plus one key is where every app keeps its own commands (Ctrl+C/V/
//      X/Z/Y/A/S, Ctrl+W, Alt+F4, Alt+D, menu access keys). A deny-list of
//      single-modifier chords would always miss one; the class does not.
//   4. Ctrl+Alt on a letter, digit or symbol also needs Shift: AltGr arrives
//      as Ctrl+Alt, so German AltGr+Q ("@") is captured as Ctrl+Alt+Q, and
//      binding it would stop "@" typing in every app. F-keys and the numpad
//      have no AltGr characters, so Ctrl+Alt+F9 is fine.
//   5. A few Ctrl+Shift chords are everyday commands too and are refused:
//      Ctrl+Shift+C / V (copy and paste in terminals, paste as plain text),
//      Z (redo), S (Save As), N (new private window, new folder), T (reopen
//      a closed tab), W (close the window) and = (Ctrl++ zoom in).
//
// Residual, accepted: some layouts (Polish programmer, US-International)
// also type characters on AltGr+Shift, which Ctrl+Alt+Shift+<key> would
// take. Requiring Shift protects the standard layouts of all 8 app locales.
//
// Applied when a key is CAPTURED only. A saved binding that breaks it is
// kept, shown flagged and still registered: refusing is never destructive.

const DEDICATED_F_KEY = /^F(1[3-9]|2[0-4])$/;
const APP_F_KEY = /^F([1-9]|1[0-2])$/;
const CURSOR_EDIT_KEYS = new Set([
  'Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PrintScreen',
  // Only from a hand-edited config (see NAMED_KEYS): Esc, Ctrl+Esc (Start),
  // Alt+Esc and Ctrl+Shift+Esc (Task Manager) all belong to someone else.
  'Escape',
]);
const SYMBOL_KEYS = new Set([
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon',
  'Quote', 'Comma', 'Period', 'Slash', 'Backquote',
]);
const EVERYDAY_CTRL_SHIFT = new Set(['KeyC', 'KeyV', 'KeyZ', 'KeyS', 'KeyN', 'KeyT', 'KeyW', 'Equal']);

/** A key that carries characters on some layout (letters, top-row digits, symbols). */
function isCharacterKey(code) {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || SYMBOL_KEYS.has(code);
}

/**
 * Why this binding would take an everyday key from other apps, or null when
 * it is safe to bind system-wide:
 *   'typing'      — a letter/digit/symbol/numpad key without Ctrl or Alt
 *   'appShortcut' — one modifier + key, a bare/Shift F1-F12, or an everyday
 *                   Ctrl+Shift chord
 *   'altGr'       — Ctrl+Alt (no Shift) on a key that AltGr types with
 *   'cursorEdit'  — a cursor, editing or screenshot key, any modifiers
 * A key with no accelerator form returns null: it is refused as invalid
 * before this is asked, and a hand-edited one is shown, not judged.
 */
export function hotkeyRisk(binding) {
  const code = binding?.code;
  if (!keyForCode(code)) return null;
  const mods = binding.mods || {};
  if (DEDICATED_F_KEY.test(code) || /^(Media|AudioVolume)/.test(code)) return null;
  if (CURSOR_EDIT_KEYS.has(code)) return 'cursorEdit';
  const held = [mods.ctrl, mods.alt, mods.shift].filter(Boolean).length;
  if (!mods.ctrl && !mods.alt && !APP_F_KEY.test(code)) return 'typing';
  if (held < 2) return 'appShortcut';
  if (mods.ctrl && mods.alt && !mods.shift && isCharacterKey(code)) return 'altGr';
  if (mods.ctrl && mods.shift && !mods.alt && EVERYDAY_CTRL_SHIFT.has(code)) return 'appShortcut';
  return null;
}

/** The settingsPanel.playback.* string that explains each hotkeyRisk reason. */
export const HOTKEY_RISK_KEYS = {
  typing: 'settingsPanel.playback.globalHotkeyNeedsModifier',
  appShortcut: 'settingsPanel.playback.globalHotkeyAppShortcut',
  altGr: 'settingsPanel.playback.globalHotkeyAltGr',
  cursorEdit: 'settingsPanel.playback.globalHotkeyCursorKey',
};

/**
 * What the OS made of one saved binding, read from the main process's answer
 * to the last registration (electron/global-shortcuts.js `apply()`, one
 * `{action, accelerator, ok, reason?}` per binding it was given):
 *   'active'  — registered
 *   'taken'   — refused: the system or another app owns the combination
 *   'invalid' — refused: Electron could not parse it
 *   null      — not known: no answer yet, or the answer was for a different
 *               accelerator (a change still on its way to the main process)
 * A row must never say a binding is active on a guess (CB-19): Windows owns
 * Ctrl+Esc, refuses it, and the row used to read "Still active as saved."
 */
export function registrationOf(results, action, accelerator) {
  if (!Array.isArray(results) || typeof accelerator !== 'string') return null;
  const r = results.find((x) => x && x.action === action && x.accelerator === accelerator);
  if (!r) return null;
  if (r.ok === true) return 'active';
  return r.reason === 'invalid' ? 'invalid' : 'taken';
}

/** Same accelerator, ignoring case and modifier order ('alt+ctrl+p' === 'Ctrl+Alt+P'). */
export function sameAccelerator(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (s) => (bindingToAccelerator(acceleratorToBinding(s)) || s.trim()).toLowerCase();
  return norm(a) === norm(b);
}
