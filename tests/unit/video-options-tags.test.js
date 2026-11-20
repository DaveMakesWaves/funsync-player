/**
 * @vitest-environment jsdom
 * jsdom on purpose: the section builds its DOM in the document, stacks the
 * REAL Modal for its questions (Paste a post link, Make a category, the
 * link-only search), and i18n.js branches on `typeof window`
 * (notes/CLAUDE.md "Test environments").
 */
// The Tags section of the video options dialog (video options design (c),
// stage 2b, 2026-11-18). What runs for real: the section, the writers
// (video-tag-edits.js), the tag merge (video-tags.js), the Get tags engine
// (eroscripts-tag-fetch.js and its TagFetchQueue), the record writers
// (script-tags.js), Modal, and the inline search in link-only mode. Fakes:
// DataService (a map), main's topic request (no forum is ever contacted),
// the search IPC, the EroScripts login.
//
// The design's test-plan rows covered here (each guard's hole was reopened
// and the test failed; see the stage report): Add a hidden tag; Remove a tag
// another source gives (+ exact Undo); Get tags success / 401 / 429 /
// network / 404; Get tags on a swapped script; One request at a time (UI
// side); Make a category from a tag; Untrusted text; plus the Unpair wiring
// (a video left with no script shows no post tags; they come back with it).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { mountTagsSection, _resetTagsSectionForTests, CHIP_LIMIT } = await import('../../renderer/components/video-options-tags.js');
const { TagFetchQueue } = await import('../../renderer/js/eroscripts-tag-fetch.js');

// The English words the assertions read. Pinned here: the merge step adds
// them to the locales (SCRATCH/2b-tags/strings.json, 1c's fetch strings).
const STRINGS = {
  'tags.source.user': 'you',
  'tags.source.eroscripts': 'EroScripts',
  'tags.lengthMinutes': '{range} min',
  'tags.facet.length': 'Length',
  'tags.facet.device': 'Device',
  'tags.facet.content': 'Content',
  'videoOptions.tags.heading': 'Tags on this video ({count})',
  'videoOptions.tags.showAll': 'Show all ({count})',
  'videoOptions.tags.removeAria': 'Remove {name} from this video',
  'videoOptions.tags.source.post': '“{title}” by {creator}',
  'videoOptions.tags.source.stale': 'gone from EroScripts',
  'videoOptions.tags.paste.invalid': 'That is not an EroScripts post link.',
  'videoOptions.tags.category.count': '{count, plural, =0 {No video in the library has this tag.} one {# video has this tag.} other {# videos have this tag.}}',
  'videoOptions.tags.category.addTo': 'Add to {name}',
  'videoOptions.tags.category.create': 'Create category',
  'videoOptions.tags.menu.makeCategory': 'Make a category from this tag…',
  'videoOptions.tags.menu.remove': 'Remove from this video',
  'videoOptions.tags.live.added': 'Added {name}.',
  'videoOptions.tags.live.addedShown': 'Added {name}. It shows on this video again.',
  'videoOptions.tags.live.removed': 'Removed {name} from this video.',
  'videoOptions.tags.live.shownAgain': '{name} shows on this video again.',
  'videoOptions.tags.live.undone': 'Undone.',
  'videoOptions.tags.live.linked': 'Post linked. Nothing is sent until you get its tags.',
  'videoOptions.tags.live.categoryMade': 'Made the category {name} with {count, plural, one {# video} other {# videos}}.',
  'videoOptions.tags.live.categoryAdded': 'Added {count, plural, one {# video} other {# videos}} to {name}.',
  'videoOptions.tags.fetch.button': 'Get tags from EroScripts',
  'videoOptions.tags.fetch.loginButton': 'Log in to get tags…',
  'videoOptions.tags.fetch.running': 'Getting tags…',
  'videoOptions.tags.fetch.success': 'Got {count, plural, one {# tag} other {# tags}} from EroScripts ({newCount} new).',
  'videoOptions.tags.fetch.gone': 'This post is gone from EroScripts. Its tags are kept.',
  'videoOptions.tags.fetch.loginAgain': 'Log in to EroScripts again',
  'videoOptions.tags.fetch.loginAction': 'Log in…',
  'videoOptions.tags.fetch.loginRequired': 'Getting tags needs your EroScripts login. Nothing was sent.',
  'videoOptions.tags.fetch.cooldown': 'EroScripts asked to wait. Try again in {seconds} s',
  'videoOptions.tags.fetch.otherScript': 'The linked post is for another script ({name})',
  'videoOptions.tags.fetch.noPost': 'No EroScripts post is linked to this video\'s script',
  'videoOptions.tags.fetch.noScript': 'This video has no script, so no EroScripts post is linked.',
};

function bundle() {
  const b = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
  for (const [key, value] of Object.entries(STRINGS)) {
    const parts = key.split('.');
    let o = b;
    for (const p of parts.slice(0, -1)) {
      if (!o[p] || typeof o[p] !== 'object') o[p] = {};
      o = o[p];
    }
    o[parts[parts.length - 1]] = value;
  }
  return b;
}
const EN = bundle();

const VIDEO = 'C:/lib/Scene.mp4';
const SCRIPT = 'C:/lib/Scene.funscript';
const OLD_SCRIPT = 'C:/lib/old.funscript';
const OTHER = 'C:/lib/Other.mp4';
const TOPIC_URL = 'https://discuss.eroscripts.com/t/scene/7';
const RECORD = Object.freeze({
  tags: [{ id: 1, name: 'pov' }, { id: 2, name: 'the-handy' }, { id: 3, name: 'len-10-25' }],
  topicId: 7, topicUrl: TOPIC_URL, title: 'Scene', creator: 'Ramie', scriptPath: SCRIPT,
  match: 'download', source: 'eroscripts', savedAt: Date.UTC(2026, 10, 17), fetchedAt: null, stale: false,
});
const OTHER_RECORD = Object.freeze({ tags: ['vr'], topicId: 99, topicUrl: null, source: 'eroscripts', savedAt: 2 });

