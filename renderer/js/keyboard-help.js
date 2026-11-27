// keyboard-help — Shared "press ? to see all shortcuts" overlay.
//
// Used by:
//   - renderer/components/script-editor.js (editor view, `?` opens
//     editor-specific shortcut groups).
//   - renderer/js/app.js (player view, `?` opens player shortcut groups).
//
// The overlay itself is a `Modal.open` — same dialog primitives as the
// rest of the app. Each caller passes its own group-of-rows data shape
// so the same module renders different content per surface. Nielsen #7
// (flexibility for experts — surface every binding without making
// novices learn them) + #10 (help in context).
//
// Group shape:
//   [
//     { title: 'Playback', rows: [['Space / K', 'Play / Pause'], ...] },
//     { title: 'Volume',   rows: [['M', 'Mute / Unmute'], ['Up / Down', 'Volume ±5%']] },
//     ...
//   ]

import { Modal } from '../components/modal.js';
import { t } from './i18n.js';
import { formatBindingLabel, numpadKeyName } from '../components/key-capture.js';
import { dataService } from './data-service.js';
import { readPatternChoice } from './pattern-choice.js';

// Z plays a pattern only in 'pattern' mode AND once one is chosen: with none
// (the default since 2026-11-17), Z stops the devices, as app.js does. The
// choice is the shared one (pattern-choice.js: player.edgePatternChoice, else
// the old player.edgePattern), 2026-11-19.
const edgePlaysPattern = () => dataService?.get?.('player.edgeHoldAction') === 'pattern'
  && readPatternChoice('edge', {
    edgePatternChoice: dataService?.get?.('player.edgePatternChoice'),
    edgePattern: dataService?.get?.('player.edgePattern'),
  }).id !== null;

// The chord column in the active language (CB-08). The rows below keep their
// chords in canonical English, the form keyboard-shortcut-clash.test.js
// parses; the overlay renders each word through the `keys.*` names FT-014
// gave Settings (formatBindingLabel's), so a German list reads Strg /
// Umschalt / Entf like its own custom-key rows instead of mixing in Ctrl.
// Letters, digits, punctuation and F-keys are the same in every language and
// pass through; the numpad's name goes through `keys.numpad` like the custom
// rows' (R3-25: "Numpad 0 – 9" read English in every locale). With no bundle
// loaded a word stays as written here (the editor pop-out had none until
// FT-103).
const CHORD_MODIFIERS = { Ctrl: 'ctrl', Alt: 'alt', Shift: 'shift' };
const CHORD_WORDS = {
  Space: 'space', Esc: 'escape', Home: 'home', End: 'end',
  Del: 'delete', Backspace: 'backspace', Enter: 'enter', Tab: 'tab',
  Left: 'arrowLeft', Right: 'arrowRight', Up: 'arrowUp', Down: 'arrowDown',
  // Not keys, but in the same column: the mouse half of a chord.
  Arrows: 'arrows', Scroll: 'scroll', Click: 'click', 'Drag dot': 'dragPoint',
};

function chordWord(id, fallback) {
  const k = `keys.${id}`;
  const s = t(k);
  return typeof s === 'string' && s && s !== k ? s : fallback;
}

/**
 * One alternative of a chord ("Ctrl+Shift+Left", "Del", "Shift+Drag dot")
 * in the active language: each leading modifier and a named base word
 * through `keys.*`; anything else unchanged. Exported for its test.
 * @param {string} part
 * @returns {string}
 */
export function localizeChordPart(part) {
  const s = String(part ?? '');
  const mods = [];
  let rest = s;
  for (;;) {
    const m = /^(Ctrl|Alt|Shift)\+(?=.)/.exec(rest);
    if (!m) break;
    mods.push(chordWord(CHORD_MODIFIERS[m[1]], m[1]));
    rest = rest.slice(m[0].length);
  }
  const base = Object.hasOwn(CHORD_WORDS, rest) ? chordWord(CHORD_WORDS[rest], rest)
    : /^Numpad(?=.)/.test(rest) ? numpadKeyName(rest.slice('Numpad'.length))
      : rest;
  return [...mods, base].join('+');
}

/**
 * Open the keyboard-help overlay with the given groups.
 * @param {string} title — Modal title (e.g. "Player keyboard shortcuts")
 * @param {Array<{title: string, rows: Array<[string, string]>}>} groups
 */
