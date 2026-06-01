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
import { formatBindingLabel } from '../components/key-capture.js';
import { dataService } from './data-service.js';

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
            kbd.textContent = part;
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
// against the active locale at modal-open time. Keyboard combos stay literal
// (they're the same in every language); only the row descriptions and group
// titles route through i18n.
export function getPlayerShortcutGroups() {
  return [
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
        ['Ctrl+Shift+R',  t('kbd.vrFormat')],
        ['Shift+Arrows',  t('kbd.vrPan')],
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
        ['O',             t('kbd.openFile')],
        ['Esc',           t('kbd.backToLibrary')],
      ],
    },
    {
      title: t('kbd.help'),
      rows: [
        ['?',             t('kbd.showHelp')],
      ],
    },
  ];
}

export function getEditorShortcutGroups() {
  return [
    {
      title: t('kbd.editorSelection'),
      rows: [
        ['Up / Down',           t('kbd.editorPrevNextAction')],
        ['Ctrl+Up / Ctrl+Down', t('kbd.editorPrevNextAcrossScripts')],
        ['Left / Right',        t('kbd.editorStepFrame')],
        ['Ctrl+Left / Right',   t('kbd.editorFastFrame')],
        ['Ctrl+A',              t('kbd.editorSelectAll')],
        ['Ctrl+1 / 2 / 3',      t('kbd.editorSelectThird')],
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
        ['Ctrl+I',              t('kbd.editorInvert')],
      ],
    },
    {
      title: t('kbd.editorPlace'),
      rows: [
        ['0 – 9 (or Numpad)',   t('kbd.editorPlaceNumpad')],
        ['Shift+0 / - / Numpad-', t('kbd.editorPlaceTop')],
        ['Alt+Click',           t('kbd.editorInsertAtClick')],
        ['Shift+Drag dot',      t('kbd.editorMoveSelected')],
        ['Q',                   t('kbd.editorAlternatingInsert')],
        ['Home',                t('kbd.editorRepeatLastStroke')],
        ['B',                   t('kbd.editorBookmark')],
        ['Shift+B / Ctrl+B',    t('kbd.editorBookmarkNav')],
        ['R',                   t('kbd.editorRecording')],
        ['W',                   t('kbd.editorWaveform')],
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
      ],
    },
    {
      title: t('kbd.view'),
      rows: [
        ['+ / -',               t('kbd.editorZoom')],
        ['?',                   t('kbd.showHelp')],
      ],
    },
    ...buildCustomPositionKeysGroup(),
  ];
}

/**
 * Build the dynamic "Custom position keys" group from the user's saved
 * bindings. Returns an empty array when the user has no custom bindings
 * — so the empty group is never rendered (no visual noise). Per
 * Nielsen #6 (recognition > recall), users should be able to find their
 * own bindings via `?` without rummaging through Settings.
 */
function buildCustomPositionKeysGroup() {
  let bindings = [];
  try {
    const raw = dataService?.get?.('editor.customPositionKeys');
    if (Array.isArray(raw)) bindings = raw;
  } catch { /* not initialised — fall through to empty group */ }
  if (bindings.length === 0) return [];
  return [{
    title: t('editor.customKeysHelpGroup'),
    rows: bindings
      .filter((b) => b && typeof b.code === 'string')
      .map((b) => [formatBindingLabel(b), `→ ${b.position}`]),
  }];
}
