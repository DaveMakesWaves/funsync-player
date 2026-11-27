/**
 * @vitest-environment jsdom
 * jsdom on purpose: NavBar builds real DOM, nav-bar.css is run through
 * jsdom's cascade, and i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// CB-20 (block B verification, 2026-11-05; also TODO lines from the
// 2026-11-03/04 verifies): the German nav bar at 125% on a 1280 px window
// (1024 CSS px) ran "Nicht verbunden" into "Web-Fernsteuerung", and English
// did the same at an 800 px window. The right-side buttons have
// `min-width: 36px`, so flexbox shrank them below their text and the text
// painted over the next button.
//
// The bar now measures itself and takes text off in steps (nav-bar.js
// `_fitToWidth`, the `nav-bar--fit-N` rules in nav-bar.css) until it fits.
// jsdom has no layout, so the bar is laid out here by a small model: each
// button is its padding plus the parts the REAL stylesheet leaves in the
// flow (an icon, a label whose computed `position` is not absolute), a
// character of label text 7 px, as 12-13 px Segoe UI roughly is. The real
// widths were measured in the sandboxed app across 8 locales, 100/125/150%
// and 1280/1100/1024/900/800 px windows (UPDATES.md); what is pinned here
// is the behaviour: the bar always fits, it takes text off in the
// documented order and no further than needed, it gives text back when
// room returns, and every button keeps its name.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { NavBar } from '../../renderer/components/nav-bar.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');

const CHAR = 7;
const PAD = 16; // .nav-bar padding, each side (read back from the CSS below)
let barWidth = 1280;
let observers = [];
const realRect = Element.prototype.getBoundingClientRect;
const RealRO = globalThis.ResizeObserver;

/** A ResizeObserver the test drives: "resizing the window" calls it, as Chromium does. */
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; observers.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom skips @media rules. nav-bar.css has one that matters here: below
// 1024 px the Web Remote / VR / Settings labels are not shown at all. The
// bar spans the window, so the model applies that block exactly when the
// bar is at least 1024 px wide.
const CSS = fs.readFileSync('renderer/styles/nav-bar.css', 'utf8');
const MEDIA = '@media (min-width: 1024px) {';
function cssAt(w) {
  const at = CSS.indexOf(MEDIA);
  if (at < 0 || CSS.indexOf(MEDIA, at + 1) >= 0) throw new Error('expected one 1024px media block in nav-bar.css');
  let depth = 0;
  let end = -1;
  for (let i = at + MEDIA.length - 1; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) { end = i; break; }
  }
  return CSS.slice(0, at) + (w >= 1024 ? CSS.slice(at + MEDIA.length, end) : '') + CSS.slice(end + 1);
}
let style;
function resizeTo(w) {
  barWidth = w;
  const css = cssAt(w);
  if (style.textContent !== css) style.textContent = css; // re-parse only across 1024 px
  for (const o of observers) o.cb([]);
}

const px = (v) => parseFloat(v) || 0;

// jsdom's getComputedStyle runs the whole cascade on every call, so the
// model caches it per element for as long as the bar's fit step and the
// stylesheet are unchanged (nothing else here changes a value the model
// reads; `nav-bar--measuring` only stops shrinking, which it does not model).
const styleCache = new WeakMap();
function computed(node) {
  const steps = (node.closest('.nav-bar')?.className || '').split(' ').filter((c) => c.startsWith('nav-bar--fit-')).sort();
  const key = `${steps.join(' ')}|${style?.textContent.length}`;
  const hit = styleCache.get(node);
  if (hit && hit.key === key) return hit.s;
  const s = getComputedStyle(node);
  const snap = { display: s.display, position: s.position, gap: s.gap, minWidth: s.minWidth,
    paddingLeft: s.paddingLeft, paddingRight: s.paddingRight, width: s.width };
  styleCache.set(node, { key, s: snap });
  return snap;
}
const inFlow = (node) => {
  const s = computed(node);
  return s.display !== 'none' && s.position !== 'absolute';
};

/** Width of one part inside a button: an icon, the LED, or a label's text. */
function partWidth(node) {
  if (node.tagName.toLowerCase() === 'svg') return Number(node.getAttribute('width')) || 16;
  if (node.classList.contains('nav-bar__icon')) return 16;
  if (node.classList.contains('nav-bar__handy-led')) return 8;
  return node.textContent.length * CHAR;
}

function buttonWidth(btn) {
  const s = computed(btn);
  const parts = [...btn.children].filter(inFlow);
  const gap = px(s.gap); // jsdom leaves columnGap 'normal' for the `gap` shorthand
  const inner = parts.reduce((sum, p) => sum + partWidth(p), 0) + gap * Math.max(0, parts.length - 1);
  return Math.max(px(s.minWidth), px(s.paddingLeft) + inner + px(s.paddingRight));
}