export function openKeyboardHelp(title, groups) {
  Modal.open({
    title,
    onRender(body, close) {
      const wrap = document.createElement('div');
      wrap.className = 'editor-help'; // reuses the editor's two-column dl styling
      for (const g of groups) {
        const sec = document.createElement('section');
        sec.className = 'editor-help__section';
        const h = document.createElement('h3');
        h.className = 'editor-help__title';
        h.textContent = g.title;
        sec.appendChild(h);
        const tbl = document.createElement('dl');
        tbl.className = 'editor-help__list';
        for (const [keys, desc] of g.rows) {
          const dt = document.createElement('dt');
          dt.className = 'editor-help__keys';
          // Render each key part as <kbd> so screen readers + copy/paste
          // both render keyboard input semantically. Splits on " / "
          // (alternative bindings) but preserves "+" combos as one chip.
          for (const part of keys.split(/\s*\/\s*/)) {
            if (dt.children.length) dt.appendChild(document.createTextNode(' / '));
            const kbd = document.createElement('kbd');
            kbd.textContent = localizeChordPart(part);
            dt.appendChild(kbd);
          }
          const dd = document.createElement('dd');
          dd.className = 'editor-help__desc';
          dd.textContent = desc;
          tbl.appendChild(dt);
          tbl.appendChild(dd);
        }
        sec.appendChild(tbl);
        wrap.appendChild(sec);
      }
      body.appendChild(wrap);

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const ok = document.createElement('button');
      ok.className = 'modal-btn modal-btn--primary';
      ok.textContent = t('common.gotIt');
      ok.addEventListener('click', () => close());
      actions.appendChild(ok);
      body.appendChild(actions);
    },
  });
}

/**
 * Pre-built group set for the player view. Centralised so the
 * shortcut documentation stays in one place — anyone updating a
 * binding (in app.js, video-player.js) updates this list too.
 */