/** A DataService stand-in: dotted keys in a flat map, categories in memory. */
function makeDs(settings = {}, { categories = [], videoCategories = {} } = {}) {
  const store = structuredClone(settings);
  const cats = structuredClone(categories);
  const vc = structuredClone(videoCategories);
  let seq = 0;
  return {
    _store: store,
    _cats: cats,
    _vc: vc,
    get: (key) => store[key],
    set: vi.fn((key, value) => { store[key] = value; }),
    getCategories: () => cats,
    addCategory: vi.fn(async (name, color) => {
      const c = { id: `cat-${++seq}`, name, color };
      cats.push(c);
      return c;
    }),
    deleteCategory: vi.fn((id) => {
      const at = cats.findIndex((c) => c.id === id);
      if (at >= 0) cats.splice(at, 1);
      for (const p of Object.keys(vc)) {
        vc[p] = vc[p].filter((x) => x !== id);
        if (!vc[p].length) delete vc[p];
      }
    }),
    assignCategory: vi.fn((p, id) => {
      if (!vc[p]) vc[p] = [];
      if (!vc[p].includes(id)) vc[p].push(id);
    }),
    unassignCategory: vi.fn((p, id) => {
      if (!vc[p]) return;
      vc[p] = vc[p].filter((x) => x !== id);
      if (!vc[p].length) delete vc[p];
    }),
    getVideoCategories: (p) => vc[p] || [],
    getAllVideoCategories: () => structuredClone(vc),
  };
}

const queueWith = (topicMeta) => new TagFetchQueue({ topicMeta, minGapMs: 0 });
const okAnswer = (meta) => ({ ok: true, outcome: 'ok', status: 200, meta: { topicId: 7, url: TOPIC_URL, title: 'Scene', creator: 'Ramie', ...meta } });

const handles = [];
function mount({ ds, video = { path: VIDEO, name: 'Scene', funscriptPath: SCRIPT }, queue, videos, eroscripts, ...extra } = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const ctx = {
    video,
    dataService: ds,
    getLibraryVideos: () => videos || [video],
    onDataChanged: vi.fn(),
    announce: vi.fn(),
    modalBody: document.body,
    tagQueue: queue,
    eroscripts: eroscripts || {
      isLoggedIn: vi.fn(async () => true),
      login: vi.fn(async () => true),
      sessionExpired: vi.fn(async () => {}),
    },
    ...extra,
  };
  const handle = mountTagsSection(host, ctx);
  handles.push(handle);
  return { host, handle, ctx };
}

const chipKeys = (host) => [...host.querySelectorAll('.video-options-tags__chip')].map((li) => li.dataset.tagKey);
const chip = (host, key) => [...host.querySelectorAll('.video-options-tags__chip')].find((li) => li.dataset.tagKey === key);
const byFocus = (host, key) => host.querySelector(`[data-vo-focus="${key}"]`);
const getButton = (host) => byFocus(host, 'tags:get');
const overlays = () => [...document.querySelectorAll('.modal-overlay')];
const topOverlay = () => overlays().at(-1) || null;
const press = (target, key, opts = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 4) {
  for (let i = 0; i < times; i++) await flush();
}

function typeAndAdd(host, text) {
  const input = host.querySelector('.video-options-tags__add-input');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  press(input, 'Enter');
  return input;
}

let savedFunsync;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  _resetTagsSectionForTests();
  showToast.mockClear();
  savedFunsync = window.funsync;
  document.body.innerHTML = '<div id="toast-container"></div>';
});

afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  for (const o of overlays().reverse()) o.querySelector('.modal-close-btn')?.click();
  window.funsync = savedFunsync;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------

describe('the merged chip list', () => {
  it('shows one list grouped by facet, each chip naming its sources', () => {
    const ds = makeDs({
      'library.userTags': { [VIDEO]: ['pov', 'cosplay'] },
      'library.scriptTags': { [VIDEO]: RECORD },
    });
    const { host } = mount({ ds, queue: queueWith(vi.fn()) });

    expect([...host.querySelectorAll('.video-options-tags__facet')].map((g) => g.dataset.facet))
      .toEqual(['length', 'device', 'content', 'creator']);
    expect(chipKeys(host)).toEqual(['length:10-25', 'device:the-handy', 'content:cosplay', 'content:pov', 'creator:ramie']);
    const pov = chip(host, 'content:pov');
    expect(pov.querySelector('.video-options-tags__chip-label').textContent).toBe('pov');
    expect(pov.querySelector('.video-options-tags__chip-sources').textContent).toBe('you, EroScripts');
    expect(chip(host, 'length:10-25').querySelector('.video-options-tags__chip-label').textContent).toBe('10-25 min');
    expect(pov.querySelector('.video-options-tags__chip-remove').getAttribute('aria-label')).toBe('Remove pov from this video');
    expect(host.querySelector('.video-options-tags__list h3').textContent).toBe('Tags on this video (5)');
    expect(host.querySelector('.video-options-tags__post').textContent).toMatch(/^“Scene” by Ramie · /);
  });

  it('opening writes nothing, sends nothing and logs in to nothing', async () => {
    const main = vi.fn();
    const ds = makeDs({ 'library.userTags': { [VIDEO]: ['pov'] }, 'library.scriptTags': { [VIDEO]: RECORD } });
    const { ctx } = mount({ ds, queue: queueWith(main) });
    await settle();
    expect(ds.set).not.toHaveBeenCalled();
    expect(main).not.toHaveBeenCalled();
    expect(ctx.eroscripts.login).not.toHaveBeenCalled();
  });

  it('Unpair: a video left with no script shows none of the post\'s tags; they come back with the script, with no write', () => {
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const unpaired = mount({ ds, video: { path: VIDEO, funscriptPath: null }, queue: queueWith(vi.fn()) });
    expect(chipKeys(unpaired.host)).toEqual([]);
    expect(getButton(unpaired.host)).toBeNull();
    expect(unpaired.host.textContent).toContain('This video has no script, so no EroScripts post is linked.');
    unpaired.handle.dispose();

    const undone = mount({ ds, video: { path: VIDEO, funscriptPath: SCRIPT }, queue: queueWith(vi.fn()) });
    expect(chipKeys(undone.host)).toEqual(['length:10-25', 'device:the-handy', 'content:pov', 'creator:ramie']);
    expect(ds.set).not.toHaveBeenCalled();
  });

  it('a long list gets a find box and "Show all (n)"', () => {
    const many = Array.from({ length: CHIP_LIMIT + 6 }, (_, i) => `tag ${String(i).padStart(2, '0')}`);
    const ds = makeDs({ 'library.userTags': { [VIDEO]: many } });
    const { host } = mount({ ds, queue: queueWith(vi.fn()) });
    const find = host.querySelector('.video-options-tags__find');
    expect(find.hidden).toBe(false);
    expect(chipKeys(host)).toHaveLength(CHIP_LIMIT);
    const all = byFocus(host, 'tags:showAll');
    expect(all.textContent).toBe(`Show all (${CHIP_LIMIT + 6})`);
    all.click();
    expect(chipKeys(host)).toHaveLength(CHIP_LIMIT + 6);

    const box = host.querySelector('.video-options-tags__find-input');
    box.value = 'tag 07';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(chipKeys(host)).toEqual(['content:tag-07']);
  });
});

