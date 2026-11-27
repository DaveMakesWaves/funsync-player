/**
 * Two variations of one video never share a name (N-02 note, TODO triage
 * 2026-11-23, also in v0.9.2). A pin (library.preferredVariants), the phone's
 * switch and the pop-out pick a variation by its LABEL, so with two alike
 * the second could not be reached. The one-file Add, the bulk naming step's
 * edits, Manage > Rename and the Associate dialog's naming step all number
 * a taken name "Name (2)", as the bulk add already numbered its suggestions.
 * jsdom: library.js and Modal touch the DOM (notes/CLAUDE.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { uniqueVariantLabel } from '../../renderer/js/variant-bulk-add.js';
import { Library } from '../../renderer/components/library.js';
import { Modal } from '../../renderer/components/modal.js';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
beforeEach(() => { _setBundlesForTests('en', EN, EN); vi.restoreAllMocks(); });

describe('uniqueVariantLabel', () => {
  it('free: as typed (trimmed); taken (any case or spacing): numbered from 2, skipping numbers taken too', () => {
    expect(uniqueVariantLabel('  Soft ', ['Hard'])).toBe('Soft');
    expect(uniqueVariantLabel('Soft', ['soft'])).toBe('Soft (2)');
    expect(uniqueVariantLabel('Soft', [' SOFT ', 'Soft (2)'])).toBe('Soft (3)');
    expect(uniqueVariantLabel('', ['x'])).toBe('');
    expect(uniqueVariantLabel('Soft', [null, undefined, ''])).toBe('Soft');
  });
});

describe('the Associate dialog\'s naming step (library.js)', () => {
  it('a name the video\'s list already has (scan or hand-added) is numbered', async () => {
    const store = { 'library.manualVariants': { 'C:\V\Clip.mp4': [{ label: 'Soft', path: 'C:\S\a.funscript', name: 'a.funscript' }] } };
    const lib = new Library({ settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } } });
    lib._videosByPath = new Map([['C:\V\Clip.mp4', { variants: [{ label: 'Default' }] }]]);
    vi.spyOn(Modal, 'open').mockResolvedValueOnce('soft').mockResolvedValueOnce('Default');
    await lib._addVariantWithNaming('C:\V\Clip.mp4', 'C:\S\b.funscript', 'b.funscript');
    await lib._addVariantWithNaming('C:\V\Clip.mp4', 'C:\S\c.funscript', 'c.funscript');
    expect(store['library.manualVariants']['C:\V\Clip.mp4'].map((v) => v.label)).toEqual(['Soft', 'soft (2)', 'Default (2)']);
  });
});

describe('the player\'s paths (app.js)', () => {
  const src = fs.readFileSync('renderer/js/app.js', 'utf8');
  it('one-file Add, the bulk naming step and Manage > Rename all go through it', () => {
    expect(src).toContain('label: this._uniqueVariantLabel?.(label, (this._allVariantsWithManual || []).map((v) => v.label)) ?? label,');
    expect(src).toMatch(/for \(const entry of named\) \{\n\s+entry\.label = this\._uniqueVariantLabel\?\.\(entry\.label, takenLabels\) \?\? entry\.label;\n\s+takenLabels\.push\(entry\.label\);/);
    expect(src).toContain('const newName = asked ? (this._uniqueVariantLabel?.(asked, others) ?? asked) : asked;');
    expect(src).toMatch(/_uniqueVariantLabel\(label, takenLabels\) \{\n\s+return uniqueVariantLabel\(label, takenLabels\);/);
  });
});
