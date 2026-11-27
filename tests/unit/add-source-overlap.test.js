/**
 * @vitest-environment jsdom
 * jsdom on purpose: i18n.js branches on `typeof window` (notes/CLAUDE.md
 * "Test environments").
 */
// Library ▾ "Add Source Folder…" and the first-launch button (app.js
// _addSource) follow Settings > Sources' rules (test day 2026-11-24, B024):
// the overlap is checked BEFORE the name is asked. It asked for a name and
// then refused an exact duplicate (compared without folding slashes or the
// drive letter), and took a folder inside a source, or one holding sources,
// without a word, so every video in it was scanned twice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { liftAppClass } from './helpers/app-methods.js';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { askSourceOverlap } from '../../renderer/js/source-overlap-ask.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
_setBundlesForTests('en', EN, EN);

const MAIN = { id: 'main', name: 'Main', path: 'C:\\Videos', enabled: true };
const SUB = { id: 'sub', name: 'Sub', path: 'C:\\Videos\\Sub', enabled: true };

let app;
let store;
let calls;

function makeApp({ picked, confirm = true, name = 'New' }) {
  calls = { prompt: 0, confirm: [], toasts: [] };
  const Modal = {
    prompt: vi.fn(async () => { calls.prompt += 1; return name; }),
    confirm: vi.fn(async (title) => { calls.confirm.push(title); return confirm; }),
  };
  const Lifted = liftAppClass(['_addSource'], {
    Modal,
    crypto: globalThis.crypto,
    showToast: vi.fn((msg) => calls.toasts.push(msg)),
    t,
    askSourceOverlap,
  });
  window.funsync = { ...(window.funsync || {}), selectDirectory: vi.fn(async () => picked) };
  return Object.assign(new Lifted(), {
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    library: { _lastScanKey: 'x', show: vi.fn() },
    _refreshCollectionsUI: vi.fn(async () => {}),
    _getViewEl: () => document.createElement('div'),
    _currentView: () => 'library',
    _rescanLibraryInBackground: vi.fn(),
    upNextEngine: { refresh: vi.fn() },
  });
}

beforeEach(() => { store = { 'library.sources': [MAIN] }; });

describe('Add Source Folder: the same rules as Settings > Sources (B024)', () => {
  it('the same folder (another slash style, a trailing slash, the drive letter in lower case) is refused BEFORE the name is asked, naming the source', async () => {
    app = makeApp({ picked: 'c:/Videos/' });
    await app._addSource();
    expect(calls.prompt).toBe(0);
    expect(calls.toasts).toEqual(['Already added as "Main"']);
    expect(store['library.sources']).toEqual([MAIN]);
  });

  it('a folder inside a source asks first; "Add anyway" adds it, Cancel adds nothing', async () => {
    app = makeApp({ picked: 'C:\\Videos\\Sub', confirm: false });
    await app._addSource();
    expect(calls.confirm).toEqual([EN.settingsPanel.sources.childOverlapTitle]);
    expect(calls.prompt).toBe(0);
    expect(store['library.sources']).toEqual([MAIN]);

    app = makeApp({ picked: 'C:\\Videos\\Sub', confirm: true });
    await app._addSource();
    expect(store['library.sources'].map((s) => s.path)).toEqual(['C:\\Videos', 'C:\\Videos\\Sub']);
  });

  it('a folder holding sources asks, and on yes replaces them with itself', async () => {
    store['library.sources'] = [SUB];
    app = makeApp({ picked: 'C:\\Videos', confirm: true, name: 'All' });
    await app._addSource();
    expect(calls.confirm).toEqual([EN.settingsPanel.sources.parentOverlapTitle]);
    expect(store['library.sources'].map((s) => [s.name, s.path])).toEqual([['All', 'C:\\Videos']]);
  });

  it('a new, separate folder: the name, then it is added', async () => {
    app = makeApp({ picked: 'E:\\Other', name: 'Other' });
    await app._addSource();
    expect(calls.confirm).toEqual([]);
    expect(calls.prompt).toBe(1);
    expect(store['library.sources'].map((s) => s.name)).toEqual(['Main', 'Other']);
  });
});
