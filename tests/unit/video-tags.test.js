/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// renderer/js/video-tags.js: the tag model's pure core (plan
// PLAN-next-major-2026-11.md §2). Groundwork for the tags phase, 2026-11-17:
// nothing in the app imports it yet. The desktop / phone filter parity is in
// tag-filter-parity.test.js; this file pins the rest: normalisation, the
// facet and alias table, the merge's absence rules, hiding, labels and the
// funscript metadata reader. Every name and path is synthetic.
import { describe, it, expect } from 'vitest';
import {
  TAG_SOURCES,
  SOURCE_ORDER,
  FACETS,
  NAME_FACETS,
  TAG_TABLE,
  foldForMatch,
  displayForm,
  tagSlug,
  deslug,
  parseTagKey,
  normalizeTagKey,
  compileTagRules,
  classifyTag,
  sourceEntries,
  effectiveTags,
  funscriptMetaRecord,
  filterByTags,
  tagIndex,
} from '../../renderer/js/video-tags.js';

const V = 'C:/Library/Clip One.mp4';
const S = 'C:/Library/Clip One.funscript';
const keys = (tags) => tags.map((t) => t.key);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('normalisation', () => {
  it('folds case, whitespace, diacritics and full-width forms for matching', () => {
    expect(foldForMatch('  Ünïcode   Tàg ')).toBe('unicode tag');
    expect(foldForMatch('ＶＲ')).toBe('vr');
    expect(foldForMatch('ﬁlm')).toBe('film');
    expect(foldForMatch(null)).toBe('');
    expect(foldForMatch({})).toBe('');
  });

  it('keeps Hangul and kana whole (decomposed, then recomposed)', () => {
    expect(tagSlug('한국어 태그')).toBe('한국어-태그');
    expect(tagSlug('がぎ')).toBe('がぎ');
  });

  it('keeps the display form as written, whitespace collapsed', () => {
    expect(displayForm('  Blow   Job ')).toBe('Blow Job');
    expect(displayForm('Ünïcode Tàg')).toBe('Ünïcode Tàg');
  });

  it('slugs spaces and underscores to single dashes, and is idempotent', () => {
    for (const raw of ['Blow Job', 'blow_job', 'BLOW-JOB', ' blow -- job ']) expect(tagSlug(raw)).toBe('blow-job');
    for (const raw of ['the-handy', '10-25', 'len-10-25', '00:51-lenght', 'unicode-tag']) {
      expect(tagSlug(tagSlug(raw))).toBe(tagSlug(raw));
    }
    expect(deslug('the-handy')).toBe('the handy');
  });

  it('reads facet:value keys; an unknown prefix is part of the value', () => {
    expect(parseTagKey('Device: The Handy')).toEqual({ facet: 'device', value: 'the-handy' });
    expect(parseTagKey('the handy')).toEqual({ facet: null, value: 'the-handy' });
    expect(parseTagKey('00:51-lenght')).toEqual({ facet: null, value: '00:51-lenght' });
    expect(parseTagKey('device:')).toBeNull();
    expect(parseTagKey('   ')).toBeNull();
    expect(normalizeTagKey('Script-Type:Cock Hero')).toBe('script-type:cock-hero');
    expect(normalizeTagKey('nope:thing')).toBe('nope:thing');
  });
});

