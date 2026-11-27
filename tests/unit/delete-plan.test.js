/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// What the delete dialog offers and what FunSync forgets (2026-11-23,
// EroScripts #434; DESIGN.md §2.18). renderer/js/delete-plan.js.
import { describe, it, expect, vi } from 'vitest';
import { planDeletion, chosenPaths, totalSize, forgetVideo, referencesByOthers, PER_VIDEO_SETTING_KEYS } from '../../renderer/js/delete-plan.js';

const DIR = 'C:\\Lib\\Scenes';
const P = (n) => `${DIR}\\${n}`;
const video = { name: 'Clip.mp4', path: P('Clip.mp4'), funscriptPath: P('Clip.funscript'), variants: [{ path: P('Clip.soft.funscript'), label: 'soft' }], subtitlePath: null };
const candidates = [
  { path: P('Clip.mp4'), kind: 'video', label: null, size: 1000 },
  { path: P('Clip.funscript'), kind: 'script', label: null, size: 20 },
  { path: P('Clip.twist.funscript'), kind: 'axis', label: 'twist', size: 5 },
  { path: P('Clip.soft.funscript'), kind: 'variant', label: 'soft', size: 6 },
  { path: P('Clip.srt'), kind: 'subtitle', label: null, size: 3 },
];

describe('planDeletion', () => {
  it('the video locked and ticked; its own script and axis files ticked; variations and subtitles unticked', () => {
    const rows = planDeletion({ video, candidates, videos: [video] });
    expect(rows.map((r) => [r.name, r.checked, r.locked])).toEqual([
      ['Clip.mp4', true, true],
      ['Clip.funscript', true, false],
      ['Clip.twist.funscript', true, false],
      ['Clip.soft.funscript', false, false],
      ['Clip.srt', false, false],
    ]);
    expect(chosenPaths(rows)).toEqual([P('Clip.mp4'), P('Clip.funscript'), P('Clip.twist.funscript')]);
    expect(totalSize(rows.filter((r) => r.checked))).toBe(1025);
  });

  it('a file another video also uses is locked, unticked, kept, and says who (compared without case)', () => {
    const other = { name: 'Clip Remaster.mp4', path: P('Clip Remaster.mp4'), funscriptPath: P('clip.FUNSCRIPT') };
    const rows = planDeletion({ video, candidates, videos: [video, other] });
    const script = rows.find((r) => r.name === 'Clip.funscript');
    expect(script).toMatchObject({ checked: false, locked: true, sharedWith: ['Clip Remaster.mp4'] });
    expect(chosenPaths(rows)).not.toContain(P('Clip.funscript'));
  });

  it('a script another video is hand-paired with (any association shape) is kept too', () => {
    const settings = { associations: { [P('Other.mp4')]: { active: 'multi', single: null, multi: { main: P('Clip.funscript'), axes: { R0: P('Clip.twist.funscript') } } } } };
    const rows = planDeletion({ video, candidates, videos: [video], settings });
    expect(rows.filter((r) => r.locked && r.kind !== 'video').map((r) => r.name)).toEqual(['Clip.funscript', 'Clip.twist.funscript']);
  });

  it('a hand-paired script in another folder is listed, unticked, with its folder', () => {
    const settings = { associations: { [video.path]: { active: 'single', single: 'D:\\Scripts\\Clip (alt).funscript' } } };
    const rows = planDeletion({ video, candidates, videos: [video], settings });
    const alt = rows.find((r) => r.name === 'Clip (alt).funscript');
    expect(alt).toMatchObject({ checked: false, locked: false, outside: true, kind: 'script' });
  });

  it('the video is listed even if the folder listing missed it; nothing twice', () => {
    const rows = planDeletion({ video, candidates: [], videos: [video] });
    expect(rows[0]).toMatchObject({ kind: 'video', subject: true, checked: true, locked: true });
    expect(new Set(rows.map((r) => r.path.toLowerCase())).size).toBe(rows.length);
  });

  it('referencesByOthers never counts the video itself', () => {
    const refs = referencesByOthers({ videoPath: video.path, videos: [video], settings: { associations: { [video.path]: P('Clip.funscript') } } });
    expect(refs.size).toBe(0);
  });
});

