/**
 * @vitest-environment jsdom
 *
 * The EroScripts tab (2026-11-22; notes/features/SCOPE-eroscripts-tab.md).
 * Dave's design: results as greyed library-style cards; Download opens a
 * window with the links; progress on the card; ticks once the script and
 * video are here; Free / Paid shown and filterable; the replies' links,
 * newest first, each marked as working or dead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn(), showUndoToast: vi.fn() }));
const { showToast, showUndoToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { EroScriptsView, formatBytes, stemForPost, errorText, hostLabel, pickBestLink, linkNameMatches, sameVideoTitle, relativeTime, compactNumber } = await import('../../renderer/components/eroscripts-view.js');
const { EroScriptsPanel } = await import('../../renderer/components/eroscripts-panel.js');
const price = await import('../../renderer/js/eroscripts-price.js');

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const TAB = EN.eroscripts.tab;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

const TOPIC = { id: 341682, title: 'Pmv mix // vol. 12', url: 'https://discuss.eroscripts.com/t/341682', creator: 'handyenjoyer', categoryId: 14 };
const PIX = 'https://pixeldrain.com/u/kbhA6apA';
const PH = 'https://www.pornhub.com/view_video.php?viewkey=x';
const MEGA = 'https://mega.nz/file/abcdefgh#k';
let answer;
// A post's tags as main's eroscriptsTopic really gives them: parseTopicMeta
// makes each one {id?, name} (pinned by eroscripts-topic-tags-shape.test.js).
// This fake used plain names, so the post window's "[object Object]" tags
// passed here for a day (Dave, 2026-11-26).
const ANSWER_TAGS = [{ id: 11, name: 'pmv' }, { id: 12, name: 'the-handy' }, { name: 'non-vr' }];
/** Names as main's answer gives them: {id, name}. */
const mainTags = (names) => names.map((name, i) => ({ id: 100 + i, name }));
/** A recorded tag list holding these names (a record keeps {id, name}). */
const recordedTags = (names) => expect.arrayContaining(names.map((name) => expect.objectContaining({ name })));
let classified;
let checks;
// The script preview main answers (review 2.2): a short, calm script by default.
let preview;

let store;
let calls;
let reservedStem = null;
let jobs;
function settings() {
  return { get: (k) => store.get(k), set: vi.fn((k, v) => store.set(k, v)) };
}

beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"><div id="eroscripts-container" hidden></div></div>';
  store = new Map([['library.sources', [{ id: 's1', name: 'Lib', path: 'C:\\Lib', enabled: true }]]]);
  calls = [];
  jobs = [];
  preview = { ok: true, actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 50 }], metaDuration: null, channels: [] };
  reservedStem = null;
  // The post checks remember answers in storage (eroscripts-probe.js): every test starts fresh.
  try { localStorage.clear(); } catch { /* none */ }
  showToast.mockClear();
  answer = {
    title: 'Pmv mix // vol. 12', url: TOPIC.url, creator: 'handyenjoyer', categoryId: 14, topicId: TOPIC.id, tags: ANSWER_TAGS,
    attachments: [{ name: 'PMVMIX12.funscript', url: 'https://discuss.eroscripts.com/uploads/a.funscript' }, { name: 'pack.zip', url: 'https://x/z.zip' }],
    links: [{ url: PIX, text: 'PMVMIX12.mp4 ~ pixeldrain' }, { url: PH, text: 'PornHub' }],
    replyLinks: [],
  };
  classified = {
    [PIX]: { kind: 'filehost', host: 'pixeldrain', supported: true },
    [PH]: { kind: 'tube', host: 'pornhub', supported: true },
    [MEGA]: { kind: 'filehost', host: 'mega', supported: true },
    'https://payhip.com/b/fHucK': { kind: 'store', host: 'payhip.com', supported: false, reason: 'paid' },
  };
  checks = { [PIX]: { status: 'ok', size: 3282000000, name: 'PMVMIX12.mp4' }, [PH]: { status: 'unknown' }, [MEGA]: { status: 'ok', size: 81000000 } };
  window.funsync = {
    eroscriptsTopic: vi.fn(async () => answer),
    eroscriptsDownload: vi.fn(async () => ({ success: true })),
    openExternal: vi.fn(),
    selectDirectory: vi.fn(async () => 'C:\\Picked'),
    showInFolder: vi.fn(),
    fileExists: vi.fn(async () => true),
    eroscriptsRestoreSession: vi.fn(async () => {}),
    eroscriptsValidate: vi.fn(async () => ({ valid: false })),
    eroscriptsTopicImage: vi.fn(async () => null),
    eroscriptsScriptPreview: vi.fn(async () => preview),
    eroscriptsImage: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,AAAA' })),
    fetchMetadata: vi.fn(async () => null),
    readFunscript: vi.fn(async () => null),
  };
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const path = String(url).replace(/^http:\/\/127\.0\.0\.1:\d+\/api\/downloads/, '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method: opts.method || 'GET', body });
    if (path === '/classify') return { ok: true, status: 200, json: async () => ({ links: body.links.map((u) => ({ url: u, ...(classified[u] || { kind: 'unsupported', host: '', supported: false }) })) }) };
    if (path === '/check') return { ok: true, status: 200, json: async () => ({ links: body.links.map((u) => ({ url: u, size: 0, name: '', ...(checks[u] || { status: 'unknown' }) })) }) };
    if (path === '' && opts.method === 'POST') {
      const job = { id: 'j1', status: 'queued', stem: reservedStem || body.stem, host: 'pixeldrain', bytes: 0, total: 0, url: body.url, path: '' };
      jobs = [job];
      return { ok: true, status: 200, json: async () => ({ job }) };
    }
    if (path === '') return { ok: true, status: 200, json: async () => ({ jobs }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
});
afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());
  delete window.funsync;
  delete globalThis.fetch;
});

function makeView() {
  const panel = { dock: vi.fn(), undock: vi.fn(), show: vi.fn(), search: vi.fn(), handleSessionExpired: vi.fn() };
  const onSaved = vi.fn();
  const playPath = vi.fn(() => true);
  const view = new EroScriptsView({
    container: document.getElementById('eroscripts-container'),
    panel, settings: settings(), getBackendPort: () => 5123,
    isLibraryFolder: (dir) => dir === 'C:\\Lib', onSavedIntoLibrary: onSaved, playPath,
  });
  view.show();
  return { view, panel, onSaved, playPath };
}
const cards = () => [...document.querySelectorAll('.es-card')];
const part = (card, kind) => card.querySelector(`.es-part--${kind}`).dataset.state;
const dlBox = () => document.querySelector('.es-dl');
const mainBtn = () => document.querySelector('.es-dl__main');
const rowValue = (i) => document.querySelectorAll('.es-dl__value')[i];
async function openWindow(view, topic = TOPIC) {
  view.openPost(topic);
  await vi.waitFor(() => expect(dlBox()?.querySelector('.es-dl__rows')).toBeTruthy());
  await vi.waitFor(() => expect(calls.some((c) => c.path === '/check')).toBe(true));
  await vi.waitFor(() => expect(document.querySelector('.es-dot--checking')).toBeNull());
}

describe('helpers', () => {
  it('sizes, file stems, error words and host names', () => {
    expect(formatBytes(3282000000)).toBe('3.3 GB');
    expect(formatBytes(136000000)).toBe('136 MB');
    expect(stemForPost('Pmv mix // vol. 12')).toBe('Pmv mix vol. 12');
    expect(stemForPost('')).toBe('video');
    expect(errorText('notFound')).toBe(TAB.err.notFound);
    expect(errorText('somethingNew')).toBe(TAB.err.failed);
    expect(hostLabel('pmvhaven')).toBe('PMVHaven');
    expect(hostLabel('xvideos')).toBe('xvideos');
  });

  it('the offered link: a working one first, never a dead one, a tube site only when on', () => {
    const post = { url: 'a', kind: 'filehost', supported: true, check: { status: 'dead' } };
    const reply = { url: 'b', kind: 'filehost', supported: true, from: 'reply', check: { status: 'ok' } };
    const unchecked = { url: 'c', kind: 'filehost', supported: true, check: { status: 'unknown' } };
    const tube = { url: 'd', kind: 'tube', supported: true, check: { status: 'unknown' } };
    expect(pickBestLink([post, unchecked, reply])).toBe(reply);          // a working reply link beats an unchecked one
    expect(pickBestLink([post, unchecked])).toBe(unchecked);
    expect(pickBestLink([post, tube])).toBe(null);                       // tube sites off
    expect(pickBestLink([post, tube], { tube: true })).toBe(tube);
    expect(pickBestLink([{ url: 'e', kind: 'store', supported: false }])).toBe(null);

    // A post that also links other videos (a PMV mix crediting its sources, seen live):
    // the link named like the post or its script wins over one named otherwise.
    const credit = { url: 'f', kind: 'videohost', supported: true, check: { status: 'ok', name: 'COOK' } };
    const faptap = { url: 'g', kind: 'videohost', supported: true, check: { status: 'ok', name: 'PMV MIX // VOL. 12' } };
    const pix = { url: 'h', kind: 'filehost', supported: true, check: { status: 'ok', name: 'PMVMIX12.mp4' } };
    const ctx = { title: 'Pmv mix // vol. 12', scriptName: 'PMVMIX12.funscript' };
    expect(pickBestLink([credit, faptap], ctx)).toBe(faptap);
    expect(pickBestLink([credit, faptap, pix], ctx)).toBe(pix);           // the original file over the site's copy
    expect(linkNameMatches(credit, ctx)).toBe(false);
    expect(linkNameMatches({ check: {} }, ctx)).toBe(null);
  });
});

describe('free or paid', () => {
  it('categories 14 and 15; the filter narrows the forum search; other categories are kept', () => {
    expect(price.priceOf(14)).toBe('free');
    expect(price.priceOf('15')).toBe('paid');
    expect(price.priceOf(21)).toBe(null);
    expect(price.queryForPrice('pmv mix', 'free')).toBe('pmv mix #free-scripts');
    expect(price.queryForPrice('pmv mix', 'paid')).toBe('pmv mix #paid-scripts');
    expect(price.queryForPrice('pmv mix', 'nonsense')).toBe('pmv mix');
    expect(price.matchesPrice({ categoryId: 15 }, 'free')).toBe(false);
    expect(price.matchesPrice({ categoryId: null }, 'free')).toBe(true);
  });
});

describe('result cards', () => {
  it('greyed cards with a Free / Paid chip and Download; the filter leaves the other kind out', () => {
    const { view, panel } = makeView();
    const results = [{ ...TOPIC }, { id: 2, title: 'Paid one', categoryId: 15 }, { id: 3, title: 'Other', categoryId: 21 }];
    panel.onResults(results);
    expect(cards()).toHaveLength(3);
    expect(cards().every((c) => !c.classList.contains('es-card--have'))).toBe(true);
    expect(cards()[0].querySelector('.es-card__price').textContent).toBe(TAB.price.free);
    expect(cards()[1].querySelector('.es-card__price').textContent).toBe(TAB.price.paid);
    expect(cards()[2].querySelector('.es-card__price')).toBeNull();
    expect(cards()[0].querySelector('.es-card__btn').textContent).toBe(TAB.card.download);

    // Free only: saved, searched again, and the forum is asked for free scripts.
    // The filter goes beside the search box (the real panel's dock puts it there).
    expect(panel.dock).toHaveBeenCalledWith(expect.anything(), { searchExtras: view._filterEl });
    const free = view._filterEl.querySelector('[data-value=free]');
    free.click();
    expect(store.get('eroscripts.priceFilter')).toBe('free');
    expect(panel.search).toHaveBeenCalledTimes(1);
    expect(panel.queryDecorator('pmv mix')).toBe('pmv mix #free-scripts');
    expect(free.getAttribute('aria-checked')).toBe('true');
    view._renderCards(results);
    expect(cards().map((c) => c.dataset.topicId)).toEqual(['341682', '3']);
  });

  it('nothing left after the filter says so', () => {
    const { view } = makeView();
    store.set('eroscripts.priceFilter', 'free');
    view._renderCards([{ id: 2, title: 'Paid one', categoryId: 15 }]);
    expect(document.querySelector('.es-view__empty').textContent).toBe(TAB.filter.none.free);
  });
});

describe('the download window', () => {
  it('says what it will fetch: the script, the working link and its size, the folder; one button', async () => {
    const { view } = makeView();
    await openWindow(view);
    expect(rowValue(0).querySelector('.es-card__have').textContent).toBe('PMVMIX12.funscript'); // the zip is not a script
    expect(rowValue(1).textContent).toBe(`${fill(TAB.dl.from, { host: 'Pixeldrain' })} · 3.3 GB`);
    expect(rowValue(1).querySelector('.es-dot--ok')).toBeTruthy();
    expect(document.querySelector('.es-view__folder-select').value).toBe('C:\\Lib');
    expect(mainBtn().textContent).toBe(TAB.dl.both);
    expect(mainBtn().disabled).toBe(false);
    // More options: every link, each marked; the tube site off with its hint.
    const rows = [...document.querySelectorAll('.es-dl__more .es-view__link')];
    expect(rows[0].querySelector('.es-view__why').textContent).toBe(TAB.check.ok);
    expect(rows[1].textContent).toContain(TAB.tubeOffHint);
    expect(rows[1].querySelector('button').textContent).toBe(TAB.openInBrowser);
    expect(window.funsync.eroscriptsTopic).toHaveBeenCalledWith(TOPIC.id, { replies: true });
  });

  it('a dead link in the post: the replacement in a reply is offered, with who posted it and when (Dave, 2026-11-22)', async () => {
    checks[PIX] = { status: 'dead' };
    answer.replyLinks = [{ url: MEGA, text: 'new link', postNumber: 7, username: 'helper', createdAt: '2026-05-03T10:00:00Z' }];
    const { view } = makeView();
    await openWindow(view);
    expect(rowValue(1).textContent).toContain(fill(TAB.dl.from, { host: 'Mega' }));
    expect(rowValue(1).querySelector('.es-dl__sub').textContent).toContain('helper');
    const more = document.querySelector('.es-dl__more');
    expect(more.textContent).toContain(TAB.dl.replyLinks);
    const rows = [...more.querySelectorAll('.es-view__link')];
    expect(rows[0].querySelector('.es-dot--dead')).toBeTruthy();
    expect(rows[0].querySelector('.es-view__why').textContent).toBe(TAB.check.dead);
    expect(rows.at(-1).querySelector('.es-view__why').textContent).toContain('#7');
  });

  it('every link dead: says so, and offers the script alone', async () => {
    checks[PIX] = { status: 'dead' };
    const { view } = makeView();
    await openWindow(view);
    expect(rowValue(1).textContent).toBe(TAB.dl.allDead);
    expect(mainBtn().textContent).toBe(TAB.dl.scriptOnly);
    mainBtn().click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsDownload).toHaveBeenCalledTimes(2));
    expect(window.funsync.eroscriptsDownload).toHaveBeenLastCalledWith(answer.attachments[0].url, 'C:\\Lib\\Pmv mix vol. 12.funscript', { replace: false });
    expect(store.get('eroscripts.downloaded')[TOPIC.id].script).toBe('C:\\Lib\\Pmv mix vol. 12.funscript');
  });

  it('a paid script: where to buy it', async () => {
    answer.attachments = [];
    answer.categoryId = 15;
    answer.links = [{ url: 'https://payhip.com/b/fHucK', text: '' }];
    const { view } = makeView();
    view.openPost({ ...TOPIC, categoryId: 15 });
    await vi.waitFor(() => expect(dlBox()?.querySelector('.es-dl__rows')).toBeTruthy());
    expect(dlBox().querySelector('.es-card__price').textContent).toBe(TAB.price.paid);
    expect(rowValue(0).textContent).toContain(fill(TAB.dl.paid, { host: 'payhip.com' }));
    rowValue(0).querySelector('button').click();
    expect(window.funsync.openExternal).toHaveBeenCalledWith('https://payhip.com/b/fHucK');
    expect(mainBtn()).toBeNull();
  });

  it('a post that fails to load says so', async () => {
    window.funsync.eroscriptsTopic = vi.fn(async () => ({ error: 'x', errorCode: 'topicFailed', attachments: [] }));
    const { view } = makeView();
    view.openPost(TOPIC);
    await vi.waitFor(() => expect(dlBox()?.textContent).toContain(TAB.postFailed));
  });
});

