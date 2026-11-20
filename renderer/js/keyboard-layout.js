// Letter shortcuts on keyboard layouts that type no Latin letters.
//
// The key switches (the player's keyboard.js, the docked editor's
// _onCanvasKeyDown, the editor pop-out) match on `e.key`: 'n', 'N', 'f', ...
// On a Russian layout the N key types 'т', on a Korean one 'ㅜ', so every
// letter shortcut did nothing there: N (New points only), Q, E, R, W in the
// editor, F, M, S, ... in the player, and Ctrl+C / Ctrl+Z, whose `key` is the
// Cyrillic letter too (FT-035). `e.code` names the physical key (KeyN) on
// every layout.
//
// layoutKey(e): when `e.key` is ONE letter outside ASCII and `e.code` is a
// letter key, the Latin letter printed on that key (upper case with Shift);
// otherwise `e.key` unchanged. A layout that types Latin letters keeps its
// own: AZERTY's A key reports code KeyQ but key 'a', and stays 'a', so Q never
// fires there (QWERTZ's Z and Y the same). Named keys ('Enter', 'ArrowLeft'),
// digits, punctuation, dead keys ('Dead') and an IME composing ('Process')
// pass through untouched.
//
// Pure, no DOM: imported by keyboard.js, script-editor.js, editor-popout.js
// and player-popout.js.

const LETTER_CODE = /^Key([A-Z])$/;
const DIGIT_CODE = /^Digit([0-9])$/;
const ONE_LETTER = /^\p{L}$/u;

/**
 * The digit printed on the pressed number-row key, from `e.code`, whatever
 * the layout types there; anything else (numpad digits included) is `e.key`
 * unchanged. For the digit CHORDS only (Ctrl+1/2/3 select a third in both
 * editors, Alt+1/2/3 switch Library / Playlists / Categories): AZERTY's
 * unshifted number row types & é " …, so a match on `e.key` never fired
 * there (CB-06). Not for bare keys, and not inside layoutKey: AZERTY's `-`
 * is on Digit6, and Ctrl+- (editor zoom out) must stay `-` there.
 * @param {{key?: string, code?: string}} e — a KeyboardEvent
 * @returns {string|undefined}
 */
export function digitKey(e) {
  const m = DIGIT_CODE.exec(typeof e?.code === 'string' ? e.code : '');
  return m ? m[1] : e?.key;
}

/**
 * The key a letter shortcut should match for this event.
 * @param {{key?: string, code?: string, shiftKey?: boolean}} e — a KeyboardEvent
 * @returns {string|undefined}
 */
export function layoutKey(e) {
  const key = e?.key;
  if (typeof key !== 'string' || !ONE_LETTER.test(key) || key.codePointAt(0) < 0x80) return key;
  const m = LETTER_CODE.exec(typeof e.code === 'string' ? e.code : '');
  if (!m) return key;
  return e.shiftKey ? m[1] : m[1].toLowerCase();
}