describe('editing', () => {
  it('Add a hidden tag: it shows again, and hiddenTags[path] no longer has it', () => {
    const ds = makeDs({
      'library.scriptTags': { [VIDEO]: RECORD },
      'library.hiddenTags': { [VIDEO]: ['content:pov'], [OTHER]: ['vr'] },
    });
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()) });
    expect(chipKeys(host)).not.toContain('content:pov');
    expect([...host.querySelectorAll('.video-options-tags__hidden-item')].map((li) => li.dataset.tagKey)).toEqual(['content:pov']);

    typeAndAdd(host, 'POV');

    expect(chipKeys(host)).toContain('content:pov');
    expect(ds._store['library.hiddenTags']).toEqual({ [OTHER]: ['vr'] });
    expect(ds._store['library.userTags']).toEqual({ [VIDEO]: ['POV'] });
    expect(host.querySelector('.video-options-tags__hidden').hidden).toBe(true);
    expect(ctx.announce).toHaveBeenLastCalledWith('Added POV. It shows on this video again.');
    expect(ctx.onDataChanged).toHaveBeenCalledWith('tags');
  });

  it('Remove a tag another source gives: the chip goes; Undo puts both lists back exactly (absence too)', () => {
    const ds = makeDs({
      'library.userTags': { [VIDEO]: ['pov', 'cosplay'], [OTHER]: ['x'] },
      'library.scriptTags': { [VIDEO]: RECORD },
    });
    const before = structuredClone({ user: ds._store['library.userTags'], hidden: ds._store['library.hiddenTags'] });
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()) });

    chip(host, 'content:pov').querySelector('.video-options-tags__chip-remove').click();

    expect(chipKeys(host)).not.toContain('content:pov');
    expect(ds._store['library.userTags']).toEqual({ [VIDEO]: ['cosplay'], [OTHER]: ['x'] });
    expect(ds._store['library.hiddenTags']).toEqual({ [VIDEO]: ['content:pov'] });
    expect(ctx.announce).toHaveBeenLastCalledWith('Removed pov from this video.');
    // The focus goes to the Undo (design (g)).
    const undo = byFocus(host, 'tags:undo');
    expect(undo.closest('[hidden]')).toBeNull();
    expect(document.activeElement).toBe(undo);

    undo.click();

    expect(ds._store['library.userTags']).toEqual(before.user);
    expect(ds._store['library.hiddenTags']?.[VIDEO]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(ds._store['library.hiddenTags'], VIDEO)).toBe(false);
    expect(chipKeys(host)).toContain('content:pov');
    expect(ctx.announce).toHaveBeenLastCalledWith('Undone.');
    expect(document.activeElement).toBe(chip(host, 'content:pov').querySelector('.video-options-tags__chip-remove'));
  });

  it('with the dialog\'s own Undo (announceUndo), the Undo it runs puts both lists back', () => {
    const ds = makeDs({ 'library.userTags': { [VIDEO]: ['pov'] }, 'library.scriptTags': { [VIDEO]: RECORD } });
    const announceUndo = vi.fn();
    const { host } = mount({ ds, queue: queueWith(vi.fn()), announceUndo });

    chip(host, 'content:pov').querySelector('.video-options-tags__chip-remove').click();

    expect(announceUndo).toHaveBeenCalledTimes(1);
    const [message, undo] = announceUndo.mock.calls[0];
    expect(message).toBe('Removed pov from this video.');
    expect(undo.focusKey).toBe('tags:remove:content:pov');
    // No second Undo of ours at all (followUp3, verify-2: it was a hidden
    // .video-options__undo in the dialog; only built without announceUndo).
    expect(byFocus(host, 'tags:undo')).toBeNull();
    expect(host.querySelector('.video-options__undo')).toBeNull();
    expect(ds._store['library.userTags']).toEqual({});
    expect(ds._store['library.hiddenTags']).toEqual({ [VIDEO]: ['content:pov'] });

    expect(undo.run()).toEqual({ message: 'Undone.' });
    expect(ds._store['library.userTags']).toEqual({ [VIDEO]: ['pov'] });
    expect(ds._store['library.hiddenTags']).toEqual({});
    expect(chipKeys(host)).toContain('content:pov');
  });

  it('Show again takes the key out of this video\'s hidden list, and nothing else', () => {
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD }, 'library.hiddenTags': { [VIDEO]: ['content:pov', 'device:the-handy'] } });
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()) });
    byFocus(host, 'tags:showAgain:device:the-handy').click();
    expect(ds._store['library.hiddenTags']).toEqual({ [VIDEO]: ['content:pov'] });
    expect(ds._store['library.userTags']).toBeUndefined();
    expect(chipKeys(host)).toContain('device:the-handy');
    expect(ctx.announce).toHaveBeenLastCalledWith('the handy shows on this video again.');
  });

  it('suggests the library\'s tags as you type (never a performer), and adds the one picked', () => {
    const ds = makeDs({ 'library.userTags': { [OTHER]: ['cosplay', 'performer:Jane Doe'] } });
    const videos = [{ path: VIDEO, funscriptPath: SCRIPT }, { path: OTHER, funscriptPath: null }];
    const { host, handle } = mount({ ds, queue: queueWith(vi.fn()), videos });
    const input = host.querySelector('.video-options-tags__add-input');
    const list = host.querySelector('.video-options-tags__suggestions');

    input.value = 'ja';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(list.hidden).toBe(true);

    input.value = 'cos';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll('[role="option"]')].map((o) => o.dataset.tagKey)).toEqual(['content:cosplay']);
    expect(input.getAttribute('aria-expanded')).toBe('true');

    // Escape closes the list first (the dialog stays open).
    expect(handle.handleEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(list.hidden).toBe(true);
    expect(handle.handleEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false);

    input.dispatchEvent(new Event('input', { bubbles: true }));
    press(input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(list.querySelector('[role="option"]').id);
    press(input, 'Enter');
    expect(ds._store['library.userTags'][VIDEO]).toEqual(['cosplay']);
    expect(chipKeys(host)).toEqual(['content:cosplay']);
  });

  it('a damaged store refuses the edit and says so', () => {
    const ds = makeDs({ 'library.userTags': { [VIDEO]: 'not a list' } });
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()) });
    typeAndAdd(host, 'pov');
    expect(ds.set).not.toHaveBeenCalled();
    expect(ctx.announce).toHaveBeenLastCalledWith(EN.videoOptions.tags.live.reason.badStore);
  });
});