describe('a download, on its card', () => {
  it('the window closes, the card shows the progress; when done the script lands beside the video, the card says so and plays it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { view, panel, onSaved, playPath } = makeView();
      panel.onResults([{ ...TOPIC }]);
      await openWindow(view);
      mainBtn().click();
      await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '')).toBe(true));
      expect(calls.find((c) => c.method === 'POST' && c.path === '').body)
        // hint: which of several videos behind one link is the script's (2026-11-24).
        .toEqual({ url: PIX, destDir: 'C:\\Lib', stem: 'Pmv mix vol. 12', allowTube: false, scriptIsOurs: false, hint: 'PMVMIX12.funscript',
          // Kept with the job, so it still finishes as this post's after FunSync closes (2026-11-25).
          meta: expect.objectContaining({
            v: 1, topicId: TOPIC.id, title: 'Pmv mix // vol. 12', axes: [],
            script: { url: answer.attachments[0].url, name: 'PMVMIX12.funscript' },
            topic: expect.objectContaining({ id: TOPIC.id, title: TOPIC.title }),
            answer: expect.objectContaining({ topicId: TOPIC.id, tags: ANSWER_TAGS }),
          }) });
      await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).toBeNull());
      const card = cards()[0];
      // The script at once, under the name the video will get: ticked on its own.
      await vi.waitFor(() => expect(part(card, 'script')).toBe('done'));
      expect(window.funsync.eroscriptsDownload).toHaveBeenCalledWith(answer.attachments[0].url, 'C:\\Lib\\Pmv mix vol. 12.funscript');
      expect(part(card, 'video')).toBe('busy');

      jobs = [{ ...jobs[0], status: 'downloading', bytes: 1641000000, total: 3282000000, speed: 20000000 }];
      await view._refreshJobs();
      expect(card.querySelector('.es-part--video').textContent).toBe(`${TAB.card.video} 50%`);
      expect(card.classList.contains('es-card--busy')).toBe(true);
      expect(card.querySelector('.es-card__progress').hidden).toBe(false);
      expect(card.querySelector('.es-card__progress-fill').style.width).toBe('50%');
      expect(card.querySelector('.es-card__btn').textContent).toBe(TAB.card.pause);       // Pause keeps what came (round 3)

      jobs = [{ ...jobs[0], status: 'done', bytes: 3282000000, path: 'C:\\Lib\\Pmv mix vol. 12.mp4' }];
      await view._refreshJobs();
      expect(window.funsync.eroscriptsDownload).toHaveBeenCalledTimes(1);          // saved at the start, not again
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(store.get('eroscripts.downloaded')[TOPIC.id]).toMatchObject({ video: 'C:\\Lib\\Pmv mix vol. 12.mp4', script: 'C:\\Lib\\Pmv mix vol. 12.funscript' });
      // The post's tags, on the video (Dave: "it just makes sense to get the tags too").
      expect(store.get('library.scriptTags')['C:\\Lib\\Pmv mix vol. 12.mp4'])
        .toMatchObject({ topicId: TOPIC.id, tags: recordedTags(['pmv', 'the-handy', 'non-vr']), scriptPath: 'C:\\Lib\\Pmv mix vol. 12.funscript' });
      expect(card.classList.contains('es-card--have')).toBe(true);
      expect([part(card, 'video'), part(card, 'script')]).toEqual(['done', 'done']);
      expect(card.querySelector('.es-part--video').getAttribute('aria-label')).toBe(TAB.card.videoState.done);
      expect(card.querySelector('.es-card__status').hidden).toBe(true);
      const btn = card.querySelector('.es-card__btn');
      expect(btn.textContent).toBe(TAB.card.play);
      btn.click();
      expect(playPath).toHaveBeenCalledWith('C:\\Lib\\Pmv mix vol. 12.mp4');
      // Once only.
      await view._refreshJobs();
      expect(window.funsync.eroscriptsDownload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembered: a later search shows the ticks, while the files are still there', async () => {
    store.set('eroscripts.downloaded', { [TOPIC.id]: { video: 'C:\\Lib\\a.mp4', script: 'C:\\Lib\\a.funscript' } });
    window.funsync.fileExists = vi.fn(async (p) => p.endsWith('.funscript'));       // the video was deleted
    const { panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    await vi.waitFor(() => expect(part(cards()[0], 'script')).toBe('done'));
    expect(part(cards()[0], 'video')).toBe('missing');                        // shown apart
    expect(cards()[0].classList.contains('es-card--have')).toBe(false);        // grey: no video
    expect(cards()[0].querySelector('.es-card__btn').textContent).toBe(TAB.card.download);
  });

  it('the script takes the name the backend reserved for the video ("(1)" when taken)', async () => {
    reservedStem = 'Pmv mix vol. 12 (1)';
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    await openWindow(view);
    mainBtn().click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsDownload).toHaveBeenCalledWith(answer.attachments[0].url, 'C:\\Lib\\Pmv mix vol. 12 (1).funscript'));
  });

  it('a second try after a cancelled video joins the script it saved, instead of a "(1)" pair', async () => {
    store.set('eroscripts.downloaded', { [TOPIC.id]: { script: 'C:\\Lib\\Pmv mix vol. 12.funscript', scriptUrl: answer.attachments[0].url } });
    window.funsync.fileExists = vi.fn(async (p) => p.endsWith('.funscript'));
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    await vi.waitFor(() => expect(part(cards()[0], 'script')).toBe('done'));
    await openWindow(view);
    mainBtn().click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.path === '').body).toMatchObject({ stem: 'Pmv mix vol. 12', scriptIsOurs: true });
    expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();        // it is already there
  });

  it('a slow host today goes behind a full-speed link, and the window says why', () => {
    const pix = { url: 'p', host: 'pixeldrain', kind: 'filehost', supported: true, check: { status: 'ok', name: 'PMVMIX12.mp4', slow: true } };
    const fap = { url: 'f', host: 'faptap', kind: 'videohost', supported: true, check: { status: 'ok', name: 'PMV MIX // VOL. 12' } };
    expect(pickBestLink([pix, fap], { title: 'Pmv mix // vol. 12', scriptName: 'PMVMIX12.funscript' })).toBe(fap);
  });

  it('a failed download: the card says why and offers another link', async () => {
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    await openWindow(view);
    mainBtn().click();
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    jobs = [{ ...jobs[0], status: 'error', error: 'notFound' }];
    await view._refreshJobs();
    const card = cards()[0];
    expect(card.querySelector('.es-card__status').textContent).toBe(TAB.err.notFound);
    expect(card.querySelector('.es-card__btn').textContent).toBe(TAB.card.tryAnother);
  });

  it('a refusal from the backend is worded and the window stays', async () => {
    const { view } = makeView();
    await openWindow(view);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ detail: { code: 'badFolder' } }) }));
    const btn = mainBtn();
    btn.click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(TAB.err.badFolder, 'error'));
    expect(btn.disabled).toBe(false);
    expect(dlBox()).toBeTruthy();
  });
});

describe('the search panel docks into the view', () => {
  it('dock: the filter beside the search box, results to the cards, the query decorated; undock: the floating list again', async () => {
    const panel = new EroScriptsPanel({ settings: settings() });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const extra = document.createElement('div');
    extra.className = 'extra';
    panel.onResults = vi.fn();
    panel.queryDecorator = (q) => `${q} #free-scripts`;
    panel.dock(host, { searchExtras: extra });
    expect(host.contains(panel._panel)).toBe(true);
    expect(panel._panel.querySelector('.eroscripts-panel__input-row .extra')).toBe(extra);
    expect(panel._panel.getAttribute('role')).toBeNull();
    const results = [{ id: 1, title: 'A post', url: 'https://discuss.eroscripts.com/t/1', tags: [] }];
    panel._renderResults(results);
    expect(panel.onResults).toHaveBeenCalledWith(results);
    expect(panel._panel.querySelector('.eroscripts-panel__result')).toBeNull();

    panel._loggedIn = true;
    panel.checkSession = vi.fn(async () => {});
    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results }));
    panel._panel.querySelector('#es-search-input').value = 'pmv';
    panel.search();
    await vi.waitFor(() => expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('pmv #free-scripts'));

    panel.undock();
    expect(extra.isConnected).toBe(false);
    expect(panel._panel.getAttribute('role')).toBe('dialog');
    expect(panel._panel.querySelectorAll('.eroscripts-panel__result')).toHaveLength(1);    // drawn as the list again
  });
});

describe('the app opens the tab', () => {
  it('the nav button navigates to the view; the view is hidden and shown with the others; leaving undocks', () => {
    const src = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(src).toMatch(/'eroscripts': document\.getElementById\('eroscripts-container'\)/);
    expect(src).toMatch(/for \(const vid of \['library', 'player', 'playlists', 'categories', 'eroscripts'\]\)/);
    expect(src).toMatch(/if \(this\.eroscriptsView\) \{\n\s+this\._navigateTo\('eroscripts'\);/);
    expect(src).toMatch(/if \(viewId === 'eroscripts'\) this\.eroscriptsView\?\.hide\(\);/);
    expect(src).toMatch(/playPath: \(path\) => \{/);
    expect(fs.readFileSync('renderer/index.html', 'utf8')).toContain('<div id="eroscripts-container" hidden></div>');
  });
});

describe('paste a link (Dave, 2026-11-22: FapTap videos with no forum post)', () => {
  const FAP = 'https://faptap.net/v/2121275335839322113';
  const pasteBox = () => document.querySelector('.es-paste');
  beforeEach(() => {
    classified[FAP] = { kind: 'videohost', host: 'faptap', supported: true };
    checks[FAP] = { status: 'ok', name: 'Riley Reid Blowjob Party Dare', size: 0 };
    classified['https://example.com/page'] = { kind: 'unsupported', host: 'example.com', supported: false };
  });
  const type = (url) => {
    const input = document.querySelector('.es-paste__input');
    input.value = url;
    input.dispatchEvent(new Event('input'));
  };

  it('the link is looked at as it is typed; Download sends it under its own name and opens the Downloads list', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { view } = makeView();
      document.querySelector('.es-view__paste-btn').click();
      await vi.waitFor(() => expect(pasteBox()).toBeTruthy());
      expect(document.querySelector('.es-view__paste-btn').getAttribute('aria-label')).toBe(TAB.paste.button);   // an icon since 2026-11-25; its words its name
      type(FAP);
      await vi.waitFor(() => expect(pasteBox().querySelector('.es-paste__name')).toBeTruthy());
      expect(pasteBox().querySelector('.es-view__badge').textContent).toBe(`${TAB.kind.videohost} · FapTap`);
      expect(pasteBox().textContent).toContain(TAB.check.ok);
      expect(pasteBox().querySelector('.es-paste__name').value).toBe('Riley Reid Blowjob Party Dare');
      mainBtn().click();
      await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '')).toBe(true));
      expect(calls.find((c) => c.method === 'POST' && c.path === '').body)
        .toEqual({ url: FAP, destDir: 'C:\\Lib', stem: 'Riley Reid Blowjob Party Dare', allowTube: false, scriptIsOurs: false,
          meta: { v: 1, topicId: null, title: 'Riley Reid Blowjob Party Dare', topic: null, answer: null, script: null, axes: [] } });
      await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).toBeNull());
      expect(document.querySelector('.es-view__dl-pop').hidden).toBe(false);
      expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();          // no script with a link
      jobs = [{ ...jobs[0], status: 'done', bytes: 10, total: 10, path: 'C:\\Lib\\Riley Reid Blowjob Party Dare.mp4' }];
      await view._refreshJobs();
      expect(showToast.mock.calls.at(-1)[0].textContent).toContain(TAB.saved.replace('{name}', 'Riley Reid Blowjob Party Dare'));
      expect(store.get('eroscripts.downloaded')).toBeUndefined();                // no post, no card to remember
    } finally {
      vi.useRealTimers();
    }
  });

  it('a link that cannot be downloaded says so and offers the browser only', async () => {
    const { view } = makeView();
    view.openPasteLink('https://example.com/page');
    await vi.waitFor(() => expect(pasteBox()?.textContent).toContain(TAB.paste.unsupported));
    expect(mainBtn()).toBeNull();
    expect(pasteBox().querySelector('.es-dl__actions button').textContent).toBe(TAB.openInBrowser);
  });

  it('a tube link waits for the Tube sites switch', async () => {
    const { view } = makeView();
    view.openPasteLink(PH);
    await vi.waitFor(() => expect(mainBtn()).toBeTruthy());
    expect(mainBtn().disabled).toBe(true);
    const box = pasteBox().querySelector('.es-view__tube-box');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(store.get('eroscripts.tubeDownloads')).toBe(true);
    expect(mainBtn().disabled).toBe(false);
  });

  it('a link pasted on the tab opens the window with it; one pasted into the search box does not', async () => {
    makeView();
    const paste = (target, text) => {
      const e = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'clipboardData', { value: { getData: () => text } });
      target.dispatchEvent(e);
    };
    const field = document.createElement('input');
    document.body.appendChild(field);
    paste(field, FAP);
    expect(pasteBox()).toBeNull();
    paste(document.body, 'not a link');
    expect(pasteBox()).toBeNull();
    paste(document.body, FAP);
    await vi.waitFor(() => expect(pasteBox()?.querySelector('.es-paste__input').value).toBe(FAP));
  });
});

describe('paste a link: the default name', () => {
  it('a direct link is named after its file, not "video"', async () => {
    const URL_ = 'https://cdn.example/clips/My%20Clip.mp4';
    classified[URL_] = { kind: 'direct', host: 'cdn.example', supported: true };
    checks[URL_] = { status: 'ok', size: 788000, name: '' };
    const { view } = makeView();
    view.openPasteLink(URL_);
    await vi.waitFor(() => expect(document.querySelector('.es-paste__name')).toBeTruthy());
    expect(document.querySelector('.es-paste__name').value).toBe('My Clip');
  });
});

describe('a link\'s script: FapTap\'s word on it, and Pair a script… (Dave, 2026-11-22)', () => {
  const FT = (n) => `https://faptap.net/v/${n}`;
  const scriptRow = () => [...document.querySelectorAll('.es-paste .es-dl__label')].find((l) => l.textContent === TAB.dl.script)?.nextElementSibling;
  beforeEach(() => {
    for (const n of ['1', '2', '3']) classified[FT(n)] = { kind: 'videohost', host: 'faptap', supported: true };
    checks[FT('1')] = { status: 'ok', name: 'Paid one', script: { exists: true, downloadable: false, shops: ['https://www.patreon.com/Maker/posts/x'] } };
    checks[FT('2')] = { status: 'ok', name: 'Free one', script: { exists: true, downloadable: true, shops: [] } };
    checks[FT('3')] = { status: 'ok', name: 'Locked one', script: { exists: true, downloadable: false, shops: [] } };
  });

  it('a paid script: not included, who sells it, and Buy', async () => {
    const { view } = makeView();
    view.openPasteLink(FT('1'));
    await vi.waitFor(() => expect(scriptRow()).toBeTruthy());
    expect(scriptRow().textContent).toContain(fill(TAB.paste.ftPaid, { host: 'Patreon' }));
    scriptRow().querySelector('button').click();
    expect(window.funsync.openExternal).toHaveBeenCalledWith('https://www.patreon.com/Maker/posts/x');
    expect(document.querySelector('.es-paste').textContent).toContain(TAB.paste.pairHint);
  });

  it('downloadable on FapTap: not included here, open it there; FapTap-only: says it cannot be downloaded', async () => {
    const { view } = makeView();
    view.openPasteLink(FT('2'));
    await vi.waitFor(() => expect(scriptRow()).toBeTruthy());
    expect(scriptRow().textContent).toContain(TAB.paste.ftDownloadable);
    expect(scriptRow().querySelector('button').textContent).toBe(TAB.paste.ftOpen);
    view.openPasteLink(FT('3'));
    await vi.waitFor(() => expect(scriptRow()?.textContent).toContain(TAB.paste.ftNotIncluded));
  });

  it('Pair a script…: the picked file is saved beside the video under its name', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      window.funsync.selectFunscript = vi.fn(async () => ({ name: 'bought.funscript', path: 'C:\\Users\\me\\Downloads\\bought.funscript' }));
      window.funsync.readFunscript = vi.fn(async () => '{"actions":[]}');
      window.funsync.writeFunscript = vi.fn(async (_c, p) => p);
      window.funsync.fileExists = vi.fn(async () => false);
      const { view, onSaved } = makeView();
      view.openPasteLink(FT('1'));
      await vi.waitFor(() => expect(mainBtn()).toBeTruthy());
      mainBtn().click();
      await vi.waitFor(() => expect(jobs).toHaveLength(1));
      jobs = [{ ...jobs[0], status: 'done', bytes: 10, total: 10, path: 'C:\\Lib\\Paid one.mp4' }];
      await view._refreshJobs();
      const pair = [...document.querySelectorAll('.es-view__job button')].find((b) => b.textContent === TAB.pair.button);
      expect(pair).toBeTruthy();
      pair.click();
      await vi.waitFor(() => expect(window.funsync.writeFunscript).toHaveBeenCalledWith('{"actions":[]}', 'C:\\Lib\\Paid one.funscript'));
      expect(showToast.mock.calls.at(-1)[0]).toBe(fill(TAB.pair.done, { name: 'Paid one.funscript' }));
      expect(onSaved).toHaveBeenCalled();
      expect([...document.querySelectorAll('.es-view__job button')].some((b) => b.textContent === TAB.pair.button)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Pair a script… never replaces a script already beside the video without asking', async () => {
    window.funsync.selectFunscript = vi.fn(async () => ({ name: 'b.funscript', path: 'C:\\D\\b.funscript' }));
    window.funsync.readFunscript = vi.fn(async () => '{}');
    window.funsync.writeFunscript = vi.fn(async (_c, p) => p);
    window.funsync.fileExists = vi.fn(async () => true);
    const { view } = makeView();
    view._jobInfo.set('jx', { topicId: null, script: null });
    const answered = view._pairScript({ id: 'jx', path: 'C:\\Lib\\Clip.mp4' }, null);
    await vi.waitFor(() => expect(document.querySelector('.modal-overlay')).toBeTruthy());     // the replace question
    document.querySelector('.modal-overlay .modal-close-btn').click();               // no answer = no
    await answered;
    expect(window.funsync.writeFunscript).not.toHaveBeenCalled();
  });
});

describe('a pasted link made easier (Dave, 2026-11-22)', () => {
  const FT = 'https://faptap.net/v/77';
  beforeEach(() => {
    classified[FT] = { kind: 'videohost', host: 'faptap', supported: true };
    checks[FT] = { status: 'ok', name: 'PMV MIX // VOL. 12', script: { exists: true, downloadable: true, shops: [] } };
  });

  it('the same video on EroScripts is offered (free first), and Use this post opens its download window', async () => {
    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [
      { id: 5, title: 'Something else entirely', categoryId: 14 },
      { id: 4, title: 'PMV MIX // VOL. 01 + bunch of other pmvs', categoryId: 14 },   // seen live: words alone matched
      { id: 6, title: 'PMV MIX // VOL. 12 (paid remaster)', categoryId: 15 },
      { id: TOPIC.id, title: 'Pmv mix // vol. 12', categoryId: 14 },
    ] }));
    const { view, panel } = makeView();
    panel.isLoggedIn = true;
    view.openPasteLink(FT);
    await vi.waitFor(() => expect(document.querySelector('.es-paste__forum-title')).toBeTruthy());
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('PMV MIX VOL. 12');
    expect(document.querySelector('.es-paste__forum-title').textContent).toBe('Pmv mix // vol. 12');
    expect(document.querySelector('.es-paste__forum .es-card__price').textContent).toBe(TAB.price.free);
    [...document.querySelectorAll('.es-paste__forum button')].find((b) => b.textContent === TAB.paste.forumUse).click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsTopic).toHaveBeenCalledWith(TOPIC.id, { replies: true }));
    await vi.waitFor(() => expect(document.querySelector('.es-paste')).toBeNull());
  });

  it('the same video: its words and its numbers', () => {
    expect(sameVideoTitle('Pmv mix // vol. 12', 'PMV MIX VOL. 12')).toBe(true);
    expect(sameVideoTitle('PMV MIX // VOL. 01 + bunch of other pmvs', 'PMV MIX VOL. 12')).toBe(false);
    expect(sameVideoTitle('Riley Reid Blowjob Party Dare', 'Riley Reid Blowjob Party Dare')).toBe(true);
  });

  it('logged out: no forum search', async () => {
    window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [] }));
    const { view, panel } = makeView();
    panel.isLoggedIn = false;
    view.openPasteLink(FT);
    await vi.waitFor(() => expect(mainBtn()).toBeTruthy());
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
    expect(document.querySelector('.es-paste__forum')).toBeNull();
  });

  it('Pair a script… works while the video is still downloading, and the picker starts in Downloads', async () => {
    window.funsync.selectFunscript = vi.fn(async () => ({ name: 'b.funscript', path: 'C:\\Users\\me\\Downloads\\b.funscript' }));
    window.funsync.readFunscript = vi.fn(async () => '{"actions":[]}');
    window.funsync.writeFunscript = vi.fn(async (_c, p) => p);
    window.funsync.fileExists = vi.fn(async () => false);
    const { view } = makeView();
    view.openPasteLink(FT);
    await vi.waitFor(() => expect(mainBtn()).toBeTruthy());
    mainBtn().click();
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    jobs = [{ ...jobs[0], status: 'downloading', bytes: 5, total: 10, destDir: 'C:\\Lib', stem: 'PMV MIX VOL. 12' }];
    await view._refreshJobs();
    const pair = [...document.querySelectorAll('.es-view__job button')].find((b) => b.textContent === TAB.pair.button);
    expect(pair).toBeTruthy();
    pair.click();
    await vi.waitFor(() => expect(window.funsync.writeFunscript).toHaveBeenCalledWith('{"actions":[]}', 'C:\\Lib\\PMV MIX VOL. 12.funscript'));
    expect(window.funsync.selectFunscript).toHaveBeenCalledWith({ startIn: 'downloads' });
  });
});