describe('the facet and alias table', () => {
  it('is data only, frozen, and every row names a known facet', () => {
    expect(Object.isFrozen(TAG_TABLE)).toBe(true);
    expect(Object.isFrozen(TAG_TABLE.facets)).toBe(true);
    for (const facet of Object.values(TAG_TABLE.facets)) expect(FACETS).toContain(facet);
    for (const p of TAG_TABLE.patterns) expect(FACETS).toContain(p.facet);
    // Every alias target lands somewhere other than its source.
    for (const [from, to] of Object.entries(TAG_TABLE.aliases)) {
      expect(classifyTag(from).key).toBe(classifyTag(to).key);
      expect(classifyTag(from).value).not.toBe(from);
    }
  });

  it('places the plan\'s examples', () => {
    expect(classifyTag('len-10-25').key).toBe('length:10-25');
    expect(classifyTag('len-2-5').key).toBe('length:2-5');
    expect(classifyTag('the-handy').key).toBe('device:the-handy');
    expect(classifyTag('non-vr').key).toBe('vr:non-vr');
    // The hand override: the-handy-2 is not in the forum's Devices group.
    expect(classifyTag('the-handy-2').key).toBe('device:the-handy-2');
    expect(classifyTag('handy-2').key).toBe('device:the-handy-2');
    expect(classifyTag('cockhero').key).toBe('script-type:cock-hero');
    expect(classifyTag('thehandy').key).toBe('device:the-handy');
    expect(classifyTag('futa').key).toBe('sexuality:futanari');
  });

  it('leaves junk tags as plain content tags', () => {
    expect(classifyTag('len-40').key).toBe('content:len-40');
    expect(classifyTag('muti-len').key).toBe('content:muti-len');
    expect(classifyTag('00:51-lenght').key).toBe('content:00:51-lenght');
    expect(classifyTag('blowjob').key).toBe('content:blowjob');
  });

  it('a content: key re-classifies (content holds what the table did not know)', () => {
    expect(classifyTag('content:cockhero').key).toBe('script-type:cock-hero');
    expect(classifyTag('content:the-handy').key).toBe('device:the-handy');
  });
});

describe('compileTagRules: your aliases and facet overrides', () => {
  it('your alias wins over the bundled one', () => {
    const rules = compileTagRules({ aliases: { futa: 'futa-tag' } });
    expect(classifyTag('futa', rules).key).toBe('content:futa-tag');
    expect(classifyTag('futa').key).toBe('sexuality:futanari');
  });

  it('a facet:value alias renames that key only (performer names)', () => {
    const rules = compileTagRules({ aliases: { 'performer:jane': 'performer:jane-doe' } });
    expect(classifyTag('jane', rules, 'performer').key).toBe('performer:jane-doe');
    expect(classifyTag('jane', rules).key).toBe('content:jane');
  });

  it('an alias may point at a full key', () => {
    const rules = compileTagRules({ aliases: { bj: 'content:blowjob', handy: 'device:the-handy' } });
    expect(classifyTag('BJ', rules).key).toBe('content:blowjob');
    expect(classifyTag('Handy', rules).key).toBe('device:the-handy');
  });

  it('an alias cycle ends, it never loops', () => {
    const rules = compileTagRules({ aliases: { a: 'b', b: 'c', c: 'a', 'device:x': 'device:y', 'device:y': 'device:x' } });
    expect(() => classifyTag('a', rules)).not.toThrow();
    expect(classifyTag('a', rules).facet).toBe('content');
    expect(classifyTag('device:x', rules).facet).toBe('device');
  });

  it('a facet override moves a tag; an unknown or name facet is ignored', () => {
    const rules = compileTagRules({ facetOverrides: { keon: 'device', real: 'display', pov: 'nonsense', bob: 'performer' } });
    expect(classifyTag('Keon', rules).key).toBe('device:keon');
    expect(classifyTag('real', rules).key).toBe('display:real');
    expect(classifyTag('pov', rules).key).toBe('content:pov');
    expect(classifyTag('bob', rules).key).toBe('content:bob');
  });

  it('ignores settings of the wrong shape', () => {
    for (const settings of [null, undefined, 'x', { aliases: ['a'], facetOverrides: 'b' }, { aliases: { a: 5 } }]) {
      expect(() => compileTagRules(settings)).not.toThrow();
    }
    expect(classifyTag('the-handy', compileTagRules({ aliases: null })).key).toBe('device:the-handy');
  });
});