describe('the chip menu', () => {
  it('opens on the label, moves with the arrows, and Escape closes it first, back on the label', () => {
    const ds = makeDs({ 'library.userTags': { [VIDEO]: ['pov'] } });
    const { host, handle } = mount({ ds, queue: queueWith(vi.fn()) });
    const label = chip(host, 'content:pov').querySelector('.video-options-tags__chip-label');
    label.click();
    const menu = host.querySelector('[role="menu"]');
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    // "Show videos with this tag" waits for the tag filter (no ctx.showVideosWithTag).
    expect(items.map((b) => b.textContent)).toEqual(['Make a category from this tag…', 'Remove from this video']);
    expect(label.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(items[0]);

    press(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press(items[1], 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    press(items[0], 'End');
    expect(document.activeElement).toBe(items[1]);

    expect(handle.handleEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(label);
    expect(handle.handleEscape(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false);
  });

  it('"Show videos with this tag" is there once the dialog hands the filter', () => {
    const ds = makeDs({ 'library.userTags': { [VIDEO]: ['pov'] } });
    const showVideosWithTag = vi.fn();
    const { host } = mount({ ds, queue: queueWith(vi.fn()), showVideosWithTag });
    chip(host, 'content:pov').querySelector('.video-options-tags__chip-label').click();
    host.querySelector('[role="menuitem"]').click();
    expect(showVideosWithTag).toHaveBeenCalledWith('content:pov', expect.objectContaining({ key: 'content:pov' }));
  });
});

describe('Get tags from EroScripts', () => {
  it('success: the record is replaced; userTags and hiddenTags are byte-identical', async () => {
    const main = vi.fn(async () => okAnswer({ title: 'Scene v2', tags: [{ id: 1, name: 'pov' }, { id: 4, name: 'vr' }] }));
    const ds = makeDs({
      'library.scriptTags': { [VIDEO]: RECORD, [OTHER]: OTHER_RECORD },
      'library.userTags': { [VIDEO]: ['cosplay', 'content:pov'] },
      'library.hiddenTags': { [VIDEO]: ['content:pov'] },
    });
    const userBefore = JSON.stringify(ds._store['library.userTags']);
    const hiddenBefore = JSON.stringify(ds._store['library.hiddenTags']);
    const { host, ctx } = mount({ ds, queue: queueWith(main) });

    expect(getButton(host).textContent).toBe('Get tags from EroScripts');
    getButton(host).click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Got 2 tags from EroScripts (1 new).'));

    expect(main).toHaveBeenCalledTimes(1);
    expect(main).toHaveBeenCalledWith(7);
    const record = ds._store['library.scriptTags'][VIDEO];
    expect(record).toMatchObject({ tags: [{ id: 1, name: 'pov' }, { id: 4, name: 'vr' }], topicId: 7, title: 'Scene v2', scriptPath: SCRIPT, match: 'download', stale: false });
    expect(Number.isFinite(record.fetchedAt)).toBe(true);
    expect(ds._store['library.scriptTags'][OTHER]).toEqual(OTHER_RECORD);
    expect(JSON.stringify(ds._store['library.userTags'])).toBe(userBefore);
    expect(JSON.stringify(ds._store['library.hiddenTags'])).toBe(hiddenBefore);
    expect(ds.set.mock.calls.map((c) => c[0])).toEqual(['library.scriptTags']);
    // The chips follow the new record; a tag you hid stays hidden.
    expect(chipKeys(host)).toEqual(['vr:vr', 'content:cosplay', 'creator:ramie']);
    expect(ctx.onDataChanged).toHaveBeenCalledWith('tags');
  });

  it('401 / 403: the record is byte-identical; "Log in to EroScripts again" with ONE login button, and the session is dropped as the panel\'s search drops it', async () => {
    const main = vi.fn()
      .mockResolvedValueOnce({ ok: false, outcome: 'authExpired', status: 403, authExpired: true, errorCode: 'accessDenied' })
      .mockResolvedValueOnce(okAnswer({ tags: [{ id: 9, name: 'cosplay' }] }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const recordBefore = JSON.stringify(ds._store['library.scriptTags']);
    // The panel's handleSessionExpired: the session check finds the login
    // dead and drops it (2026-11-18: a 403 alone no longer does), so main's
    // session reads logged out until the login.
    let session = true;
    const eroscripts = {
      isLoggedIn: vi.fn(async () => session),
      login: vi.fn(async () => { session = true; return true; }),
      sessionExpired: vi.fn(async () => { session = false; }),
    };
    const { host, ctx } = mount({ ds, queue: queueWith(main), eroscripts });

    getButton(host).click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Log in to EroScripts again'));
    expect(JSON.stringify(ds._store['library.scriptTags'])).toBe(recordBefore);
    expect(ds.set).not.toHaveBeenCalled();
    expect(ctx.eroscripts.sessionExpired).toHaveBeenCalledTimes(1);
    // One login button (verify-1, fixup-data 2026-11-18): Get tags reads
    // "Log in to get tags…" and has the focus; no second [Log in…] beside it.
    expect(byFocus(host, 'tags:login')).toBeNull();
    const login = getButton(host);
    expect(login.textContent).toBe('Log in to get tags…');
    expect([...host.querySelectorAll('button')].filter((b) => /Log in/.test(b.textContent))).toHaveLength(1);
    expect(document.activeElement).toBe(login);

    login.click();
    await vi.waitFor(() => expect(main).toHaveBeenCalledTimes(2));
    expect(ctx.eroscripts.login).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(ds._store['library.scriptTags'][VIDEO].tags).toEqual([{ id: 9, name: 'cosplay' }]));
  });

  it('429: a cooldown disables every Get tags button for Retry-After seconds; nothing is stored', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 9) });
    const main = vi.fn(async () => ({ ok: false, outcome: 'rateLimited', status: 429, retryAfter: 42, errorCode: 'rateLimited' }));
    const queue = new TagFetchQueue({ topicMeta: main });
    const second = 'C:/lib/Second.mp4';
    const secondScript = 'C:/lib/Second.funscript';
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD, [second]: { ...RECORD, topicId: 8, scriptPath: secondScript } } });
    const recordsBefore = JSON.stringify(ds._store['library.scriptTags']);
    const a = mount({ ds, queue });
    const b = mount({ ds, queue, video: { path: second, funscriptPath: secondScript } });
    await vi.advanceTimersByTimeAsync(0);

    getButton(a.host).click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(a.ctx.announce).toHaveBeenCalledWith('EroScripts asked to wait. Try again in 42 s');
    for (const { host } of [a, b]) {
      expect(getButton(host).getAttribute('aria-disabled')).toBe('true');
      expect(getButton(host).textContent).toBe('EroScripts asked to wait. Try again in 42 s');
    }
    getButton(b.host).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(main).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ds._store['library.scriptTags'])).toBe(recordsBefore);
    expect(ds.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(41_000);
    expect(getButton(b.host).textContent).toBe('EroScripts asked to wait. Try again in 1 s');
    await vi.advanceTimersByTimeAsync(1_000);
    for (const { host } of [a, b]) {
      expect(getButton(host).getAttribute('aria-disabled')).toBe('false');
      expect(getButton(host).textContent).toBe('Get tags from EroScripts');
    }
  });

  it('network and other failures: the existing words, and the record is byte-identical', async () => {
    const main = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: false, outcome: 'failed', status: 500, errorCode: 'topicFailed' });
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const before = JSON.stringify(ds._store['library.scriptTags']);
    const { host, ctx } = mount({ ds, queue: queueWith(main) });

    getButton(host).click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith(EN.eroscripts.error.network));
    getButton(host).click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Couldn\'t load that post (HTTP 500).'));
    expect(JSON.stringify(ds._store['library.scriptTags'])).toBe(before);
    expect(ds.set).not.toHaveBeenCalled();
  });

  it('404: stale is set and the tags are kept', async () => {
    const main = vi.fn(async () => ({ ok: false, outcome: 'notFound', status: 404, errorCode: 'notFound' }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const { host, ctx } = mount({ ds, queue: queueWith(main) });

    getButton(host).click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('This post is gone from EroScripts. Its tags are kept.'));
    const record = ds._store['library.scriptTags'][VIDEO];
    expect(record.stale).toBe(true);
    expect(record.tags).toEqual(RECORD.tags);
    expect(host.querySelector('.video-options-tags__post').textContent).toContain('gone from EroScripts');
    expect(chipKeys(host)).toContain('content:pov');
  });

  it('on a swapped script: not offered, the "another script" line shows, the old post\'s tags do not', async () => {
    const main = vi.fn();
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: { ...RECORD, scriptPath: OLD_SCRIPT } } });
    const { host } = mount({ ds, queue: queueWith(main) });
    await settle();
    expect(getButton(host)).toBeNull();
    expect(host.querySelector('.video-options-tags__other-script').textContent)
      .toBe('The linked post is for another script (old.funscript)');
    expect(byFocus(host, 'tags:paste')).not.toBeNull();
    expect(byFocus(host, 'tags:findPost')).not.toBeNull();
    expect(chipKeys(host)).toEqual([]);
    expect(main).not.toHaveBeenCalled();
  });

  it('logged out: the button reads "Log in to get tags…"; a login that does not happen sends nothing', async () => {
    const main = vi.fn();
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const eroscripts = { isLoggedIn: vi.fn(async () => false), login: vi.fn(async () => false), sessionExpired: vi.fn() };
    const { host, ctx } = mount({ ds, queue: queueWith(main), eroscripts });
    await vi.waitFor(() => expect(getButton(host).textContent).toBe('Log in to get tags…'));
    getButton(host).click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Getting tags needs your EroScripts login. Nothing was sent.'));
    expect(eroscripts.login).toHaveBeenCalledTimes(1);
    expect(main).not.toHaveBeenCalled();
    expect(ds.set).not.toHaveBeenCalled();
  });

  it('one request at a time (UI side): two presses on two videos share the app\'s queue; the second starts >= 1 s after the first ends', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 10) });
    const calls = [];
    window.funsync = {
      ...savedFunsync,
      eroscriptsTopicMeta: vi.fn((id) => {
        const call = { id, start: Date.now(), end: null };
        calls.push(call);
        return new Promise((resolve) => setTimeout(() => {
          call.end = Date.now();
          resolve(okAnswer({ topicId: id, tags: [] }));
        }, 500));
      }),
    };
    const second = 'C:/lib/Second.mp4';
    const secondScript = 'C:/lib/Second.funscript';
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD, [second]: { ...RECORD, topicId: 8, scriptPath: secondScript } } });
    // No tagQueue: each section takes the app's one queue.
    const a = mount({ ds, queue: undefined });
    const b = mount({ ds, queue: undefined, video: { path: second, funscriptPath: secondScript } });
    await vi.advanceTimersByTimeAsync(0);

    getButton(a.host).click();
    getButton(b.host).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(getButton(a.host).getAttribute('aria-disabled')).toBe('true'); // its own request runs
    expect(a.host.querySelector('.video-options-tags').getAttribute('aria-busy')).toBe('true');

    await vi.advanceTimersByTimeAsync(500);
    expect(calls[0].end).not.toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id)).toEqual([7, 8]);
    expect(calls[1].start - calls[0].end).toBeGreaterThanOrEqual(1000);
  });
});

