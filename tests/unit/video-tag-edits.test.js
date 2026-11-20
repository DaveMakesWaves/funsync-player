/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// renderer/js/video-tag-edits.js: the writers for a video's tags and "Make a
// category from this tag" (notes/features/DESIGN-video-options.md (c), (h)
// test plan rows "Add a hidden tag", "Remove a tag another source gives",
// "Make a category from a tag"). Each plan is applied the way the dialog
// will apply it (whole maps through settings.set), and the test then reads
// what the app would show: effectiveTags over the stored maps. Every name
// and path is synthetic.
import { describe, it, expect, vi } from 'vitest';
import { effectiveTags, tagIndex } from '../../renderer/js/video-tags.js';
import {
  USER_TAGS_KEY,
  HIDDEN_TAGS_KEY,
  MAX_TAG_TEXT,
  SNAPSHOT_THRESHOLD,
  SNAPSHOT_LABEL,
  planAddTag,
  planRemoveTag,
  planShowAgain,
  planUndo,
  applyWrites,
  hiddenOnVideo,
  planMakeCategory,
  applyMakeCategory,
  undoMakeCategory,
} from '../../renderer/js/video-tag-edits.js';

const V = 'C:/Library/Clip One.mp4';
const S = 'C:/Library/Clip One.funscript';
const OTHER = 'C:/Library/Clip Two.mp4';
const OFFLINE = 'E:/Offline Drive/Not Scanned.mp4'; // not in any library list
const keys = (tags) => tags.map((t) => t.key);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** settings.library as stored, behind DataService-style get/set of whole maps. */
function fakeStore(library) {
  const values = new Map([
    [USER_TAGS_KEY, library.userTags],
    [HIDDEN_TAGS_KEY, library.hiddenTags],
  ]);
  const set = vi.fn((key, value) => { values.set(key, JSON.parse(JSON.stringify(value))); });
  return {
    get: (key) => values.get(key),
    set,
    state: () => ({ userTags: values.get(USER_TAGS_KEY), hiddenTags: values.get(HIDDEN_TAGS_KEY) }),
  };
}

/** What the Tags section would list for a video, from the stored maps. */
function shown(store, path, sources, extra = {}) {
  const { userTags, hiddenTags } = store.state();
  return keys(effectiveTags(path, { ...sources, user: userTags }, { hidden: hiddenTags, ...extra }));
}

const EROSCRIPTS = { eroscripts: { [V]: { tags: ['pov', 'the-handy'], topicId: 7, source: 'eroscripts', savedAt: 1 } } };

