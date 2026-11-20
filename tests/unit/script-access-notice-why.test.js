/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL Library imports DOM-branching modules
 * (notes/CLAUDE.md "Test environments").
 */
// R4-14 (wording, found in the round-3 review of R3-18): `files-exist`
// answered null for a check that ran out of time as well as for a permission
// error. On a slow share the folder answered in time and the script did not,
// and the open said "Can't read <name>: access denied." Now main tells them
// apart (`files-exist { why: true }`, see path-status-detail.test.js) and a
// timeout, a busy file or an I/O error say "Can't read <name> right now.
// Playing without sync." Only a permission error says "access denied".
// Nothing is pruned either way; once per script per session as before.
//
// The REAL Library click route; `files-exist` is a fake per path answering
// in the `{ status, why }` shape main sends when asked `{ why: true }`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { Library } = await import('../../renderer/components/library.js');
const { _resetUnreadableScriptNotices } = await import('../../renderer/js/script-access-notice.js');

// The words the user reads, pinned here (the strings stage adds the new key
// to the 8 locales; a missing key would show raw).
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
ENX.toast.scriptAccessDenied = 'Can\'t read {name}: access denied. Playing without sync.';
ENX.toast.scriptUnreadableNow = 'Can\'t read {name} right now. Playing without sync.';

const DIR = 'C:\\sandbox\\slowshare';
const VIDEO = `${DIR}\\Slow Clip.mp4`;
const SCRIPT = `${DIR}\\Slow Clip.funscript`;
const ASSOC = { [VIDEO]: { active: 'single', single: SCRIPT, multi: null, custom: null } };

let answer; // path -> { status, why }
let store;

const settled = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
const notices = () => showToast.mock.calls.filter(([msg]) => /Can't read/.test(msg));

beforeEach(() => {
  _setBundlesForTests('en', ENX, ENX);
  _resetUnreadableScriptNotices();
  showToast.mockClear();
  answer = new Map([[DIR, { status: true, why: null }]]);
  store = { 'library.associations': structuredClone(ASSOC), 'library.sources': [] };
  window.funsync = {
    readFunscript: vi.fn(async () => null),
    filesExist: vi.fn(async (paths, _budget, opts) => paths.map((p) => {
      const a = answer.get(p) || { status: false, why: null };
      return opts?.why ? a : a.status;
    })),
  };
});

afterEach(() => { delete window.funsync; });

async function open() {
  const settings = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const lib = new Library({ settings, onPlayVideo: () => {} });
  lib._videos = [{ name: 'Slow Clip.mp4', path: VIDEO, hasFunscript: true, funscriptPath: SCRIPT }];
  await lib._playVideo(lib.getVideoByPath(VIDEO));
  await settled();
}

describe('R4-14: a script that did not answer in time is not "access denied"', () => {
  it('the folder answers, the script times out: "right now", not "access denied"', async () => {
    answer.set(SCRIPT, { status: null, why: 'timeout' });
    await open();
    expect(notices()).toEqual([
      ['Can\'t read Slow Clip.funscript right now. Playing without sync.', 'warn', 6000],
    ]);
  });

  it('a busy file or an I/O error: "right now" too', async () => {
    answer.set(SCRIPT, { status: null, why: 'error' });
    await open();
    expect(notices().map(([m]) => m)).toEqual(['Can\'t read Slow Clip.funscript right now. Playing without sync.']);
  });

  it('a permission error is still "access denied"', async () => {
    answer.set(SCRIPT, { status: null, why: 'denied' });
    await open();
    expect(notices().map(([m]) => m)).toEqual(['Can\'t read Slow Clip.funscript: access denied. Playing without sync.']);
  });

  it('asks main for the reason, and nothing is pruned or changed either way', async () => {
    answer.set(SCRIPT, { status: null, why: 'timeout' });
    await open();
    expect(window.funsync.filesExist).toHaveBeenCalledWith([SCRIPT, DIR], undefined, { why: true });
    expect(store['library.associations']).toEqual(ASSOC);
  });

  it('once per script per session', async () => {
    answer.set(SCRIPT, { status: null, why: 'timeout' });
    await open();
    await open();
    expect(notices()).toHaveLength(1);
  });
});