describe('linking a post', () => {
  it('Paste a post link: only a discuss.eroscripts.com topic link is taken; it is written at once; nothing is sent until Get tags', async () => {
    const main = vi.fn(async () => okAnswer({ topicId: 123, url: 'https://discuss.eroscripts.com/t/scene/123', tags: [{ id: 5, name: 'pov' }] }));
    const ds = makeDs({});
    const { host, ctx } = mount({ ds, queue: queueWith(main) });
    expect(host.textContent).toContain('No EroScripts post is linked to this video\'s script');
    expect(getButton(host)).toBeNull();

    byFocus(host, 'tags:paste').click();
    const dialog = topOverlay();
    const input = dialog.querySelector('.video-options-tags__paste-input');
    const ok = dialog.querySelector('.modal-btn--primary');
    input.value = 'https://evil.example/t/scene/123';
    ok.click();
    expect(topOverlay()).toBe(dialog);
    expect(dialog.querySelector('.video-options-tags__error').textContent).toBe('That is not an EroScripts post link.');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.value = 'https://discuss.eroscripts.com/t/scene/123';
    ok.click();
    await vi.waitFor(() => expect(getButton(host)).not.toBeNull());
    expect(topOverlay()).toBeNull();
    expect(main).not.toHaveBeenCalled();
    // Written at once, as Change post… does (fixup-data 2026-11-18): the
    // post with no tags yet; Undo is offered.
    expect(ds.set.mock.calls.map((c) => c[0])).toEqual(['library.scriptTags']);
    expect(ds._store['library.scriptTags'][VIDEO]).toMatchObject({ topicId: 123, tags: [], unread: true, match: 'manual', scriptPath: SCRIPT });
    expect(ctx.announce).toHaveBeenCalledWith('Post linked. Nothing is sent until you get its tags.');
    expect(host.querySelector('.video-options-tags__undo-row').hidden).toBe(false);

    getButton(host).click();
    await vi.waitFor(() => expect(ds._store['library.scriptTags'][VIDEO].unread).toBeUndefined());
    expect(main).toHaveBeenCalledWith(123);
    expect(ds._store['library.scriptTags'][VIDEO]).toMatchObject({ topicId: 123, match: 'manual', scriptPath: SCRIPT });
    expect(chipKeys(host)).toEqual(['content:pov', 'creator:ramie']);
  });

  it('Find the post: link-only search, no search until a press, picking only links the post (no Get tags until pressed); nothing is downloaded', async () => {
    const results = [{ id: 321, title: 'Scene <b>bold</b>', url: 'https://discuss.eroscripts.com/t/scene/321', creator: 'Ramie', tags: ['pov'], likeCount: 0 }];
    window.funsync = {
      ...savedFunsync,
      eroscriptsSearch: vi.fn(async () => ({ results })),
      eroscriptsTopic: vi.fn(async () => ({ attachments: [] })),
      eroscriptsDownload: vi.fn(async () => ({ success: true })),
    };
    const main = vi.fn(async () => okAnswer({ topicId: 321, url: results[0].url, title: 'Scene', tags: [{ id: 5, name: 'cosplay' }] }));
    const ds = makeDs({});
    const { host } = mount({ ds, queue: queueWith(main) });

    byFocus(host, 'tags:findPost').click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.eroscripts-panel__search-input')).toBeTruthy());
    const dialog = topOverlay();
    expect(dialog.querySelector('.eroscripts-panel__search-input').value).toBe('Scene');
    await settle();
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();

    dialog.querySelector('.eroscripts-panel__btn').click();
    await vi.waitFor(() => expect(dialog.querySelector('.eroscripts-inline__link-btn')).toBeTruthy());
    expect(window.funsync.eroscriptsSearch).toHaveBeenCalledTimes(1);
    expect(dialog.querySelector('b')).toBeNull();
    expect(dialog.querySelector('.eroscripts-panel__result-title').textContent).toBe('Scene <b>bold</b>');

    dialog.querySelector('.eroscripts-inline__link-btn').click();
    await vi.waitFor(() => expect(ds._store['library.scriptTags']?.[VIDEO]).toBeTruthy());
    // Find the post only links (Dave; fixup-data 2026-11-18 made both paths
    // agree): written at once, no Get tags until it is pressed.
    await settle();
    expect(main).not.toHaveBeenCalled();
    expect(ds._store['library.scriptTags'][VIDEO]).toMatchObject({
      topicId: 321, match: 'search', scriptPath: SCRIPT, unread: true, tags: [], title: 'Scene <b>bold</b>', creator: 'Ramie',
    });
    expect(window.funsync.eroscriptsTopic).not.toHaveBeenCalled();
    expect(window.funsync.eroscriptsDownload).not.toHaveBeenCalled();
    expect(topOverlay()).toBeNull();

    getButton(host).click();
    await vi.waitFor(() => expect(main).toHaveBeenCalledWith(321));
    await vi.waitFor(() => expect(ds._store['library.scriptTags'][VIDEO].tags).toEqual([{ id: 5, name: 'cosplay' }]));
  });

  it('Find the post while logged out: the login comes first; no login, no search', async () => {
    window.funsync = { ...savedFunsync, eroscriptsSearch: vi.fn(async () => ({ results: [] })) };
    const eroscripts = { isLoggedIn: vi.fn(async () => false), login: vi.fn(async () => false), sessionExpired: vi.fn() };
    const ds = makeDs({});
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()), eroscripts });
    byFocus(host, 'tags:findPost').click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Getting tags needs your EroScripts login. Nothing was sent.'));
    expect(eroscripts.login).toHaveBeenCalledTimes(1);
    expect(topOverlay()).toBeNull();
    expect(window.funsync.eroscriptsSearch).not.toHaveBeenCalled();
  });
});

