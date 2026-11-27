/**
 * @vitest-environment jsdom
 * jsdom: the card's DOM and the stylesheet (notes/CLAUDE.md "Test environments").
 */
// Dave, 2026-11-26 (seen in the feature clip): on a post with both a video and
// a script, the card's Download button "covers the script badge": the chips'
// row (overflow: hidden) clipped "Script" to "Scrip" beside the button at
// ~220 px cards. Now, when the words do not fit, the chips show as icons only;
// the words stay as each chip's title / label.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { EroScriptsView } from '../../renderer/components/eroscripts-view.js';

const CSS = fs.readFileSync('renderer/styles/eroscripts.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function entryWith({ scroll, client }) {
  const parts = document.createElement('div');
  parts.className = 'es-card__parts';
  const video = document.createElement('span');
  video.className = 'es-part es-part--video';
  parts.appendChild(video);
  document.body.appendChild(parts);
  Object.defineProperty(parts, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(parts, 'clientWidth', { configurable: true, get: () => client });
  return { entry: { els: { videoPart: video } }, parts };
}
const fit = (entry, view = {}) => EroScriptsView.prototype._fitParts.call(view, entry);

describe('the card\'s Video / Script chips never get clipped by the button', () => {
  it('words wider than the room beside the button: icons only', () => {
    const { entry, parts } = entryWith({ scroll: 142, client: 118 });
    fit(entry);
    expect(parts.classList.contains('es-card__parts--compact')).toBe(true);
  });

  it('room enough: the words stay; a wider card later takes the compact look off again', () => {
    const { entry, parts } = entryWith({ scroll: 118, client: 140 });
    fit(entry);
    expect(parts.classList.contains('es-card__parts--compact')).toBe(false);
    parts.classList.add('es-card__parts--compact');
    fit(entry, { _gridWidth: 1880 });           // the grid resized: measured again
    expect(parts.classList.contains('es-card__parts--compact')).toBe(false);
  });

  it('a card not in the page yet (or hidden by a filter) is left alone', () => {
    expect(() => fit({ els: { videoPart: document.createElement('span') } })).not.toThrow();
    expect(() => fit({ els: {} })).not.toThrow();
  });

  it('the compact look hides the words, not the chips', () => {
    expect(CSS).toMatch(/\.es-card__parts--compact \.es-part__text\s*\{\s*display:\s*none;?\s*\}/);
    expect(CSS).not.toMatch(/\.es-card__parts--compact \.es-part\s*\{[^}]*display:\s*none/);
  });

  it('every card paint fits its chips (after the button has its words)', () => {
    const src = fs.readFileSync('renderer/components/eroscripts-view.js', 'utf8');
    const paint = src.slice(src.indexOf('  _paintCard(entry) {'), src.indexOf('  _fitParts(entry) {'));
    expect(paint.indexOf('this._fitParts(entry)')).toBeGreaterThan(paint.indexOf("b.setAttribute('aria-label'"));
  });
});

describe('a card painted before it is in the grid', () => {
  it('is measured on the next frame, once it is in the page', async () => {
    const parts = document.createElement('div');
    parts.className = 'es-card__parts';
    const video = document.createElement('span');
    parts.appendChild(video);
    Object.defineProperty(parts, 'scrollWidth', { configurable: true, get: () => 126 });
    Object.defineProperty(parts, 'clientWidth', { configurable: true, get: () => (parts.isConnected ? 112 : 0) });
    const entry = { els: { videoPart: video } };
    const view = { _fitParts: EroScriptsView.prototype._fitParts };
    view._fitParts(entry);                       // painted while detached
    expect(parts.classList.contains('es-card__parts--compact')).toBe(false);
    document.body.appendChild(parts);            // then added to the grid
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => setTimeout(r, 0));
    expect(parts.classList.contains('es-card__parts--compact')).toBe(true);
  });
});

describe('measured only when something that decides it changed', () => {
  it('the same words, button and grid width: not measured again (each download poll repaints every card)', () => {
    const { entry, parts } = entryWith({ scroll: 142, client: 118 });
    let reads = 0;
    Object.defineProperty(parts, 'scrollWidth', { configurable: true, get: () => { reads += 1; return 142; } });
    fit(entry, { _gridWidth: 1880 });
    fit(entry, { _gridWidth: 1880 });
    fit(entry, { _gridWidth: 1880 });
    expect(reads).toBe(1);
    entry.els.videoPart.textContent = 'Video 45%';
    fit(entry, { _gridWidth: 1880 });
    expect(reads).toBe(2);
  });
});