describe('the newest script threads when nothing is searched (Dave, 2026-11-22)', () => {
  const topic = (id, categoryId) => ({ id, title: `Thread ${id}`, categoryId, creator: 'maker' });

  it('the tab opens on them; Show more adds the next page; All / Free / Paid picks the list', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async (price, page) => ({
      results: page === 0 ? [topic(1, 14), topic(2, 15)] : [topic(3, 14)], more: page === 0,
    }));
    const { view, panel } = makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(window.funsync.eroscriptsLatest).toHaveBeenCalledWith('all', 0, { sort: 'newest', period: 'all', tags: [] });
    expect(document.querySelector('.es-view__heading').textContent).toBe(TAB.latest.all);
    const more = document.querySelector('.es-view__more');
    expect(more.hidden).toBe(false);
    more.click();
    await vi.waitFor(() => expect(cards()).toHaveLength(3));
    expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('all', 1, { sort: 'newest', period: 'all', tags: [] });
    expect(more.hidden).toBe(true);
    view._filterEl.querySelector('[data-value=free]').click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('free', 0, { sort: 'newest', period: 'all', tags: [] }));
    expect(document.querySelector('.es-view__heading').textContent).toBe(TAB.latest.free);
    expect(panel.search).not.toHaveBeenCalled();                  // nothing searched: the list, not a search
  });

  it('a search replaces them; emptying the search box brings them back', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [topic(1, 14)], more: false }));
    const { panel } = makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    panel.onResults([{ ...TOPIC }]);
    expect(document.querySelector('.es-view__heading').hidden).toBe(true);
    expect(cards().map((c) => c.dataset.topicId)).toEqual([String(TOPIC.id)]);
    panel.onQueryCleared();
    await vi.waitFor(() => expect(cards().map((c) => c.dataset.topicId)).toEqual(['1']));
  });

  it('logged out: says to log in; a late answer never draws over a search', async () => {
    let answer;
    window.funsync.eroscriptsLatest = vi.fn(() => new Promise((r) => { answer = r; }));
    const { panel } = makeView();
    panel.onResults([{ ...TOPIC }]);                                // a search lands first
    answer({ results: [], error: 'x', loginRequired: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.es-view__empty').hidden).toBe(true);
    expect(cards()).toHaveLength(1);
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [], error: 'x', loginRequired: true }));
    panel.onQueryCleared();
    await vi.waitFor(() => expect(document.querySelector('.es-view__empty').textContent).toBe(TAB.latest.loginNeeded));
  });
});

// --- round 3 (Dave, 2026-11-22: "do all of those ... add tests and manual test extensively") ---

const browse = await import('../../renderer/js/eroscripts-browse.js');

describe('browse helpers', () => {
  it('sorts, filters, the search query, card chips', () => {
    expect(browse.sortParams('top-weekly')).toEqual({ sort: 'top', period: 'weekly' });
    expect(browse.sortParams('nonsense')).toEqual({ sort: 'newest', period: 'all' });
    const f = { video: 'vr', length: 'len-10-25', device: 'multi' };
    expect(browse.filterTags(f)).toEqual(['vr', 'len-10-25', 'multi-axis']);
    expect(browse.filterTags({ video: 'bogus' })).toEqual([]);
    expect(browse.matchesFilters({ tags: ['vr', 'len-10-25', 'multi-axis', 'pov'] }, f)).toBe(true);
    expect(browse.matchesFilters({ tags: ['vr', 'len-10-25'] }, f)).toBe(false);
    expect(browse.matchesFilters({}, f)).toBe(true);                                  // tags unknown: kept
    expect(browse.decorateQuery('pmv mix', { price: 'free', sort: 'top-all', filters: f })).toBe('pmv mix #free-scripts order:likes tags:vr');
    expect(browse.decorateQuery('pmv mix', {})).toBe('pmv mix');
    expect(browse.cardTags(['jav-vr', 'len-25-60', 'sr6'])).toEqual({ video: 'vr', length: 'len-25-60', multi: true });
    expect(browse.cardTags(['non-vr'])).toEqual({ video: 'flat', length: null, multi: false });
  });

  it('what the library already has, by post', () => {
    const map = browse.libraryByTopic({
      'C:\\Lib\\A.mp4': { topicId: 5, scriptPath: 'C:\\Lib\\A.funscript' },
      'C:\\Lib\\Old.mp4': { topicId: 6 },                                   // before scriptPath: its same-name script
      'C:\\Lib\\X.mp4': { tags: [] },
    });
    expect(map.get(5)).toEqual([{ video: 'C:\\Lib\\A.mp4', script: 'C:\\Lib\\A.funscript' }]);
    expect(map.get(6)).toEqual([{ video: 'C:\\Lib\\Old.mp4', script: 'C:\\Lib\\Old.funscript' }]);
    expect(map.size).toBe(2);
  });
});

describe('round 3 in the tab', () => {
  const topic = (id, extra = {}) => ({ id, title: `Thread ${id}`, categoryId: 14, creator: 'maker', ...extra });

  it('1. a post the library already has shows its ticks and Play, without this tab having downloaded it', async () => {
    store.set('library.scriptTags', { 'C:\\Lib\\Got it.mp4': { topicId: 77, scriptPath: 'C:\\Lib\\Got it.funscript' } });
    const { panel, playPath } = makeView();
    panel.onResults([topic(77)]);
    await vi.waitFor(() => expect(part(cards()[0], 'video')).toBe('done'));
    expect(part(cards()[0], 'script')).toBe('done');
    const btn = cards()[0].querySelector('.es-card__btn');
    expect(btn.textContent).toBe(TAB.card.play);
    btn.click();
    expect(playPath).toHaveBeenCalledWith('C:\\Lib\\Got it.mp4');
  });

  it('1b. a video LINKED to the post counts as had with its drive unplugged; a download of this tab that is gone does not', async () => {
    // Dave, 2026-11-23: "if a user has gone in a linked it to an eroscripts post for the
    // tags, its safe to say theyve got it" (his two linked Rae Lil Black videos were on D:,
    // unplugged, and showed grey).
    store.set('library.scriptTags', { 'D:\\funsc\\Linked.mp4': { topicId: 88, scriptPath: 'D:\\funsc\\Linked.funscript' } });
    store.set('eroscripts.downloaded', { 99: { video: 'C:\\Lib\\Gone.mp4', script: 'C:\\Lib\\Gone.funscript' } });
    window.funsync.fileExists = vi.fn(async () => false);            // nothing reachable
    const { panel } = makeView();
    panel.onResults([topic(88), topic(99)]);
    await vi.waitFor(() => expect(window.funsync.fileExists).toHaveBeenCalled());
    await vi.waitFor(() => expect(cards()[0].classList.contains('es-card--have')).toBe(true));
    expect(part(cards()[0], 'video')).toBe('done');
    expect(cards()[1].classList.contains('es-card--have')).toBe(false);
  });

  it('1c. a post with no downloadable video says so on its card before it is opened, and the Download filter hides it', async () => {
    // Dave, 2026-11-23: "why wouldn't I be able to see this one has no video download available before clicking it", "Why can't I filter by that?"
    answer = { ...answer, links: [{ url: 'https://example.com/page', text: 'somewhere' }], replyLinks: [], attachments: [{ name: 'Only.funscript', url: 'https://discuss.eroscripts.com/uploads/o.funscript' }] };
    const { panel } = makeView();
    panel.onResults([topic(55)]);
    await vi.waitFor(() => expect(cards()[0].querySelector('[data-state=none]')).toBeTruthy(), { timeout: 3000 });
    expect(window.funsync.eroscriptsTopic).toHaveBeenCalledWith(55, { replies: false });
    expect(part(cards()[0], 'video')).toBe('none');
    expect(part(cards()[0], 'script')).toBe('missing');
    expect(cards()[0].hidden).toBe(false);
    const get = document.querySelector('.es-tool__select[data-k=get]');
    get.value = 'video';
    get.dispatchEvent(new Event('change'));
    expect(store.get('eroscripts.needFilter')).toBe('video');
    expect(cards()[0].hidden).toBe(true);
    get.value = 'script';
    get.dispatchEvent(new Event('change'));
    expect(cards()[0].hidden).toBe(false);
  });

  it('1f. a video linked to the post after the list loaded lights its card at once, and on coming back to the tab (B009)', async () => {
    // Dave, 2026-11-24: "videos that are in my downloads folder ... still greyed out on the
    // eroscripts feed even though I have linked tags". The tab built its "linked to this post"
    // map only when a list loaded; linking in the library, then coming back, kept the old map.
    const { eventBus } = await import('../../renderer/js/event-bus.js');
    const { view, panel } = makeView();
    panel.onResults([topic(77)]);
    expect(cards()[0].classList.contains('es-card--have')).toBe(false);
    store.set('library.scriptTags', { 'D:\\Downloads\\Clip.mp4': { topicId: 77, tags: ['pov'] } });
    eventBus.emit('settings:changed', { path: 'library.scriptTags', value: store.get('library.scriptTags') });
    expect(cards()[0].classList.contains('es-card--have')).toBe(true);
    // Linked while the tab was hidden, with no event for it: coming back repaints from the store.
    view.hide();
    store.set('library.scriptTags', {});
    view.show();
    expect(cards()[0].classList.contains('es-card--have')).toBe(false);
  });

  it('1e. the Downloads list updates its rows in place: a Pause press or keyboard focus survives the every-second refresh (B006)', async () => {
    // Test day 2026-11-24: the list was rebuilt every second while anything
    // downloaded; a 300 ms press on Pause lost its click 1 time in 8 in the
    // real app, and focus on a row's button was thrown away every second.
    const { view } = makeView();
    jobs = [{ id: 'j9', status: 'downloading', stem: 'Long one', host: 'pixeldrain', bytes: 10, total: 100, speed: 5, url: 'https://pixeldrain.com/u/x', path: '' }];
    await view._refreshJobs();
    const row = () => document.querySelector('.es-view__job--downloading');
    const pause = row().querySelector('.es-view__job-actions button');
    pause.focus();
    jobs = [{ ...jobs[0], bytes: 55 }];
    await view._refreshJobs();
    expect(row().querySelector('.es-view__job-actions button')).toBe(pause);      // the same button
    expect(document.activeElement).toBe(pause);
    expect(row().querySelector('.es-view__bar-fill').style.width).toBe('55%');
    expect(row().querySelector('.es-view__job-status').textContent).toContain('55');
    // A new state: new buttons (Resume / Discard).
    jobs = [{ ...jobs[0], status: 'paused' }];
    await view._refreshJobs();
    const paused = document.querySelector('.es-view__job--paused');
    expect(paused.querySelector('.es-view__job-actions button').getAttribute('aria-label')).toBe(TAB.card.resume);
    // Gone from the backend: gone from the list; none: the empty line.
    jobs = [];
    await view._refreshJobs();
    expect(document.querySelectorAll('.es-view__job').length).toBe(1);
    expect(document.querySelector('.es-view__job--empty')).toBeTruthy();
  });

  it('1d. leaving the tab pauses the card checks; coming back carries on', async () => {
    // Test day 2026-11-24: the checks kept reading posts with the tab hidden.
    const { view, panel } = makeView();
    panel.onResults([topic(81)]);
    view.hide();
    await new Promise((r) => setTimeout(r, 1200));
    expect(window.funsync.eroscriptsTopic).not.toHaveBeenCalledWith(81, { replies: false });
    view.show();
    await vi.waitFor(() => expect(window.funsync.eroscriptsTopic).toHaveBeenCalledWith(81, { replies: false }), { timeout: 3000 });
  });

  it('2. chips for VR / 2D, length, multi-axis; the filters narrow the newest list on the forum', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [topic(1, { tags: ['vr', 'len-10-25', 'multi-axis'] })], more: false }));
    const { view } = makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect([...cards()[0].querySelectorAll('.es-chip')].map((c) => c.textContent)).toEqual([TAB.chip.vr, TAB.len['10_25'], TAB.chip.multi]);
    const video = view._toolbar.querySelector('select[data-k=video]');
    video.value = 'vr';
    video.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('all', 0, { sort: 'newest', period: 'all', tags: ['vr'] }));
    expect(store.get('eroscripts.filters')).toEqual({ tags: [], hide: [], video: 'vr', length: 'any', device: 'any' });
    expect(video.classList.contains('es-tool__select--set')).toBe(true);
  });

  it('3. Top this week: the forum\'s top list; in a search, order:likes; other tags checked on the results', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [topic(1)], more: false }));
    const { view, panel } = makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const sort = view._toolbar.querySelector('select[data-k=sort]');
    sort.value = 'top-weekly';
    sort.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('all', 0, { sort: 'top', period: 'weekly', tags: [] }));
    expect(document.querySelector('.es-view__heading').textContent).toBe(TAB.top.all);
    // A search: the query carries the sort and the first tag; the rest are checked here.
    store.set('eroscripts.filters', { video: 'vr', length: 'any', device: 'multi' });
    expect(panel.queryDecorator('pmv')).toBe('pmv order:likes tags:vr');
    panel.onResults([topic(2, { tags: ['vr', 'multi-axis'] }), topic(3, { tags: ['vr'] })]);
    expect(cards().map((c) => c.dataset.topicId)).toEqual(['2']);
    sort.value = 'newest';
    sort.dispatchEvent(new Event('change'));
    expect(panel.search).toHaveBeenCalled();                                // a search reruns, not the list
  });

  it('4. finished: Play in the "Saved" message; a notification when the app is not in front', async () => {
    const shown = [];
    globalThis.Notification = vi.fn(function N(title, opts) { shown.push([title, opts]); this.onclick = null; });
    globalThis.Notification.permission = 'default';
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      const { view, playPath } = makeView();
      view._announce('C:\\Lib\\Clip.mp4', 'Saved Clip', 'Clip');
      const msg = showToast.mock.calls.at(-1)[0];
      expect(msg.textContent).toContain('Saved Clip');
      msg.querySelector('.es-toast__play').click();
      expect(playPath).toHaveBeenCalledWith('C:\\Lib\\Clip.mp4');
      expect(shown).toEqual([[TAB.notify.title, { body: 'Clip', silent: false, icon: '../assets/icons/icon.png' }]]);
      globalThis.Notification.mock.instances[0].onclick();
      expect(playPath).toHaveBeenCalledTimes(2);
    } finally {
      focus.mockRestore();
      delete globalThis.Notification;
    }
  });

  it('5. the window says the room on the disk, and will not start a download that does not fit', async () => {
    const realFetch = globalThis.fetch;
    let free = 51e9;
    globalThis.fetch = vi.fn(async (url, opts) => (String(url).includes('/space')
      ? { ok: true, status: 200, json: async () => ({ free, margin: 200 * 1024 * 1024 }) }
      : realFetch(url, opts)));
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-dl__space').textContent).toBe(fill(TAB.space.fits, { size: '3.3 GB', free: '51.0 GB' })));
    expect(mainBtn().disabled).toBe(false);
    document.querySelector('.modal-overlay .modal-close-btn').click();
    free = 1e9;
    view._spaceCache.clear();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-dl__space').textContent).toBe(fill(TAB.space.short, { need: '3.3 GB', free: '1.0 GB' })));
    expect(mainBtn().disabled).toBe(true);
  });

  it('6. Pause on the card keeps the part; Resume continues; Discard deletes it', async () => {
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    await openWindow(view);
    mainBtn().click();
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    jobs = [{ ...jobs[0], status: 'downloading', bytes: 5, total: 10 }];
    await view._refreshJobs();
    const btn = cards()[0].querySelector('.es-card__btn');
    expect(btn.textContent).toBe(TAB.card.pause);
    btn.click();
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/j1/pause' && c.method === 'POST')).toBe(true));
    jobs = [{ ...jobs[0], status: 'paused', resumable: true }];
    await view._refreshJobs();
    expect(btn.textContent).toBe(TAB.card.resume);
    expect(part(cards()[0], 'video')).toBe('paused');
    expect(cards()[0].querySelector('.es-card__status').textContent).toBe(fill(TAB.status.paused, { percent: 50, size: '10 B' }));
    const row = document.querySelector('.es-view__job');
    // Icons, named by their tooltip and label (Dave: "a pause icon and an x would be best").
    expect([...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([TAB.card.resume, TAB.discard]);
    expect([...row.querySelectorAll('button')].every((b) => b.querySelector('svg') && b.textContent === '' && b.title)).toBe(true);
    btn.click();
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/j1/resume')).toBe(true));
    [...document.querySelector('.es-view__job').querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === TAB.discard).click();
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/j1/cancel')).toBe(true));
  });

  it('7. several at once: Select, pick, Download N: each post gets its best link, one after another', async () => {
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }, { ...TOPIC, id: 2, title: 'Second' }]);
    document.querySelector('.es-view__select-btn').click();
    expect(document.querySelector('.es-view__selbar').hidden).toBe(false);
    cards()[0].click();
    cards()[1].click();
    expect(document.querySelector('.modal-overlay')).toBeNull();                 // picked, not opened
    expect(cards().every((c) => c.classList.contains('es-card--selected'))).toBe(true);
    expect(document.querySelector('.es-view__selbar-text').textContent).toBe(fill(TAB.select.count, { count: 2 }));
    document.querySelector('.es-view__selbar-go').click();
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '')).toHaveLength(2), { timeout: 5000 });
    expect(window.funsync.eroscriptsTopic).toHaveBeenCalledWith(2, { replies: true });
    await vi.waitFor(() => expect(document.querySelector('.es-view__selbar').hidden).toBe(true));
    expect(showToast.mock.calls.at(-1)[0]).toBe('2 downloads started');
  });

  it('8. more as you scroll: the list\'s next page, and the search\'s', async () => {
    let seen;
    globalThis.IntersectionObserver = class { constructor(cb) { seen = cb; } observe() {} disconnect() {} };
    try {
      window.funsync.eroscriptsLatest = vi.fn(async (price, page) => ({ results: [topic(page * 10 + 1)], more: true }));
      const { panel } = makeView();
      await vi.waitFor(() => expect(cards()).toHaveLength(1));
      seen([{ isIntersecting: true }]);
      await vi.waitFor(() => expect(cards()).toHaveLength(2));
      expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('all', 1, expect.any(Object));
      // A search of a full page (50) has more.
      window.funsync.eroscriptsSearch = vi.fn(async () => ({ results: [topic(999)] }));
      panel.queryDecorator('pmv');
      panel.onResults(Array.from({ length: 50 }, (_, i) => topic(100 + i)));
      seen([{ isIntersecting: true }]);
      await vi.waitFor(() => expect(window.funsync.eroscriptsSearch).toHaveBeenCalledWith('pmv', 2));
      await vi.waitFor(() => expect(cards()).toHaveLength(51));
    } finally {
      delete globalThis.IntersectionObserver;
    }
  });
});

describe('a post behind several videos (found live, 2026-11-22)', () => {
  it('the tick shows when any of them is still there, not only the first one recorded', async () => {
    store.set('library.scriptTags', {
      'C:\\Lib\\Gone.mp4': { topicId: 88, scriptPath: 'C:\\Lib\\Gone.funscript' },
      'C:\\Lib\\Here.mp4': { topicId: 88, scriptPath: 'C:\\Lib\\Here.funscript' },
    });
    window.funsync.fileExists = vi.fn(async (p) => p.includes('Here'));
    const { panel, playPath } = makeView();
    panel.onResults([{ id: 88, title: 'Two copies', categoryId: 14 }]);
    await vi.waitFor(() => expect(part(cards()[0], 'video')).toBe('done'));
    cards()[0].querySelector('.es-card__btn').click();
    expect(playPath).toHaveBeenCalledWith('C:\\Lib\\Here.mp4');
  });
});

describe('one set of results (Dave, 2026-11-22: "why does the search bring up 2 result sets")', () => {
  it('back in the tab after the player, the panel\'s old list is gone: only the cards', () => {
    const panel = new EroScriptsPanel({ settings: settings() });
    const host = document.createElement('div');
    document.body.appendChild(host);
    panel.onResults = vi.fn();
    panel.dock(host);
    panel._renderResults([{ id: 1, title: 'A post', url: 'https://discuss.eroscripts.com/t/1', tags: [] }]);
    panel.undock();                                                   // the player view: the floating list draws them
    expect(panel._panel.querySelectorAll('.eroscripts-panel__result')).toHaveLength(1);
    panel.dock(host);                                                 // back in the tab
    expect(panel._panel.querySelectorAll('.eroscripts-panel__result')).toHaveLength(0);
  });
});

