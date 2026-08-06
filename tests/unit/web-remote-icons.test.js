import { describe, it, expect } from 'vitest';
import { svgIcon } from '../../backend/web-remote/icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

describe('svgIcon namespace', () => {
  it('returns an <svg> in the SVG namespace (not an unknown HTML element)', () => {
    const el = svgIcon('maximize', 20);
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.namespaceURI).toBe(SVG_NS);
  });

  it('child paths are also SVG-namespaced', () => {
    const el = svgIcon('maximize', 20);
    const kids = [...el.children];
    expect(kids.length).toBeGreaterThan(0);
    for (const k of kids) expect(k.namespaceURI).toBe(SVG_NS);
  });

  it('keeps the rendering attributes call sites depend on', () => {
    const el = svgIcon('volume', 20);
    expect(el.getAttribute('width')).toBe('20');
    expect(el.getAttribute('height')).toBe('20');
    expect(el.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(el.getAttribute('stroke')).toBe('currentColor');
    expect(el.getAttribute('fill')).toBe('none');
  });

  it('is appendable and replaceable like before', () => {
    const btn = document.createElement('button');
    btn.appendChild(svgIcon('play', 34));
    expect(btn.querySelector('svg')).toBeTruthy();
    btn.replaceChildren(svgIcon('pause', 34));
    expect(btn.querySelectorAll('svg').length).toBe(1);
  });

  it('unknown icon name still returns a harmless element', () => {
    expect(svgIcon('nope').tagName.toLowerCase()).toBe('span');
  });

  it('every player-control icon resolves', () => {
    for (const n of ['play', 'pause', 'volume', 'volumeOff', 'maximize']) {
      expect(svgIcon(n, 20).tagName.toLowerCase()).toBe('svg');
    }
  });
});
