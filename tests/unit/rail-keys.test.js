/**
 * @vitest-environment jsdom
 *
 * The rails of Settings and the video options dialog are a column on a wide
 * window and a row below 620 px. They kept aria-orientation="vertical" and
 * moved on Up / Down only (found fixup-ui 2026-11-18; fixed 2026-11-22).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { railNextIndex, wireRailKeys } from '../../renderer/js/rail-keys.js';

describe('railNextIndex', () => {
  it('a column: Up / Down wrap, Home / End jump, Left / Right are not its keys', () => {
    expect(railNextIndex('ArrowDown', 0, 3, false)).toBe(1);
    expect(railNextIndex('ArrowDown', 2, 3, false)).toBe(0);
    expect(railNextIndex('ArrowUp', 0, 3, false)).toBe(2);
    expect(railNextIndex('Home', 2, 3, false)).toBe(0);
    expect(railNextIndex('End', 0, 3, false)).toBe(2);
    expect(railNextIndex('ArrowRight', 0, 3, false)).toBe(-1);
    expect(railNextIndex('ArrowLeft', 0, 3, false)).toBe(-1);
  });

  it('a row: Left / Right move along it and wrap; Up / Down still work', () => {
    expect(railNextIndex('ArrowRight', 0, 3, true)).toBe(1);
    expect(railNextIndex('ArrowRight', 2, 3, true)).toBe(0);
    expect(railNextIndex('ArrowLeft', 0, 3, true)).toBe(2);
    expect(railNextIndex('ArrowDown', 0, 3, true)).toBe(1);
    expect(railNextIndex('a', 0, 3, true)).toBe(-1);
  });
});

describe('wireRailKeys on a rail that is a row', () => {
  function rail(direction) {
    const el = document.createElement('div');
    el.setAttribute('role', 'tablist');
    el.style.display = 'flex';
    el.style.flexDirection = direction;
    el.innerHTML = '<button class="r">A</button><button class="r">B</button><button class="r">C</button>';
    document.body.replaceChildren(el);
    const clicked = [];
    for (const b of el.querySelectorAll('.r')) b.addEventListener('click', () => { clicked.push(b.textContent); b.focus(); });
    wireRailKeys(el, '.r');
    return { el, clicked, items: [...el.querySelectorAll('.r')] };
  }
  const press = (target, key) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };

  it('says horizontal once focus enters, and Right / Left move the selection', () => {
    const { el, clicked, items } = rail('row');
    items[0].focus();
    expect(el.getAttribute('aria-orientation')).toBe('horizontal');
    expect(press(items[0], 'ArrowRight').defaultPrevented).toBe(true);
    press(items[1], 'ArrowLeft');
    press(items[0], 'ArrowLeft');
    expect(clicked).toEqual(['B', 'A', 'C']);
  });

  it('a column stays vertical, and Right does nothing there', () => {
    const { el, clicked, items } = rail('column');
    items[0].focus();
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(press(items[0], 'ArrowRight').defaultPrevented).toBe(false);
    press(items[0], 'ArrowDown');
    expect(clicked).toEqual(['B']);
  });

  it('Settings and the video options dialog both use it', () => {
    expect(fs.readFileSync('renderer/components/settings-panel.js', 'utf8')).toMatch(/wireRailKeys\(rail, '\.settings-panel__rail-item'\)/);
    expect(fs.readFileSync('renderer/components/video-options-dialog.js', 'utf8')).toMatch(/wireRailKeys\(rail, '\.video-options__rail-item'\)/);
  });
});