describe('forgetVideo: an explicit delete takes the video out of FunSync\'s records', () => {
  function store() {
    const s = {
      'library.associations': { [video.path]: P('Clip.funscript'), [P('Keep.mp4')]: P('Keep.funscript') },
      'library.resumePositions': { [video.path]: { t: 12 } },
      'library.userTags': { [video.path]: ['mine'] },
      'library.customThumbnails': { [P('Keep.mp4')]: 'x' },
      'library.collections': [{ id: 'c1', videoPaths: [video.path, P('Keep.mp4')], excludedPaths: [video.path] }],
    };
    const playlists = [{ id: 'p1', videoPaths: [video.path, P('Keep.mp4')] }, { id: 'p2', videoPaths: [P('Keep.mp4')] }];
    return {
      get: (k) => s[k],
      set: vi.fn((k, v) => { s[k] = v; }),
      getPlaylists: () => playlists,
      removeVideoFromPlaylist: vi.fn((id, p) => { const pl = playlists.find((x) => x.id === id); pl.videoPaths = pl.videoPaths.filter((x) => x !== p); }),
      getVideoCategories: (p) => (p === video.path ? ['cat1', 'cat2'] : []),
      unassignCategory: vi.fn(),
      _s: s,
      _playlists: playlists,
    };
  }

  it('per-video settings, playlists, categories and collections; nothing of another video', () => {
    const settings = store();
    const changed = forgetVideo(settings, video.path);
    expect(changed).toEqual(['associations', 'resumePositions', 'userTags', 'playlist:p1', 'category:cat1', 'category:cat2', 'collections']);
    expect(settings._s['library.associations']).toEqual({ [P('Keep.mp4')]: P('Keep.funscript') });
    expect(settings._s['library.customThumbnails']).toEqual({ [P('Keep.mp4')]: 'x' });
    expect(settings._playlists[0].videoPaths).toEqual([P('Keep.mp4')]);
    expect(settings._s['library.collections'][0]).toMatchObject({ videoPaths: [P('Keep.mp4')], excludedPaths: [] });
    expect(settings.unassignCategory).toHaveBeenCalledTimes(2);
  });

  it('knows every per-video map the rename code moves', () => {
    for (const k of ['associations', 'manualVariants', 'subtitleAssociations', 'userTags', 'hiddenTags', 'scriptTags', 'customThumbnails', 'resumePositions', 'manualVRType', 'vrFormat', 'syncOffsets']) {
      expect(PER_VIDEO_SETTING_KEYS, k).toContain(k);
    }
  });
});

// Dave, 2026-11-25: deleting a video and its script left the EroScripts tab
// showing them as downloaded; the tab's own record (eroscripts.downloaded)
// was kept. The dialog offers to forget it; forgetting reverts the post.
describe('the EroScripts download record of deleted files', () => {
  const V = 'C:/Lib/Post A.mp4';
  const S = 'C:/Lib/Post A.funscript';
  const DOWNLOADED = {
    7: { video: V, script: S, scriptUrl: 'https://discuss.eroscripts.com/uploads/a.funscript', title: 'Post A', at: 1 },
    8: { video: 'C:/Lib/Other.mp4', title: 'Other', at: 1 },
  };
  function store(initial) {
    const m = new Map(Object.entries(initial));
    return { get: (k) => m.get(k), set: vi.fn((k, v) => m.set(k, v)), _m: m };
  }

  it('downloadsFor names the posts the files came from (paths compared as Windows does)', async () => {
    const { downloadsFor } = await import('../../renderer/js/delete-plan.js');
    expect(downloadsFor(DOWNLOADED, ['c:/lib/post a.mp4'])).toEqual([{ topicId: '7', title: 'Post A' }]);
    expect(downloadsFor(DOWNLOADED, [S])).toEqual([{ topicId: '7', title: 'Post A' }]);
    expect(downloadsFor(DOWNLOADED, ['C:/Lib/Unrelated.mp4'])).toEqual([]);
    expect(downloadsFor(null, [V])).toEqual([]);
  });

  it('both deleted: the record goes (never downloaded); only the video: the kept script stays recorded; nothing else is touched', async () => {
    const { forgetDownloads, DOWNLOADED_KEY } = await import('../../renderer/js/delete-plan.js');
    const s = store({ [DOWNLOADED_KEY]: structuredClone(DOWNLOADED) });
    expect(forgetDownloads(s, [V, S])).toEqual(['7']);
    expect(s._m.get(DOWNLOADED_KEY)).toEqual({ 8: DOWNLOADED[8] });

    const s2 = store({ [DOWNLOADED_KEY]: structuredClone(DOWNLOADED) });
    forgetDownloads(s2, [V]);
    expect(s2._m.get(DOWNLOADED_KEY)[7]).toEqual({ script: S, scriptUrl: DOWNLOADED[7].scriptUrl, title: 'Post A', at: 1 });

    const s3 = store({ [DOWNLOADED_KEY]: structuredClone(DOWNLOADED) });
    expect(forgetDownloads(s3, ['C:/Lib/Unrelated.mp4'])).toEqual([]);
    expect(s3.set).not.toHaveBeenCalled();
  });
});