describe('feeds in the tab (Dave, 2026-11-22: "custom queues ... a badge for new ones")', () => {
  const thread = (id, createdAt, extra = {}) => ({ id, title: `Thread ${id}`, categoryId: 14, createdAt, tags: ['pmv'], ...extra });
  const feedChips = () => [...document.querySelectorAll('.es-feed')];

  it('chips: All scripts, each feed with its badge, + New feed; the nav badge gets the total', async () => {
    store.set('eroscripts.feeds', [
      { id: 'fa', name: 'PMV', tags: ['pmv'], newCount: 3 },
      { id: 'fb', name: 'VR multi', filters: { video: 'vr', device: 'multi' }, newCount: 30, full: true },
    ]);
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [], more: false }));
    const { view } = makeView();
    const totals = [];
    view.onFeedsChanged = (n) => totals.push(n);
    view._feedsChanged();
    // Suggested (built in, 2026-11-24) sits after All scripts.
    expect(feedChips().map((c) => c.textContent)).toEqual([TAB.feeds.all, TAB.suggest.chip, 'PMV3', 'VR multi30+', TAB.feeds.add]);
    expect(feedChips()[0].classList.contains('es-feed--on')).toBe(true);
    expect(totals.at(-1)).toBe(33);
  });

  it('opening a feed: its newest threads with its tags, New on the ones since last time, the badge cleared, the bar locked', async () => {
    store.set('eroscripts.feeds', [{ id: 'fa', name: 'PMV', price: 'free', tags: ['pmv'], lastSeenAt: '2026-11-21T00:00:00Z', newCount: 1 }]);
    window.funsync.eroscriptsLatest = vi.fn(async () => ({
      results: [thread(1, '2026-11-22T10:00:00Z'), thread(2, '2026-11-20T10:00:00Z')], more: false,
    }));
    const { view } = makeView();
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenCalled());
    feedChips().find((c) => c.dataset.feedId === 'fa').click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('free', 0, { sort: 'newest', period: 'all', tags: ['pmv'] }));
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(document.querySelector('.es-view__heading').textContent).toBe('PMV');
    expect(cards()[0].querySelector('.es-chip--new')?.textContent).toBe(TAB.feeds.new);
    expect(cards()[1].querySelector('.es-chip--new')).toBeNull();
    const stored = store.get('eroscripts.feeds')[0];
    expect(stored.newCount).toBe(0);
    expect(Date.parse(stored.lastSeenAt)).toBeGreaterThan(Date.parse('2026-11-22T00:00:00Z'));
    expect(view._toolbar.querySelector('select[data-k=video]').disabled).toBe(true);
    expect(document.querySelector('.es-view__feed-edit').hidden).toBe(false);
    expect(view._filterEl.querySelector('[data-value=free]').getAttribute('aria-checked')).toBe('true');
    // All scripts again: unlocked.
    feedChips()[0].click();
    expect(view._toolbar.querySelector('select[data-k=video]').disabled).toBe(false);
  });

  it('Modern pieces (2026-11-23): a logo tile under every card picture; card-shaped skeletons while a list loads, gone when it lands, none in list view', async () => {
    let release = null;
    window.funsync.eroscriptsLatest = vi.fn(() => new Promise((r) => { release = () => r({ results: [thread(1, '2026-11-22T10:00:00Z')], more: false }); }));
    const { view } = makeView();
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenCalled());
    const skels = document.querySelectorAll('.es-grid > .es-skel');
    expect(skels.length).toBe(10);
    expect(skels[0].getAttribute('aria-hidden')).toBe('true');
    expect(cards()).toHaveLength(0); // a skeleton is not a thread
    release();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(document.querySelectorAll('.es-skel')).toHaveLength(0);
    const thumb = cards()[0].querySelector('.es-card__thumb');
    expect(thumb.firstElementChild.className).toBe('es-card__nothumb');
    expect(thumb.querySelector('.es-card__nothumb + .es-card__img')).not.toBeNull();
    // List view: no card-shaped placeholders.
    view._setViewMode('list');
    window.funsync.eroscriptsLatest = vi.fn(() => new Promise(() => {}));
    view._loadLatest(true);
    expect(document.querySelectorAll('.es-skel')).toHaveLength(0);
    // Classic hides both (Modern shows them: modern-polish.css).
    expect(fs.readFileSync('renderer/styles/eroscripts.css', 'utf8')).toMatch(/\.es-card__nothumb,\s+\.es-skel \{ display: none; \}/);
  });

  it('Refresh (Dave 2026-11-23): loads the open feed again now; what came in meanwhile is New, the badge cleared; busy while loading; hidden in a search', async () => {
    store.set('eroscripts.feeds', [{ id: 'fa', name: 'PMV', price: 'free', tags: ['pmv'], lastSeenAt: '2026-11-21T00:00:00Z', newCount: 0 }]);
    let answer = { results: [thread(1, '2026-11-20T10:00:00Z')], more: false };
    let release = null;
    window.funsync.eroscriptsLatest = vi.fn(async () => answer);
    const { view, panel } = makeView();
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenCalled());
    view.openFeed('fa');
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    const btn = document.querySelector('.es-view__refresh');
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe(TAB.feeds.refresh);
    expect(btn.title).toBe(TAB.feeds.refreshFeedTitle.replace('{name}', 'PMV'));
    // A thread arrives; the background check counted it.
    answer = { results: [thread(2, '2026-11-23T10:00:00Z'), thread(1, '2026-11-20T10:00:00Z')], more: false };
    view._checker.update('fa', { newCount: 1 });
    window.funsync.eroscriptsLatest = vi.fn(() => new Promise((r) => { release = () => r(answer); }));
    btn.click();
    expect(window.funsync.eroscriptsLatest).toHaveBeenCalledWith('free', 0, { sort: 'newest', period: 'all', tags: ['pmv'] });
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    btn.click(); // a second click while loading asks nothing more
    expect(window.funsync.eroscriptsLatest).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    expect(btn.disabled).toBe(false);
    expect(cards()[0].querySelector('.es-chip--new')?.textContent).toBe(TAB.feeds.new);
    expect(store.get('eroscripts.feeds')[0].newCount).toBe(0);
    // All scripts has it too; a search hides it.
    feedChips()[0].click();
    expect(btn.hidden).toBe(false);
    expect(btn.title).toBe(TAB.feeds.refreshAllTitle);
    panel.onResults([{ ...TOPIC }]);
    expect(btn.hidden).toBe(true);
  });

  it('a search leaves the feed', async () => {
    store.set('eroscripts.feeds', [{ id: 'fa', name: 'PMV', tags: ['pmv'] }]);
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [], more: false }));
    const { view, panel } = makeView();
    view.openFeed('fa');
    panel.onResults([{ ...TOPIC }]);
    expect(view._feedId).toBe(null);
    expect(feedChips()[0].classList.contains('es-feed--on')).toBe(true);
  });

  it('+ New feed: filled in from the tab, tags added, saved and opened; more than 5 tags cannot be saved', async () => {
    store.set('eroscripts.priceFilter', 'free');
    store.set('eroscripts.filters', { video: 'vr', length: 'any', device: 'any' });
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [thread(1, '2026-11-22T10:00:00Z', { tags: ['pmv', 'hmv'] })], more: false }));
    const { view } = makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    feedChips().at(-1).click();
    await vi.waitFor(() => expect(document.querySelector('.es-feedform')).toBeTruthy());
    const form = document.querySelector('.es-feedform');
    expect(form.querySelector('.es-feedform__price .es-seg__btn--on').dataset.value).toBe('free');
    expect(form.querySelector('select[data-k=video]').value).toBe('vr');
    // The tag box: typing suggests (the forum's tags, and the loaded threads'), Enter picks.
    window.funsync.eroscriptsTagSearch = vi.fn(async (q) => ({ tags: [{ name: 'tentacle' }, { name: 'pmv' }].filter((x) => x.name.includes(q)) }));
    const box = form.querySelector('.es-taginput__input');
    box.value = 'pm';
    box.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect([...form.querySelectorAll('.es-taginput__opt')].map((o) => o.textContent)).toEqual(['pmv']));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect([...form.querySelectorAll('.es-taginput__chip')].map((c) => c.dataset.tag)).toEqual(['pmv']);
    // A comma makes a chip of what was typed (Dave: "tentacle").
    box.value = 'tentacle,';
    box.dispatchEvent(new Event('input'));
    expect([...form.querySelectorAll('.es-taginput__chip')].map((c) => c.dataset.tag)).toEqual(['pmv', 'tentacle']);
    // VR takes one of the 5; two more filters would make 6: said, and Save is off.
    for (const [k, v] of [['length', 'len-10-25'], ['device', 'multi']]) {
      const sel = form.querySelector(`select[data-k=${k}]`);
      sel.value = v;
      sel.dispatchEvent(new Event('change'));
    }
    expect(form.querySelector('.es-feedform__save').disabled).toBe(false);                 // 3 + 2 = 5
    box.value = 'hmv,';
    box.dispatchEvent(new Event('input'));
    expect(form.querySelectorAll('.es-taginput__chip')).toHaveLength(2);                    // no room for a third
    expect(box.disabled).toBe(true);
    for (const [k, v] of [['length', 'any'], ['device', 'any']]) {
      const sel = form.querySelector(`select[data-k=${k}]`);
      sel.value = v;
      sel.dispatchEvent(new Event('change'));
    }
    form.querySelector('.es-taginput__chip[data-tag=tentacle] .es-taginput__x').click();
    expect(form.querySelector('.es-feedform__name').placeholder).toBe(`pmv · ${TAB.fVideo.vr} · ${TAB.price.free}`);
    form.querySelector('.es-feedform__save').click();
    await vi.waitFor(() => expect(document.querySelector('.es-feedform')).toBeNull());
    const saved = store.get('eroscripts.feeds');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: `pmv · ${TAB.fVideo.vr} · ${TAB.price.free}`, price: 'free', tags: ['pmv'], filters: { video: 'vr' } });
    expect(view._feedId).toBe(saved[0].id);
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('free', 0, { sort: 'newest', period: 'all', tags: ['vr', 'pmv'] }));
  });

  it('Edit feed: renamed; Delete removes it after asking', async () => {
    store.set('eroscripts.feeds', [{ id: 'fa', name: 'PMV', tags: ['pmv'] }]);
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [], more: false }));
    const { view } = makeView();
    view.openFeed('fa');
    document.querySelector('.es-view__feed-edit').click();
    await vi.waitFor(() => expect(document.querySelector('.es-feedform')).toBeTruthy());
    const name = document.querySelector('.es-feedform__name');
    name.value = 'My PMVs';
    document.querySelector('.es-feedform__save').click();
    await vi.waitFor(() => expect(store.get('eroscripts.feeds')[0].name).toBe('My PMVs'));
    await vi.waitFor(() => expect(document.querySelector('.es-feedform')).toBeNull());
    document.querySelector('.es-view__feed-edit').click();
    await vi.waitFor(() => expect(document.querySelector('.es-feedform__delete')).toBeTruthy());
    document.querySelector('.es-feedform__delete').click();
    await vi.waitFor(() => expect([...document.querySelectorAll('.modal-overlay button')].some((b) => b.textContent === TAB.feeds.delete && !b.closest('.es-feedform'))).toBe(true));
    [...document.querySelectorAll('.modal-overlay button')].find((b) => b.textContent === TAB.feeds.delete && !b.closest('.es-feedform')).click();
    await vi.waitFor(() => expect(store.get('eroscripts.feeds')).toEqual([]));
    expect(view._feedId).toBe(null);
  });
});

describe('the list view (Dave, 2026-11-22: "a list view more closely resembling the eroscripts pages")', () => {
  const rows = () => [...document.querySelectorAll('.es-row')];
  const NOW = Date.parse('2026-11-22T12:00:00Z');

  it('Activity reads like the forum\'s; Views are short', () => {
    // The platform's own words (Chromium: "2h ago"; this Node's ICU: "2 hr ago").
    const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'always', style: 'narrow' });
    expect(relativeTime('2026-11-22T10:00:00Z', NOW)).toBe(rtf.format(-2, 'hour'));
    expect(relativeTime('2026-11-19T12:00:00Z', NOW)).toBe(rtf.format(-3, 'day'));
    expect(relativeTime('2026-11-22T11:59:30Z', NOW)).toBe(rtf.format(-1, 'minute'));
    expect(relativeTime('bad', NOW)).toBe('');
    expect(compactNumber(24300)).toBe('24k');
    expect(compactNumber(1234)).toBe('1.2k');
    expect(compactNumber(87)).toBe('87');
  });

  it('List: the column titles, then one row per thread: category, tags, creator, Replies / Views / Activity, the same marks and button', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({
      results: [{ id: 7, title: 'A thread', categoryId: 15, tags: ['pmv', 'non-vr'], creator: 'maker', likeCount: 4, replies: 12, views: 2400, activityAt: new Date(Date.now() - 2 * 3600e3).toISOString() }],
      more: false,
    }));
    const { view } = makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    document.querySelector('.es-view__mode-btn[data-mode=list]').click();
    expect(store.get('eroscripts.viewMode')).toBe('list');
    expect(window.funsync.eroscriptsLatest).toHaveBeenCalledTimes(1);           // drawn again, not asked again
    expect([...document.querySelectorAll('.es-list__head span')].map((s) => s.textContent)).toEqual([TAB.list.topic, TAB.list.replies, TAB.list.views, TAB.list.activity]);
    const r = rows()[0];
    expect(r.querySelector('.es-row__title').textContent).toBe('A thread');
    expect(r.querySelector('.es-row__cat').textContent).toBe(TAB.price.paid);
    expect([...r.querySelectorAll('.es-row__tag')].map((x) => x.textContent)).toEqual(['pmv', 'non-vr']);
    const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'always', style: 'narrow' });
    expect([...r.querySelectorAll('.es-row__num')].map((x) => x.textContent)).toEqual(['12', '2.4k', rtf.format(-2, 'hour')]);
    expect(r.querySelector('.es-part--video')).toBeTruthy();
    expect(r.querySelector('.es-card__btn').textContent).toBe(TAB.card.download);
    r.click();
    await vi.waitFor(() => expect(document.querySelector('.es-dl')).toBeTruthy());    // its download window
    document.querySelector('.modal-overlay .modal-close-btn').click();
    // Back to cards: the same thread, as a card.
    document.querySelector('.es-view__mode-btn[data-mode=cards]').click();
    expect(rows()).toHaveLength(0);
    expect(cards()).toHaveLength(1);
    expect(view._viewMode()).toBe('cards');
  });

  it('a search, picking several, a feed\'s New: the same in the list', async () => {
    store.set('eroscripts.viewMode', 'list');
    store.set('eroscripts.feeds', [{ id: 'fa', name: 'PMV', tags: ['pmv'], lastSeenAt: '2026-11-21T00:00:00Z' }]);
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [{ id: 1, title: 'New one', categoryId: 14, tags: ['pmv'], createdAt: '2026-11-22T10:00:00Z' }], more: false }));
    const { view, panel } = makeView();
    view.openFeed('fa');
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].querySelector('.es-chip--new').textContent).toBe(TAB.feeds.new);
    panel.onResults([{ ...TOPIC }, { ...TOPIC, id: 2, title: 'Second' }]);
    expect(rows()).toHaveLength(2);
    document.querySelector('.es-view__select-btn').click();
    rows()[1].click();
    expect(rows()[1].classList.contains('es-card--selected')).toBe(true);
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});

