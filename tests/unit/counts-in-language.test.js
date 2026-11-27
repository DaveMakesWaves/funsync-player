/**
 * @vitest-environment jsdom
 * jsdom: the real Categories renders into a DOM; i18n.js branches on
 * `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Test day 2026-11-26 (B102): counts were pluralised by hand in English, so
// the German UI said "2 videos" on a category card and in its header, "8
// videos" on a folder card, and "3 sources" in the library header (in
// v0.10.0 too). They use the locale's plural forms now.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Categories } from '../../renderer/components/categories.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const DE = JSON.parse(fs.readFileSync('renderer/locales/de.json', 'utf8'));
const CAT = { id: 'cat-1', name: 'Testkategorie', color: '#e94560' };
const PATHS = ['C:\\Lib\\Alpha.mp4', 'C:\\Lib\\Bravo.mp4'];

beforeEach(() => {
  document.body.innerHTML = '';
  _setBundlesForTests('de', DE, EN);
  window.funsync = {
    filesExist: vi.fn(async (list) => list.map(() => true)),
    fileExists: vi.fn(async () => true),
    readFunscript: vi.fn(async () => null),
    generateSingleThumbnail: vi.fn(async () => null),
  };
});
afterEach(() => { delete window.funsync; _setBundlesForTests('en', EN, EN); });

function mount() {
  const settings = {
    getCategories: () => [CAT],
    getVideosByCategory: (id) => (id === CAT.id ? PATHS.slice() : []),
    getVideoCategories: () => [],
    get: () => ({}),
    unassignCategory: vi.fn(),
  };
  const cats = new Categories({ settings, onPlayVideo: vi.fn(), library: null });
  const container = document.createElement('div');
  document.body.appendChild(container);
  cats._container = container;
  cats._viewMode = 'grid';
  return { cats, container };
}

describe('counts in the language chosen (B102)', () => {
  it('a category\'s detail header: "2 Videos", not "2 videos"', async () => {
    const { cats, container } = mount();
    cats._view = 'detail';
    cats._detailCategoryId = CAT.id;
    await cats._renderDetail(CAT.id);
    const text = container.textContent;
    expect(text).toContain('2 Videos');
    expect(text).not.toContain('2 videos');
  });

  it('no count in the renderer is pluralised by hand in English any more', () => {
    const hits = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name !== 'vendor' && ent.name !== 'node_modules') walk(p); continue; }
        if (!ent.name.endsWith('.js')) continue;
        fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (/!== 1 \? 's' : ''/.test(line) && !/console\.|log\(/.test(line)) hits.push(`${p}:${i + 1}`);
        });
      }
    };
    walk('renderer');
    expect(hits).toEqual([]);
  });
});