describe('effectiveTags: absence is never destructive', () => {
  const SOURCES = {
    eroscripts: { [V]: { tags: ['the-handy', 'non-vr'], topicId: 1, source: 'eroscripts', savedAt: 1 } },
    funscript: { [S]: { tags: ['POV'], performers: ['Jane Doe'], creator: 'scripter-one' } },
    user: { [V]: ['favourite'] },
  };

  it('no path, no sources, or no record for the video gives no tags', () => {
    expect(effectiveTags('', SOURCES)).toEqual([]);
    expect(effectiveTags(null, SOURCES)).toEqual([]);
    expect(effectiveTags(V, undefined)).toEqual([]);
    expect(effectiveTags(V, {})).toEqual([]);
    expect(effectiveTags('C:/Library/Other.mp4', SOURCES, { scriptPath: 'C:/Library/Other.funscript' })).toEqual([]);
  });

  it('a missing source takes nothing away from the others', () => {
    const all = keys(effectiveTags(V, SOURCES, { scriptPath: S }));
    expect(all).toEqual(['vr:non-vr', 'device:the-handy', 'content:favourite', 'content:pov', 'performer:jane-doe', 'creator:scripter-one']);
    // Each source dropped in turn, or present but empty, or with no record
    // for this video: the other sources' tags are all still there.
    for (const drop of Object.keys(SOURCES)) {
      const others = all.filter((k) => effectiveTags(V, { [drop]: SOURCES[drop] }, { scriptPath: S }).every((t) => t.key !== k));
      for (const variant of [undefined, {}, new Map(), { [V]: null, [S]: null }, { [V]: [], [S]: {} }]) {
        const got = keys(effectiveTags(V, { ...SOURCES, [drop]: variant }, { scriptPath: S }));
        for (const k of others) expect(got).toContain(k);
      }
    }
  });

  it('an empty EroScripts record (the false-empty search branch) adds nothing and hides nothing', () => {
    const sources = { ...SOURCES, eroscripts: { [V]: { tags: [], topicId: 1, source: 'eroscripts', savedAt: 1 } } };
    expect(keys(effectiveTags(V, sources, { scriptPath: S }))).toEqual(['content:favourite', 'content:pov', 'performer:jane-doe', 'creator:scripter-one']);
  });

  it('records of the wrong shape are skipped, not thrown on', () => {
    const junk = [null, 5, 'tags', [], { tags: 'the-handy' }, { tags: [null, 3, {}, { name: null }, ''] }, { performers: 'x', studio: 7 }];
    for (const record of junk) {
      for (const source of SOURCE_ORDER) {
        expect(() => effectiveTags(V, { [source]: { [V]: record, [S]: record } }, { scriptPath: S })).not.toThrow();
      }
    }
    // A bare number is a tag (`{tags: [null, 3]}` gives content:3), nothing else.
    expect(keys(effectiveTags(V, { user: { [V]: [null, 3, {}, ''] } }))).toEqual(['content:3']);
  });

  it('never writes to its inputs', () => {
    const sources = deepFreeze(structuredClone(SOURCES));
    const options = deepFreeze({ scriptPath: S, hidden: { [V]: ['pov'] }, hiddenEverywhere: ['favourite'], aliases: { bj: 'blowjob' } });
    const before = JSON.stringify([sources, options]);
    expect(() => effectiveTags(V, sources, options)).not.toThrow();
    expect(JSON.stringify([sources, options])).toBe(before);
  });

  it('reads Map-shaped source maps too', () => {
    const sources = { user: new Map([[V, ['favourite']]]), funscript: new Map([[S, { tags: ['POV'] }]]) };
    expect(keys(effectiveTags(V, sources, { scriptPath: S }))).toEqual(['content:favourite', 'content:pov']);
  });
});