// Group sets are exported as builder functions so each `t()` call resolves
// against the active locale at modal-open time. Keyboard combos are written
// in canonical English here (the clash test parses them) and translated
// when the overlay renders them (localizeChordPart, CB-08).
export function getPlayerShortcutGroups({ vrZoomKeys } = {}) {
  const groups = [
    {
      title: t('kbd.navigation'),
      rows: [
        ['Alt+1',         t('kbd.library')],
        ['Alt+2',         t('kbd.playlists')],
        ['Alt+3',         t('kbd.categories')],
      ],
    },
    {
      title: t('kbd.playback'),
      rows: [
        ['Space / K',     t('kbd.playPause')],
        ['J / L',         t('kbd.seek10s')],
        ['Left / Right',  t('kbd.seek5s')],
        ['Shift+Left / Right', t('kbd.seekFrame')],
        ['Home / End',    t('kbd.jumpStartEnd')],
        ['G',             t('kbd.skipNextAction')],
        ['Shift+G',       t('kbd.skipPrevAction')],
        ['N',             t('kbd.nextVideo')],
        ['P',             t('kbd.prevVideo')],
      ],
    },
    {
      title: t('kbd.volume'),
      rows: [
        ['Up / Down',     t('kbd.volume5')],
        ['M',             t('kbd.muteToggle')],
      ],
    },
    {
      title: t('kbd.view'),
      rows: [
        ['F / F11',       t('kbd.fullscreen')],
        ['R',             t('kbd.cycleAspect')],
        ['Shift+R',       t('kbd.vrFlatten')],
        ['Shift+Arrows',  t('kbd.vrPan')],
        ['Ctrl+Scroll',   t('kbd.vrZoom')],
        // The defaults; the keys bound in Settings > Keyboard replace them below.
        ['= / -',         t('kbd.vrZoomKeys')],
        ['Ctrl+0',        t('kbd.vrZoomReset')],
        ['<',             t('kbd.speedDown')],
        ['>',             t('kbd.speedUp')],
        ['I',             t('kbd.toggleInfo')],
        ['S',             t('kbd.screenshot')],
      ],
    },
    {
      title: t('kbd.abLoop'),
      rows: [
        ['A',             t('kbd.loopA')],
        ['B',             t('kbd.loopB')],
        ['Shift+L',       t('kbd.toggleVideoLoop')],
        ['Shift+Q',       t('kbd.toggleQueue')],
        ['Esc',           t('kbd.clearLoop')],
      ],
    },
    {
      title: t('kbd.devicesSync'),
      rows: [
        ['H',             t('kbd.devicesPanel')],
        ['D',             t('kbd.deviceSimulator')],
        // X was never listed here — a user with a configured finisher had no
        // way to discover the hotkey (lettuce, EroScripts #302).
        // Both keys can run as hold or press-to-toggle, so the row has to
        // say which one is armed — "(hold)" next to a key that toggles is
        // worse than no label at all.
        ['X',             dataService?.get?.('player.orgasmSwitchMode') === 'toggle'
                            ? t('kbd.orgasmSwitchToggle') : t('kbd.orgasmSwitch')],
        // ...and Z can play a pattern instead of stopping the devices.
        ['Z',             edgePlaysPattern()
                            ? (dataService?.get?.('player.edgeHoldMode') === 'toggle'
                              ? t('kbd.edgeHoldPatternToggle') : t('kbd.edgeHoldPattern'))
                            : (dataService?.get?.('player.edgeHoldMode') === 'toggle'
                              ? t('kbd.edgeHoldToggle') : t('kbd.edgeHold'))],
        // Stop all (DESIGN.md §2.15): the one stop, whatever drives the devices.
        ['Shift+Space',   t('kbd.stopAll')],
      ],
    },
    {
      title: t('kbd.script'),
      rows: [
        ['E',             t('kbd.scriptEditor')],
        ['V',             t('kbd.nextVariant')],
        ['Shift+V',       t('kbd.prevVariant')],
      ],
    },
    {
      title: t('kbd.chaptersBookmarks'),
      rows: [
        [',',             t('kbd.prevChapter')],
        ['.',             t('kbd.nextChapter')],
        ['Shift+B',       t('kbd.prevBookmark')],
        ['Ctrl+B',        t('kbd.nextBookmark')],
      ],
    },
    {
      title: t('kbd.libraryGroup'),
      rows: [
        // No "Esc — back to library" row: Escape has never left the player
        // (it dismisses Up Next, closes the queue, clears the A-B loop and
        // closes panels — the Esc row above), and that row contradicted it
        // since May 2026 (V46). The Back button and Alt+1/2/3 leave.
        ['O',             t('kbd.openFile')],
        // On a focused card's ⋮ (its Tab stop): the video options dialog,
        // as Windows' "Properties" key and the context-menu key (design (b)).
        ['Alt+Enter / Shift+F10', t('kbd.videoOptions')],
      ],
    },
    {
      title: t('kbd.help'),
      rows: [
        ['?',             t('kbd.showHelp')],
      ],
    },
  ];
  // VR zoom with no Ctrl: the keys actually bound (Settings > Keyboard >
  // VR zoom keys), the numpad's + / - with them.
  const zoom = vrZoomKeys ? [vrZoomKeys.in, vrZoomKeys.out].filter(Boolean).map((b) => formatBindingLabel(b)) : null;
  if (zoom) {
    const label = t('kbd.vrZoomKeys');
    for (const g of groups) {
      // No key bound for either: the row goes (the Ctrl keys are listed above).
      if (!zoom.length) { g.rows = g.rows.filter((row) => row[1] !== label); continue; }
      for (const row of g.rows) if (row[1] === label) row[0] = zoom.join(' / ');
    }
  }
  return groups;
}

/**
 * @param {object} [opts]
 * @param {Array} [opts.customPositionKeys]  the bindings to list; the editor POP-OUT
 *   passes the ones its parent sent (it has no settings store of its own, so its
 *   '?' list left them out; FT-103, fixed 2026-11-22). Without it, read from the store.
 */
