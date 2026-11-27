/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The shape of a post's tags as main hands them to the renderer
// (eroscriptsTopic -> parseTopicMeta): each one an object, {id?, name},
// whether the forum sent names or objects. Renderer code that reads
// `answer.tags` must take `.name`; eroscripts-tab.test.js's fake answer
// mirrors this shape. String() of one put "[object Object]" in the post
// window's tags (Dave, 2026-11-26).
import { describe, it, expect } from 'vitest';

const { parseTopicMeta } = await import('../../electron/eroscripts-api.js');

describe('a post\'s tags from main are objects with a name', () => {
  it('names and objects from the forum both come out as {id?, name}', () => {
    const meta = parseTopicMeta({ id: 7, slug: 's', title: 'T', tags: ['pmv', { id: 12, name: 'the-handy', slug: 'the-handy' }] });
    expect(meta.tags).toEqual([{ name: 'pmv' }, { id: 12, name: 'the-handy' }]);
    for (const tag of meta.tags) expect(typeof tag).toBe('object');
  });
});