describe('effectiveTags: which script a record is about', () => {
  const record = { tags: ['osr2'], topicId: 9, scriptPath: 'C:/Library/Clip One v1.funscript', source: 'eroscripts', savedAt: 1 };

  it('ignores an EroScripts record about a script that is no longer associated, and keeps it stored', () => {
    const sources = deepFreeze({ eroscripts: { [V]: structuredClone(record) } });
    expect(effectiveTags(V, sources, { scriptPath: 'C:/Library/Clip One v2.funscript' })).toEqual([]);
    expect(sources.eroscripts[V].tags).toEqual(['osr2']);
  });

  it('counts it when it is about the script associated now (slashes and case aside)', () => {
    const sources = { eroscripts: { [V]: record } };
    expect(keys(effectiveTags(V, sources, { scriptPath: 'c:\\library\\Clip One v1.funscript' }))).toEqual(['device:osr2']);
  });

  it('counts it when either path is unknown: an unknown never hides tags', () => {
    expect(keys(effectiveTags(V, { eroscripts: { [V]: record } }))).toEqual(['device:osr2']);
    const { scriptPath, ...today } = record;
    expect(keys(effectiveTags(V, { eroscripts: { [V]: today } }, { scriptPath: S }))).toEqual(['device:osr2']);
  });

  it('a stale record (topic deleted) still counts', () => {
    expect(keys(effectiveTags(V, { eroscripts: { [V]: { tags: ['sr6'], stale: true } } }))).toEqual(['device:sr6']);
  });

  it('the funscript record is picked by the script path, not the video path', () => {
    const sources = { funscript: { [V]: { tags: ['wrong'] }, [S]: { tags: ['right'] } } };
    expect(keys(effectiveTags(V, sources, { scriptPath: S }))).toEqual(['content:right']);
    expect(effectiveTags(V, sources)).toEqual([]);
  });
});

describe('effectiveTags: hiding', () => {
  const sources = {
    eroscripts: { [V]: { tags: ['cockhero', 'len-40', 'the-handy'] }, 'C:/Library/Clip Two.mp4': { tags: ['len-40'] } },
    user: { [V]: ['mine'] },
  };

  it('hides by key, by name, or by a name an alias maps; whatever the source', () => {
    const hidden = { [V]: ['script-type:cock-hero', 'LEN 40', 'mine'] };
    expect(keys(effectiveTags(V, sources, { hidden }))).toEqual(['device:the-handy']);
    expect(keys(effectiveTags(V, sources, { hidden: ['cockhero'] }))).toEqual(['device:the-handy', 'content:len-40', 'content:mine']);
  });

  it('a tag hidden on one video stays on another', () => {
    const hidden = { [V]: ['len-40'] };
    expect(keys(effectiveTags('C:/Library/Clip Two.mp4', sources, { hidden }))).toEqual(['content:len-40']);
  });

  it('hiddenEverywhere hides on every video', () => {
    expect(keys(effectiveTags('C:/Library/Clip Two.mp4', sources, { hiddenEverywhere: ['content:len-40'] }))).toEqual([]);
  });

  it('a hidden tag stays hidden when the source re-sends it', () => {
    const resent = { eroscripts: { [V]: { tags: ['len-40', 'len-40', 'LEN-40'] } } };
    expect(effectiveTags(V, resent, { hidden: ['len-40'] })).toEqual([]);
  });
});

