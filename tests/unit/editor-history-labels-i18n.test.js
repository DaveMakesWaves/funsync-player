/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The undo history's step names (editor work list 4.5, 2026-11-24) are
// locale keys stored in EditableScript's undo entries, never written as
// t('...') literals, so the i18n-keys-exist scan cannot see them. This pins
// that every one of them, and every modifier's, is in all 8 shipped bundles:
// a missing one would show the menu's "Edit" fallback for that step.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HISTORY_LABELS, modifierLabel } from '../../renderer/js/editable-script.js';
import * as M from '../../renderer/js/script-modifiers.js';

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh'];
const bundle = (code) => JSON.parse(readFileSync(`renderer/locales/${code}.json`, 'utf8'));
const get = (o, key) => key.split('.').reduce((n, p) => (n && typeof n === 'object' ? n[p] : undefined), o);

const KEYS = [
  ...Object.values(HISTORY_LABELS),
  ...[M.halfSpeed, M.doubleSpeed, M.reverseActions, M.remapRange, M.offsetTime, M.removePauses, M.rangeExtend, M.fadeIn, M.fadeOut]
    .map((fn) => modifierLabel(fn)),
];

describe('undo history step names', () => {
  it.each(LOCALES)('%s.json has every one', (code) => {
    const b = bundle(code);
    const missing = KEYS.filter((k) => typeof get(b, k) !== 'string' || !get(b, k));
    expect(missing).toEqual([]);
  });
});
