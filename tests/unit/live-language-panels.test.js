/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL EroScripts panel, queue panel, Up Next card,
 * Audience tab and session card render DOM, and i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// After a live language switch, every panel must read exactly as it would
// had the app booted in that language (app test V50, the part c13 left).
//
// These were drawn with t() when built or shown and never again: the
// EroScripts panel had no language:changed handler at all, the queue panel
// and the Up Next card set their region aria-labels once in the constructor,
// the Devices panel's Audience tab re-rendered only on room events, and the
// session card only on a session change (a paused session sends none). All
// of it stayed in the previous language until a restart.
//
// The check is generic, like nav-bar-retranslate.test.js: every text node,
// title, aria-label and placeholder after an en -> de switch must equal the
// same surface built in German and driven into the same state. A string a
// future change forgets to re-translate fails it without a new assertion.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { eventBus } from '../../renderer/js/event-bus.js';
import { EroScriptsPanel } from '../../renderer/components/eroscripts-panel.js';
import { QueuePanel } from '../../renderer/components/queue-panel.js';
import { UpNextCard } from '../../renderer/components/up-next-card.js';
import { AudiencePanel } from '../../renderer/components/audience-panel.js';
import { SessionCard } from '../../renderer/components/session-card.js';

const bundle = (l) => JSON.parse(fs.readFileSync(`renderer/locales/${l}.json`, 'utf8'));
const EN = bundle('en');
const DE = bundle('de');

afterAll(() => _setBundlesForTests('en', EN, EN));

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
});

const boot = (locale) => _setBundlesForTests(locale, locale === 'de' ? DE : EN, EN);
function switchTo(locale) {
  boot(locale);
  eventBus.emit('language:changed', { locale });
}

/** Everything a user or a screen reader gets from a surface. */
function rendered(el) {
  const out = [];
  [el, ...el.querySelectorAll('*')].forEach((n, i) => {
    const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('');
    out.push(`${i} ${n.tagName} ${n.className} text=${own} title=${n.getAttribute('title') ?? ''}`
      + ` aria=${n.getAttribute('aria-label') ?? ''} ph=${n.getAttribute('placeholder') ?? ''}`);
  });
  return out;
}

/**
 * Build `make()` in German and in English; drive both with `drive`; switch the
 * English one to German; it must read exactly like the German one.
 */
async function expectLiveSwitchMatchesBoot(make, drive = async () => {}) {
  boot('de');
  const refHost = document.createElement('div');
  document.body.appendChild(refHost);
  const ref = await make(refHost);
  await drive(ref);
  const reference = rendered(ref.el());
  refHost.remove();
  document.querySelectorAll('#app > *').forEach((n) => n.remove());

  boot('en');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const live = await make(host);
  await drive(live);
  // Sanity: really built in English, so a pass below is not a no-op.
  expect(rendered(live.el())).not.toEqual(reference);

  switchTo('de');
  expect(rendered(live.el())).toEqual(reference);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EroScripts panel follows a live language switch (V50)', () => {
  const TOPICS = [
    { id: 1, title: 'Alpha Scene', url: 'https://x/t/1', creator: 'scripter', likeCount: 12, views: 340, tags: ['pov'], thumbnail: 'https://x/1.jpg' },
    { id: 2, title: 'Bravo', url: 'https://x/t/2', creator: 'other', likeCount: 1, views: 0, tags: [], thumbnail: 'https://x/2.jpg' },
  ];

  function makePanel() {
    window.funsync = {
      eroscriptsSearch: async (q) => ({ results: q === 'nothing' ? [] : TOPICS }),
      eroscriptsTopic: async () => ({ attachments: [{ name: 'alpha.funscript', url: 'https://x/a' }] }),
      eroscriptsDownload: async () => ({ success: true }),
      eroscriptsTopicImage: async () => null,
      eroscriptsLogout: async () => {},
      openExternal: () => {},
    };
    const values = new Map([['library.sources', [{ path: 'C:/lib', enabled: true }]]]);
    const settings = { get: (k) => values.get(k), set: (k, v) => values.set(k, v) };
    const panel = new EroScriptsPanel({ settings });
    return { panel, el: () => panel._panel };
  }
  const search = async ({ panel }, query) => {
    panel._panel.querySelector('#es-search-input').value = query;
    await panel._search();
  };

  it('logged out, before any search', async () => {
    await expectLiveSwitchMatchesBoot(makePanel);
  });

  it('logged in, with results, one script already saved', async () => {
    await expectLiveSwitchMatchesBoot(makePanel, async (p) => {
      p.panel._setLoggedIn('dave');
      await search(p, 'alpha');
      // Get Script on the first card, through the real download path.
      const getScript = p.panel._panel.querySelector('.eroscripts-panel__result .eroscripts-panel__btn');
      getScript.click();
      await flush();
      await flush();
      expect(getScript.textContent).toBe(t('eroscripts.scriptSaved'));
    });
  });

  it('a search with no results', async () => {
    await expectLiveSwitchMatchesBoot(makePanel, async (p) => {
      p.panel._setLoggedIn('dave');
      await search(p, 'nothing');
    });
  });

  it('a search while logged out: "log in to search" with its button (2026-11-18)', async () => {
    await expectLiveSwitchMatchesBoot(makePanel, (p) => search(p, 'alpha'));
  });

  it('while the login window is open', async () => {
    await expectLiveSwitchMatchesBoot(makePanel, async (p) => {
      window.funsync.eroscriptsLoginWindow = () => new Promise(() => {}); // never closes
      p.panel._panel.querySelector('#es-auth-btn').click();
      await flush();
      expect(p.panel._panel.querySelector('#es-auth-btn').textContent).toBe(t('eroscripts.waitingLogin'));
    });
  });
});