describe('effectiveTags: labels, sources, refs and order', () => {
  it('lists every source of a tag, in SOURCE_ORDER, and takes the label from the first', () => {
    const sources = {
      eroscripts: { [V]: { tags: ['blow-job'] } },
      funscript: { [S]: { tags: ['blow job'] } },
      stash: { [V]: { tags: [{ id: 't9', name: 'Blow Job' }] } },
      user: { [V]: ['BLOW_JOB'] },
    };
    const [tag] = effectiveTags(V, sources, { scriptPath: S });
    expect(tag.key).toBe('content:blow-job');
    expect(tag.sources).toEqual(['user', 'stash', 'funscript', 'eroscripts']);
    expect(tag.label).toBe('BLOW_JOB');
    expect(tag.refs).toEqual([{ source: 'stash', id: 't9' }]);
    expect(SOURCE_ORDER).toEqual(['user', 'stash', 'stashbox', 'funscript', 'eroscripts']);
    expect(Object.values(TAG_SOURCES).sort()).toEqual([...SOURCE_ORDER].sort());
  });

  it('a forum tag is only de-slugged; a forum creator keeps its spelling', () => {
    const tags = effectiveTags(V, { eroscripts: { [V]: { tags: ['non-vr', 'the-handy'], creator: 'ScripterTwo' } } });
    expect(tags.map((t) => t.label)).toEqual(['non vr', 'the handy', 'ScripterTwo']);
  });

  it('an aliased tag takes the canonical name; a length keeps its numbers', () => {
    const tags = effectiveTags(V, { user: { [V]: ['Futa', 'len-10-25', 'cock hero'] } });
    expect(tags.map((t) => [t.key, t.label])).toEqual([
      ['length:10-25', '10-25'],
      ['script-type:cock-hero', 'cock hero'],
      ['sexuality:futanari', 'futanari'],
    ]);
  });

  it('Stash and stash-box names land in the name facets, with their ids', () => {
    const sources = {
      stash: { [V]: { tags: [], performers: [{ id: 'p1', name: 'Jane Doe' }, 'Ann Roe'], studio: { id: 's1', name: 'Studio Nine' } } },
      stashbox: { [V]: { performers: [{ id: 'sb-7', name: 'Jane  Doe' }], studio: 'Studio Nine' } },
    };
    const tags = effectiveTags(V, sources);
    expect(tags.map((t) => [t.key, t.label, t.sources])).toEqual([
      ['performer:ann-roe', 'Ann Roe', ['stash']],
      ['performer:jane-doe', 'Jane Doe', ['stash', 'stashbox']],
      ['studio:studio-nine', 'Studio Nine', ['stash', 'stashbox']],
    ]);
    expect(tags[1].refs).toEqual([{ source: 'stash', id: 'p1' }, { source: 'stashbox', id: 'sb-7' }]);
    expect(NAME_FACETS).toEqual(['performer', 'creator', 'studio']);
  });

  it('the same tag twice from one source counts once, with each id once', () => {
    const [tag] = effectiveTags(V, { eroscripts: { [V]: { tags: [{ id: 1, name: 'pov' }, { id: 1, name: 'POV' }, 'pov'] } } });
    expect(tag.sources).toEqual(['eroscripts']);
    expect(tag.refs).toEqual([{ source: 'eroscripts', id: 1 }]);
  });

  it('sorts by facet, then value, numbers in numeric order', () => {
    const tags = effectiveTags(V, { user: { [V]: ['zeta', 'len-10-25', 'len-2-5', 'alpha', 'performer:Bo', 'non-vr', 'osr2'] } });
    expect(keys(tags)).toEqual(['vr:non-vr', 'length:2-5', 'length:10-25', 'device:osr2', 'content:alpha', 'content:zeta', 'performer:bo']);
  });

  it('uses precompiled rules when given (and then ignores aliases)', () => {
    const rules = compileTagRules({ aliases: { bj: 'blowjob' } });
    expect(keys(effectiveTags(V, { user: { [V]: ['BJ'] } }, { rules, aliases: {} }))).toEqual(['content:blowjob']);
  });

  it('sourceEntries lists one source on its own', () => {
    expect(sourceEntries('stash', { performers: ['Jane Doe'] })).toEqual([{ source: 'stash', raw: 'Jane Doe', facet: 'performer', id: null }]);
    expect(sourceEntries('nope', { tags: ['x'] })).toEqual([]);
    expect(sourceEntries('user', null)).toEqual([]);
  });
});