describe('notifications carry FunSync, not Electron (Dave, 2026-11-22: "the funsync app logo has reverted to the electron logo")', () => {
  it('the installed app uses the installer\'s app id for Windows; the logo it points at ships', async () => {
    const appId = fs.readFileSync('electron-builder.yml', 'utf8').match(/^appId:\s*(\S+)/m)[1];
    const { appIdentity } = (await import('../../electron/app-identity.js')).default;
    expect(appIdentity({ packaged: true, platform: 'win32', appRoot: '.' }).appId).toBe(appId);
    expect(fs.readFileSync('electron/main.js', 'utf8')).toContain('app.setAppUserModelId(appId.appId)');
    expect(fs.existsSync('assets/icons/icon.png')).toBe(true);
  });
  // Dave, 2026-11-24: "the app icon is default electron icon again". A dev
  // build under the installed id took it over: Electron made a Start-menu
  // "Electron" shortcut for it (to the dev electron.exe), and Windows then
  // showed Electron's logo for the installed app and the dev build alike.
  it('a dev build never uses the installed app\'s id, and its windows carry the FunSync icon', async () => {
    const { appIdentity, INSTALLED_APP_ID } = (await import('../../electron/app-identity.js')).default;
    const dev = appIdentity({ packaged: false, platform: 'win32', appRoot: '.' });
    expect(dev.appId).not.toBe(INSTALLED_APP_ID);
    expect(dev.windowDetails.appId).toBe(dev.appId);
    expect(fs.existsSync(dev.windowDetails.appIconPath)).toBe(true);
    expect(dev.windowDetails.appIconPath.endsWith('icon.ico')).toBe(true);
    expect(appIdentity({ packaged: true, platform: 'linux', appRoot: '.' })).toBeNull();
  });

  // It came back the next day (2026-11-25, 13:12): Electron 41 writes the
  // notification shortcut itself (<Programs>\Electron.lnk, the id and CLSID,
  // no icon). It keeps one whose target, folder, id and CLSID match, so the
  // dev build writes it first, with the FunSync icon and a fixed CLSID.
  it('a dev build writes the notification shortcut Electron would, with the FunSync icon', async () => {
    const { appIdentity, devShortcut, DEV_TOAST_CLSID } = (await import('../../electron/app-identity.js')).default;
    const dev = appIdentity({ packaged: false, platform: 'win32', appRoot: '.' });
    expect(dev.toastClsid).toBe(DEV_TOAST_CLSID);
    expect(DEV_TOAST_CLSID).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
    const exe = 'C:\\Repo\\node_modules\\electron\\dist\\electron.exe';
    const lnk = devShortcut({ identity: dev, execPath: exe, programsDir: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs' });
    expect(lnk.path.replace(/\\/g, '/')).toBe('C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Electron.lnk');
    // What Electron checks, as it would write them; plus the icon it never sets.
    expect(lnk.options).toMatchObject({ target: exe, args: '', appUserModelId: dev.appId, toastActivatorClsid: DEV_TOAST_CLSID, iconIndex: 0 });
    expect(lnk.options.cwd.replace(/\\/g, '/')).toBe('C:/Repo/node_modules/electron/dist');
    expect(lnk.options.icon).toBe(dev.windowDetails.appIconPath);
    // The installed app and other platforms: nothing (its installer's shortcut is FunSync's).
    expect(devShortcut({ identity: appIdentity({ packaged: true, platform: 'win32', appRoot: '.' }), execPath: exe, programsDir: 'C:\\P' })).toBeNull();
    expect(devShortcut({ identity: null, execPath: exe, programsDir: 'C:\\P' })).toBeNull();
    // main.js wires it: the fixed CLSID first, the shortcut once ready.
    const main = fs.readFileSync('electron/main.js', 'utf8');
    expect(main).toMatch(/setToastActivatorCLSID\(appId\.toastClsid\)/);
    expect(main).toMatch(/shell\.writeShortcutLink\(lnk\.path/);
  });
});

describe('Watch: a post streamed into the player with its script (Dave, 2026-11-22: "can we try to stream into funsyncs own player")', () => {
  async function watchView(playStream = vi.fn(async () => {})) {
    const { canWatch, streamScriptName } = await import('../../renderer/components/eroscripts-view.js');
    window.funsync.getStreamScriptsDir = vi.fn(async () => 'C:\\Data\\stream-scripts');
    window.funsync.resolveRemoteVideo = vi.fn(async (u) => ({ ok: true, title: 'page title', proxyUrl: 'http://localhost:5123/api/media/remote/t/file', isHls: false, url: u }));
    const view = new EroScriptsView({
      container: document.getElementById('eroscripts-container'),
      panel: { dock: vi.fn(), undock: vi.fn(), show: vi.fn(), search: vi.fn(), handleSessionExpired: vi.fn() },
      settings: settings(), getBackendPort: () => 5123, isLibraryFolder: () => false, onSavedIntoLibrary: vi.fn(), playPath: vi.fn(), playStream,
    });
    view.show();
    return { view, playStream, canWatch, streamScriptName };
  }
  const watchNow = () => document.querySelector('.es-dl__watch');

  it('which links can stream: the hosts the backend plays, a tube site only with the switch, never Mega or a dead link', async () => {
    const { canWatch, streamScriptName } = await watchView();
    expect(canWatch({ supported: true, kind: 'videohost', host: 'faptap' })).toBe(true);
    expect(canWatch({ supported: true, kind: 'filehost', host: 'pixeldrain' })).toBe(true);
    expect(canWatch({ supported: true, kind: 'direct', host: 'x.com' })).toBe(true);
    expect(canWatch({ supported: true, kind: 'filehost', host: 'mega' })).toBe(false);
    expect(canWatch({ supported: true, kind: 'tube', host: 'xvideos' })).toBe(false);
    expect(canWatch({ supported: true, kind: 'tube', host: 'xvideos' }, true)).toBe(true);
    expect(canWatch({ supported: true, kind: 'videohost', host: 'faptap', check: { status: 'dead' } })).toBe(false);
    expect(canWatch({ supported: false, kind: 'store' })).toBe(false);
    const a = streamScriptName(341682, { name: 'PMVMIX12.funscript', url: 'https://u/a.funscript' });
    expect(a).toMatch(/^341682-[0-9a-f]+-PMVMIX12\.funscript$/);
    expect(streamScriptName(341682, { name: 'PMVMIX12.funscript', url: 'https://u/b.funscript' })).not.toBe(a);   // a new upload, a new file
    expect(streamScriptName(1, { name: 'a/b:c?.funscript', url: 'u' })).toMatch(/^1-[0-9a-f]+-a_b_c_\.funscript$/);
  });

  it('Watch now saves the script to the stream folder, streams the best link and hands both to the player', async () => {
    const { view, playStream } = await watchView();
    await openWindow(view);
    expect(watchNow().textContent).toBe(TAB.watch.now);
    watchNow().click();
    await vi.waitFor(() => expect(playStream).toHaveBeenCalled());
    const [result, scriptPath] = playStream.mock.calls[0];
    expect(window.funsync.resolveRemoteVideo).toHaveBeenCalledWith(PIX);
    expect(result.title).toBe('Pmv mix // vol. 12');                          // the post's title, not the page's
    expect(scriptPath).toMatch(/^C:\\Data\\stream-scripts\\341682-[0-9a-f]+-PMVMIX12\.funscript$/);
    expect(window.funsync.eroscriptsDownload).toHaveBeenCalledWith(answer.attachments[0].url, scriptPath);
    expect(calls.some((c) => c.path === '' && c.method === 'POST')).toBe(false); // nothing downloaded
    await vi.waitFor(() => expect(dlBox()).toBeNull());                     // the window closes
  });

  it('a link that will not resolve says why and plays nothing; a script that will not save plays the video alone', async () => {
    const { view, playStream } = await watchView();
    window.funsync.resolveRemoteVideo = vi.fn(async () => ({ ok: false, kind: 'unsupported' }));
    await openWindow(view);
    watchNow().click();
    // In the window (2026-11-23), not a passing toast: why, and the way on.
    await vi.waitFor(() => expect(document.querySelector('.es-dl__watch-status--failed')).toBeTruthy());
    const failed = document.querySelector('.es-dl__watch-status--failed');
    expect(failed.querySelector('.es-dl__watch-text').textContent).toBe(fill(TAB.watch.failed, { reason: EN.remoteVideo.err.unsupported }));
    [...failed.querySelectorAll('button')].find((b) => b.textContent === TAB.openInBrowser).click();
    expect(window.funsync.openExternal).toHaveBeenCalledWith(PIX);
    expect(playStream).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(watchNow().disabled).toBe(false));
    expect(watchNow().textContent).toBe(TAB.watch.now);

    window.funsync.resolveRemoteVideo = vi.fn(async () => ({ ok: true, title: 't', proxyUrl: 'p' }));
    window.funsync.eroscriptsDownload = vi.fn(async () => ({ success: false, error: 'HTTP 404' }));
    watchNow().click();
    await vi.waitFor(() => expect(playStream).toHaveBeenCalled());
    expect(playStream.mock.calls[0][1]).toBe(null);
    expect(showToast).toHaveBeenCalledWith(TAB.watch.noScript, 'warn');
  });

  it('every streamable link in More options has its own Watch; no player hook, no Watch', async () => {
    const { view } = await watchView();
    await openWindow(view);
    const rows = [...document.querySelectorAll('.es-view__link')];
    const watchIn = (url) => [...rows.find((r) => r.querySelector('.es-view__link-text').title === url).querySelectorAll('button')].some((b) => b.textContent === TAB.watch.button);
    expect(watchIn(PIX)).toBe(true);
    expect(watchIn(PH)).toBe(false);                                          // a tube site, switch off
    document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());

    const { view: plain } = makeView();
    await openWindow(plain);
    expect(watchNow()).toBeNull();
  });

  it('a pasted link has Watch too: the video alone, a tube link only with the switch on', async () => {
    const { view, playStream } = await watchView();
    const watchBtn = () => [...document.querySelectorAll('.es-paste .es-dl__actions button')].find((b) => b.textContent === TAB.watch.button);
    view.openPasteLink(PH);
    await vi.waitFor(() => expect(document.querySelector('.es-paste .es-dl__actions')).toBeTruthy());
    expect(watchBtn()).toBeUndefined();                                       // tube, switch off
    document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());

    view.openPasteLink(PIX);
    await vi.waitFor(() => expect(watchBtn()).toBeTruthy());
    watchBtn().click();
    await vi.waitFor(() => expect(playStream).toHaveBeenCalled());
    expect(window.funsync.resolveRemoteVideo).toHaveBeenCalledWith(PIX);
    expect(playStream.mock.calls[0][0].title).toBe('page title');            // no post: the page's own title
    expect(playStream.mock.calls[0][1]).toBe(null);
    expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();
  });

  it('the app plays it through Load from URL, which is back on the nav bar and the player bar', () => {
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(app).toMatch(/playStream: \(result, scriptPath, axes, opts\) => this\._loadRemoteVideo\(result, scriptPath, axes, opts\)/);
    expect(app).toMatch(/^\s+onLoadUrlClick: \(\) => this\._openLoadUrlModal\(\),/m);
    expect(app).toMatch(/^\s+document\.getElementById\('btn-load-url'\)\?\.addEventListener/m);
    expect(fs.readFileSync('renderer/index.html', 'utf8')).toMatch(/^\s+<button id="btn-load-url"/m);
    expect(fs.readFileSync('electron/main.js', 'utf8')).toMatch(/ipcMain\.handle\('get-stream-scripts-dir'/);
  });
});

describe('streaming UX (2026-11-23): steps in the window, the next link when one fails', () => {
  const FT = 'https://faptap.net/v/2107858395183714305';
  async function view2(playStream = vi.fn(async () => {})) {
    answer.links = [{ url: PIX, text: 'PMVMIX12.mp4 ~ pixeldrain' }, { url: FT, text: 'PMV MIX // VOL. 12 - Faptap' }, { url: PH, text: 'PornHub' }];
    classified[FT] = { kind: 'videohost', host: 'faptap', supported: true };
    checks[FT] = { status: 'ok', name: 'PMV MIX // VOL. 12' };
    window.funsync.getStreamScriptsDir = vi.fn(async () => 'C:\\Data\\stream-scripts');
    const view = new EroScriptsView({
      container: document.getElementById('eroscripts-container'),
      panel: { dock: vi.fn(), undock: vi.fn(), show: vi.fn(), search: vi.fn(), handleSessionExpired: vi.fn() },
      settings: settings(), getBackendPort: () => 5123, isLibraryFolder: () => false, onSavedIntoLibrary: vi.fn(), playPath: vi.fn(), playStream,
    });
    view.show();
    await openWindow(view);
    return { view, playStream };
  }

  it('rankLinks: the best first, dead and switched-off tube links left out, ties in the post order', async () => {
    const { rankLinks } = await import('../../renderer/components/eroscripts-view.js');
    const links = [
      { url: 'a', supported: true, kind: 'filehost', check: { status: 'unknown' } },
      { url: 'b', supported: true, kind: 'videohost', check: { status: 'ok' } },
      { url: 'c', supported: true, kind: 'tube', check: { status: 'ok' } },
      { url: 'd', supported: true, kind: 'filehost', check: { status: 'dead' } },
      { url: 'e', supported: true, kind: 'direct', check: { status: 'ok' } },
    ];
    expect(rankLinks(links).map((l) => l.url)).toEqual(['e', 'b', 'a']);
    expect(rankLinks(links, { tube: true }).map((l) => l.url)).toEqual(['e', 'b', 'c', 'a']);
    expect(pickBestLink(links)?.url).toBe('e');
  });

  it('Watch now: a link that will not play hands over to the next, and the window says so', async () => {
    const resolves = [];
    const { playStream } = await view2();
    window.funsync.resolveRemoteVideo = vi.fn((u) => new Promise((r) => resolves.push({ u, r })));
    document.querySelector('.es-dl__watch').click();
    await vi.waitFor(() => expect(resolves).toHaveLength(1));
    const text = () => document.querySelector('.es-dl__watch-text')?.textContent;
    expect(text()).toBe(TAB.watch.stepFinding);
    resolves[0].r({ ok: false, kind: 'unavailable' });
    await vi.waitFor(() => expect(resolves).toHaveLength(2));
    expect(resolves.map((x) => x.u)).toEqual([PIX, FT]);                    // best first, then the next; never the tube link
    expect(text()).toBe(fill(TAB.watch.stepNext, { host: 'FapTap', n: 2, total: 2 }));
    resolves[1].r({ ok: true, title: 'x', proxyUrl: 'p', isHls: true });
    await vi.waitFor(() => expect(playStream).toHaveBeenCalled());
  });

  it('Cancel stops a Watch: nothing plays, the button comes back', async () => {
    let resolve;
    const { playStream } = await view2();
    window.funsync.resolveRemoteVideo = vi.fn(() => new Promise((r) => { resolve = r; }));
    const btn = document.querySelector('.es-dl__watch');
    btn.click();
    await vi.waitFor(() => expect(window.funsync.resolveRemoteVideo).toHaveBeenCalled());   // past the script, finding the video
    document.querySelector('.es-dl__watch-cancel').click();
    expect(document.querySelector('.es-dl__watch-status')).toBeNull();
    expect(btn.disabled).toBe(false);
    resolve({ ok: true, title: 'late', proxyUrl: 'p' });
    await new Promise((r) => setTimeout(r, 20));
    expect(playStream).not.toHaveBeenCalled();
  });

  it('every link failing: one line naming why, with Open in browser', async () => {
    await view2();
    window.funsync.resolveRemoteVideo = vi.fn(async () => ({ ok: false, kind: 'refused' }));
    document.querySelector('.es-dl__watch').click();
    await vi.waitFor(() => expect(document.querySelector('.es-dl__watch-status--failed')).toBeTruthy());
    expect(document.querySelector('.es-dl__watch-text').textContent).toBe(fill(TAB.watch.failedAll, { reason: EN.remoteVideo.err.refused }));
    expect(window.funsync.resolveRemoteVideo).toHaveBeenCalledTimes(2);
  });

  it('a download that fails before any video came starts the next link of the post', async () => {
    const { view } = await view2();
    mainBtn().click();
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    const posted = () => calls.filter((c) => c.path === '' && c.method === 'POST').map((c) => c.body.url);
    expect(posted()).toEqual([PIX]);
    jobs = [{ ...jobs[0], status: 'error', error: 'notFound', bytes: 0, resumable: false }];
    await view._refreshJobs();
    await vi.waitFor(() => expect(posted()).toEqual([PIX, FT]));
    expect(showToast).toHaveBeenCalledWith(fill(TAB.watch.nextLink, { host: 'FapTap' }), 'info');
  });
});

describe('multi-axis posts (Dave, 2026-11-23: "distinguish multi axis and download all axis or give the option"; "it can be a combined one ... or a split axis one")', () => {
  const U = (n) => `https://discuss.eroscripts.com/uploads/${n}`;
  const SPLIT = [
    { name: 'Izzy.funscript', url: U('main.funscript') },
    { name: 'Izzy.pitch.funscript', url: U('pitch.funscript') },
    { name: 'Izzy.roll.funscript', url: U('roll.funscript') },
    { name: 'Other scene.funscript', url: U('other.funscript') },
  ];

  it('scriptChoices: a split set is one choice carrying its axes (app order); a lone axis file stays its own', async () => {
    const { scriptChoices } = await import('../../renderer/components/eroscripts-view.js');
    const c = scriptChoices([...SPLIT, { name: 'Lonely.twist.funscript', url: U('t') }, { name: 'x.zip', url: U('z') }]);
    expect(c.map((x) => x.name)).toEqual(['Izzy.funscript', 'Other scene.funscript', 'Lonely.twist.funscript']);
    expect(c[0].axes.map((a) => [a.suffix, a.label])).toEqual([['roll', 'Roll'], ['pitch', 'Pitch']]);
    expect(c[1].axes).toEqual([]);
  });

  it('the window names the axes; Download saves every axis beside the video under its name', async () => {
    answer.attachments = SPLIT;
    const { view } = makeView();
    await openWindow(view);
    expect(rowValue(0).textContent).toContain(fill(TAB.dl.multiAxis, { axes: 'Roll, Pitch' }));
    expect(rowValue(0).textContent).toContain(fill(TAB.dl.allAxes, { count: 3 }));
    mainBtn().click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsDownload).toHaveBeenCalledTimes(3));
    const saved = window.funsync.eroscriptsDownload.mock.calls.map(([url, path]) => [url.split('/').pop(), path.split('\\').pop()]);
    expect(saved).toEqual(expect.arrayContaining([
      ['main.funscript', 'Pmv mix vol. 12.funscript'],
      ['roll.funscript', 'Pmv mix vol. 12.roll.funscript'],
      ['pitch.funscript', 'Pmv mix vol. 12.pitch.funscript'],
    ]));
  });

  it('"Every axis" off: the main script only, and it stays off', async () => {
    answer.attachments = SPLIT;
    const { view } = makeView();
    await openWindow(view);
    const box = document.querySelector('.es-dl__axes-all input');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(store.get('eroscripts.allAxes')).toBe(false);
    mainBtn().click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsDownload).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(window.funsync.eroscriptsDownload.mock.calls.map(([url]) => url.split('/').pop())).toEqual(['main.funscript']);
  });

  it('Watch hands the player the axes too, {suffix: path}', async () => {
    answer.attachments = SPLIT;
    window.funsync.getStreamScriptsDir = vi.fn(async () => 'C:\\Data\\stream-scripts');
    window.funsync.resolveRemoteVideo = vi.fn(async () => ({ ok: true, title: 't', proxyUrl: 'p' }));
    const playStream = vi.fn(async () => {});
    const view = new EroScriptsView({
      container: document.getElementById('eroscripts-container'),
      panel: { dock: vi.fn(), undock: vi.fn(), show: vi.fn(), search: vi.fn(), handleSessionExpired: vi.fn() },
      settings: settings(), getBackendPort: () => 5123, isLibraryFolder: () => false, onSavedIntoLibrary: vi.fn(), playPath: vi.fn(), playStream,
    });
    view.show();
    await openWindow(view);
    document.querySelector('.es-dl__watch').click();
    await vi.waitFor(() => expect(playStream).toHaveBeenCalled());
    const [, scriptPath, axes] = playStream.mock.calls[0];
    const stem = scriptPath.split('\\').pop().replace(/\.funscript$/, '');
    expect(axes).toEqual({ roll: `C:\\Data\\stream-scripts\\${stem}.roll.funscript`, pitch: `C:\\Data\\stream-scripts\\${stem}.pitch.funscript` });
    const app = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(app).toMatch(/this\._currentMultiAxis = \{ axes: \{ \.\.\.axes \} \};\s+await this\._loadMultiAxisScripts\(this\._currentMultiAxis\);/);
  });

  it('combined: a post tagged multi-axis with one script says the axes are inside it (the player reads them on load)', async () => {
    answer.tags = mainTags(['pmv', 'multi-axis']);   // as main gives them: the check never matched objects (2026-11-26)
    const { view } = makeView();
    await openWindow(view);
    expect(rowValue(0).textContent).toContain(TAB.dl.combinedAxes);
    expect(document.querySelector('.es-dl__axes')).toBeNull();
    expect(fs.readFileSync('renderer/js/app.js', 'utf8')).toMatch(/this\._feedEmbeddedMultiAxis\(rawContent, this\._currentFunscriptPath\)/);
  });
});

