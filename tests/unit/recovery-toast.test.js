// The boot-time recovery toast (V06).
//
// jsdom on purpose (no node docblock): i18n.js branches on
// `typeof window`. See notes/CLAUDE.md "Test environments".
//
// Two defects, both in v0.9.2:
//   1. verifyAndRecover could not tell a first launch from a lost config,
//      so every new install got a red 15 s "Settings could not be
//      recovered" toast (data-backup.test.js covers the `fresh` result);
//   2. both recovery toasts were hard-coded English.
//
// app.js self-instantiates `new App()` on import, so it cannot be imported
// here. Instead the REAL `_maybeShowRecoveryToast` body is lifted out of
// app.js and run with a stubbed boot result, the real i18n `t` and a
// recording showToast, so what is asserted is what the user would see.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { t, _setBundlesForTests, _resetForTests } from '../../renderer/js/i18n.js';

const en = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const de = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));

function liftMethod(src, signature) {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found in app.js`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

const body = liftMethod(fs.readFileSync('renderer/js/app.js', 'utf8'), 'async _maybeShowRecoveryToast()');
// eslint-disable-next-line no-new-func
const makeToastFn = new Function('window', 'showToast', 't', `return async function () {${body}};`);

async function bootWith(result) {
  const toasts = [];
  const fakeWindow = { funsync: { backupGetBootResult: async () => result } };
  const run = makeToastFn(fakeWindow, (message, type, duration) => toasts.push({ message, type, duration }), t);
  await run.call({});
  return toasts;
}

describe('boot recovery toast', () => {
  beforeEach(() => { _setBundlesForTests('en', en, en); });
  afterEach(() => { _resetForTests(); });

  it('shows nothing on a first launch (fresh)', async () => {
    expect(await bootWith({ recovered: false, fresh: true, reason: 'file missing' })).toEqual([]);
  });

  it('shows nothing on a healthy boot', async () => {
    expect(await bootWith({ recovered: false })).toEqual([]);
  });

  it('still warns, as an error, when settings were genuinely lost', async () => {
    const toasts = await bootWith({ recovered: false, fellBack: true, reason: 'empty file' });
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].message).toBe(en.toast.settingsNotRecovered);
  });

  it('speaks the user\'s language for both toasts', async () => {
    _setBundlesForTests('de', de, en);
    const lost = await bootWith({ recovered: false, fellBack: true, reason: 'empty file' });
    const recovered = await bootWith({ recovered: true, fromSnapshot: { filename: 'x.json' }, reason: 'empty file' });
    expect(lost[0].message).toBe(de.toast.settingsNotRecovered);
    expect(recovered[0].message).toBe(de.toast.settingsRecovered);
    expect(recovered[0].type).toBe('warn');
    expect(lost[0].message).not.toBe(en.toast.settingsNotRecovered);
    expect(recovered[0].message).not.toBe(en.toast.settingsRecovered);
  });
});