describe('funscriptMetaRecord', () => {
  it('reads every spelling the plan lists', () => {
    expect(funscriptMetaRecord({
      author: 'scripter-one',
      tags: ['POV', 'POV', ''],
      topic_tags: ['the-handy'],
      performers: ['Jane Doe'],
      title: 'Clip One',
      script_url: 'https://discuss.eroscripts.com/t/clip-one/12345',
      videoSourceUrl: 'https://example.invalid/v/1',
    }, 7)).toEqual({
      tags: ['POV'],
      topicTags: ['the-handy'],
      performers: ['Jane Doe'],
      creator: 'scripter-one',
      title: 'Clip One',
      topicId: 12345,
      topicUrl: null,
      scriptUrl: 'https://discuss.eroscripts.com/t/clip-one/12345',
      videoUrl: 'https://example.invalid/v/1',
      readAt: 7,
    });
  });

  it('prefers creator over author, topic_url over script_url', () => {
    const record = funscriptMetaRecord({
      creator: 'a', author: 'b', topic_url: 'https://discuss.eroscripts.com/t/x/1', script_url: 'https://discuss.eroscripts.com/t/2',
    }, 1);
    expect(record.creator).toBe('a');
    expect(record.topicId).toBe(1);
    expect(funscriptMetaRecord({ script_url: 'https://discuss.eroscripts.com/t/2' }, 1).topicId).toBe(2);
    expect(funscriptMetaRecord({ tags: 'single' }, 1).tags).toEqual(['single']);
  });

  it('nothing useful is unknown (null), never an empty "no tags" record', () => {
    // The editor's own blank metadata block, as Test.funscript carries it.
    const blank = { bookmarks: [], chapters: [], creator: '', description: '', duration: 220, license: '', notes: '', performers: [], script_url: '', tags: [], title: '', type: 'basic', video_url: '' };
    expect(funscriptMetaRecord(blank, 1)).toBeNull();
    expect(funscriptMetaRecord(undefined, 1)).toBeNull();
    expect(funscriptMetaRecord([], 1)).toBeNull();
    expect(funscriptMetaRecord({ script_url: 'https://example.invalid/not-a-topic' }, 1)).toBeNull();
  });

  it('its record merges as the funscript source', () => {
    const record = funscriptMetaRecord({ tags: ['VR'], topic_tags: ['futa'], performers: ['Jane Doe'], creator: 'scripter-one' }, 1);
    expect(keys(effectiveTags(V, { funscript: { [S]: record } }, { scriptPath: S })))
      .toEqual(['vr:vr', 'sexuality:futanari', 'performer:jane-doe', 'creator:scripter-one']);
  });
});

describe('filterByTags (beyond the parity fixture)', () => {
  const a = { path: 'C:/Library/a.mp4' };
  const b = { path: 'C:/Library/b.mp4' };
  const tags = { [a.path]: ['device:the-handy'], [b.path]: [{ key: 'device:osr2' }] };

  it('returns the same objects, in order, as a new array', () => {
    const videos = [b, a];
    const out = filterByTags(videos, {}, tags);
    expect(out).toEqual([b, a]);
    expect(out).not.toBe(videos);
    expect(out[0]).toBe(b);
    expect(filterByTags(videos, { include: ['device:osr2', 'device:the-handy'], mode: 'any' }, tags)).toEqual([b, a]);
  });

  it('reads keys or tag objects, from a map, an object or the video', () => {
    expect(filterByTags([a, b], { include: ['device:osr2'] }, tags)).toEqual([b]);
    expect(filterByTags([a, b], { include: ['device:osr2'] }, new Map(Object.entries(tags)))).toEqual([b]);
    expect(filterByTags([{ ...b, tags: tags[b.path] }], { include: ['device:osr2'] })).toHaveLength(1);
    expect(filterByTags([a], { include: [{ key: 'device:the-handy' }] }, tags)).toEqual([a]);
  });

  it('is safe on bad input and never touches it', () => {
    expect(filterByTags(null, { include: ['x'] })).toEqual([]);
    expect(filterByTags([null, 3, a], { include: ['device:the-handy'] }, tags)).toEqual([a]);
    const frozen = deepFreeze({ videos: [a, b], query: { include: ['device:osr2'], exclude: ['content:x'] }, tags: structuredClone(tags) });
    expect(() => filterByTags(frozen.videos, frozen.query, frozen.tags)).not.toThrow();
  });

  it('include-only is the default: exclude is opt-in', () => {
    expect(filterByTags([a, b], { include: ['device:the-handy'] }, tags)).toEqual([a]);
    expect(filterByTags([a, b], { exclude: ['device:the-handy'] }, tags)).toEqual([b]);
  });
});

