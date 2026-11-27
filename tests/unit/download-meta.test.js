/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The EroScripts tab's note on a video download, kept with the job by the
// backend so a download that comes back after FunSync closed still finishes
// as its post's (Dave, 2026-11-25). renderer/js/download-meta.js.
import { describe, it, expect } from 'vitest';
import { downloadMeta, infoFromMeta } from '../../renderer/js/download-meta.js';

const TOPIC = { id: 341682, title: 'Pmv mix // vol. 12', url: 'https://discuss.eroscripts.com/t/341682', creator: 'maker', categoryId: 14, tags: ['pmv'] };
const ANSWER = {
  topicId: 341682, title: 'Pmv mix // vol. 12', url: TOPIC.url, creator: 'maker', tags: ['pmv', 'the-handy'],
  // What a post also carries, and the note must not: the backend drops one over 64 KB.
  attachments: Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.funscript`, url: `https://x/${i}` })),
  links: Array.from({ length: 50 }, (_, i) => ({ url: `https://pixeldrain.com/u/${i}`, text: 'x'.repeat(200) })),
  cooked: '<p>'.padEnd(200000, 'x'),
};
const SCRIPT = { url: 'https://discuss.eroscripts.com/uploads/a.funscript', name: 'PMVMIX12.funscript', size: 1234, axes: [{ url: 'https://x/r', suffix: 'roll' }] };

describe('downloadMeta', () => {
  it('keeps what finishing needs (post, script, axes, tags), small, and nothing else', () => {
    const meta = downloadMeta({ topic: TOPIC, answer: ANSWER, script: SCRIPT, axes: SCRIPT.axes, title: ANSWER.title });
    expect(meta).toEqual({
      v: 1, topicId: 341682, title: 'Pmv mix // vol. 12',
      topic: { id: 341682, topicId: null, url: TOPIC.url, title: TOPIC.title, creator: 'maker', tags: ['pmv'] },
      answer: { id: null, topicId: 341682, url: TOPIC.url, title: ANSWER.title, creator: 'maker', tags: ['pmv', 'the-handy'] },
      script: { url: SCRIPT.url, name: 'PMVMIX12.funscript' },
      axes: [{ url: 'https://x/r', suffix: 'roll' }],
    });
    expect(JSON.stringify(meta).length).toBeLessThan(2000);
  });

  it('a pasted link: only its name', () => {
    expect(downloadMeta({ title: 'Clip' })).toEqual({ v: 1, topicId: null, title: 'Clip', topic: null, answer: null, script: null, axes: [] });
  });
});

describe('infoFromMeta', () => {
  it("rebuilds the tab's info: the post, the script under the video's reserved name, marked as brought back", () => {
    const job = { id: 'r1', stem: 'Pmv mix vol. 12', destDir: 'C:\\Lib\\', meta: downloadMeta({ topic: TOPIC, answer: ANSWER, script: SCRIPT, axes: SCRIPT.axes, title: ANSWER.title }) };
    expect(infoFromMeta(job)).toMatchObject({
      topicId: 341682, title: 'Pmv mix // vol. 12', stem: 'Pmv mix vol. 12', handled: false, restored: true,
      script: { url: SCRIPT.url, name: 'PMVMIX12.funscript' },
      scriptPath: 'C:\\Lib\\Pmv mix vol. 12.funscript',
      topic: { id: 341682 }, answer: { tags: ['pmv', 'the-handy'] }, axes: [{ url: 'https://x/r', suffix: 'roll' }],
    });
    expect(infoFromMeta({ ...job, destDir: '/home/me/Videos' }).scriptPath).toBe('/home/me/Videos/Pmv mix vol. 12.funscript');
  });

  it('no note (an older backend, a pasted link): a bare row the Downloads list can show', () => {
    expect(infoFromMeta({ id: 'x', stem: 'Clip', destDir: 'C:\\Lib' }))
      .toEqual({ topicId: null, topic: null, answer: null, script: null, scriptPath: null, stem: 'Clip', title: 'Clip', handled: false, axes: [], restored: true });
  });
});

// Dave, 2026-11-25: a download resumed after FunSync closed came back with NO
// tags ("it was in the case of a partial and resumed download"). The note kept
// only tags written as strings, and the post's own answer lists them as
// objects ({id, name}): every one was dropped, and the finish recorded "this
// post has no tags" over the list's.
describe('a resumed download keeps its post\'s tags', () => {
  it('the answer\'s tag objects survive the note; the finish records them', async () => {
    const { recordDownloadTags, getScriptTags } = await import('../../renderer/js/script-tags.js');
    const topic = { id: 7, title: 'Post A', url: 'https://discuss.eroscripts.com/t/a/7', creator: 'maker', tags: ['pov', 'vr'] };
    const answer = { topicId: 7, title: 'Post A', url: topic.url, creator: 'maker', tags: [{ id: 1, name: 'pov' }, { id: 2, name: 'vr' }, { id: 3, name: 'the-handy' }, 'tentacle'] };
    const meta = JSON.parse(JSON.stringify(downloadMeta({ topic, answer, title: 'Post A' })));   // as the backend keeps it
    expect(meta.answer.tags.map((x) => (typeof x === 'string' ? x : x.name))).toEqual(['pov', 'vr', 'the-handy', 'tentacle']);
    const info = infoFromMeta({ id: 'j1', stem: 'Post A', destDir: 'C:\Lib', meta });
    const store = new Map();
    const settings = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
    recordDownloadTags(settings, 'C:\Lib\Post A.mp4', { topic: info.topic, answer: info.answer, scriptPath: info.scriptPath, video: true });
    const names = getScriptTags(settings, 'C:\Lib\Post A.mp4').tags.map((x) => (typeof x === 'string' ? x : x.name));
    expect(names).toEqual(['pov', 'vr', 'the-handy', 'tentacle']);
  });

  it('junk in a tag list is left out, not kept', () => {
    const meta = downloadMeta({ topic: { id: 1, tags: ['ok', 5, null, { id: 'x' }, { name: '' }, { name: 'named', id: 9, extra: 'drop' }] } });
    expect(meta.topic.tags).toEqual(['ok', { id: 9, name: 'named' }]);
  });
});
