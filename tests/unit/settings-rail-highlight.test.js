/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL SettingsPanel opens through Modal.open() and
 * builds every area as DOM, and settings-panel.js / i18n.js branch on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// FT-079 (also in v0.9.2): a click on Global hotkeys or Multi-Axis in the
// Settings rail lit Orgasm Switch. The click marked the group, then the
// smooth scroll's own scroll events ran the scroll-spy, which lights the last
// section whose top has passed the top of the view; those two sections are
// near the end and can never reach the top, so the one above them won.
//
// jsdom lays nothing out, so the content column's geometry is stubbed with
// the shape the real Playback area has (the last two sections start less
// than a screen from the end) and the smooth scroll is played out as the
// browser does it: scroll events on the way, then `scrollend`. What is
// asserted is the rail group the user sees lit.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { SettingsPanel } from '../../renderer/components/settings-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));

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

// The Playback area's sections, top to bottom (px from the content's top).
// Gap Filler and Edge Hold have rail entries of their own since pf-fixup
// (Dave 2026-11-19 ~15:05, "Add both").
const TOPS = {
  'sp-sec-playback': 0,
  'sp-sec-upnext': 400,
  'sp-sec-gapskip': 800,
  'sp-sec-gapfiller': 1000,
  'sp-sec-orgasm': 1200,
  'sp-sec-edge': 1400,
  'sp-sec-global-hotkeys': 1600,
  'sp-sec-multiaxis': 1800,
};
const CLIENT = 600;
const SCROLL_HEIGHT = 2100; // the deepest scrollTop is 1500

/** Open Settings on Playback with the stubbed geometry. */
function openPlayback() {
  const panel = new SettingsPanel({ settings: settingsStub() });
  showing = panel.show();
  document.querySelector('.settings-panel__rail-item[data-area="playback"]').click();
  const content = document.querySelector('.settings-panel__content');
  let top = 0;
  Object.defineProperty(content, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = Math.max(0, Math.min(SCROLL_HEIGHT - CLIENT, v)); } });
  Object.defineProperty(content, 'clientHeight', { configurable: true, get: () => CLIENT });
  Object.defineProperty(content, 'scrollHeight', { configurable: true, get: () => SCROLL_HEIGHT });
  for (const [id, y] of Object.entries(TOPS)) {
    const el = content.querySelector(`#${id}`);
    expect(el, id).not.toBeNull();
    Object.defineProperty(el, 'offsetTop', { configurable: true, get: () => y });
  }
  const seen = [];
  // Smooth scroll as Chromium plays it: steps with a scroll event each, then
  // scrollend. The highlight is read after every event.
  content.scrollTo = ({ top: to }) => {
    const from = top;
    for (let i = 1; i <= 5; i++) {
      content.scrollTop = from + ((to - from) * i) / 5;
      content.dispatchEvent(new Event('scroll'));
      seen.push(lit());
    }
    content.dispatchEvent(new Event('scrollend'));
    seen.push(lit());
  };
  return { content, seen };
}

const lit = () => [...document.querySelectorAll('.settings-panel__rail-group--active')].map((el) => el.dataset.section);
const clickGroup = (id) => document.querySelector(`.settings-panel__rail-group[data-section="${id}"]`).click();
/** The user's own scroll: a wheel, then the scroll it makes. */
function userScrollTo(content, y) {
  content.dispatchEvent(new Event('wheel'));
  content.scrollTop = y;
  content.dispatchEvent(new Event('scroll'));
}