describe('Make a category from this tag', () => {
  // The chip is display:pov (you typed it); another video has content:pov,
  // which has the same LABEL but is another tag.
  const A = 'C:/lib/A.mp4';
  const B = 'C:/lib/B.mp4';
  const C = 'C:/lib/C.mp4';
  const library = () => [
    { path: VIDEO, funscriptPath: SCRIPT }, { path: A, funscriptPath: null },
    { path: B, funscriptPath: null }, { path: C, funscriptPath: null },
  ];
  const tagged = () => makeDs({
    'library.userTags': { [VIDEO]: ['display:pov'], [A]: ['pov'], [B]: ['Display: POV'] },
  });

  async function openMakeCategory(host) {
    chip(host, 'display:pov').querySelector('.video-options-tags__chip-label').click();
    [...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.startsWith('Make a category')).click();
    await vi.waitFor(() => expect(topOverlay()?.querySelector('.video-options-tags__category-input')).toBeTruthy());
    return topOverlay();
  }

  it('creates it and assigns exactly the videos with the tag\'s KEY; Undo removes it', async () => {
    const ds = tagged();
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()), videos: library() });
    const dialog = await openMakeCategory(host);
    expect(dialog.querySelector('.video-options-tags__category-input').value).toBe('pov');
    expect(dialog.querySelector('.video-options-tags__category-count').textContent).toBe('2 videos have this tag.');
    const ok = dialog.querySelector('.modal-btn--primary');
    expect(ok.textContent).toBe('Create category');
    ok.click();

    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Made the category pov with 2 videos.'));
    expect(ds.addCategory).toHaveBeenCalledWith('pov', expect.any(String));
    expect(ds.assignCategory.mock.calls).toEqual([[VIDEO, 'cat-1'], [B, 'cat-1']]);
    expect(ctx.onDataChanged).toHaveBeenCalledWith('categories');

    // Undo in a toast (8 s).
    const [toastBody, , ms] = showToast.mock.calls.at(-1);
    expect(ms).toBe(8000);
    toastBody.querySelector('button').click();
    expect(ds.deleteCategory).toHaveBeenCalledWith('cat-1');
    expect(ds._cats).toEqual([]);
    expect(ds._vc).toEqual({});
  });

  it('a name an existing category has adds the videos to it; Undo takes away only what it added', async () => {
    const ds = makeDs(
      { 'library.userTags': { [VIDEO]: ['display:pov'], [B]: ['display:pov'] } },
      { categories: [{ id: 'c1', name: 'POV', color: '#fff' }], videoCategories: { [B]: ['c1'] } },
    );
    const { host, ctx } = mount({ ds, queue: queueWith(vi.fn()), videos: library() });
    const dialog = await openMakeCategory(host);
    const input = dialog.querySelector('.video-options-tags__category-input');
    input.value = 'POV';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const ok = dialog.querySelector('.modal-btn--primary');
    expect(ok.textContent).toBe('Add to POV');
    expect(dialog.querySelector('.video-options-tags__category-exists').hidden).toBe(false);
    ok.click();

    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalledWith('Added 1 video to POV.'));
    expect(ds.addCategory).not.toHaveBeenCalled();
    expect(ds.assignCategory.mock.calls).toEqual([[VIDEO, 'c1']]);
    showToast.mock.calls.at(-1)[0].querySelector('button').click();
    expect(ds.unassignCategory.mock.calls).toEqual([[VIDEO, 'c1']]);
    expect(ds._vc).toEqual({ [B]: ['c1'] });
  });
});