describe('add a tag', () => {
  it('stores it as typed on that video only; other paths, an offline one included, are untouched', () => {
    const others = { [OTHER]: ['keep'], [OFFLINE]: ['offline-tag'] };
    const store = fakeStore({ userTags: structuredClone(others), hiddenTags: { [OFFLINE]: ['content:x'] } });
    const plan = planAddTag(store.state(), V, '  Cosplay   Outfit ');
    expect(plan.ok).toBe(true);
    expect(plan.key).toBe('content:cosplay-outfit');
    applyWrites(store, plan);
    expect(store.get(USER_TAGS_KEY)).toEqual({ ...others, [V]: ['Cosplay Outfit'] });
    expect(store.get(HIDDEN_TAGS_KEY)).toEqual({ [OFFLINE]: ['content:x'] }); // not written at all
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(shown(store, V, {})).toEqual(['content:cosplay-outfit']);
  });

  it('a tag hidden on this video shows again, and the same plan clears the hide (Dave, 2026-11-17)', () => {
    const store = fakeStore({ userTags: {}, hiddenTags: { [V]: ['content:pov', 'device:the-handy'], [OTHER]: ['content:pov'] } });
    expect(shown(store, V, EROSCRIPTS)).toEqual([]);

    const plan = planAddTag(store.state(), V, 'POV');
    applyWrites(store, plan);

    expect(shown(store, V, EROSCRIPTS)).toEqual(['content:pov']);
    expect(store.get(HIDDEN_TAGS_KEY)[V]).toEqual(['device:the-handy']);
    expect(store.get(HIDDEN_TAGS_KEY)[OTHER]).toEqual(['content:pov']); // another video's hide stays
    expect(store.get(USER_TAGS_KEY)).toEqual({ [V]: ['POV'] });
  });

  it('when the last hide goes, the video has no hidden entry at all (absent, not [])', () => {
    const store = fakeStore({ userTags: undefined, hiddenTags: { [V]: ['pov'] } });
    applyWrites(store, planAddTag(store.state(), V, 'pov'));
    expect(Object.prototype.hasOwnProperty.call(store.get(HIDDEN_TAGS_KEY), V)).toBe(false);
  });

  it('a tag you already gave the video is not stored twice', () => {
    const state = { userTags: { [V]: ['pov'] }, hiddenTags: {} };
    const plan = planAddTag(state, V, 'POV ');
    expect(plan.ok).toBe(true);
    expect(plan.changed).toBe(false);
    expect(plan.writes).toEqual([]);
  });

  it('facet:value puts it in that facet, a name facet included (yours to type)', () => {
    expect(planAddTag({}, V, 'Performer: Jane Doe').key).toBe('performer:jane-doe');
    expect(planAddTag({}, V, 'device: OSR2').key).toBe('device:osr2');
  });

  it('refuses empty, too long and pathless input, with nothing to write', () => {
    for (const text of ['', '   ', '---', null, undefined, {}]) {
      expect(planAddTag({}, V, text)).toMatchObject({ ok: false, reason: 'empty', writes: [] });
    }
    expect(planAddTag({}, V, 'x'.repeat(MAX_TAG_TEXT + 1))).toMatchObject({ ok: false, reason: 'too-long' });
    expect(planAddTag({}, V, 'x'.repeat(MAX_TAG_TEXT)).ok).toBe(true);
    expect(planAddTag({}, '', 'pov')).toMatchObject({ ok: false, reason: 'no-path' });
  });

  it('never overwrites a map or an entry it cannot read (a damaged config)', () => {
    for (const state of [
      { userTags: ['pov'] },
      { userTags: 'pov' },
      { userTags: { [V]: 'pov' } },
      { userTags: { [V]: null } },
      { hiddenTags: { [V]: { pov: true } } },
    ]) {
      expect(planAddTag(state, V, 'cosplay')).toMatchObject({ ok: false, reason: 'bad-store', writes: [] });
    }
  });

  it('never writes to its inputs', () => {
    const state = deepFreeze({ userTags: { [V]: ['a'] }, hiddenTags: { [V]: ['content:b'] } });
    const before = JSON.stringify(state);
    expect(() => planAddTag(state, V, 'b')).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('remove a tag', () => {
  it('your own tag only: it leaves userTags and nothing is hidden', () => {
    const store = fakeStore({ userTags: { [V]: ['cosplay', 'pov'], [OFFLINE]: ['cosplay'] }, hiddenTags: undefined });
    const plan = planRemoveTag(store.state(), V, 'content:cosplay', { sources: EROSCRIPTS });
    applyWrites(store, plan);
    expect(plan.hidden).toBe(false);
    expect(store.get(USER_TAGS_KEY)).toEqual({ [V]: ['pov'], [OFFLINE]: ['cosplay'] });
    expect(store.get(HIDDEN_TAGS_KEY)).toBeUndefined(); // never written
  });

  it('a tag another source still gives: the chip goes, because the key is hidden on this video', () => {
    const store = fakeStore({ userTags: { [V]: ['POV'] }, hiddenTags: {} });
    expect(shown(store, V, EROSCRIPTS)).toEqual(['device:the-handy', 'content:pov']);

    const plan = planRemoveTag(store.state(), V, 'content:pov', { sources: EROSCRIPTS });
    applyWrites(store, plan);

    expect(shown(store, V, EROSCRIPTS)).toEqual(['device:the-handy']);
    expect(store.get(HIDDEN_TAGS_KEY)).toEqual({ [V]: ['content:pov'] });
    expect(Object.prototype.hasOwnProperty.call(store.get(USER_TAGS_KEY), V)).toBe(false);
  });

  it('a tag only a source gives (no copy of yours) is hidden', () => {
    const store = fakeStore({ userTags: {}, hiddenTags: {} });
    const plan = planRemoveTag(store.state(), V, 'device:the-handy', { sources: EROSCRIPTS });
    applyWrites(store, plan);
    expect(store.set).toHaveBeenCalledTimes(1); // userTags untouched
    expect(shown(store, V, EROSCRIPTS)).toEqual(['content:pov']);
  });

  it('the funscript source counts, picked by the script path', () => {
    const sources = { funscript: { [S]: { tags: ['Cosplay'] } } };
    const state = { userTags: { [V]: ['cosplay'] }, hiddenTags: {} };
    expect(planRemoveTag(state, V, 'content:cosplay', { sources, scriptPath: S }).hidden).toBe(true);
    expect(planRemoveTag(state, V, 'content:cosplay', { sources }).hidden).toBe(false);
  });

  it('an EroScripts record about another script does not count (it gives this video nothing)', () => {
    const sources = { eroscripts: { [V]: { tags: ['pov'], scriptPath: 'C:/Library/Old.funscript' } } };
    const plan = planRemoveTag({ userTags: { [V]: ['pov'] } }, V, 'content:pov', { sources, scriptPath: S });
    expect(plan.hidden).toBe(false);
    expect(plan.writes.map((w) => w.key)).toEqual([USER_TAGS_KEY]);
  });

  it('a tag nobody gives changes nothing', () => {
    const plan = planRemoveTag({ userTags: { [V]: ['a'] } }, V, 'content:zzz', { sources: EROSCRIPTS });
    expect(plan).toMatchObject({ ok: true, changed: false, writes: [], undo: null });
  });

  it('every spelling of your copy goes (keys match, not text)', () => {
    const plan = planRemoveTag({ userTags: { [V]: ['Cock Hero', 'cockhero', 'other'] } }, V, 'script-type:cock-hero');
    expect(plan.writes[0].value[V]).toEqual(['other']);
  });
});

describe('Undo puts both lists back exactly', () => {
  const cases = {
    'remove (your copy and a hide)': (state) => planRemoveTag(state, V, 'content:pov', { sources: EROSCRIPTS }),
    'add (your copy and an unhide)': (state) => planAddTag(state, V, 'the handy'),
    'show again': (state) => planShowAgain(state, V, 'device:the-handy'),
  };
  const starts = {
    'both lists present': { userTags: { [V]: ['pov', 'mine'], [OTHER]: ['x'] }, hiddenTags: { [V]: ['device:the-handy', 'content:zz'], [OTHER]: ['y'] } },
    'both lists absent for this video': { userTags: { [OTHER]: ['x'] }, hiddenTags: { [V]: ['device:the-handy'] } },
    'no maps at all': { userTags: undefined, hiddenTags: { [V]: ['device:the-handy'] } },
  };

  for (const [what, plan] of Object.entries(cases)) {
    for (const [label, start] of Object.entries(starts)) {
      it(`${what}, ${label}`, () => {
        const store = fakeStore(structuredClone(start));
        const before = JSON.stringify(store.state());
        const edit = plan(store.state());
        expect(edit.changed).toBe(true);
        applyWrites(store, edit);
        expect(JSON.stringify(store.state())).not.toBe(before);

        const undo = planUndo(store.state(), JSON.parse(JSON.stringify(edit.undo)));
        expect(undo.exact).toBe(true);
        applyWrites(store, undo);
        // A map that did not exist is written as {} (an empty map reads the
        // same everywhere); every entry, and every entry's absence, is back.
        const after = store.state();
        for (const name of ['userTags', 'hiddenTags']) {
          expect(after[name] ?? {}).toEqual(start[name] ?? {});
          expect(Object.prototype.hasOwnProperty.call(after[name] ?? {}, V))
            .toBe(Object.prototype.hasOwnProperty.call(start[name] ?? {}, V));
        }
      });
    }
  }

  it('an edit made since is kept: only the undone edit is reversed (exact: false)', () => {
    const store = fakeStore({ userTags: { [V]: ['pov', 'cosplay'] }, hiddenTags: {} });
    const first = planRemoveTag(store.state(), V, 'content:pov', { sources: EROSCRIPTS });
    applyWrites(store, first);
    applyWrites(store, planAddTag(store.state(), V, 'latex'));
    applyWrites(store, planAddTag(store.state(), OTHER, 'elsewhere'));

    const undo = planUndo(store.state(), first.undo);
    expect(undo.exact).toBe(false);
    applyWrites(store, undo);
    expect(store.get(USER_TAGS_KEY)).toEqual({ [V]: ['cosplay', 'latex', 'pov'], [OTHER]: ['elsewhere'] });
    expect(store.get(HIDDEN_TAGS_KEY)).toEqual({});
    expect(shown(store, V, EROSCRIPTS)).toEqual(['device:the-handy', 'content:cosplay', 'content:latex', 'content:pov']);
  });

  it('other videos edited since keep their edits after an exact Undo', () => {
    const store = fakeStore({ userTags: { [V]: ['pov'] }, hiddenTags: {} });
    const edit = planRemoveTag(store.state(), V, 'content:pov');
    applyWrites(store, edit);
    applyWrites(store, planAddTag(store.state(), OTHER, 'later'));
    applyWrites(store, planUndo(store.state(), edit.undo));
    expect(store.get(USER_TAGS_KEY)).toEqual({ [V]: ['pov'], [OTHER]: ['later'] });
  });

  it('refuses a missing undo record and never overwrites a damaged map', () => {
    expect(planUndo({}, null)).toMatchObject({ ok: false, writes: [] });
    const edit = planAddTag({ userTags: {} }, V, 'pov');
    const undo = planUndo({ userTags: 'damaged' }, edit.undo);
    expect(undo.writes).toEqual([]);
    expect(undo.exact).toBe(false);
  });
});

describe('show again', () => {
  it('takes the key out of the hidden list; your tags are not touched', () => {
    const store = fakeStore({ userTags: { [V]: ['mine'] }, hiddenTags: { [V]: ['content:pov', 'device:the-handy'] } });
    applyWrites(store, planShowAgain(store.state(), V, 'content:pov'));
    expect(store.get(HIDDEN_TAGS_KEY)).toEqual({ [V]: ['device:the-handy'] });
    expect(store.set).toHaveBeenCalledTimes(1);
    expect(shown(store, V, EROSCRIPTS)).toEqual(['content:mine', 'content:pov']);
  });

  it('a key that is not hidden, or no hidden map, changes nothing', () => {
    expect(planShowAgain({ hiddenTags: { [V]: ['a'] } }, V, 'b')).toMatchObject({ ok: true, changed: false, writes: [] });
    expect(planShowAgain({}, V, 'b')).toMatchObject({ ok: true, changed: false, writes: [] });
  });
});

describe('hiddenOnVideo', () => {
  it('lists each hidden key once, labelled as the source spells it when sources are given', () => {
    const hidden = { [V]: ['content:pov', 'POV', 'content:len-40', 'performer:jane-doe'] };
    const sources = { funscript: { [S]: { performers: ['Jane Doe'] } }, ...EROSCRIPTS };
    expect(hiddenOnVideo(hidden, V, { sources, scriptPath: S })).toEqual([
      { key: 'content:pov', facet: 'content', label: 'pov' },
      { key: 'content:len-40', facet: 'content', label: 'len 40' },
      { key: 'performer:jane-doe', facet: 'performer', label: 'Jane Doe' },
    ]);
    expect(hiddenOnVideo(hidden, V).map((t) => t.label)).toEqual(['pov', 'len 40', 'jane doe']);
  });

  it('nothing for a video with no hides or a damaged entry', () => {
    expect(hiddenOnVideo(undefined, V)).toEqual([]);
    expect(hiddenOnVideo({ [V]: 'pov' }, V)).toEqual([]);
    expect(hiddenOnVideo({ [V]: ['pov'] }, '')).toEqual([]);
  });
});

describe('Make a category from this tag', () => {
  const A = 'C:/Library/A.mp4';
  const B = 'C:/Library/B.mp4';
  const C = 'C:/Library/C.mp4';
  const P = 'C:/Library/Performer Pov.mp4';
  const videos = [{ path: A, funscriptPath: null }, { path: B }, { path: C }, { path: P }];
  const sources = {
    user: { [A]: ['pov'], [P]: ['performer:pov'] }, // P: a performer named "pov": same label, another key
    eroscripts: { [B]: { tags: ['pov', 'osr2'] }, [C]: { tags: ['osr2'] }, [OFFLINE]: { tags: ['pov'] } },
  };
  const index = () => tagIndex(videos, sources);

  it('counts and assigns exactly the library videos with the tag KEY (not the label, not offline paths)', () => {
    const tagsByPath = index();
    expect(tagsByPath.get(P).map((t) => t.label)).toEqual(['pov']);
    const plan = planMakeCategory({ key: 'content:pov', name: ' POV ', videos, tagsByPath, categories: [] });
    expect(plan).toMatchObject({ ok: true, mode: 'create', name: 'POV', count: 2, paths: [A, B], assign: [A, B], snapshot: false });
  });

  it('a category with that name (case aside) gets only the videos it lacks', () => {
    const plan = planMakeCategory({
      key: 'content:pov', name: 'pov', videos, tagsByPath: index(),
      categories: [{ id: 'c9', name: 'POV', color: '#000' }], videoCategories: { [A]: ['c9'] },
    });
    expect(plan).toMatchObject({ mode: 'existing', category: { id: 'c9', name: 'POV' }, paths: [A, B], assign: [B], count: 2 });
  });

  it(`asks for a pre-action snapshot above ${SNAPSHOT_THRESHOLD} videos`, () => {
    const many = Array.from({ length: SNAPSHOT_THRESHOLD + 1 }, (_, i) => ({ path: `C:/Library/M${i}.mp4` }));
    const user = Object.fromEntries(many.map((v) => [v.path, ['pov']]));
    const tagsByPath = tagIndex(many, { user });
    expect(planMakeCategory({ key: 'pov', name: 'pov', videos: many, tagsByPath }).snapshot).toBe(true);
    expect(planMakeCategory({ key: 'pov', name: 'pov', videos: many.slice(1), tagsByPath }).snapshot).toBe(false);
  });

  it('refuses an empty key or name', () => {
    expect(planMakeCategory({ key: '', name: 'x', videos, tagsByPath: index() })).toMatchObject({ ok: false, reason: 'empty' });
    expect(planMakeCategory({ key: 'pov', name: '  ', videos, tagsByPath: index() })).toMatchObject({ ok: false, reason: 'empty-name' });
  });

  /** A DataService-shaped fake over a categories list and the root videoCategories map. */
  function fakeCategories(videoCategories, categories = []) {
    const vc = structuredClone(videoCategories);
    const calls = [];
    const settings = {
      addCategory: vi.fn(async (name, color) => { calls.push('add'); const c = { id: 'new1', name, color }; categories.push(c); return c; }),
      assignCategory: vi.fn((p, id) => { calls.push('assign'); (vc[p] ||= []).includes(id) || vc[p].push(id); }),
      unassignCategory: vi.fn((p, id) => { vc[p] = (vc[p] || []).filter((x) => x !== id); if (!vc[p].length) delete vc[p]; }),
      deleteCategory: vi.fn((id) => {
        categories.splice(0, categories.length, ...categories.filter((c) => c.id !== id));
        for (const p of Object.keys(vc)) { vc[p] = vc[p].filter((x) => x !== id); if (!vc[p].length) delete vc[p]; }
      }),
      getVideoCategories: (p) => vc[p] || [],
    };
    return { settings, vc, calls, categories };
  }

  it('create: snapshot first, then the category, then the assignments; Undo removes it and every link', async () => {
    const start = { [C]: ['c1'] };
    const fake = fakeCategories(start, [{ id: 'c1', name: 'Other' }]);
    const plan = { ...planMakeCategory({ key: 'content:pov', name: 'POV', videos, tagsByPath: index(), categories: fake.categories }), snapshot: true };
    const takeSnapshot = vi.fn(async () => { fake.calls.push('snapshot'); });

    const done = await applyMakeCategory(plan, { settings: fake.settings, color: '#123456', takeSnapshot });
    expect(done).toMatchObject({ ok: true, categoryId: 'new1', assigned: [A, B], snapshotTaken: true });
    expect(takeSnapshot).toHaveBeenCalledWith(SNAPSHOT_LABEL);
    expect(fake.calls).toEqual(['snapshot', 'add', 'assign', 'assign']);
    expect(fake.settings.addCategory).toHaveBeenCalledWith('POV', '#123456');
    expect(fake.vc).toEqual({ [A]: ['new1'], [B]: ['new1'], [C]: ['c1'] });

    expect(undoMakeCategory(done.undo, { settings: fake.settings })).toBe(true);
    expect(fake.vc).toEqual(start);
    expect(fake.categories.map((c) => c.id)).toEqual(['c1']);
  });

  it('existing: Undo takes away only what it added, never a link that was there before', async () => {
    const start = { [A]: ['c9'], [C]: ['c9'] };
    const fake = fakeCategories(start, [{ id: 'c9', name: 'POV' }]);
    const plan = planMakeCategory({ key: 'content:pov', name: 'pov', videos, tagsByPath: index(), categories: fake.categories, videoCategories: start });
    // Between the plan and the press, B was put in the category by hand.
    fake.settings.assignCategory(B, 'c9');
    const done = await applyMakeCategory(plan, { settings: fake.settings });
    expect(done.assigned).toEqual([]);
    undoMakeCategory(done.undo, { settings: fake.settings });
    expect(fake.vc).toEqual({ ...start, [B]: ['c9'] });
    expect(fake.settings.deleteCategory).not.toHaveBeenCalled();
  });

  it('a snapshot that fails does not block the (undoable) assignments', async () => {
    const fake = fakeCategories({});
    const plan = { ...planMakeCategory({ key: 'pov', name: 'POV', videos, tagsByPath: index() }), snapshot: true };
    const done = await applyMakeCategory(plan, { settings: fake.settings, takeSnapshot: async () => { throw new Error('disk full'); } });
    expect(done).toMatchObject({ ok: true, snapshotTaken: false, assigned: [A, B] });
  });
});