describe('the Settings rail lights the group you clicked and the one you scrolled to (FT-079)', () => {
  it('Global hotkeys clicked: it stays lit through its scroll and after it', () => {
    const { seen } = openPlayback();
    clickGroup('sp-sec-global-hotkeys');
    expect(seen.length).toBe(6);
    for (const s of seen) expect(s).toEqual(['sp-sec-global-hotkeys']);
    expect(lit()).toEqual(['sp-sec-global-hotkeys']);
  });

  it('Multi-Axis clicked: Multi-Axis', () => {
    const { seen } = openPlayback();
    clickGroup('sp-sec-multiaxis');
    for (const s of seen) expect(s).toEqual(['sp-sec-multiaxis']);
  });

  it('a group that reaches the top: that group, as before', () => {
    const { seen } = openPlayback();
    clickGroup('sp-sec-gapskip');
    expect(seen.at(-1)).toEqual(['sp-sec-gapskip']);
  });

  it('scrolled by hand: the bottom lights the last group in view, the top the first, the middle the one at the top', () => {
    const { content } = openPlayback();
    clickGroup('sp-sec-upnext');
    userScrollTo(content, SCROLL_HEIGHT - CLIENT);
    expect(lit()).toEqual(['sp-sec-multiaxis']);
    userScrollTo(content, 0);
    expect(lit()).toEqual(['sp-sec-playback']);
    userScrollTo(content, 810);
    expect(lit()).toEqual(['sp-sec-gapskip']);
  });

  it('after a click, the first hand scroll follows the view again', () => {
    const { content } = openPlayback();
    clickGroup('sp-sec-global-hotkeys');
    userScrollTo(content, 1210);
    expect(lit()).toEqual(['sp-sec-orgasm']);
  });
});

describe('Gap Filler and Edge Hold have rail entries of their own (Dave 2026-11-19 ~15:05, "Add both")', () => {
  const groups = () => [...document.querySelectorAll('.settings-panel__rail-groups:not([hidden]) .settings-panel__rail-group')];

  it("the Playback rail reads ... Gap Skip, Gap Filler, Orgasm Switch, Edge Hold ..., in the content's own order", () => {
    const { content } = openPlayback();
    const labels = groups().map((g) => g.textContent);
    const at = labels.indexOf(EN.settingsPanel.playback.gapSkipHeader);
    expect(labels.slice(at, at + 4)).toEqual([
      EN.settingsPanel.playback.gapSkipHeader, EN.settingsPanel.playback.fillerHeader,
      EN.settingsPanel.playback.orgasmHeader, EN.settingsPanel.playback.edgeHeader,
    ]);
    // every entry has its section, and the sections stand in the rail's order
    const ids = groups().map((g) => g.dataset.section);
    const sections = [...content.querySelectorAll(':scope .settings-panel__tab-content:not([hidden]) > .settings-panel__section')].map((s) => s.id);
    expect(sections.filter((id) => ids.includes(id))).toEqual(ids);
  });

  it("each jumps to the section with its own rows: Gap Filler's on / off, threshold and pattern; Edge Hold's key and pattern", () => {
    const { content } = openPlayback();
    const filler = content.querySelector('#sp-sec-gapfiller');
    expect(filler.querySelector('.settings-panel__section-header').textContent).toBe(EN.settingsPanel.playback.fillerHeader);
    for (const id of ['sp-filler-enabled', 'sp-filler-threshold', 'sp-filler-pattern-rows', 'sp-filler-hint']) expect(filler.querySelector(`#${id}`), id).not.toBeNull();
    expect(content.querySelector('#sp-sec-gapskip #sp-filler-enabled')).toBeNull();
    const edge = content.querySelector('#sp-sec-edge');
    for (const id of ['sp-edge-mode', 'sp-edge-action', 'sp-edge-pattern-rows']) expect(edge.querySelector(`#${id}`), id).not.toBeNull();
  });

  it('clicked, each scrolls to its section and lights, through its scroll and after it', () => {
    for (const id of ['sp-sec-gapfiller', 'sp-sec-edge']) {
      const { content, seen } = openPlayback();
      let target = null;
      const scrollTo = content.scrollTo;
      content.scrollTo = (o) => { target = o.top; scrollTo(o); };
      clickGroup(id);
      expect(target, id).toBe(TOPS[id] - 8);
      for (const s of seen) expect(s, id).toEqual([id]);
      expect(lit(), id).toEqual([id]);
      document.querySelector('.settings-panel__done-btn')?.click();
    }
  });

  it('scrolled to by hand, each lights', () => {
    const { content } = openPlayback();
    userScrollTo(content, 1010);
    expect(lit()).toEqual(['sp-sec-gapfiller']);
    userScrollTo(content, 1410);
    expect(lit()).toEqual(['sp-sec-edge']);
    userScrollTo(content, 1210);
    expect(lit()).toEqual(['sp-sec-orgasm']);
  });
});