/** Natural (unshrunk) width of the bar's content, from the real CSS. */
function contentWidth(nav) {
  const kids = [...nav.children].filter((c) => !c.hidden);
  let total = 2 * Math.max(0, kids.length - 1); // .nav-bar gap: 2px
  for (const c of kids) {
    if (c.classList.contains('nav-bar__cluster-gap')) total += px(computed(c).width);
    else if (c.classList.contains('nav-bar__group')) {
      // The connections group (2026-11-25): its shown buttons, a 1 px border
      // each side and a 1 px hairline between buttons.
      const shown = [...c.children].filter((b) => !b.hidden);
      total += 2 + Math.max(0, shown.length - 1) + shown.reduce((sum, b) => sum + buttonWidth(b), 0);
    }
    else if (c.classList.contains('nav-bar__library-wrapper')) {
      total += buttonWidth(c.querySelector('.nav-bar__item')) + 36 - 2; // arrow 36, margin-left -2
    } else total += buttonWidth(c);
  }
  return total;
}

function installLayout() {
  Element.prototype.getBoundingClientRect = function () {
    const nav = this.closest?.('.nav-bar');
    if (!nav || !nav.isConnected) return realRect.call(this);
    if (this === nav) return { left: 0, right: barWidth, width: barWidth, top: 0, bottom: 48, height: 48 };
    if (this.classList.contains('nav-bar__settings')) {
      // The auto margin on the right side takes any free space, so Settings
      // ends at the content edge unless the content is wider.
      const right = PAD + Math.max(contentWidth(nav), barWidth - 2 * PAD);
      return { left: right - 36, right, width: 36, top: 6, bottom: 42, height: 36 };
    }
    return realRect.call(this);
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  globalThis.ResizeObserver = FakeResizeObserver;
  installLayout();
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = realRect;
  globalThis.ResizeObserver = RealRO;
  _setBundlesForTests('en', EN, EN);
});

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  style = document.createElement('style');
  style.textContent = cssAt(1280);
  document.head.appendChild(style);
  _setBundlesForTests('en', EN, EN);
  observers = [];
  barWidth = 1280;
});
afterEach(() => { observers = []; });

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const bar = new NavBar({ onNavigate: () => {} });
  bar.init(host);
  return { bar, nav: host.querySelector('.nav-bar') };
}

// The order text comes off in, as the user sees it (nav-bar.js / nav-bar.css).
const STEPS = [
  ['.nav-bar__remote-btn .nav-bar__action-label', '.nav-bar__vr-btn .nav-bar__action-label', '.nav-bar__settings .nav-bar__action-label'],
  ['.nav-bar__eroscripts .nav-bar__action-label'],
  ['[data-view-id="playlists"] .nav-bar__label', '[data-view-id="categories"] .nav-bar__label'],
  ['[data-view-id="library"] .nav-bar__label'],
];
const visible = (nav, sel) => inFlow(nav.querySelector(sel));
const fits = (nav) => contentWidth(nav) <= barWidth - 2 * PAD + 0.5;
const fitLevel = (nav) => [1, 2, 3, 4, 5].filter((n) => nav.classList.contains(`nav-bar--fit-${n}`)).length;

/** The narrowest width (below 1024 px) where the bar shows every label it can. */
function narrowestFull(nav) {
  let lo = 400; // needs a step
  let hi = 1000; // shows everything
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    resizeTo(mid);
    if (fitLevel(nav) === 0) hi = mid; else lo = mid;
  }
  return hi;
}

/** Every button still has a name a screen reader can read. */
function names(nav) {
  return [...nav.querySelectorAll(':scope > button, .nav-bar__library-wrapper > button, .nav-bar__group > button')]
    .filter((b) => !b.hidden)
    .map((b) => (b.getAttribute('aria-label') || b.textContent).trim());
}