// The first-use review's 2.1-2.5 (Dave, 2026-11-23: "No way to read the post
// is good, no idea what the script is like is great, fixed scripts is a good
// suggestion length check before download is great, marking uploads by other
// creators great, implement all").
describe('judging a post before downloading it (review 2.1-2.5)', () => {
  const V2 = 'https://discuss.eroscripts.com/uploads/short-url/v2.funscript';
  const ALT = 'https://discuss.eroscripts.com/uploads/short-url/alt.funscript';

  it('2.5 the scripter\'s fixed script in a reply is the one chosen; the post\'s own and another user\'s stay under More options', async () => {
    answer.replyScripts = [
      { name: 'PMVMIX12 v2.funscript', url: V2, postNumber: 23, username: 'HandyEnjoyer', createdAt: '2026-11-20T10:00:00Z', likes: 4 },
      { name: 'PMVMIX12 alt.funscript', url: ALT, postNumber: 9, username: 'someone', createdAt: '2026-11-10T10:00:00Z', likes: 0 },
    ];
    const { view } = makeView();
    await openWindow(view);
    expect(rowValue(0).querySelector('.es-card__have').textContent).toBe('PMVMIX12 v2.funscript');
    expect(rowValue(0).querySelector('.es-dl__prov--scripter').textContent).toContain(TAB.dl.scriptFromScripter.split(',')[0]);
    const names = [...document.querySelectorAll('.es-view__script span')].map((n) => n.textContent);
    expect(names).toEqual([
      'PMVMIX12.funscript',
      `PMVMIX12 v2.funscript · ${fill(TAB.dl.scriptReplyLabel, { post: 23, user: 'HandyEnjoyer' })} (${TAB.post.scripter})`,
      `PMVMIX12 alt.funscript · ${fill(TAB.dl.scriptReplyLabel, { post: 9, user: 'someone' })}`,
    ]);
    mainBtn().click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsDownload).toHaveBeenCalled());
    expect(window.funsync.eroscriptsDownload.mock.calls[0][0]).toBe(V2);
  });

  it('2.5 only another user\'s script in a reply: never chosen over the post\'s, and marked "not the scripter" when picked', async () => {
    answer.replyScripts = [{ name: 'Mine.funscript', url: ALT, postNumber: 9, username: 'someone', createdAt: '2026-11-10T10:00:00Z', likes: 0 }];
    const { view } = makeView();
    await openWindow(view);
    expect(rowValue(0).querySelector('.es-card__have').textContent).toBe('PMVMIX12.funscript');
    const radios = [...document.querySelectorAll('.es-view__script input')];
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event('change'));
    expect(rowValue(0).querySelector('.es-dl__prov--other').classList.contains('es-dl__sub--warn')).toBe(true);
  });

  it('2.4 reply links: the scripter\'s own before a re-upload by someone else; each says who, with likes', async () => {
    const REUP = 'https://pixeldrain.com/u/reup1';
    const OWN = 'https://pixeldrain.com/u/own2';
    answer.links = [{ url: PIX, text: 'PMVMIX12.mp4 ~ pixeldrain' }];
    answer.replyLinks = [
      { url: REUP, text: 'mirror', postNumber: 30, username: 'uploader', createdAt: '2026-11-21T10:00:00Z', likes: 5 },
      { url: OWN, text: 'new link', postNumber: 12, username: 'handyenjoyer', createdAt: '2026-11-15T10:00:00Z', likes: 0 },
    ];
    classified[REUP] = { kind: 'filehost', host: 'pixeldrain', supported: true };
    classified[OWN] = { kind: 'filehost', host: 'pixeldrain', supported: true };
    checks[PIX] = { status: 'dead' };
    checks[REUP] = { status: 'ok', size: 2900000000 };
    checks[OWN] = { status: 'ok', size: 3282000000 };
    const { view } = makeView();
    await openWindow(view);
    // The scripter's new link is offered, though the re-upload is newer.
    expect(rowValue(1).querySelector('.es-dl__prov--scripter').textContent).toContain(TAB.dl.byScripter.split(',')[0]);
    const why = [...document.querySelectorAll('.es-dl__more .es-view__link')].map((r) => r.querySelector('.es-view__why')?.textContent || '');
    const reup = why.find((w) => w.includes('@uploader'));
    expect(reup).toContain(TAB.dl.reupBy.split(' @')[0]);
    expect(reup).toContain('5 likes');
  });

  it('2.4 a re-upload not the size of the post\'s own link says so', async () => {
    const REUP = 'https://pixeldrain.com/u/reup1';
    answer.links = [{ url: PIX, text: 'PMVMIX12.mp4 ~ pixeldrain' }];
    answer.replyLinks = [{ url: REUP, text: 'mirror', postNumber: 30, username: 'uploader', createdAt: '2026-11-21T10:00:00Z', likes: 0 }];
    classified[REUP] = { kind: 'filehost', host: 'pixeldrain', supported: true };
    checks[REUP] = { status: 'ok', size: 2900000000 };
    const { view } = makeView();
    await openWindow(view);
    const reup = [...document.querySelectorAll('.es-dl__more .es-view__link')].find((r) => r.textContent.includes('@uploader'));
    expect(reup.querySelector('.es-view__why').textContent).toContain(fill(TAB.dl.sizeDiffers, { size: '2.9 GB', original: '3.3 GB' }));
  });

  it('2.2 the script before it is downloaded: a heatmap, length, actions and speeds; "very fast" over 600 u/s; its other channels', async () => {
    preview = { ok: true, actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }, { at: 2100, pos: 100 }], metaDuration: null, channels: ['roll'] };
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-dl__heat')).toBeTruthy());
    expect(window.funsync.eroscriptsScriptPreview).toHaveBeenCalledWith(answer.attachments[0].url);
    expect(document.querySelector('.es-dl__stats').textContent).toBe(fill(TAB.preview.stats, { length: '0:02', count: '4', avg: 400, max: 1000 }));
    const lines = [...rowValue(0).querySelectorAll('.es-dl__sub')].map((l) => l.textContent);
    expect(lines).toContain(fill(TAB.preview.fast, { limit: 600 }));
    expect(lines).toContain(fill(TAB.preview.channels, { list: 'roll' }));
  });

  it('2.3 the host\'s length against the script\'s: a script past the video\'s end is a different cut', async () => {
    checks[PIX] = { status: 'ok', size: 3282000000, name: 'PMVMIX12.mp4', duration: 100 };
    preview = { ok: true, actions: [{ at: 0, pos: 0 }, { at: 130000, pos: 100 }], metaDuration: null, channels: [] };
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-dl__len-verdict')).toBeTruthy());
    expect(document.querySelector('.es-dl__len').textContent).toBe(fill(TAB.lenCheck.fromHost, { length: '1:40', host: 'Pixeldrain' }));
    const verdict = document.querySelector('.es-dl__len-verdict');
    expect(verdict.textContent).toBe(fill(TAB.lenCheck.pastEnd, { script: '2:10', video: '1:40' }));
    expect(verdict.classList.contains('es-dl__sub--warn')).toBe(true);
  });

  it('2.3 the post\'s stated length never vouches for someone else\'s re-upload (B005)', async () => {
    // Test day 2026-11-24, "Collect Mandy's Rent - GTA VI": the post says 6:40,
    // the only working link was a re-upload in reply #2; the window said
    // "Lengths match (script 6:40, video 6:40)" and the download was a 0:51 clip.
    const REUP = 'https://pixeldrain.com/u/reup51';
    answer.links = [];
    answer.replyLinks = [{ url: REUP, text: 'reup', postNumber: 2, username: 'yakuzadragon', createdAt: '2026-11-22T10:00:00Z', likes: 1 }];
    classified[REUP] = { kind: 'filehost', host: 'pixeldrain', supported: true };
    checks[REUP] = { status: 'ok', size: 15279710 };
    answer.post = { postNumber: 1, username: 'handyenjoyer', createdAt: null, likes: 0, cooked: '<p>Video length: 6:40</p>' };
    answer.replies = [];
    preview = { ok: true, actions: [{ at: 0, pos: 0 }, { at: 400000, pos: 100 }], metaDuration: 400, channels: [] };
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-dl__stats')).toBeTruthy());
    expect(document.querySelector('.es-dl__len-verdict')).toBeNull();                 // no "Lengths match"
    expect(document.querySelector('.es-dl__len').textContent).toBe(fill(TAB.lenCheck.fromPost, { length: '6:40' }));
    expect(rowValue(1).textContent).toContain(TAB.lenCheck.reupUnknown);
  });

  it('2.3 "Lengths match" names the length the script was MADE for, not a second script length (test day 2026-11-24)', async () => {
    // Gofile post 350043: the stats said 24:27 (the last action) and the
    // verdict "Lengths match (script 24:26, video 24:26)" (the length in the
    // script's metadata): two different script lengths in one window.
    checks[PIX] = { status: 'ok', size: 350603988, name: 'TS-02.mp4', duration: 1466 };
    preview = { ok: true, actions: [{ at: 0, pos: 0 }, { at: 1467000, pos: 100 }], metaDuration: 1466, channels: [] };
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-dl__len-verdict')).toBeTruthy());
    expect(document.querySelector('.es-dl__stats').textContent).toContain('24:27');
    expect(document.querySelector('.es-dl__len-verdict').textContent)
      .toBe('Lengths match: the script was made for a 24:26 video; this one is 24:26');
  });

  it('2.3 the length the post states counts too; a fitting script is no warning', async () => {
    answer.post = { postNumber: 1, username: 'handyenjoyer', createdAt: null, likes: 0, cooked: '<p>Duration: 2:10</p>' };
    answer.replies = [];
    preview = { ok: true, actions: [{ at: 0, pos: 0 }, { at: 128000, pos: 100 }], metaDuration: null, channels: [] };
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-dl__len-verdict')).toBeTruthy());
    expect(document.querySelector('.es-dl__len').textContent).toBe(fill(TAB.lenCheck.fromPost, { length: '2:10' }));
    const verdict = document.querySelector('.es-dl__len-verdict');
    expect(verdict.textContent).toBe(fill(TAB.lenCheck.fits, { script: '2:08', video: '2:10' }));
    expect(verdict.classList.contains('es-dl__sub--warn')).toBe(false);
  });

  it('2.3 after the download: a video shorter than its script says so (local ffprobe, no forum request)', async () => {
    window.funsync.fetchMetadata = vi.fn(async () => ({ duration: 100 }));
    window.funsync.readFunscript = vi.fn(async () => JSON.stringify({ actions: [{ at: 0, pos: 0 }, { at: 130000, pos: 100 }] }));
    const { view } = makeView();
    await openWindow(view);
    mainBtn().click();
    await vi.waitFor(() => expect(jobs.length).toBe(1));
    jobs = [{ ...jobs[0], status: 'done', bytes: 10, total: 10, path: 'C:\\Lib\\Pmv mix vol. 12.mp4' }];
    await view._refreshJobs();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(
      fill(TAB.lenCheck.afterDownload, { name: 'Pmv mix vol. 12', video: '1:40', script: '2:10' }), 'warn', 12000));
    expect(window.funsync.fetchMetadata).toHaveBeenCalledWith('C:\\Lib\\Pmv mix vol. 12.mp4');
  });

  it('2.1 the post: its text sanitised, forum images through main, another host\'s on a click, links outside, the replies folded', async () => {
    answer.post = {
      postNumber: 1, username: 'handyenjoyer', createdAt: null, likes: 3,
      cooked: '<p>Hi <b>all</b> <a href="https://example.com/x">site</a></p><script>window.__pwned = 1</script>'
        + '<p onclick="x()" style="color:red">click</p><img src="/uploads/default/a.png" width="200" height="100" onerror="window.__pwned = 2">'
        + '<img src="https://i.imgur.com/b.gif"><img class="emoji" alt=":smile:" src="/images/emoji/smile.png">',
    };
    answer.replies = [
      { postNumber: 2, username: 'fan', createdAt: '2026-11-20T10:00:00Z', likes: 1, cooked: '<p>thanks</p>' },
      { postNumber: 3, username: 'HandyEnjoyer', createdAt: '2026-11-21T10:00:00Z', likes: 0, cooked: '<p>v2 is up</p>' },
    ];
    answer.replyCount = 2;
    const { view } = makeView();
    await openWindow(view);
    const post = document.querySelector('.es-dl__post');
    expect(post.open).toBe(false);
    expect(post.querySelector('summary').textContent).toBe(`${TAB.post.title} · 2 replies`);
    expect(window.funsync.eroscriptsImage).not.toHaveBeenCalled();               // nothing loads while it is closed
    post.open = true;
    post.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(post.querySelector('.es-post__img img')).toBeTruthy());
    expect(window.funsync.eroscriptsImage).toHaveBeenCalledTimes(1);
    expect(window.funsync.eroscriptsImage).toHaveBeenCalledWith('https://discuss.eroscripts.com/uploads/default/a.png', { external: false });
    expect(store.get('eroscripts.postOpen')).toBe(true);
    const body = post.querySelector('.es-post');
    expect(body.textContent).toContain('Hi all');
    expect(body.textContent).toContain('😄');                               // an emoji image as its character
    expect(body.querySelector('script')).toBeNull();
    expect(body.innerHTML).not.toMatch(/onclick|onerror|style="color/);
    expect(window.__pwned).toBeUndefined();
    // Another host's image: only when asked.
    const ask = post.querySelector('.es-post__img-btn');
    expect(ask.textContent).toBe(fill(TAB.post.showImage, { host: 'i.imgur.com' }));
    ask.click();
    await vi.waitFor(() => expect(window.funsync.eroscriptsImage).toHaveBeenCalledWith('https://i.imgur.com/b.gif', { external: true }));
    // A link opens in the browser.
    body.querySelector('a.es-post__link').click();
    expect(window.funsync.openExternal).toHaveBeenCalledWith('https://example.com/x');
    // The replies, folded; the scripter's marked.
    const replies = post.querySelector('.es-post__replies');
    expect(replies.open).toBe(false);
    expect(replies.querySelectorAll('.es-post__reply').length).toBe(2);
    expect(replies.querySelector('.es-post__reply--op .es-post__reply-head').textContent).toContain(`@HandyEnjoyer (${TAB.post.scripter})`);
  });

  it('2.1 an image that does not come says so, with the way to open it', async () => {
    window.funsync.eroscriptsImage = vi.fn(async () => ({ error: 'Image failed (404)', httpStatus: 404 }));
    answer.post = { postNumber: 1, username: 'handyenjoyer', createdAt: null, likes: 0, cooked: '<img src="/uploads/default/gone.png">' };
    store.set('eroscripts.postOpen', true);
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(document.querySelector('.es-post__img-failed')).toBeTruthy());
    expect(document.querySelector('.es-post__img-failed').textContent).toBe(fill(TAB.post.imageFailed, { host: 'discuss.eroscripts.com' }));
  });
});

// "Suggested for you" (Dave, 2026-11-24): a built-in feed from the library's
// taste tags; posts the user has or has linked are left out, newest first.
describe('the Suggested feed (Dave, 2026-11-24)', () => {
  const linked = (n, tags) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`C:\\Lib\\v${i}.mp4`, { topicId: 900 + i, tags: tags(i) }]));
  const post = (id, tags) => ({ id, title: `Post ${id}`, categoryId: 14, creator: 'maker', tags });

  function libraryWithTaste() {
    store.set('library.scriptTags', linked(10, (i) => ['non-vr', 'real', 'len-5-10', 'the-handy', ...(i < 6 ? ['blowjob'] : []), ...(i < 4 ? ['pov'] : [])]));
    window.funsync.eroscriptsTags = vi.fn(async () => ({ tags: [{ name: 'non-vr', count: 1 }, { name: 'real', count: 1 }, { name: 'blowjob', count: 1 }, { name: 'pov', count: 1 }] }));
  }
  // The forum's newest script posts (the baseline): real on all, blowjob on 5, pov on 1.
  const BASELINE = Array.from({ length: 20 }, (_, i) => ({ id: 5000 + i, title: 'b', categoryId: 14, tags: ['real', ...(i < 5 ? ['blowjob'] : []), ...(i < 1 ? ['pov'] : []), ...(i >= 12 ? ['hentai'] : [])] }));
  const latestWith = (suggested) => vi.fn(async (price, page, opts) => ({ results: opts?.anyTags ? suggested : (page === 0 ? BASELINE : []), more: false }));

  it('asks the forum for ANY of the library\'s taste tags (no length, device or format tags); leaves out what you have, linked, the other format', async () => {
    libraryWithTaste();
    store.set('eroscripts.downloaded', { 5: { video: 'C:\\Lib\\had.mp4' } });
    window.funsync.eroscriptsLatest = latestWith([post(1, ['blowjob', 'non-vr']), post(5, ['pov']), post(900, ['blowjob']), post(6, ['pov', 'vr']), post(7, ['pov']), post(8, ['pov', 'hentai']), post(9, ['real'])]);
    const { view } = makeView();
    view.openFeed('suggested');
    await vi.waitFor(() => expect(cards().length).toBe(2));
    expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('all', 0, { sort: 'newest', period: 'all', tags: ['pov', 'blowjob', 'real'], anyTags: true });
    // 5 downloaded, 900 linked to a library video, 6 is VR in a 2D library, 8 is hentai (the
    // library has none, the forum's posts often), 9 has only the broad "real": left out.
    expect(cards().map((c) => c.querySelector('.es-card__title').textContent)).toEqual(['Post 1', 'Post 7']);
    expect(document.querySelector('.es-view__heading').textContent).toBe(TAB.suggest.chip);
    expect([...document.querySelectorAll('.es-suggest__tag:not(.es-suggest__tag--avoid)')].map((t) => t.textContent)).toEqual(['pov', 'blowjob', 'real']);
    expect([...document.querySelectorAll('.es-suggest__tag--avoid')].map((t) => t.textContent)).toEqual(['hentai']);
    expect(cards()[0].querySelector('.es-card__why-text').textContent).toBe(fill(TAB.suggest.because, { tags: 'blowjob' }));
    expect(document.querySelector('.es-feed--suggested').getAttribute('aria-pressed')).toBe('true');
    expect(view._feedEditBtn.hidden).toBe(true);                    // nothing to edit: it is made from the library
  });

  it('Not interested hides the card and is remembered; Undo brings it back', async () => {
    libraryWithTaste();
    window.funsync.eroscriptsLatest = latestWith([post(1, ['blowjob']), post(2, ['pov'])]);
    const { view } = makeView();
    view.openFeed('suggested');
    await vi.waitFor(() => expect(cards().length).toBe(2));
    cards()[0].querySelector('.es-card__not').click();
    expect(cards().map((c) => c.querySelector('.es-card__title').textContent)).toEqual(['Post 2']);
    expect(Object.keys(store.get('eroscripts.suggestDismissed'))).toEqual(['1']);
    expect(showUndoToast).toHaveBeenCalledWith(TAB.suggest.dismissed, expect.any(Function), 'info', 6000);
    showUndoToast.mock.calls.at(-1)[1]();                            // Undo
    expect(store.get('eroscripts.suggestDismissed')).toEqual({});
    await vi.waitFor(() => expect(cards().length).toBe(2));
    cards()[0].querySelector('.es-card__not').click();
    view._loadLatest(true);
    await vi.waitFor(() => expect(cards().length).toBe(1));
  });

  it('leaving a tag out asks again without it; no linked posts says how to get suggestions', async () => {
    libraryWithTaste();
    window.funsync.eroscriptsLatest = latestWith([post(1, ['blowjob'])]);
    const { view } = makeView();
    view.openFeed('suggested');
    await vi.waitFor(() => expect(document.querySelectorAll('.es-suggest__tag:not(.es-suggest__tag--avoid)').length).toBe(3));
    document.querySelector('.es-suggest__out').click();              // leave "pov" out
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('all', 0, expect.objectContaining({ tags: ['blowjob', 'real'] })));
    expect(store.get('eroscripts.suggestLeftOut')).toEqual(['pov']);
    // A library with nothing linked: the way to get suggestions, and no forum request for it.
    store.set('library.scriptTags', {});
    window.funsync.eroscriptsLatest.mockClear();
    view._loadLatest(true);
    await vi.waitFor(() => expect(document.querySelector('.es-view__empty, .es-view__note')?.textContent || document.body.textContent).toContain(TAB.suggest.none.slice(0, 30)));
    expect(window.funsync.eroscriptsLatest).not.toHaveBeenCalled();
  });
});

// Gofile (Dave, 2026-11-24: "I know has a gofile link so why is the ui telling
// me theres no video download"): the app resolves it (electron/gofile.js).
describe('Gofile links (2026-11-24)', () => {
  const GOFILE = 'https://gofile.io/d/UX0LG6wr';
  const RESOLVED = { ok: true, name: 'TRANSGENDER SURPRISE.mp4', size: 350603988, link: 'https://file-na-phx-1.gofile.io/download/web/b/x.mp4', cookie: 'accountToken=abcdefghij0123456789', count: 1 };

  it('the window shows the Gofile video as working, with its size; Download sends the app\'s resolution to the backend', async () => {
    answer.links = [{ url: GOFILE, text: 'Gofile' }];
    classified[GOFILE] = { kind: 'filehost', host: 'gofile', supported: true, needsApp: true };
    window.funsync.gofileResolve = vi.fn(async () => RESOLVED);
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(rowValue(1).textContent).toContain('351 MB'));
    expect(rowValue(1).textContent).toContain(fill(TAB.dl.from, { host: 'Gofile' }));
    expect(rowValue(1).querySelector('.es-dot--ok')).toBeTruthy();
    expect(mainBtn().textContent).toBe(TAB.dl.both);
    mainBtn().click();
    await vi.waitFor(() => expect(calls.some((c) => c.path === '' && c.method === 'POST')).toBe(true));
    const start = calls.find((c) => c.path === '' && c.method === 'POST');
    expect(start.body).toMatchObject({ url: GOFILE, resolved: { link: RESOLVED.link, name: RESOLVED.name, size: RESOLVED.size, cookie: RESOLVED.cookie } });
    expect(window.funsync.gofileResolve).toHaveBeenCalledWith(GOFILE, 'PMVMIX12.funscript');   // the script's name picks among several
  });

  it('a Gofile folder that is gone says so; one that needs a password says so and starts nothing', async () => {
    answer.links = [{ url: GOFILE, text: 'Gofile' }];
    classified[GOFILE] = { kind: 'filehost', host: 'gofile', supported: true, needsApp: true };
    window.funsync.gofileResolve = vi.fn(async () => ({ error: 'notFound' }));
    const { view } = makeView();
    await openWindow(view);
    await vi.waitFor(() => expect(rowValue(1).textContent).toBe(TAB.dl.allDead));
    // A password: the link stays (not checked), Download explains and starts no job.
    window.funsync.gofileResolve = vi.fn(async () => ({ error: 'password' }));
    const r = await view._download(view._dl.post, { ...view._dl.post.links[0], check: null }, null);
    expect(r).toBe(false);
    expect(showToast).toHaveBeenCalledWith(TAB.err.password, 'error');
    expect(calls.some((c) => c.path === '' && c.method === 'POST')).toBe(false);
  });
});