describe('queue panel, Up Next, Audience tab, session card (V50)', () => {
  it('queue panel: its region label and every row', async () => {
    await expectLiveSwitchMatchesBoot((host) => {
      const element = document.createElement('div');
      host.appendChild(element);
      const panel = new QueuePanel({ element, library: null, settings: { get: () => undefined } });
      panel.setState({
        history: ['C:/v/a.mp4'], nowPlaying: 'C:/v/b.mp4', userQueue: ['C:/v/c.mp4'],
        upcoming: ['C:/v/d.mp4'], hasContext: true,
      });
      panel.open();
      return { el: () => element };
    });
  });

  const makeCard = (host) => {
    const element = document.createElement('div');
    element.hidden = true;
    host.appendChild(element);
    const card = new UpNextCard({
      element, library: { getVideoByPath: () => ({ name: 'Next one', duration: 95, hasFunscript: true }) },
    });
    return { card, el: () => element };
  };

  it('Up Next: the region label and a countdown card on screen', async () => {
    await expectLiveSwitchMatchesBoot(makeCard, ({ card }) => card.show('C:/v/next.mp4', 7));
  });

  it('Up Next: the end-of-list card', async () => {
    await expectLiveSwitchMatchesBoot(makeCard, ({ card }) => card.showEndOfList('My Playlist', { kind: 'playlist' }));
  });

  it('Up Next: hidden, only the region label', async () => {
    await expectLiveSwitchMatchesBoot(makeCard);
  });

  it('Audience tab, no room open', async () => {
    await expectLiveSwitchMatchesBoot((host) => {
      const mount = document.createElement('div');
      host.appendChild(mount);
      const panel = new AudiencePanel({
        element: mount, bridge: { aggregateStatus: 'idle', roomActive: false, viewers: [] },
      });
      return { el: () => panel._root };
    });
  });

  it('session card, a paused web-remote session', async () => {
    await expectLiveSwitchMatchesBoot((host) => {
      const tracker = new EventTarget();
      tracker.getSession = () => ({
        state: 'paused', source: 'web-remote', identifier: '192.168.1.5', videoName: 'clip.mp4',
        currentTime: 30, duration: 120, actionCount: 412, devices: { handy: true },
      });
      const card = new SessionCard({ tracker });
      card.mount(host);
      return { el: () => card._el };
    });
  });
});
