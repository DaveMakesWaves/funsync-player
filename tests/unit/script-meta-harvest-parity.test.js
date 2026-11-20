/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The funscript metadata harvest exists in two languages: the backend reads
// the file and keeps its `metadata` block, capped (backend/services/
// script_meta.py harvest_metadata), and the renderer turns that into the tag
// engine's record (renderer/js/video-tags.js funscriptMetaRecord). One table,
// tests/fixtures/script-meta-harvest.json, pins both: the Python suite
// (backend/tests/test_script_meta.py) asserts harvest(file) is `harvested`,
// and this asserts the renderer gets the SAME record from `harvested` as it
// would from the file's own block. A cap or a type rule changed in one
// language and not the other fails one side.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { funscriptMetaRecord } from '../../renderer/js/video-tags.js';

const PLACEHOLDERS = {
  '@@LONG201@@': 'x'.repeat(201),
  '@@LONG200@@': 'y'.repeat(200),
  '@@EMOJI100@@': '\u{1F600}'.repeat(100),
  '@@EMOJI101@@': '\u{1F600}'.repeat(101),
};

function expand(value) {
  if (typeof value === 'string') return PLACEHOLDERS[value] ?? value;
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]));
  return value;
}

const { cases } = JSON.parse(fs.readFileSync('tests/fixtures/script-meta-harvest.json', 'utf8'));

describe('the harvest gives the renderer what the file would', () => {
  for (const raw of cases) {
    const c = expand(raw);
    it(c.name, () => {
      const fromFile = funscriptMetaRecord(c.file.metadata, 1234);
      const fromHarvest = c.harvested === null ? null : funscriptMetaRecord(c.harvested, 1234);
      expect(fromHarvest).toEqual(fromFile);
      if (fromFile) expect(fromFile.topicId).toBe(c.topicId);
    });
  }

  it('the table covers the edges it claims to', () => {
    const names = cases.map((c) => c.name).join(' | ');
    for (const word of ['odd types', 'junk', 'overlong', 'no metadata block', 'astral', 'author', 'surrogate']) {
      expect(names).toContain(word);
    }
  });
});