// Test day 2026-11-24, B029: with the login expired every card check came back
// 401 / 403, and the tab went on to the next post every 0.8 s, said nothing,
// and never asked those posts again after a sign-in.
describe('card checks with a dead login (B029)', () => {
  it('a 401 / 403 asks the panel to check the login, once; the checks wait, and carry on after a sign-in', async () => {
    const { view, panel } = makeView();
    view._checker = { start: vi.fn(), stop: vi.fn(), checkIfStale: vi.fn(async () => {}) };
    view._loadLatest = vi.fn();   // in the app a list is showing; a NEW list would replace the queue
    panel.handleSessionExpired.mockResolvedValue('expired');
    window.funsync.eroscriptsTopic = vi.fn(async () => ({ attachments: [], error: 'Access denied', errorCode: 'accessDenied', authExpired: true }));
    view._probe.clearQueue();
    view._probe.enqueue(['90101', '90102', '90103']);
    // Only this test's posts: earlier tests' views are still checking theirs.
    const mine = () => window.funsync.eroscriptsTopic.mock.calls.map((c) => c[0]).filter((id) => id >= 90101 && id <= 90103);
    await new Promise((r) => setTimeout(r, 2000));
    expect(mine()).toEqual([90101]);
    expect(panel.handleSessionExpired).toHaveBeenCalledTimes(1);

    window.funsync.eroscriptsTopic = vi.fn(async () => answer);
    view.onLoginChanged(true);
    await vi.waitFor(() => expect(mine()).toEqual([90101, 90102, 90103]), { timeout: 5000 });
    view._probe.clearQueue();
  }, 15000);
});

// Dave, 2026-11-25: "i started a download closed the app reopened and
// downloaded again, it seemed to resume the download but there was no
// indicator that the download could resume". The backend now keeps its list
// (<userData>/downloads.json) and a running download comes back paused and
// `interrupted`, with the tab's note on it (`meta`).
describe('a download stopped when FunSync closed', () => {
  const SCRIPT_URL = 'https://discuss.eroscripts.com/uploads/a.funscript';
  let downloadMeta;
  beforeEach(async () => { ({ downloadMeta } = await import('../../renderer/js/download-meta.js')); });
  const stopped = (extra = {}) => ({
    id: 'r1', status: 'paused', interrupted: true, resumable: true, stem: 'Pmv mix vol. 12', destDir: 'C:\\Lib',
    host: 'pixeldrain', bytes: 1641000000, total: 3282000000, speed: 0, url: PIX, path: '',
    meta: downloadMeta({ topic: TOPIC, answer, script: { url: SCRIPT_URL, name: 'PMVMIX12.funscript' }, title: TOPIC.title }),
    ...extra,
  });

  it("its card offers Resume and says how far it got; Resume continues it; it lands as its post's", async () => {
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    jobs = [stopped()];
    expect(await view._refreshJobs()).toBe(true);
    const card = cards()[0];
    const words = fill(TAB.status.interrupted, { percent: 50, size: '3.3 GB' });
    expect(card.querySelector('.es-card__btn').textContent).toBe(TAB.card.resume);
    expect(card.querySelector('.es-card__status').textContent).toBe(words);
    expect(card.querySelector('.es-card__progress').hidden).toBe(false);
    expect(card.querySelector('.es-card__progress-fill').style.width).toBe('50%');
    // The Downloads button counts it; its row says the same and offers Resume / Discard.
    expect(document.querySelector('.es-view__dl-btn').getAttribute('aria-label')).toBe(fill(TAB.downloadsPaused, { count: 1 }));   // an icon since 2026-11-25
    expect(document.querySelector('.es-view__dl-badge').textContent).toBe('1');
    expect(document.querySelector('.es-view__dl-badge').classList.contains('es-view__dl-badge--paused')).toBe(true);
    expect(document.querySelector('.es-view__job-status').textContent).toBe(words);
    expect(document.querySelector('.es-view__job-actions button').getAttribute('aria-label')).toBe(TAB.card.resume);

    card.querySelector('.es-card__btn').click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/r1/resume')).toBe(true));
    expect(calls.find((c) => c.path === '/r1/resume').body).toBeNull();      // nothing to look up again

    jobs = [{ ...stopped(), status: 'done', interrupted: false, bytes: 3282000000, path: 'C:\\Lib\\Pmv mix vol. 12.mp4' }];
    await view._refreshJobs();
    // The script was saved when it started and is still there: not fetched again.
    expect(window.funsync.fileExists).toHaveBeenCalledWith('C:\\Lib\\Pmv mix vol. 12.funscript');
    expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();
    expect(store.get('eroscripts.downloaded')[TOPIC.id]).toMatchObject({ video: 'C:\\Lib\\Pmv mix vol. 12.mp4', script: 'C:\\Lib\\Pmv mix vol. 12.funscript' });
    expect(store.get('library.scriptTags')['C:\\Lib\\Pmv mix vol. 12.mp4'])
      .toMatchObject({ topicId: TOPIC.id, tags: recordedTags(['pmv', 'the-handy', 'non-vr']) });
    expect([part(card, 'video'), part(card, 'script')]).toEqual(['done', 'done']);
  });

  it('when its script did not make it at the start, finishing saves it', async () => {
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    window.funsync.fileExists = vi.fn(async () => false);
    jobs = [{ ...stopped(), status: 'done', interrupted: false, bytes: 3282000000, path: 'C:\\Lib\\Pmv mix vol. 12.mp4' }];
    await view._refreshJobs();
    await vi.waitFor(() => expect(window.funsync.eroscriptsDownload).toHaveBeenCalledWith(SCRIPT_URL, 'C:\\Lib\\Pmv mix vol. 12.funscript'));
  });

  it('a paused one you paused yourself reads as before', async () => {
    const { view } = makeView();
    jobs = [stopped({ interrupted: false })];
    await view._refreshJobs();
    expect(document.querySelector('.es-view__job-status').textContent).toBe(fill(TAB.status.paused, { percent: 50, size: '3.3 GB' }));
  });

  it('at start it is said once, with Show opening the Downloads list', async () => {
    // As the app makes it at start: not built, not shown.
    const view = new EroScriptsView({
      container: document.getElementById('eroscripts-container'),
      panel: { dock: vi.fn(), undock: vi.fn(), show: vi.fn(), search: vi.fn(), handleSessionExpired: vi.fn() },
      settings: settings(), getBackendPort: () => 5123, showTab: vi.fn(),
    });
    jobs = [stopped()];
    const dismiss = vi.fn();
    showToast.mockReturnValueOnce({ dismiss, el: null });
    expect(await view.checkInterruptedDownloads({ tries: 1, waitMs: 0 })).toBe(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    const msg = showToast.mock.calls[0][0];
    expect(msg.textContent).toContain(fill(TAB.interrupted.one, { name: TOPIC.title, percent: 50 }));
    msg.querySelector('button').click();
    expect(view._showTab).toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalled();                     // done with: it goes (live, 2026-11-25)
    expect(document.querySelector('.es-view__dl-pop').hidden).toBe(false);
    await vi.waitFor(() => expect(document.querySelector('.es-view__job-status')?.textContent).toBe(fill(TAB.status.interrupted, { percent: 50, size: '3.3 GB' })));

    // Two: counted. None: nothing said. The backend not up yet: asked again, then nothing.
    showToast.mockClear();
    jobs = [stopped(), stopped({ id: 'r2', stem: 'Other' })];
    expect(await view.checkInterruptedDownloads({ tries: 1, waitMs: 0 })).toBe(2);
    expect(showToast.mock.calls[0][0].textContent).toContain(fill(TAB.interrupted.many, { count: 2 }));
    showToast.mockClear();
    jobs = [stopped({ interrupted: false })];
    expect(await view.checkInterruptedDownloads({ tries: 1, waitMs: 0 })).toBe(0);
    globalThis.fetch = vi.fn(async () => { throw new Error('backend starting'); });
    expect(await view.checkInterruptedDownloads({ tries: 2, waitMs: 0 })).toBe(0);
    expect(globalThis.fetch.mock.calls.filter(([url]) => /\/api\/downloads$/.test(String(url))).length).toBe(2);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a Gofile one is looked up again on Resume (its cookie is never saved)', async () => {
    const { view } = makeView();
    jobs = [stopped({ id: 'g1', host: 'gofile', url: 'https://gofile.io/d/UX0LG6wr', needsResolve: true })];
    await view._refreshJobs();
    window.funsync.gofileResolve = vi.fn(async () => ({ ok: false, error: 'failed' }));
    document.querySelector('.es-view__job-actions button').click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(calls.some((c) => c.path === '/g1/resume')).toBe(false);
    const resolved = { link: 'https://file-na-phx-1.gofile.io/download/web/b/C.mp4', name: 'C.mp4', size: 10, cookie: 'accountToken=abcdefghij0123456789' };
    window.funsync.gofileResolve = vi.fn(async () => ({ ok: true, ...resolved }));
    document.querySelector('.es-view__job-actions button').click();
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/g1/resume')).toBe(true));
    expect(window.funsync.gofileResolve).toHaveBeenCalledWith('https://gofile.io/d/UX0LG6wr', 'PMVMIX12.funscript');
    expect(calls.find((c) => c.path === '/g1/resume').body).toEqual({ resolved });
  });
});

// Break-it, 2026-11-25: with a download stopped (FunSync closed) or paused,
// pasting its link again, or Download in its post's window, started a SECOND
// copy from zero under "Name (1)" beside the stopped one: what Dave did this
// morning. The windows now say it is in Downloads and offer Resume (or Show
// while it runs); a fresh copy is "Download again".
describe('a link already in Downloads', () => {
  const SINTEL = 'https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv';
  beforeEach(() => {
    classified[SINTEL] = { kind: 'direct', host: 'download.blender.org', supported: true };
    checks[SINTEL] = { status: 'ok', name: 'Sintel.2010.1080p.mkv', size: 1180090590 };
  });
  const stoppedJob = (extra = {}) => ({ id: 's1', status: 'paused', interrupted: true, resumable: true, stem: 'Sintel.2010.1080p', destDir: 'C:\\Lib',
    host: 'download.blender.org', bytes: 165000000, total: 1180090590, speed: 0, url: SINTEL, path: '', meta: { v: 1, topicId: null, title: 'Sintel.2010.1080p' }, ...extra });

  it('pasted again: says so, Resume continues it (no second copy); Download again is still there', async () => {
    const { view } = makeView();
    jobs = [stoppedJob()];
    view.openPasteLink(SINTEL);
    await vi.waitFor(() => expect(document.querySelector('.es-paste .es-dl__actions')).toBeTruthy());
    const box = document.querySelector('.es-paste');
    expect(box.textContent).toContain(fill(TAB.paste.inDownloads, { status: fill(TAB.status.interrupted, { percent: 14, size: '1.2 GB' }) }));
    const main = box.querySelector('.es-dl__main');
    expect(main.textContent).toBe(TAB.card.resume);
    const again = [...box.querySelectorAll('.es-dl__actions button')].find((b) => b.textContent === TAB.paste.downloadAgain);
    expect(again).toBeTruthy();
    main.click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/s1/resume')).toBe(true));
    expect(calls.some((c) => c.method === 'POST' && c.path === '')).toBe(false);          // no new download
    await vi.waitFor(() => expect(document.querySelector('.es-view__dl-pop').hidden).toBe(false));
    expect(document.querySelector('.es-paste')).toBeNull();                               // the window closed
  });

  it('pasted while it is still downloading: Show, not Resume', async () => {
    const { view } = makeView();
    jobs = [stoppedJob({ status: 'downloading', interrupted: false })];
    view.openPasteLink(SINTEL);
    await vi.waitFor(() => expect(document.querySelector('.es-paste .es-dl__main')).toBeTruthy());
    expect(document.querySelector('.es-paste .es-dl__main').textContent).toBe(TAB.interrupted.show);
  });

  it('a link not in Downloads (or only finished there) downloads as before', async () => {
    const { view } = makeView();
    jobs = [stoppedJob({ status: 'done', path: 'C:\\Lib\\Sintel.2010.1080p.mkv' })];
    view.openPasteLink(SINTEL);
    await vi.waitFor(() => expect(document.querySelector('.es-paste .es-dl__main')).toBeTruthy());
    expect(document.querySelector('.es-paste .es-dl__main').textContent).toBe(TAB.download);
  });

  it("a post's window with its video stopped in Downloads: Resume, and Download again beside it", async () => {
    const { view, panel } = makeView();
    panel.onResults([{ ...TOPIC }]);
    jobs = [stoppedJob({ id: 'p1', url: PIX, meta: { v: 1, topicId: TOPIC.id, title: TOPIC.title } })];
    await view._refreshJobs();
    await openWindow(view);
    const box = dlBox();
    expect(box.textContent).toContain(TAB.paste.inDownloads.split(':')[0]);
    expect(mainBtn().textContent).toBe(TAB.card.resume);
    expect([...box.querySelectorAll('.es-dl__actions button')].some((b) => b.textContent === TAB.paste.downloadAgain)).toBe(true);
    mainBtn().click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/p1/resume')).toBe(true));
    expect(calls.some((c) => c.method === 'POST' && c.path === '')).toBe(false);
  });
});

// Dave, 2026-11-25: "can we put the filter and sort options on the eroscripts
// tab under a menu or modal or drawer ... so that the results are the main
// feature of the page". Four rows of controls sat over the results: now the
// list's title, Sort, Filters (a count, the choices in a popover as the
// Library's), the view, Refresh and Select share one row; what is set shows
// as chips under it.
describe('the tidied bar: Filters in a popover, chips for what is set', () => {
  const topic = (id, extra = {}) => ({ id, title: `Thread ${id}`, categoryId: 14, creator: 'maker', ...extra });
  const pop = () => document.querySelector('.es-view__filters-pop');
  const btn = () => document.querySelector('.es-view__filters-btn');
  const badge = () => document.querySelector('.es-view__filters-badge');
  const chips = () => [...document.querySelectorAll('.es-view__chips .filter-chip')];
  const toolbar = () => document.querySelector('.es-view__toolbar');

  it('one bar: the title, Sort and Filters on it; the filter choices and tag boxes inside the closed popover; Refresh an icon with its name', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [topic(1)], more: false }));
    makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(toolbar().querySelector('.es-view__heading').textContent).toBe(TAB.latest.all);
    expect(toolbar().querySelector('select[data-k=sort]').closest('.es-view__filters-pop')).toBeNull();   // Sort stays on the bar
    for (const k of ['video', 'length', 'device', 'get']) {
      expect(pop().querySelector(`select[data-k=${k}]`), k).toBeTruthy();
    }
    expect(pop().querySelector('.es-view__tags-host input')).toBeTruthy();
    expect(pop().querySelector('.es-view__hide-host input')).toBeTruthy();
    expect(pop().hidden).toBe(true);
    expect(btn().textContent).toContain(EN.library.filters);
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(badge().hidden).toBe(true);                                // nothing set
    expect(document.querySelector('.es-view__chips').hidden).toBe(true);
    const refresh = document.querySelector('.es-view__refresh');
    expect(refresh.querySelector('svg')).toBeTruthy();
    expect(refresh.querySelector('.es-sr-only').textContent).toBe(TAB.feeds.refresh);
  });

  it('Filters opens and closes it; from the keyboard the focus goes in; Escape closes it back to Filters; a press outside closes it', async () => {
    makeView();
    btn().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(pop().hidden).toBe(false);
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    btn().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(pop().hidden).toBe(true);
    btn().focus();
    btn().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));      // Enter / Space
    expect(pop().contains(document.activeElement)).toBe(true);
    expect(document.activeElement.dataset.k).toBe('video');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(esc);
    expect(pop().hidden).toBe(true);
    expect(esc.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(btn());
    btn().click();
    pop().querySelector('select[data-k=length]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(false);                                 // inside: stays
    document.querySelector('.es-grid').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(pop().hidden).toBe(true);                                  // outside: closes
  });

  it('what is set shows as chips and a count; a chip\'s × takes that one off; Clear all takes them all off in one new list', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [topic(1)], more: false }));
    store.set('eroscripts.filters', { video: 'vr', length: 'any', device: 'any', tags: ['tentacle'], hide: ['pmv'] });
    store.set('eroscripts.needFilter', 'video');
    const { view } = makeView();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(chips().map((c) => c.textContent)).toEqual([TAB.fVideo.vr, TAB.fGet.video, 'tentacle', TAB.chip.hide.replace('{tag}', 'pmv')]);
    expect(badge().hidden).toBe(false);
    expect(badge().textContent).toBe('4');
    // One off: the VR chip.
    chips()[0].click();
    await vi.waitFor(() => expect(store.get('eroscripts.filters').video).toBe('any'));
    expect(view._toolbar.querySelector('select[data-k=video]').value).toBe('any');
    expect(badge().textContent).toBe('3');
    // A tag's chip: off the tag box too.
    const boxChips = () => document.querySelectorAll('.es-view__tags-host .es-taginput__chip').length;
    expect(boxChips()).toBe(1);
    chips().find((c) => c.textContent === 'tentacle').click();
    expect(store.get('eroscripts.filters').tags).toEqual([]);
    expect(boxChips()).toBe(0);
    // Clear all: the rest, one new request.
    const before = window.funsync.eroscriptsLatest.mock.calls.length;
    document.querySelector('.es-view__chips-clear').click();
    expect(store.get('eroscripts.filters')).toEqual({ video: 'any', length: 'any', device: 'any', tags: [], hide: [] });
    expect(store.get('eroscripts.needFilter')).toBe('any');
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest.mock.calls.length).toBe(before + 1));
    expect(chips()).toHaveLength(0);
    expect(badge().hidden).toBe(true);
    expect(document.querySelector('.es-view__chips').hidden).toBe(true);
  });

  it('a single chip has no Clear all; a choice made in the popover shows as a chip at once', async () => {
    makeView();
    const length = pop().querySelector('select[data-k=length]');
    length.value = length.options[1].value;
    length.dispatchEvent(new Event('change'));
    expect(chips().map((c) => c.textContent)).toEqual([length.options[1].textContent]);
    expect(document.querySelector('.es-view__chips-clear')).toBeNull();
    expect(badge().textContent).toBe('1');
  });
});

// Dave, 2026-11-25: "on the post preview for eroscripts i cant at the moment
// see tags". The window showed the price, the scripter and Open post; the
// post's tags (on the forum, and on the cards only as VR / length / axes)
// were nowhere in it.
describe("a post's window shows its tags", () => {
  it('every tag of the post, as the forum names them (a length tag as the cards read it); the list\'s tags while the post loads', async () => {
    let release;
    window.funsync.eroscriptsTopic = vi.fn(() => new Promise((r) => { release = () => r({ ...answer, tags: mainTags(['pmv', 'the-handy', 'non-vr', 'len-10-25']) }); }));
    const { view } = makeView();
    view.openPost({ ...TOPIC, tags: ['pmv', 'non-vr'] });
    const tags = () => [...document.querySelectorAll('.es-dl .es-dl__tags .es-dl__tag')].map((el) => el.textContent);
    await vi.waitFor(() => expect(tags()).toEqual(['pmv', 'non-vr']));           // from the list, at once
    expect(document.querySelector('.es-dl__tags').getAttribute('aria-label')).toBe(TAB.tool.tags);
    release();
    await vi.waitFor(() => expect(tags()).toEqual(['pmv', 'the-handy', 'non-vr', TAB.len['10_25']]));   // the post's own, complete
    expect([...document.querySelectorAll('.es-dl__tag')].at(-1).title).toBe(TAB.dl.tagShow.replace('{tag}', 'len-10-25'));
  });

  it('a post with no tags: no empty row', async () => {
    answer = { ...answer, tags: [] };
    const { view } = makeView();
    await openWindow(view, { ...TOPIC, tags: [] });
    expect(document.querySelector('.es-dl__tags')).toBeNull();
  });
});

