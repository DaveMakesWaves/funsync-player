/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL editor-popout.html body and the REAL editor.css
 * and popout-chrome.css go through jsdom's cascade (getComputedStyle).
 */
// CB-03: the pop-out editor did not fit its window. At the default 1100x700
// the content was 748px tall in a 700px viewport with body overflow hidden:
// the 48px title strip, then the editor at `height: 100%` (700px) under it.
// The time-axis labels at the bottom were cut off, and once the canvas took
// focus the body scrolled 30px and hid the title strip instead.
//
// jsdom does no layout, so this pins what makes the window fit, through the
// real stylesheets on the real page markup: the body is a column, the strip
// keeps its 48px, and the editor takes the REST (it grows, shrinks below its
// content, and is not 100% of the window). Measured in a headless Electron
// window on the real page (CB-03 notes): 700/500/1000/360px windows, opened
// and resized both ways, give a body scroll height equal to the viewport,
// scrollTop 0 after the canvas focus, and the scrubber ending on the last px.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';

const HTML = fs.readFileSync('renderer/editor-popout.html', 'utf8');
// Every stylesheet the page links, in its order.
const SHEETS = [...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);

beforeAll(() => {
  // The page's own body (title strip, host, toast container), without the
  // module script: the host gets the classes editor-popout.js gives it.
  const body = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
  document.documentElement.classList.add('has-wco');
  expect(SHEETS).toContain('styles/editor.css');
  for (const href of SHEETS) {
    const style = document.createElement('style');
    style.textContent = fs.readFileSync(`renderer/${href}`, 'utf8');
    document.head.appendChild(style);
  }
  const host = document.getElementById('editor-popout-host');
  host.classList.add('script-editor', 'script-editor--popout-window');
  for (const cls of ['editor__toolbar', 'editor__canvas-container', 'editor__scrubber']) {
    const el = document.createElement('div');
    el.className = cls;
    host.appendChild(el);
  }
});

const cs = (sel) => getComputedStyle(document.querySelector(sel));

describe('the pop-out editor fits its window (CB-03)', () => {
  it('the window is a column: the title strip, then the editor', () => {
    expect(cs('body').display).toBe('flex');
    expect(cs('body').flexDirection).toBe('column');
    expect(cs('body').overflow).toBe('hidden');
    // The strip keeps its height and never shrinks.
    expect(cs('.popout-titlebar').height).toBe('48px');
    expect(cs('.popout-titlebar').flexShrink).toBe('0');
  });

  it('the editor takes the rest of the height, not 100% of the window under the strip', () => {
    const host = cs('#editor-popout-host');
    expect(host.height).not.toBe('100%');
    expect(host.flexGrow).toBe('1');
    expect(host.flexShrink).toBe('1');
    expect(host.minHeight).toBe('0px'); // can shrink with a smaller window
    expect(host.position).toBe('static');
    expect(host.display).toBe('flex');
    expect(host.flexDirection).toBe('column');
  });

  it('inside the editor the canvas takes what the toolbar and the scrubber leave', () => {
    expect(cs('.editor__canvas-container').flexGrow).toBe('1');
    // Overflow hidden makes its automatic minimum 0, so it shrinks with the window.
    expect(cs('.editor__canvas-container').overflow).toBe('hidden');
    expect(cs('.editor__toolbar').flexShrink).toBe('0');
    expect(cs('.editor__scrubber').flexShrink).toBe('0');
  });

  it('toasts float over the editor and take no height from it', () => {
    expect(['fixed', 'absolute']).toContain(cs('#toast-container').position);
  });
});