export function getEditorShortcutGroups({ customPositionKeys } = {}) {
  return [
    {
      title: t('kbd.editorSelection'),
      rows: [
        ['Down / Up',           t('kbd.editorPrevNextAction')], // Down = previous, Up = next, as in OFS (2026-11-22)
        ['Ctrl+Up / Ctrl+Down', t('kbd.editorPrevNextAcrossScripts')],
        ['PageUp / PageDown',   t('kbd.editorPrevNextScript')],
        ['Left / Right',        t('kbd.editorStepFrame')],
        ['Ctrl+Left / Right',   t('kbd.editorFastFrame')],
        ['Ctrl+A',              t('kbd.editorSelectAll')],
        ['Ctrl+1 / 2 / 3',      t('kbd.editorSelectThird')],
        ['N',                   t('kbd.editorSelectCreated')],
        ['Esc',                 t('kbd.editorClearSelection')],
      ],
    },
    {
      title: t('kbd.editorEdit'),
      rows: [
        ['Shift+Up / Down',     t('kbd.editorNudgeCoarse')],
        ['Ctrl+Shift+Up / Down',t('kbd.editorNudgeFine')],
        ['Shift+Left / Right',  t('kbd.editorMoveFrame')],
        ['Ctrl+Shift+Left / Right', t('kbd.editorMoveFrames')],
        ['Ctrl+Alt+Left / Right', t('kbd.editorSelectLeftRightOfCursor')],
        ['E',                   t('kbd.editorEqualize')],
        ['End',                 t('kbd.editorMoveToPlayhead')],
        ['Del / Backspace',     t('kbd.editorDelete')],
        ['Shift+Del',           t('kbd.editorRippleDelete')],
        ['Ctrl+I',              t('kbd.editorInvert')],
        ['P',                   t('kbd.editorFillPattern')],
      ],
    },
    {
      title: t('kbd.editorPlace'),
      rows: [
        ['0 – 9 / Numpad 0 – 9', t('kbd.editorPlaceNumpad')],
        ['Shift+0 / - / Numpad-', t('kbd.editorPlaceTop')],
        ['Alt+Click',           t('kbd.editorInsertAtClick')],
        ['Shift+Drag dot',      t('kbd.editorMoveSelected')],
        ['Q',                   t('kbd.editorAlternatingInsert')],
        ['Home',                t('kbd.editorRepeatLastStroke')],
        ['B',                   t('kbd.editorBookmark')],
        ['Shift+B / Ctrl+B',    t('kbd.editorBookmarkNav')],
        ['R',                   t('kbd.editorRecording')],
        ['Shift+R',             t('editor.gamepad.help')],
        ['W',                   t('kbd.editorWaveform')],
        ['T',                   t('kbd.editorReference')],
        ['Shift+W',             t('kbd.editorMultiBand')],
        ['V',                   t('kbd.editorVAD')],
        ['[ / ]',                t('kbd.editorSpeedStep')],
      ],
    },
    {
      title: t('kbd.editorHistory'),
      rows: [
        ['Ctrl+Z',                t('kbd.editorUndo')],
        ['Ctrl+Y / Ctrl+Shift+Z', t('kbd.editorRedo')],
        ['Ctrl+C / Ctrl+X',       t('kbd.editorCopyCut')],
        ['Ctrl+V',                t('kbd.editorPaste')],
        ['Ctrl+Shift+V',          t('kbd.editorPasteOriginal')],
        ['Ctrl+S',                t('kbd.editorSave')],
        ['Ctrl+Shift+S',          t('kbd.editorSaveAs')],
      ],
    },
    {
      title: t('kbd.view'),
      rows: [
        // Ctrl+-, not bare -: that places a point at 100 (FT-032, CB-04).
        ['+ / Ctrl+-',          t('kbd.editorZoom')],
        ['?',                   t('kbd.showHelp')],
      ],
    },
    ...buildCustomPositionKeysGroup(customPositionKeys),
  ];
}

/**
 * Build the dynamic "Custom position keys" group from the user's saved
 * bindings. Returns an empty array when the user has no custom bindings
 * — so the empty group is never rendered (no visual noise). Per
 * Nielsen #6 (recognition > recall), users should be able to find their
 * own bindings via `?` without rummaging through Settings.
 */
function buildCustomPositionKeysGroup(given) {
  let bindings = [];
  if (Array.isArray(given)) {
    bindings = given;
  } else {
    try {
      const raw = dataService?.get?.('editor.customPositionKeys');
      if (Array.isArray(raw)) bindings = raw;
    } catch { /* not initialised — fall through to empty group */ }
  }
  if (bindings.length === 0) return [];
  return [{
    title: t('editor.customKeysHelpGroup'),
    rows: bindings
      .filter((b) => b && typeof b.code === 'string')
      .map((b) => [formatBindingLabel(b), `→ ${b.position}`]),
  }];
}
