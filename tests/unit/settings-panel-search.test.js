/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel opens through Modal.open() and
 * builds every area as DOM, and settings-panel.js / i18n.js branch on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 *
 * Settings re-sorted and searchable (2026-11-23, Dave: "the settings menu
 * seems a bit cluttered again ... possibly add a searchbox at the top, so if
 * someone is looking for a setting pertaining to a specific functionality
 * like the feed notifications they can type feed or eroscripts ... we need
 * to be forgiving with the search").
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel, SETTINGS_ELSEWHERE } from '../../renderer/components/settings-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

const settingsStub = () => {
  const values = { 'player.language': 'en' };
  return { get: (k) => values[k], set: (k, v) => { values[k] = v; }, getAll: () => ({}) };
};

let showing = null;
beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('en', EN, EN);
  window.funsync = { setSetting: () => {}, onGlobalShortcut: () => {}, setGlobalShortcuts: async () => [] };
});
afterEach(async () => {
  document.querySelector('.settings-panel__done-btn')?.click();
  await showing;
  showing = null;
});
afterAll(() => _setBundlesForTests('en', EN, EN));

const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function open(opts = {}) {
  const panel = new SettingsPanel({ settings: settingsStub(), ...opts });
  showing = panel.show();
  await tick();
  return panel;
}

