/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Integration: end-to-end that a user's custom position binding fires
// in the editor's key handler, that defaults still fire, and that
// overrides win.
//
// We avoid booting the full ScriptEditor class (which requires the
// VideoPlayer, FunscriptEngine, ProgressBar, autosave plumbing, etc.).
// Instead we exercise the resolver path the editor uses: build the
// resolver Map from settings → simulate the key event → assert the
// resolved position.
//
// SCOPE: notes/features/SCOPE-editor-custom-position-keys.md §6.

import { describe, it, expect } from 'vitest';
import {
  buildResolverMap,
  lookupBinding,
} from '../../renderer/js/position-key-resolver.js';

function resolve(customBindings, evt) {
  const map = buildResolverMap(customBindings);
  const pos = lookupBinding(map, {
    code: evt.code,
    mods: { shift: !!evt.shiftKey, ctrl: !!evt.ctrlKey, alt: !!evt.altKey },
  });
  return pos;
}

describe('script-editor — custom position key integration', () => {
  it('custom binding A → 25 fires when A is pressed', () => {
    const bindings = [{ code: 'KeyA', mods: {}, position: 25 }];
    expect(resolve(bindings, { code: 'KeyA' })).toBe(25);
  });

  it('custom binding does not match a different key', () => {
    const bindings = [{ code: 'KeyA', mods: {}, position: 25 }];
    expect(resolve(bindings, { code: 'KeyB' })).toBe(null);
  });

  it('default key (5 → 50) is unaffected when no custom binding exists', () => {
    expect(resolve([], { code: 'Digit5' })).toBe(null);
    // Editor falls through to its numpadMap[Digit5] = 50.
  });

  it('override binding 5 → 75 wins over default 5 → 50', () => {
    const bindings = [{ code: 'Digit5', mods: {}, position: 75 }];
    expect(resolve(bindings, { code: 'Digit5' })).toBe(75);
  });

  it('removing the override restores the default fall-through', () => {
    const map1 = buildResolverMap([{ code: 'Digit5', mods: {}, position: 75 }]);
    expect(map1.get('Digit5')).toBe(75);
    const map2 = buildResolverMap([]);
    expect(map2.has('Digit5')).toBe(false);
  });

  it('Shift+A and bare A are independent bindings', () => {
    const bindings = [
      { code: 'KeyA', mods: {}, position: 25 },
      { code: 'KeyA', mods: { shift: true }, position: 75 },
    ];
    expect(resolve(bindings, { code: 'KeyA' })).toBe(25);
    expect(resolve(bindings, { code: 'KeyA', shiftKey: true })).toBe(75);
  });

  it('modifier mismatch does not fire (Ctrl+A on a bare-A binding)', () => {
    const bindings = [{ code: 'KeyA', mods: {}, position: 25 }];
    expect(resolve(bindings, { code: 'KeyA', ctrlKey: true })).toBe(null);
  });

  it('user can bind a top-key alternative (Equal → 100)', () => {
    const bindings = [{ code: 'Equal', mods: {}, position: 100 }];
    expect(resolve(bindings, { code: 'Equal' })).toBe(100);
  });
});