// ---------------------------------------------------------------------------
// Fix-up 2026-11-17 (review-1, from the tags sub-review).
describe('aliases follow several hops', () => {
  it('your alias may point at a bundled alias: handy -> thehandy -> device:the-handy', () => {
    const rules = compileTagRules({ aliases: { handy: 'thehandy' } });
    expect(classifyTag('handy', rules).key).toBe('device:the-handy');
    expect(classifyTag('Handy', rules).key).toBe('device:the-handy');
  });

  it('a chain of your own aliases is followed to its end (well within the step bound)', () => {
    const rules = compileTagRules({ aliases: { a1: 'a2', a2: 'a3', a3: 'a4', a4: 'a5', a5: 'thehandy' } });
    expect(classifyTag('a1', rules).key).toBe('device:the-handy');
  });
});

describe('robustness of what other sources give', () => {
  it('a name facet in a tag is yours to give: from a funscript or the forum it plants no performer, creator or studio', () => {
    const record = funscriptMetaRecord({ tags: ['performer:Some Name', 'creator:x', 'studio:y', 'VR'] }, 1);
    const fromFile = keys(effectiveTags(V, { funscript: { [S]: record } }, { scriptPath: S }));
    expect(fromFile).toEqual(['vr:vr']);
    const fromForum = keys(effectiveTags(V, { eroscripts: { [V]: { tags: ['performer:some-name', 'pov'] } } }));
    expect(fromForum.some((k) => k.startsWith('performer:'))).toBe(false);
    // Typed by you, it is a performer; and a record's own performer field still is.
    expect(keys(effectiveTags(V, { user: { [V]: ['performer:Jane Doe'] } }))).toEqual(['performer:jane-doe']);
    expect(keys(effectiveTags(V, { funscript: { [S]: funscriptMetaRecord({ performers: ['Jane Doe'] }, 1) } }, { scriptPath: S })))
      .toEqual(['performer:jane-doe']);
  });

  it('the facet part of a key is folded like its value', () => {
    expect(normalizeTagKey('Script Type: Cock Hero')).toBe('script-type:cock-hero');
    expect(normalizeTagKey('SCRIPT_TYPE:x')).toBe('script-type:x');
    expect(parseTagKey('ＤＥＶＩＣＥ:The Handy')).toEqual({ facet: 'device', value: 'the-handy' });
    expect(classifyTag('Script Type: Cock Hero').key).toBe('script-type:cock-hero');
  });

  it('funscript metadata is capped: a huge tag list keeps its first 200, an over-long string is left out', () => {
    const many = Array.from({ length: 200000 }, (_, i) => `tag${i}`);
    const huge = 'x'.repeat(5 * 1024 * 1024);
    const record = funscriptMetaRecord({ tags: many, topic_tags: [huge, 'pov'], performers: many, title: huge, creator: huge, author: 'scripter-one' }, 1);
    expect(record.tags).toHaveLength(200);
    expect(record.tags[0]).toBe('tag0');
    expect(record.performers).toHaveLength(200);
    expect(record.topicTags).toEqual(['pov']);
    expect(record.title).toBeNull();
    expect(record.creator).toBe('scripter-one');
    expect(JSON.stringify(record).length).toBeLessThan(20000);
  });

  it('a topic id comes only from a forum topic URL on the forum\'s own host, as a whole number that fits', () => {
    const id = (url) => funscriptMetaRecord({ topic_url: url, tags: ['x'] }, 1).topicId;
    expect(id('https://discuss.eroscripts.com/t/clip-one/12345')).toBe(12345);
    expect(id('https://discuss.eroscripts.com/t/clip-one/12345/7')).toBe(12345);   // a post in it
    expect(id('https://discuss.eroscripts.com/t/123/7')).toBe(123);                // /t/<id>/<post>
    expect(id('https://discuss.eroscripts.com/t/123')).toBe(123);
    expect(id('https://DISCUSS.EROSCRIPTS.COM/t/x/5?u=me#p')).toBe(5);
    expect(id('https://evil.example/discuss.eroscripts.com/t/x/5')).toBeNull();     // another host
    expect(id('https://discuss.eroscripts.com.evil.example/t/x/5')).toBeNull();
    expect(id('https://discuss.eroscripts.com/u/x/5')).toBeNull();                  // not a topic
    expect(id(`https://discuss.eroscripts.com/t/x/${'9'.repeat(400)}`)).toBeNull();  // never Infinity
    expect(id('javascript:discuss.eroscripts.com/t/x/5')).toBeNull();
    expect(id('not a url')).toBeNull();
  });
});