describe('untrusted text', () => {
  it('a tag named <img onerror> and a post title with markup render as text', () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    const ds = makeDs({
      'library.userTags': { [VIDEO]: [evil] },
      'library.scriptTags': { [VIDEO]: { ...RECORD, tags: [{ id: 1, name: '<script>alert(1)</script>' }], title: '<b>title</b>', creator: '<i>me</i>' } },
      'library.hiddenTags': { [VIDEO]: ['<svg onload=alert(1)>'] },
    });
    const { host } = mount({ ds, queue: queueWith(vi.fn()) });
    expect(host.querySelector('img, script, b, i, svg')).toBeNull();
    const labels = [...host.querySelectorAll('.video-options-tags__chip-label')].map((b) => b.textContent);
    expect(labels).toContain(evil);
    expect(host.querySelector('.video-options-tags__post').textContent).toMatch(/^“<b>title<\/b>” by <i>me<\/i>/);
    expect(window.__pwned).toBeUndefined();
  });
});

describe('dispose', () => {
  it('a running request finishes and saves after the section is gone; a pending Undo goes on in a toast', async () => {
    let answer;
    const main = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD }, 'library.userTags': { [VIDEO]: ['cosplay'] } });
    const { host, handle, ctx } = mount({ ds, queue: queueWith(main) });

    chip(host, 'content:cosplay').querySelector('.video-options-tags__chip-remove').click();
    getButton(host).click();
    await vi.waitFor(() => expect(main).toHaveBeenCalledTimes(1));

    handle.dispose();
    expect(host.childElementCount).toBe(0);
    const toast = showToast.mock.calls.at(-1);
    expect(toast[2]).toBe(8000);
    expect(toast[0].textContent).toContain('Removed cosplay from this video.');

    answer(okAnswer({ tags: [{ id: 4, name: 'vr' }] }));
    await vi.waitFor(() => expect(ds._store['library.scriptTags'][VIDEO].tags).toEqual([{ id: 4, name: 'vr' }]));
    expect(ctx.onDataChanged).toHaveBeenCalledWith('tags');
    expect(host.childElementCount).toBe(0);

    // The toast's Undo still works once the section is gone.
    toast[0].querySelector('button').click();
    expect(ds._store['library.userTags']).toEqual({ [VIDEO]: ['cosplay'] });
  });
});