// Dave, 2026-11-25: "instead of the user name and a log out button have the
// users profile picture or an avatar with an arrow button next to it which
// opens a dropdown with the logout option ... on the far right side ... and
// replace the download and paste item buttons with icons that have tooltips".
describe('the top row: Paste and Downloads as icons, your account far right', () => {
  function viewWith(over = {}) {
    const panel = {
      dock: vi.fn(), undock: vi.fn(), show: vi.fn(), search: vi.fn(), handleSessionExpired: vi.fn(),
      isLoggedIn: true, username: 'dave', avatarUrl: '', loginPending: false, openLogin: vi.fn(), logout: vi.fn(), ...over,
    };
    const view = new EroScriptsView({
      container: document.getElementById('eroscripts-container'),
      panel, settings: settings(), getBackendPort: () => 5123,
      isLibraryFolder: () => true, onSavedIntoLibrary: vi.fn(), playPath: vi.fn(),
    });
    view.show();
    return { view, panel };
  }
  const me = () => document.querySelector('.es-view__me');
  const meBtn = () => document.querySelector('.es-view__me-btn');
  const menu = () => document.querySelector('.es-view__me-menu');
  const img = () => document.querySelector('.es-view__avatar-img');
  const letter = () => document.querySelector('.es-view__avatar-letter');

  it('Paste and Downloads are icons with their words as name and tooltip; the account is the last thing on the row', () => {
    viewWith();
    const paste = document.querySelector('.es-view__paste-btn');
    const dl = document.querySelector('.es-view__dl-btn');
    for (const b of [paste, dl]) expect(b.querySelector('svg')).toBeTruthy();
    expect(paste.getAttribute('aria-label')).toBe(TAB.paste.button);
    expect(paste.title).toBe(TAB.paste.title);
    expect(dl.getAttribute('aria-label')).toBe(TAB.downloadsHeading);
    expect(document.querySelector('.es-view__dl-badge').hidden).toBe(true);      // nothing downloading
    const top = document.querySelector('.es-view__top');
    // Three parts on the row (2026-11-25, space-between): search, feeds, then Paste / Downloads / the account.
    expect([...top.children].map((el) => el.className.split(' ')[0])).toEqual(['es-view__search', 'es-view__feeds', 'es-view__actions']);
    expect(top.lastElementChild.lastElementChild.classList.contains('es-view__account')).toBe(true);
  });

  it('logged out: Log In opens the login window, "Waiting for login" while it is open; no picture', () => {
    const { view, panel } = viewWith({ isLoggedIn: false, username: '' });
    const login = document.querySelector('.es-view__login');
    expect(login.hidden).toBe(false);
    expect(login.textContent).toBe(EN.eroscripts.logIn);
    expect(me().hidden).toBe(true);
    login.click();
    expect(panel.openLogin).toHaveBeenCalledTimes(1);
    panel.loginPending = true;
    panel.onProfileChanged();
    expect(login.disabled).toBe(true);
    expect(login.textContent).toBe(EN.eroscripts.waitingLogin);
    // Signed in: the picture button takes its place, repainted by the panel's notice.
    Object.assign(panel, { loginPending: false, isLoggedIn: true, username: 'dave' });
    panel.onProfileChanged();
    expect(login.hidden).toBe(true);
    expect(me().hidden).toBe(false);
    expect(view).toBeTruthy();
  });

  // Dave, 2026-11-25, live: "the avatar isnt showing my profile picture from
  // eroscripts". The <img> asked the forum itself, with no login cookie: the
  // forum serves its uploads only with the session. The picture comes through
  // main now (eroscriptsImage, as a post's images): a data: address.
  const PIC = 'https://discuss.eroscripts.com/user_avatar/discuss.eroscripts.com/dave/64/9_2.png';
  const DATA = 'data:image/png;base64,iVBORw0KGgo=';

  it('logged in: the first letter until the picture is fetched (through main, with the session) and loaded; the picture then', async () => {
    window.funsync.eroscriptsImage = vi.fn(async () => ({ ok: true, dataUrl: DATA }));
    const { panel } = viewWith({ username: 'dave', avatarUrl: '' });
    expect(letter().textContent).toBe('D');
    expect(letter().hidden).toBe(false);
    expect(img().hidden).toBe(true);
    expect(meBtn().getAttribute('aria-label')).toBe(TAB.account.aria.replace('{user}', 'dave'));
    panel.avatarUrl = PIC;
    panel.onProfileChanged();
    expect(window.funsync.eroscriptsImage).toHaveBeenCalledWith(PIC, { external: true });
    await vi.waitFor(() => expect(img().getAttribute('src')).toBe(DATA));
    expect(img().getAttribute('src')).not.toBe(PIC);                    // never the forum address itself
    expect(img().hidden).toBe(true);                                   // not loaded yet
    img().dispatchEvent(new Event('load'));
    expect(img().hidden).toBe(false);
    expect(letter().hidden).toBe(true);
    panel.onProfileChanged();                                          // a repaint asks nothing more
    expect(window.funsync.eroscriptsImage).toHaveBeenCalledTimes(1);
    expect(img().hidden).toBe(false);
  });

  it('a picture main cannot fetch, or that will not draw, leaves the letter; it is not asked for again', async () => {
    window.funsync.eroscriptsImage = vi.fn(async () => ({ error: 'Image failed (403)', httpStatus: 403 }));
    const { panel } = viewWith({ username: 'dave', avatarUrl: PIC });
    await vi.waitFor(() => expect(window.funsync.eroscriptsImage).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(img().hidden).toBe(true);
    expect(img().getAttribute('src')).toBeNull();
    expect(letter().hidden).toBe(false);
    panel.onProfileChanged();
    expect(window.funsync.eroscriptsImage).toHaveBeenCalledTimes(1);
    // Another picture that fetches but will not draw.
    window.funsync.eroscriptsImage = vi.fn(async () => ({ ok: true, dataUrl: DATA }));
    panel.avatarUrl = PIC.replace('9_2', '10_2');
    panel.onProfileChanged();
    await vi.waitFor(() => expect(img().getAttribute('src')).toBe(DATA));
    img().dispatchEvent(new Event('error'));
    expect(img().hidden).toBe(true);
    expect(letter().hidden).toBe(false);
    panel.onProfileChanged();
    expect(window.funsync.eroscriptsImage).toHaveBeenCalledTimes(1);
  });

  it('an answer for a picture no longer wanted (logged out meanwhile) is not shown', async () => {
    let release;
    window.funsync.eroscriptsImage = vi.fn(() => new Promise((r) => { release = () => r({ ok: true, dataUrl: DATA }); }));
    const { panel } = viewWith({ username: 'dave', avatarUrl: PIC });
    Object.assign(panel, { isLoggedIn: false, username: '', avatarUrl: '' });
    panel.onProfileChanged();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(img().getAttribute('src')).toBeNull();
  });

  it('the chevron opens a menu naming the account with Log Out; Escape and a press outside close it; Log Out logs out', () => {
    const { panel } = viewWith();
    expect(menu().hidden).toBe(true);
    meBtn().click();
    expect(menu().hidden).toBe(false);
    expect(meBtn().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.es-view__me-name').textContent).toBe('@dave');
    const logout = menu().querySelector('[role=menuitem]');
    expect(logout.textContent).toBe(EN.eroscripts.logOut);
    logout.focus();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    logout.dispatchEvent(esc);
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(meBtn());
    meBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));   // from the keyboard
    expect(document.activeElement).toBe(logout);
    document.querySelector('.es-grid').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu().hidden).toBe(true);
    meBtn().click();
    logout.click();
    expect(panel.logout).toHaveBeenCalledTimes(1);
    expect(menu().hidden).toBe(true);
  });

  it('Downloads shows its count as a badge (the accent while running, grey when only paused)', async () => {
    const { view } = viewWith();
    jobs = [{ id: 'a', status: 'downloading', stem: 'A', host: 'pixeldrain', bytes: 1, total: 9, speed: 1, url: 'https://pixeldrain.com/u/a', path: '' }];
    await view._refreshJobs();
    const badge = document.querySelector('.es-view__dl-badge');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
    expect(badge.classList.contains('es-view__dl-badge--paused')).toBe(false);
    expect(document.querySelector('.es-view__dl-btn').title).toBe(fill(TAB.downloadsActive, { count: 1 }));
  });

  it('the Download filter offers Video and script', () => {
    viewWith();
    const get = document.querySelector('.es-tool__select[data-k=get]');
    expect([...get.options].map((o) => o.value)).toEqual(['any', 'video', 'script', 'both']);
    expect([...get.options].at(-1).textContent).toBe(TAB.fGet.both);
  });
});

// Dave, 2026-11-25: "make the tags clickable in the post window". A tag
// clicked: the posts with that tag, as a tag link on the forum.
describe("a post's tag, clicked", () => {
  function viewWithPanel() {
    const panel = { dock: vi.fn(), undock: vi.fn(), show: vi.fn(), search: vi.fn(), handleSessionExpired: vi.fn(), clearQuery: vi.fn() };
    const view = new EroScriptsView({
      container: document.getElementById('eroscripts-container'),
      panel, settings: settings(), getBackendPort: () => 5123,
      isLibraryFolder: () => true, onSavedIntoLibrary: vi.fn(), playPath: vi.fn(),
    });
    view.show();
    return { view, panel };
  }
  const tagBtn = (name) => document.querySelector(`.es-dl__tag[data-tag="${name}"]`);

  it('closes the window and lists All scripts with that tag; the search box emptied; Hide and Download kept', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [], more: false }));
    store.set('eroscripts.filters', { video: 'vr', length: 'len-2-5', device: 'any', tags: ['pmv'], hide: ['animation'] });
    store.set('eroscripts.needFilter', 'video');
    const { view, panel } = viewWithPanel();
    answer = { ...answer, tags: mainTags(['tentacle', 'the-handy', 'len-10-25', 'non-vr']) };
    view.openPost({ ...TOPIC, tags: [] });
    await vi.waitFor(() => expect(tagBtn('tentacle')).toBeTruthy());
    expect(tagBtn('tentacle').tagName).toBe('BUTTON');
    expect(tagBtn('tentacle').title).toBe(TAB.dl.tagShow.replace('{tag}', 'tentacle'));
    window.funsync.eroscriptsLatest.mockClear();
    tagBtn('tentacle').click();
    expect(document.querySelector('.es-dl')).toBeNull();                              // the window closed
    expect(store.get('eroscripts.filters')).toEqual({ video: 'any', length: 'any', device: 'any', tags: ['tentacle'], hide: ['animation'] });
    expect(store.get('eroscripts.needFilter')).toBe('video');
    expect(panel.clearQuery).toHaveBeenCalled();
    await vi.waitFor(() => expect(window.funsync.eroscriptsLatest).toHaveBeenCalledTimes(1));   // one list, not two
    expect(window.funsync.eroscriptsLatest).toHaveBeenLastCalledWith('all', 0, expect.objectContaining({ tags: ['tentacle'] }));
    expect([...document.querySelectorAll('.es-view__chips .filter-chip')].map((c) => c.textContent)).toContain('tentacle');
  });

  it('a tag the Video / Length / Device choices stand for sets that choice instead', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [], more: false }));
    const { view } = viewWithPanel();
    answer = { ...answer, tags: mainTags(['the-handy', 'len-10-25', 'non-vr']) };
    for (const [tag, want] of [['the-handy', { device: 'handy', tags: [] }], ['len-10-25', { length: 'len-10-25', tags: [] }], ['non-vr', { video: 'flat', tags: [] }]]) {
      view.openPost({ ...TOPIC, tags: [] });
      await vi.waitFor(() => expect(tagBtn(tag)).toBeTruthy());
      tagBtn(tag).click();
      expect(store.get('eroscripts.filters'), tag).toMatchObject(want);
    }
  });

  it('from an open feed: All scripts again (a feed\'s own choices are not changed)', async () => {
    window.funsync.eroscriptsLatest = vi.fn(async () => ({ results: [], more: false }));
    store.set('eroscripts.feeds', [{ id: 'fa', name: 'PMV', price: 'all', filters: { video: 'any', length: 'any', device: 'any', tags: ['pmv'], hide: [] }, tags: ['pmv'] }]);
    const { view } = viewWithPanel();
    view.openFeed('fa');
    expect(view._feedId).toBe('fa');
    answer = { ...answer, tags: mainTags(['tentacle']) };
    view.openPost({ ...TOPIC, tags: [] });
    await vi.waitFor(() => expect(tagBtn('tentacle')).toBeTruthy());
    tagBtn('tentacle').click();
    expect(view._feedId).toBeNull();
    expect(store.get('eroscripts.feeds')[0].tags).toEqual(['pmv']);                 // a feed keeps its tags in feed.tags
    expect(store.get('eroscripts.filters').tags).toEqual(['tentacle']);
  });
});

// Dave, 2026-11-25: deleted in the library, the card still said downloaded:
// the tab kept "this file is there" for the session.
describe('files deleted in the library', () => {
  it('the tab forgets it saw them (paths as Windows compares them) and asks the disk again', async () => {
    const { eventBus } = await import('../../renderer/js/event-bus.js');
    const { view } = makeView();
    view._exists.set('C:/Lib/A.mp4', true);
    view._exists.set('C:/Lib/Keep.mp4', true);
    window.funsync.fileExists = vi.fn(async () => false);
    eventBus.emit('library:filesDeleted', { paths: ['c:/lib/A.MP4'] });
    expect(view._exists.has('C:/Lib/A.mp4')).toBe(false);
    expect(view._exists.get('C:/Lib/Keep.mp4')).toBe(true);
    expect(view._present('C:/Lib/A.mp4')).toBe(false);
    await vi.waitFor(() => expect(window.funsync.fileExists).toHaveBeenCalledWith('C:/Lib/A.mp4'));
  });
});

// Dave, 2026-11-25: "make that a pillgroup and if it gets too long and would
// [move] onto the next row then change the last one that will fit into a down
// arrow and put the rest under a dropdown menu", "that should be tested on
// different screen sizes too". jsdom has no layout: the group's width is laid
// out here from the pills' words (_measureFeeds), at several widths.
describe('feeds: one pill group, the rest in the ▾ menu', () => {
  const NAMES = Array.from({ length: 30 }, (_, i) => `Feed number ${i + 1}`);
  const feedsSetting = () => NAMES.map((name, i) => ({ id: `f${i}`, name, price: 'all', filters: { video: 'any', length: 'any', device: 'any', tags: [], hide: [] }, tags: [`t${i}`] }));
  const pillWidth = (el) => 24 + el.textContent.length * 7;
  function layout(view, room) {
    view._measureFeeds = () => {
      const group = document.querySelector('.es-feeds');
      let used = 4;
      for (const el of group.querySelectorAll(':scope > .es-feed')) if (!el.hidden) used += pillWidth(el) + 2;
      const more = group.querySelector('.es-feeds__more-wrap');
      if (more && !more.hidden) {
        const name = more.querySelector('.es-feeds__more-name');
        used += 16 + 14 + (name.hidden ? 0 : name.textContent.length * 7);   // the button only, not its menu
      }
      return { room, used };
    };
    view._fitFeeds();
  }
  const shown = () => [...document.querySelectorAll('.es-feeds > .es-feed')].filter((el) => !el.hidden).map((el) => el.textContent);
  const inMenu = () => [...document.querySelectorAll('.es-feeds__menu .es-feeds__item')].map((el) => el.querySelector('.es-feeds__item-name').textContent);
  const moreBtn = () => document.querySelector('.es-feeds__more');

  for (const room of [1600, 900, 600, 420, 260]) {
    it(`at ${room} px: one line that fits; the pills in order, the rest in the menu in order; nothing lost`, () => {
      store.set('eroscripts.feeds', feedsSetting());
      const { view } = makeView();
      layout(view, room);
      const { used } = view._measureFeeds();
      expect(used).toBeLessThanOrEqual(room);
      const all = [TAB.feeds.all, TAB.suggest.chip, ...NAMES, TAB.feeds.add];
      expect([...shown(), ...inMenu()]).toEqual(all);                   // every one, once, in order
      expect(shown()[0]).toBe(TAB.feeds.all);                          // All scripts always shows
      expect(document.querySelector('.es-feeds__more-wrap').hidden).toBe(inMenu().length === 0);
      const n = inMenu().length;
      if (n) expect(moreBtn().getAttribute('aria-label')).toBe(`${n} more feed${n === 1 ? '' : 's'}`);
    });
  }

  it('wide enough for all: no ▾; narrower: the ▾ takes the last slot', () => {
    store.set('eroscripts.feeds', feedsSetting().slice(0, 3));
    const { view } = makeView();
    layout(view, 2000);
    expect(document.querySelector('.es-feeds__more-wrap').hidden).toBe(true);
    expect(shown()).toHaveLength(6);
    layout(view, 300);
    expect(document.querySelector('.es-feeds__more-wrap').hidden).toBe(false);
    expect(shown().length).toBeLessThan(6);
    layout(view, 2000);                                                // wider again: every pill back
    expect(shown()).toHaveLength(6);
    expect(inMenu()).toEqual([]);
  });

  it('the open feed in the menu: the ▾ shows its name, lit; the menu marks it', () => {
    store.set('eroscripts.feeds', feedsSetting());
    const { view } = makeView();
    view.openFeed('f29');
    layout(view, 600);
    expect(inMenu()).toContain('Feed number 30');
    expect(moreBtn().classList.contains('es-feeds__more--on')).toBe(true);
    expect(moreBtn().querySelector('.es-feeds__more-name').textContent).toBe('Feed number 30');
    const item = [...document.querySelectorAll('.es-feeds__item')].find((el) => el.textContent.includes('Feed number 30'));
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(view._measureFeeds().used).toBeLessThanOrEqual(600);         // the longer ▾ still fits
  });

  it('a menu item opens its feed (the menu closes); right-click opens its editor; keys as the ⋮ menu', () => {
    store.set('eroscripts.feeds', feedsSetting());
    const { view } = makeView();
    layout(view, 420);
    const editor = vi.spyOn(view, '_openFeedEditor').mockImplementation(() => {});
    moreBtn().click();
    expect(document.querySelector('.es-feeds__menu').hidden).toBe(false);
    const item = [...document.querySelectorAll('.es-feeds__item')].find((el) => el.textContent.includes('Feed number 20'));
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(editor).toHaveBeenCalledWith(expect.objectContaining({ id: 'f19' }));
    moreBtn().click();
    [...document.querySelectorAll('.es-feeds__item')].find((el) => el.textContent.includes('Feed number 20')).click();
    expect(view._feedId).toBe('f19');
    expect(document.querySelector('.es-feeds__menu').hidden).toBe(true);
    // From the keyboard: Enter on ▾ focuses the first item; Escape closes and returns.
    layout(view, 420);
    moreBtn().focus();
    moreBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(document.activeElement.classList.contains('es-feeds__item')).toBe(true);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.es-feeds__menu').hidden).toBe(true);
    expect(document.activeElement).toBe(moreBtn());
  });

  it('jsdom (no layout, 0 room): every pill shows, no ▾ (never a feed lost to a failed measure)', () => {
    store.set('eroscripts.feeds', feedsSetting());
    makeView();
    expect(shown()).toHaveLength(33);
    expect(document.querySelector('.es-feeds__more-wrap').hidden).toBe(true);
  });
});