function type(q) {
  const input = $('.settings-panel__search-input');
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Shown on screen: not search-hidden, not hidden, in a shown area. */
const shown = (el) => !!el && !el.closest('.settings-panel__search-hidden, [hidden]');
const row = (controlId) => $(`#${controlId}`)?.closest('.settings-panel__field');
const shownAreas = () => $$('.settings-panel__content > .settings-panel__tab-content:not([hidden])').map((p) => p.id.replace('settings-tabpanel-', ''));
const elsewhereShown = () => $$('.settings-panel__elsewhere-row').filter(shown).map((r) => r.dataset.elsewhere);

describe('the map: every section where _railAreas says, in its order', () => {
  it('seven areas, and each area holds exactly its sections', async () => {
    const panel = await open();
    const areas = panel._railAreas();
    expect(areas.map((a) => a.id)).toEqual(['sources', 'playback', 'motion', 'appearance', 'keyboard', 'data', 'help']);
    expect($$('.settings-panel__rail-item').map((b) => b.textContent)).toEqual([
      EN.settingsPanel.tabLibrary, EN.settingsPanel.tabPlayback, EN.settingsPanel.tabMotion, EN.settingsPanel.tabAppearance,
      EN.settingsPanel.tabKeyboard, EN.settingsPanel.tabDataPrivacy, EN.settingsPanel.tabHelp,
    ]);
    for (const a of areas) {
      const ids = $$(`#settings-tabpanel-${a.id} > .settings-panel__section`).map((s) => s.id);
      expect(ids, a.id).toEqual(a.sections.map((s) => s.id));
    }
    // Nothing rendered is outside the map, and every section has a heading.
    const mapped = new Set(areas.flatMap((a) => a.sections.map((s) => s.id)));
    for (const s of $$('.settings-panel__section')) {
      expect(mapped.has(s.id), s.id).toBe(true);
      expect(s.querySelector('.settings-panel__section-header'), s.id).not.toBeNull();
    }
  });

  it('the old 20-row Playback section is three: Player, Smoothing & range (Device motion), Timeline & heatmap (Appearance)', async () => {
    await open();
    const in_ = (sec, id) => !!$(`#${sec} #${id}`);
    for (const id of ['sp-autoplay-on-open', 'sp-open-fullscreen', 'sp-remember-speed', 'sp-mini-player']) expect(in_('sp-sec-playback', id), id).toBe(true);
    for (const id of ['sp-smoothing', 'sp-speed-limit', 'sp-range-extender', 'sp-range-live-preview']) expect(in_('sp-sec-motion', id), id).toBe(true);
    for (const id of ['sp-inline-viz-placement', 'sp-inline-tl-window', 'sp-inline-viz-opacity', 'sp-hm-playhead', 'sp-device-sim-opacity']) expect(in_('sp-sec-overlay', id), id).toBe(true);
    expect($('#settings-tabpanel-motion #sp-sec-motion')).not.toBeNull();
    expect($('#settings-tabpanel-appearance #sp-sec-overlay')).not.toBeNull();
    // Player reads how a video opens first.
    const order = $$('#sp-sec-playback .settings-panel__field input').map((i) => i.id);
    expect(order).toEqual(['sp-autoplay-on-open', 'sp-open-fullscreen', 'sp-remember-speed', 'sp-mini-player']);
  });

  it('wiring still reaches a moved section: the speed limit (built in Playback, shown in Device motion) saves', async () => {
    const settings = settingsStub();
    const panel = new SettingsPanel({ settings });
    showing = panel.show();
    await tick();
    await tick();
    const slider = $('#sp-speed-limit');
    slider.value = '200';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(settings.get('player.speedLimit')).toBe(200);
  });

  it('Device motion says where the device itself is set, and its button opens Devices', async () => {
    const onOpenElsewhere = vi.fn();
    await open({ onOpenElsewhere });
    const note = $('#settings-tabpanel-motion .settings-panel__area-note');
    expect(note.textContent).toContain(EN.settingsPanel.motion.devicesNote);
    note.querySelector('button').click();
    await showing;
    await tick();
    expect(onOpenElsewhere).toHaveBeenCalledWith('handy');
  });
});

describe('searching', () => {
  it('opens on the search box', async () => {
    await open();
    await new Promise((r) => requestAnimationFrame(() => r()));
    await tick();
    expect(document.activeElement).toBe($('.settings-panel__search-input'));
  });

  it('"fullscreen" shows that one row, under its area, and nothing else', async () => {
    await open();
    type('fullscreen');
    expect(shown(row('sp-open-fullscreen'))).toBe(true);
    expect(shown(row('sp-remember-speed'))).toBe(false);
    expect(shownAreas()).toEqual(['playback']);
    expect(shown($('#settings-tabpanel-playback .settings-panel__area-heading'))).toBe(true);
    expect($('.settings-panel__search-status').textContent).toBe('1 result');
  });

  it('forgiving: a typo, a word for what it does, a plural, another order', async () => {
    await open();
    type('fulscreen');
    expect(shown(row('sp-open-fullscreen'))).toBe(true);
    type('picture in picture'); // the mini player, by what it is
    expect(shown(row('sp-mini-player'))).toBe(true);
    type('dark mode');
    expect(shown($('#sp-sec-theme'))).toBe(true);
    type('hotkeys');
    expect(shown($('#sp-sec-global-hotkeys'))).toBe(true);
    expect($('[data-area="keyboard"] .settings-panel__rail-count')?.textContent).toBeTruthy();
    type('Strokes FILL');
    expect(shown(row('sp-filler-enabled'))).toBe(true);
  });

  it('Dave\'s example: "feed" and "eroscripts" find the feed notifications, which live in the EroScripts tab', async () => {
    await open();
    type('feed');
    expect(elsewhereShown()).toContain('feeds');
    type('notifications');
    expect(elsewhereShown()).toContain('feeds');
    type('notifcations');
    expect(elsewhereShown()).toContain('feeds');
    type('eroscripts');
    expect(elsewhereShown()).toEqual(expect.arrayContaining(['feeds', 'eroscriptsDownloads', 'eroscriptsLogin']));
    expect(shown($('.settings-panel__elsewhere-row[data-elsewhere="feeds"] .settings-panel__elsewhere-open'))).toBe(true);
  });

  it('a device\'s own settings on the Devices tab are found too: "safety cap", "ramp up", "machine mode" (full manual test, 2026-11-23)', async () => {
    // "safety cap" said "Nothing matches": the Buttplug entry named only the
    // connection settings. Its words now carry each per-device setting's
    // label, in every language (the German one as the tab shows it).
    await open();
    for (const q of ['safety cap', 'ramp up', 'machine mode', 'e-stim']) {
      type(q);
      expect(elsewhereShown(), q).toContain('buttplug');
    }
    const B = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
    for (const l of ['de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const b = B(l);
      const cap = b.connection.buttplug.safetyCap.replace(/[:：]\s*$/, '').trim();
      expect(b.settingsPanel.search.elsewhere.buttplug.aliases, l).toContain(cap);
    }
  });

  it('a match its own setting keeps hidden shows its whole section (the control that reveals it)', async () => {
    await open();
    expect($('#sp-gap-threshold-row').hidden).toBe(true); // Gap Skip is off
    type('threshold');
    expect(shown($('#sp-sec-gapskip'))).toBe(true);
    expect(shown(row('sp-gap-mode'))).toBe(true);
  });

  it('nothing found: says so, with the words typed', async () => {
    await open();
    type('xyzzy');
    expect(shown($('.settings-panel__search-empty'))).toBe(true);
    expect($('.settings-panel__search-empty').textContent).toContain('“xyzzy”');
    expect(shownAreas()).toEqual([]);
    expect($('.settings-panel__search-status').textContent).toBe('');
  });

  it('clearing puts the area back as it was', async () => {
    await open();
    $('.settings-panel__rail-item[data-area="appearance"]').click();
    type('fullscreen');
    $('.settings-panel__search-clear').click();
    expect(shownAreas()).toEqual(['appearance']);
    expect($$('.settings-panel__search-hidden')).toEqual([]);
    expect($$('.settings-panel__area-heading').filter((h) => !h.hidden)).toEqual([]);
    expect($('.settings-panel__elsewhere').hidden).toBe(true);
    expect($$('.settings-panel__rail-count')).toEqual([]);
  });

  it('Escape clears a search first; the dialog stays open', async () => {
    await open();
    type('fullscreen');
    $('.settings-panel__search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.settings-panel__search-input').value).toBe('');
    expect($('.settings-panel__layout')).not.toBeNull();
    expect(shownAreas()).toEqual(['sources']);
  });

  it('Ctrl+F anywhere in Settings goes to the box', async () => {
    await open();
    $('.settings-panel__rail-item[data-area="help"]').focus();
    $('.settings-panel__rail-item[data-area="help"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(document.activeElement).toBe($('.settings-panel__search-input'));
  });

  it('Open closes Settings and hands app.js the id', async () => {
    const onOpenElsewhere = vi.fn();
    await open({ onOpenElsewhere });
    type('feed');
    $('.settings-panel__elsewhere-row[data-elsewhere="feeds"] .settings-panel__elsewhere-open').click();
    await showing;
    await tick();
    expect($('.settings-panel__layout')).toBeNull();
    expect(onOpenElsewhere).toHaveBeenCalledWith('feeds');
  });

  it('in German: German words, and the English ones too', async () => {
    _setBundlesForTests('de', DE, EN);
    await open();
    type('Benachrichtigung');
    expect(elsewhereShown()).toContain('feeds');
    type('feed');
    expect(elsewhereShown()).toContain('feeds');
    type('Vollbild');
    expect(shown(row('sp-open-fullscreen'))).toBe(true);
    expect($('.settings-panel__search-input').placeholder).toBe(DE.settingsPanel.search.placeholder);
  });
});

describe('every section in Settings has search words in every language', () => {
  // The script editor's speed limits (added 2026-11-24) had none, so "max
  // speed", what scripters call it, found nothing (test day B026).
  it('aliases for each section id, in all 8 locales', async () => {
    await open();
    const ids = $$('.settings-panel__section[id]').map((sec) => sec.id.replace(/^sp-sec-/, ''));
    expect(ids.length).toBeGreaterThan(20);
    for (const loc of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const j = JSON.parse(fs.readFileSync(`renderer/locales/${loc}.json`, 'utf8'));
      for (const id of ids) expect(j.settingsPanel.search.aliases[id], `${loc} ${id}`).toBeTruthy();
    }
  });

  it('"max speed", "too fast" and "OFS" find the script editor\'s speed limits', async () => {
    await open();
    for (const q of ['max speed', 'too fast', 'OFS']) {
      type(q);
      expect(shown($('#sp-sec-editor-speed')), q).toBe(true);
    }
  });
});

describe('every setting outside Settings has its words in every language', () => {
  it('title, where and aliases for each SETTINGS_ELSEWHERE id, in all 8 locales', () => {
    for (const loc of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
      const j = JSON.parse(fs.readFileSync(`renderer/locales/${loc}.json`, 'utf8'));
      for (const { id } of SETTINGS_ELSEWHERE) {
        const e = j.settingsPanel.search.elsewhere[id];
        for (const k of ['title', 'where', 'aliases']) expect(e?.[k], `${loc} ${id}.${k}`).toBeTruthy();
      }
    }
  });

  it('app.js opens each one that has an Open button', () => {
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    const body = app.slice(app.indexOf('  _openSettingElsewhere(id) {'), app.indexOf('  /** Open the Load-from-URL'));
    for (const { id, open: canOpen } of SETTINGS_ELSEWHERE) {
      if (canOpen) expect(body.includes(`'${id}'`) || body.includes(`${id}:`), id).toBe(true);
    }
  });
});

describe('the best match leads', () => {
  it('"feed": Feeds and their notifications comes before Report a Problem ("feedback")', async () => {
    await open();
    type('feed');
    const blocks = [...document.querySelectorAll('.settings-panel__content > :not([hidden])')]
      .filter((b) => b.querySelector('.settings-panel__area-heading:not([hidden])'));
    expect(blocks[0].classList.contains('settings-panel__elsewhere')).toBe(true);
    // Cleared: the rail's order again.
    document.querySelector('.settings-panel__search-clear').click();
    const ids = [...document.querySelectorAll('.settings-panel__content > .settings-panel__tab-content')].map((p) => p.id.replace('settings-tabpanel-', ''));
    expect(ids).toEqual(['sources', 'playback', 'motion', 'appearance', 'keyboard', 'data', 'help']);
  });
});