describe('in the real video options dialog (the contract with stage 2a)', () => {
  it('mounts in the Tags panel, its writes update the rail count, and Escape closes the chip menu before the dialog', async () => {
    const { DataService } = await import('../../renderer/js/data-service.js');
    const { openVideoOptionsDialog, _resetVideoOptionsSessionForTests } = await import('../../renderer/components/video-options-dialog.js');
    _resetVideoOptionsSessionForTests();
    vi.stubGlobal('requestAnimationFrame', (cb) => { cb(0); return 0; });
    window.funsync = new Proxy({}, { get: () => vi.fn(async () => null) });
    const ds = new DataService();
    ds._cache.settings.library = { ...ds._cache.settings.library, userTags: { [VIDEO]: ['pov'] } };
    ds._initialized = true;
    const video = { name: 'Scene.mp4', path: VIDEO, funscriptPath: SCRIPT, hasFunscript: true, variants: [], duration: 60 };
    const host = {
      settings: ds,
      getVideo: (p) => (p === VIDEO ? video : null),
      libraryVideos: () => [video],
      canQueue: false,
      formatDuration: () => '1:00',
      thumbnailUrl: () => null,
      pathStatus: async () => true,
      embeddedAxes: () => null,
      randomVariantOn: () => false,
      collectionContext: () => ({ sources: [], folderIndex: null, descendantsOf: null }),
      dataChanged: vi.fn(),
      categoriesChanged: vi.fn(),
    };
    const done = openVideoOptionsDialog(host, video, { section: 'tags' });
    await vi.waitFor(() => expect(document.querySelector('.modal-body.video-options .video-options-tags')).toBeTruthy());
    const body = document.querySelector('.modal-body.video-options');
    const tagsPanel = body.querySelector('.video-options__panel[data-section="tags"]');
    expect(tagsPanel.querySelector('.video-options-tags')).toBeTruthy();
    const count = () => body.querySelector('.video-options__rail-item[data-section="tags"] .video-options__rail-count')?.textContent;
    expect(count()).toBe('1');

    typeAndAdd(tagsPanel, 'cosplay');
    expect(ds.get('library.userTags')[VIDEO]).toEqual(['pov', 'cosplay']);
    expect(count()).toBe('2');
    expect(host.dataChanged).toHaveBeenCalled();
    expect(body.querySelector('.video-options__live-text').textContent).toBe('Added cosplay.');

    chip(tagsPanel, 'content:pov').querySelector('.video-options-tags__chip-label').click();
    expect(tagsPanel.querySelector('[role="menu"]')).toBeTruthy();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(tagsPanel.querySelector('[role="menu"]')).toBeNull();
    expect(overlays()).toHaveLength(1);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await done;
    expect(overlays()).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

// followUp3 (2026-11-18, verify-2): after Get tags the Undo beside "Got N tags"
// was the older "Post linked" one. Get tags has its own Undo now: the record
// back exactly as before the fetch, while it is still as the fetch left it.
describe('Get tags has its own Undo', () => {
  it('the record goes back exactly as before the fetch; the focus stays where it is', async () => {
    const main = vi.fn(async () => okAnswer({ title: 'Scene v2', tags: [{ id: 1, name: 'pov' }, { id: 4, name: 'vr' }] }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD, [OTHER]: OTHER_RECORD } });
    const before = JSON.stringify(ds._store['library.scriptTags']);
    const announceUndo = vi.fn();
    const { host } = mount({ ds, queue: queueWith(main), announceUndo });
    getButton(host).click();
    await vi.waitFor(() => expect(announceUndo).toHaveBeenCalledTimes(1));
    const [message, undo, opts] = announceUndo.mock.calls[0];
    expect(message).toMatch(/^Got 2 tags from EroScripts/);
    expect(opts).toEqual({ focus: false });
    expect(undo.focusKey).toBe('tags:get');
    expect(JSON.stringify(ds._store['library.scriptTags'])).not.toBe(before);
    expect(undo.run()).toEqual({ message: 'Undone: the tags are as they were before Get tags.' });
    expect(JSON.stringify(ds._store['library.scriptTags'])).toBe(before);
    expect(chipKeys(host)).toContain('device:the-handy');
  });

  it('refuses, writing nothing, when the record changed since', async () => {
    const main = vi.fn(async () => okAnswer({ tags: [{ id: 4, name: 'vr' }] }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const announceUndo = vi.fn();
    const { host } = mount({ ds, queue: queueWith(main), announceUndo });
    getButton(host).click();
    await vi.waitFor(() => expect(announceUndo).toHaveBeenCalledTimes(1));
    ds._store['library.scriptTags'] = { [VIDEO]: { ...RECORD, tags: [{ id: 8, name: 'newer' }] } };
    const now = JSON.stringify(ds._store['library.scriptTags']);
    expect(announceUndo.mock.calls[0][1].run()).toEqual({ message: "Not undone: this video's tags from EroScripts changed again since." });
    expect(JSON.stringify(ds._store['library.scriptTags'])).toBe(now);
  });

  it('a fetch that writes nothing (a 403) offers no Undo', async () => {
    const main = vi.fn(async () => ({ ok: false, outcome: 'authExpired', status: 403, authExpired: true, errorCode: 'accessDenied' }));
    const ds = makeDs({ 'library.scriptTags': { [VIDEO]: RECORD } });
    const announceUndo = vi.fn();
    const { host, ctx } = mount({ ds, queue: queueWith(main), announceUndo });
    getButton(host).click();
    await vi.waitFor(() => expect(ctx.announce).toHaveBeenCalled());
    await settle();
    expect(announceUndo).not.toHaveBeenCalled();
  });
});