describe('effectiveTags: a tag you add shows even when it is hidden on every video (2026-11-18)', () => {
  // Dave (2026-11-17): a hidden tag the user adds again shows again. The
  // per-video hide is cleared by the writer (video-tag-edits.js); the
  // every-video hide (tagSettings.hidden) stays, so effectiveTags exempts a
  // tag YOU gave this video from it.
  const OTHER = 'C:/Library/Clip Two.mp4';
  const sources = {
    eroscripts: { [V]: { tags: ['pov', 'the-handy'] }, [OTHER]: { tags: ['pov', 'the-handy'] } },
    user: { [V]: ['POV'] },
  };

  it('shows on the video you added it to, with both sources; stays hidden where you did not', () => {
    const options = { hiddenEverywhere: ['pov'] };
    const mine = effectiveTags(V, sources, options);
    expect(keys(mine)).toEqual(['device:the-handy', 'content:pov']);
    expect(mine.find((t) => t.key === 'content:pov').sources).toEqual(['user', 'eroscripts']);
    expect(keys(effectiveTags(OTHER, sources, options))).toEqual(['device:the-handy']);
  });

  it('a hide on this video still applies to your own tag', () => {
    expect(keys(effectiveTags(V, sources, { hidden: { [V]: ['content:pov'] }, hiddenEverywhere: ['pov'] }))).toEqual(['device:the-handy']);
    expect(keys(effectiveTags(V, sources, { hidden: ['pov'] }))).toEqual(['device:the-handy']);
  });

  it('a tag only other sources give stays hidden everywhere, aliases and spellings aside', () => {
    const options = { hiddenEverywhere: ['TheHandy'] };
    expect(keys(effectiveTags(V, sources, options))).toEqual(['content:pov']);
  });
});

describe('tagIndex', () => {
  it('one entry per library video with tags, each read with its own script', () => {
    const A = 'C:/Library/A.mp4';
    const B = 'C:/Library/B.mp4';
    const C = 'C:/Library/C.mp4';
    const sources = {
      user: { [A]: ['mine'] },
      funscript: { 'C:/Library/B.funscript': { tags: ['osr2'] } },
      eroscripts: { [A]: { tags: ['sr6'], scriptPath: 'C:/Library/Old.funscript' } },
    };
    const index = tagIndex([
      { path: A, funscriptPath: 'C:/Library/A.funscript' },
      { path: B, funscriptPath: 'C:/Library/B.funscript' },
      { path: C, funscriptPath: null },
      { path: A }, null, { path: '' },
    ], sources, { hidden: { [B]: [] } });
    expect([...index.keys()]).toEqual([A, B]);
    expect(keys(index.get(A))).toEqual(['content:mine']); // the old script's post is not this video's
    expect(keys(index.get(B))).toEqual(['device:osr2']);
  });

  it('applies the same hides as effectiveTags', () => {
    const index = tagIndex([{ path: V }], { user: { [V]: ['a', 'b'] } }, { hidden: { [V]: ['a'] } });
    expect(keys(index.get(V))).toEqual(['content:b']);
    expect(tagIndex(undefined, {})).toEqual(new Map());
  });
});