// Every test here measures through jsdom's getComputedStyle, which runs the
// whole cascade on each call: alone, "refits after a language switch" takes
// ~1.1 s and "hiding buttons" ~1.1 s against the default 5 s timeout, so a
// loaded full run (4 workers) can time them out. That fits the one failure
// seen (FLAKY-TESTS.md row 7: "failed once in a full run, 3 of 3 alone";
// its error was not recorded). One generous timeout for the whole file, as
// the 1400-to-440 sweep already had (2026-11-23).
describe('CB-20: the nav bar fits its width in every language, without overlap', { timeout: 30000 }, () => {
  it('reads the bar padding the model assumes from the real stylesheet', () => {
    const { nav } = mount();
    expect(px(getComputedStyle(nav).paddingRight)).toBe(PAD);
    expect(px(getComputedStyle(nav).paddingLeft)).toBe(PAD);
  });

  it('German at 1024 CSS px (125% on 1280): it fits, and "Keine Geräte" stays readable', async () => {
    _setBundlesForTests('de', DE, EN);
    const { nav } = mount();
    resizeTo(1024);
    expect(fits(nav)).toBe(true);
    expect(fitLevel(nav)).toBeGreaterThan(0);
    expect(visible(nav, '.nav-bar__handy-text')).toBe(true);
    expect(nav.querySelector('.nav-bar__handy-text').textContent).toBe('Keine Geräte');
    expect(visible(nav, '.nav-bar__remote-btn .nav-bar__action-label')).toBe(false);
    // The Web Remote button is still "Web-Fernsteuerung" to a screen reader.
    expect(nav.querySelector('.nav-bar__remote-btn').getAttribute('aria-label')).toBe('Web-Fernsteuerung');
  });

  it('from 1400 down to 440 px it always fits, takes text off in order and no more than needed', () => {
    for (const lang of ['en', 'de']) {
      _setBundlesForTests(lang, lang === 'de' ? DE : EN, EN);
      document.body.innerHTML = '';
      observers = [];
      const { nav } = mount();
      const allNames = names(nav);
      let last = 0;
      let shownBefore = Infinity;
      // The CSS widths of the real cases: 1280/1100/1024/900/800 px windows
      // at 100%, 1024/880/819/720/640 at 125%, 853/733/683/600/533 at 150%.
      for (const w of [1400, 1280, 1100, 1024, 1000, 880, 853, 819, 760, 720, 683, 640, 600, 533, 480, 440]) {
        resizeTo(w);
        const level = fitLevel(nav);
        const where = `${lang} at ${w}px, step ${level}`;
        expect(fits(nav) || level === 5, where).toBe(true);
        // Narrower never gives text back. (The step number can drop at
        // 1024 px, where the media query hides the step-1 labels anyway.)
        const shown = STEPS.flat().filter((sel) => visible(nav, sel)).length;
        expect(shown, where).toBeLessThanOrEqual(shownBefore);
        shownBefore = shown;
        last = level;
        // Cumulative, in the documented order (below 1024 px the step-1
        // labels are off anyway, by the media query).
        STEPS.forEach((sels, i) => {
          for (const sel of sels) {
            // Step 1 is labels the media query hides below 1024 px anyway.
            expect(visible(nav, sel), `${where}: ${sel}`).toBe(i + 1 > level && !(i === 0 && w < 1024));
          }
        });
        // No further than needed: one step fewer would not fit.
        if (level > 0) {
          nav.classList.remove(`nav-bar--fit-${level}`);
          expect(fits(nav), `${where} without its last step`).toBe(false);
          nav.classList.add(`nav-bar--fit-${level}`);
        }
        expect(names(nav), where).toEqual(allNames);
      }
      expect(last, lang).toBeGreaterThanOrEqual(4);
    }
  }, 30000); // jsdom runs the whole cascade on every getComputedStyle

  it('gives the labels back when the window widens again', () => {
    const { nav } = mount();
    resizeTo(600);
    expect(fitLevel(nav)).toBeGreaterThanOrEqual(3); // several steps (the bar is narrower since 2026-11-25)
    resizeTo(1400);
    expect(fitLevel(nav)).toBe(0);
    for (const sels of STEPS) for (const sel of sels) expect(visible(nav, sel), sel).toBe(true);
  });

  it('refits after a language switch and after a longer device status', async () => {
    const { bar, nav } = mount();
    // The narrowest width where English shows everything (found, not fixed:
    // the bar's width changes with its buttons). German is longer: a step.
    const w = narrowestFull(nav);
    resizeTo(w);
    expect(fitLevel(nav)).toBe(0);
    _setBundlesForTests('de', DE, EN);
    eventBus.emit('language:changed');
    await settle();
    expect(fits(nav)).toBe(true);
    expect(fitLevel(nav)).toBeGreaterThan(0);

    // Back to English there, then a longer status.
    _setBundlesForTests('en', EN, EN);
    eventBus.emit('language:changed');
    await settle();
    expect(fitLevel(nav)).toBe(0);
    // "The Handy not responding" is longer than "No devices", and Stop all shows with it.
    bar.setDeviceStatus({ devices: [{ label: 'The Handy', state: 'unresponsive' }] });
    await settle();
    expect(fits(nav)).toBe(true);
    expect(fitLevel(nav)).toBeGreaterThan(0);
    bar.setDeviceStatus({});
    await settle();
    expect(fitLevel(nav)).toBe(0);
  });

  it('hiding buttons (#381) frees room, and the labels come back', async () => {
    const { bar, nav } = mount();
    resizeTo(narrowestFull(nav) - 60);
    const before = fitLevel(nav);
    expect(before).toBeGreaterThan(0);
    bar.setHiddenItems({ eroscripts: true, remote: true, vr: true, playlists: true });
    await settle();
    expect(fits(nav)).toBe(true);
    expect(fitLevel(nav)).toBeLessThan(before);
  });

  it('a bar that is not laid out is left exactly as built', () => {
    Element.prototype.getBoundingClientRect = realRect; // jsdom: everything is 0x0
    try {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const bar = new NavBar({ onNavigate: () => {} });
      bar.init(host);
      const nav = host.querySelector('.nav-bar');
      for (const o of observers) o.cb([]);
      expect(nav.className).toBe('nav-bar');
    } finally {
      installLayout();
    }
  });

  it('nothing inside a right-side button can paint over its neighbour', () => {
    const { nav } = mount();
    for (const btn of nav.querySelectorAll('.nav-bar__action')) {
      expect(getComputedStyle(btn).overflow, btn.className).toBe('hidden');
    }
  });
});
