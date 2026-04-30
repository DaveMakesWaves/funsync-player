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
      ok.textContent = 'Got it';
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
export const PLAYER_SHORTCUT_GROUPS = [
  {
    title: 'Navigation',
    rows: [
      ['Alt+1',         'Library'],
      ['Alt+2',         'Playlists'],
      ['Alt+3',         'Categories'],
    ],
  },
  {
    title: 'Playback',
    rows: [
      ['Space / K',     'Play / Pause'],
      ['J / L',         'Seek backward / forward 10s'],
      ['Left / Right',  'Seek backward / forward 5s'],
      ['Shift+Left / Right', 'Seek backward / forward 1 frame'],
      ['Home / End',    'Jump to start / end'],
      ['G',             'Skip to next action (gap skip)'],
      ['Shift+G',       'Skip to previous action'],
    ],
  },
  {
    title: 'Volume',
    rows: [
      ['Up / Down',     'Volume ±5%'],
      ['M',             'Mute / Unmute'],
    ],
  },
  {
    title: 'View',
    rows: [
      ['F / F11',       'Fullscreen'],
      ['R',             'Cycle aspect ratio'],
      ['I',             'Toggle info overlay'],
      ['S',             'Screenshot'],
    ],
  },
  {
    title: 'A / B loop',
    rows: [
      ['A',             'Set loop point A'],
      ['B',             'Set loop point B'],
      ['Esc',           'Clear loop / close panels'],
    ],
  },
  {
    title: 'Devices & sync',
    rows: [
      ['H',             'Toggle Devices panel'],
      ['D',             'Toggle device simulator'],
    ],
  },
  {
    title: 'Script',
    rows: [
      ['E',             'Toggle script editor'],
      ['V',             'Cycle to next variant'],
      ['Shift+V',       'Cycle to previous variant'],
    ],
  },
  {
    title: 'Library',
    rows: [
      ['O',             'Open file (native dialog)'],
      ['Esc',           'Back from player to library'],
    ],
  },
  {
    title: 'Help',
    rows: [
      ['?',             'Show this help'],
    ],
  },
];

/**
 * Pre-built group set for the editor view. Mirrors what was previously
 * inline in script-editor.js::_openKeyboardHelp.
 */
export const EDITOR_SHORTCUT_GROUPS = [
  {
    title: 'Selection & navigation',
    rows: [
      ['Up / Down',           'Prev / next action (with seek)'],
      ['Ctrl+Up / Ctrl+Down', 'Same, across all loaded scripts'],
      ['Left / Right',        'Step one video frame'],
      ['Ctrl+Left / Right',   'Fast frame step (configurable; default 6)'],
      ['Ctrl+A',              'Select all'],
      ['Ctrl+1 / 2 / 3',      'Select top / middle / bottom third'],
      ['Esc',                 'Clear selection / close editor'],
    ],
  },
  {
    title: 'Edit selected',
    rows: [
      ['Shift+Up / Down',     'Nudge position ±5 (coarse)'],
      ['Ctrl+Shift+Up / Down','Nudge position ±1 (fine)'],
      ['Shift+Left / Right',  'Move action(s) ±1 frame in time'],
      ['Ctrl+Shift+Left / Right', 'Move action(s) ±N frames'],
      ['Del / Backspace',     'Delete selected'],
      ['Ctrl+I',              'Invert positions'],
    ],
  },
  {
    title: 'Place / edit actions',
    rows: [
      ['0 – 9 (or Numpad)',   'Place action at 0 / 11 / 22 / … / 100'],
      ['Alt+Click',           'Insert action at click position'],
      ['Shift+Drag dot',      'Move selected actions'],
      ['B',                   'Add bookmark at playhead'],
      ['R',                   'Toggle recording mode'],
      ['W',                   'Toggle waveform'],
    ],
  },
  {
    title: 'History & I/O',
    rows: [
      ['Ctrl+Z',                'Undo'],
      ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'],
      ['Ctrl+C / Ctrl+X',       'Copy / cut selected'],
      ['Ctrl+V',                'Paste at playhead'],
      ['Ctrl+Shift+V',          'Paste at original times'],
      ['Ctrl+S',                'Save'],
    ],
  },
  {
    title: 'View',
    rows: [
      ['+ / -',               'Zoom in / out'],
      ['?',                   'Show this help'],
    ],
  },
];
