// Fixtures for the video options dialog's Stash tests (Stash S1, stage
// s1-2c-dialog, 2026-11-18): the English words the assertions read, the
// Stash data in the shape main projects it (electron/stash-library-file.js
// buildProjection; DESIGN-stash-s1.md (c) "library.json"), and a fake
// `host.stash` with the interface library.js `_stashHost()` gives the
// dialog (s1-2d-renderer). Every value is synthetic; every stash_id uses
// stash-box.invalid. Nothing here talks to any Stash.
//
// The fake keeps main's rules for the writes the dialog asks for (link,
// choose, refuse, unlink): each answers an Undo token (an `undoId`, as
// main's IPC does) that names the video's link, check and refusal exactly
// as they were; undo(path, undoId) puts all three back. So a test can
// check that the dialog's Undo gives the token back as it got it. The
// interface is SCRATCH/s1-2d-renderer/host-stash-api.txt (2026-11-18).

import { stashVideoView } from '../../renderer/js/stash-tags.js';

/** The English words of the new keys (SCRATCH/s1-2c-dialog/strings.json, en) plus Settings' error words the dialog shares. */
export const STASH_STRINGS = Object.freeze({
  'videoOptions.stash.heading': 'Stash',
  'videoOptions.stash.sceneTitle': '“{title}”',
  'videoOptions.stash.untitled': 'Scene {id}',
  'videoOptions.stash.studioOf': '{studio} ({parent})',
  'videoOptions.stash.code': 'code {code}',
  'videoOptions.stash.rated': 'rated {rating}/100',
  'videoOptions.stash.organised': 'organised',
  'videoOptions.stash.director': 'directed by {name}',
  'videoOptions.stash.markerCount': '{count, plural, one {# marker} other {# markers}}',
  'videoOptions.stash.by.oshash': 'matched by file fingerprint',
  'videoOptions.stash.by.chosen': 'chosen by you',
  'videoOptions.stash.by.manual': 'linked by you',
  'videoOptions.stash.synced': 'synced {date}',
  'videoOptions.stash.verify': 'moved since; checked again at the next sync',
  'videoOptions.stash.performers': 'Performers',
  'videoOptions.stash.markers': 'Markers',
  'videoOptions.stash.moreMarkers': '{count, plural, one {# more} other {# more}}',
  'videoOptions.stash.urls': 'Links',
  'videoOptions.stash.copyUrl': 'Copy',
  'videoOptions.stash.copyUrlAria': 'Copy {url}',
  'videoOptions.stash.urlCopied': 'Link copied.',
  'videoOptions.stash.urlCopyFailed': "Couldn't copy the link.",
  'videoOptions.stash.showDescription': 'Show description',
  'videoOptions.stash.copy': 'Another file in your library is the same video: {path}',
  'videoOptions.stash.open': 'Open in Stash',
  'videoOptions.stash.openAria': 'Open in Stash (opens your browser)',
  'videoOptions.stash.syncVideo': 'Sync this video',
  'videoOptions.stash.syncing': 'Syncing…',
  'videoOptions.stash.notThis': 'Not this scene…',
  'videoOptions.stash.unlink': 'Unlink',
  'videoOptions.stash.find': 'Find in Stash…',
  'videoOptions.stash.notSynced': 'FunSync has not synced with Stash yet.',
  'videoOptions.stash.notFound': 'Not found in Stash.',
  'videoOptions.stash.changed': 'This file changed since it was matched. Its Stash data is hidden until the next sync.',
  'videoOptions.stash.gone': 'This scene is gone from Stash. Its data is kept.',
  'videoOptions.stash.refused': 'You said this file is not {name}.',
  'videoOptions.stash.refusedSome': '{count, plural, =1 {You said this file is not the Stash scene offered for it.} other {You said this file is none of the # Stash scenes offered for it.}}',
  'videoOptions.stash.otherServer': 'From your other Stash ({address}).',
  'videoOptions.stash.check.several': '{count, plural, =2 {Two Stash scenes have this exact file.} other {# Stash scenes have this exact file.}} Which one is it?',
  'videoOptions.stash.check.pathChanged': 'Stash has a file at this path, but it is not the same file. It changed after Stash last scanned it.',
  'videoOptions.stash.check.keptLink': 'Linked now: {name}.',
  'videoOptions.stash.check.legend': 'Which Stash scene is this?',
  'videoOptions.stash.check.use': 'Use this scene',
  'videoOptions.stash.check.none': 'None of these',
  'videoOptions.stash.check.useAnyway': 'Use it anyway',
  'videoOptions.stash.check.ignore': 'Ignore',
  'videoOptions.stash.check.durationDiff': 'length differs by {seconds} s',
  'videoOptions.stash.notThisConfirm.title': 'Not this scene?',
  'videoOptions.stash.notThisConfirm.message': 'FunSync will unlink this video from {name} and will not link this file to it again. Nothing changes in Stash.',
  'videoOptions.stash.notThisConfirm.button': 'Not this scene',
  'videoOptions.stash.live.syncing': 'Syncing this video with Stash…',
  'videoOptions.stash.live.synced': 'Synced with Stash.',
  'videoOptions.stash.live.syncedLinked': 'Synced. This video is {name} in Stash.',
  'videoOptions.stash.live.syncedCheck': 'Synced. Stash could not decide which scene this video is: choose below.',
  'videoOptions.stash.live.syncedNotFound': 'Synced. This video was not found in Stash.',
  'videoOptions.stash.live.syncedGone': 'Synced. {name} is gone from Stash; its data is kept.',
  'videoOptions.stash.live.syncedChanged': 'Synced. This file still differs from the one matched; its Stash data stays hidden.',
  'videoOptions.stash.live.relinked': 'This file is now linked to {name}.',
  'videoOptions.stash.live.linked': 'Linked this video to {name}.',
  'videoOptions.stash.live.unlinked': 'Unlinked this video from {name}.',
  'videoOptions.stash.live.noneOfThese': 'None of these scenes will be offered for this file again.',
  'videoOptions.stash.live.ignored': 'That Stash scene will not be offered for this file again.',
  'videoOptions.stash.live.undoFailed': "Can't undo: FunSync could not change its Stash data.",
  'videoOptions.stash.error.fileOffline': "FunSync could not read this video's file (its drive may be offline). Nothing was changed.",
  'videoOptions.stash.error.busy': 'Stash is syncing already. Try again when it ends.',
  'videoOptions.stash.error.cancelled': 'Stopped. Nothing was changed.',
  'videoOptions.stash.error.changedMeanwhile': "This video's Stash data changed meanwhile. Nothing was changed.",
  'videoOptions.stash.error.saveFailed': 'FunSync could not save its Stash data. Nothing was changed.',
  'videoOptions.stash.error.generic': 'Stash could not be asked. Nothing was changed.',
  'videoOptions.tags.source.stashRow': '{tags, plural, one {# tag} other {# tags}}, {performers, plural, one {# performer} other {# performers}}, {studios, plural, one {# studio} other {# studios}}',
  'videoOptions.tags.source.stashGone': 'gone from Stash',
  'videoOptions.tags.source.stashHidden': 'this file changed; its Stash tags are hidden until the next sync',
  'stash.picker.title': 'Find in Stash',
  'stash.picker.label': 'Search your Stash',
  'stash.picker.placeholder': 'Scene title, code or file name',
  'stash.picker.search': 'Search',
  'stash.picker.hint': 'Pick the scene this video is. FunSync only links it; nothing changes in Stash.',
  'stash.picker.prompt': 'Type and press Search. Nothing is sent before you do.',
  'stash.picker.searching': 'Searching…',
  'stash.picker.none': 'No scenes found for “{query}”.',
  'stash.picker.found': '{count, plural, one {# scene found.} other {# scenes found.}}',
  'stash.picker.someOf': 'Showing the first {shown} of {count}. Add words to narrow the search.',
  'stash.picker.link': 'Link',
  'stash.picker.linkAria': 'Link this video to {name}',
  'stash.picker.resultsAria': 'Stash scenes',
  // Stage s1-1a's shared error words (SCRATCH/s1-1a-client/strings.json), design (e).
  'stash.error.unreachable': "Can't reach Stash at {address}. Is it running?",
  'stash.error.timeout': 'Stash did not answer in time.',
  'stash.error.tooOld': 'This Stash ({version}) is too old. FunSync needs v{minVersion} or newer.',
  'stash.error.tooOldNoVersion': 'This Stash is too old. FunSync needs v{minVersion} or newer.',
  'stash.error.http': 'Stash answered with an error (HTTP {status}).',
});

/**
 * The English words of the Stash fix-up's new keys
 * (SCRATCH/s1-fixup-renderer/strings.json, en), until the merge puts them
 * in en.json (laid over it, they read the same afterwards).
 */
export const S1_FIXUP_STRINGS = Object.freeze({
  'settingsPanel.stash.syncRelinked': '{count, plural, one {# video was re-linked to another Stash scene.} other {# videos were re-linked to another Stash scene.}}',
  'settingsPanel.stash.relinkHeader': 'Re-linked ({count, number})',
  'settingsPanel.stash.relinkHint': 'A sync linked these videos to another Stash scene (for example, scenes merged in Stash). Undo puts the earlier link back.',
  'settingsPanel.stash.relinkTo': 'now linked to {name}',
  'settingsPanel.stash.relinkToUntitled': 'now linked to another Stash scene',
  'settingsPanel.stash.relinkUndoAria': 'Undo the re-link of {name}',
  'settingsPanel.stash.relinkUndoAll': 'Undo all',
  'settingsPanel.stash.relinkUndoAllAria': 'Undo all {count, number} re-links',
  'settingsPanel.stash.undoRelinksAria': '{count, plural, one {Undo the re-link} other {Undo the # re-links}}',
  'settingsPanel.stash.relinkUndone': '{name} is linked to its earlier Stash scene again.',
  'settingsPanel.stash.relinksUndone': '{count, plural, one {# re-link undone.} other {# re-links undone.}}',
  'settingsPanel.stash.relinkUndoFailed': 'The re-link of {name} could not be undone. Its Stash data changed since, or FunSync could not save it.',
  'settingsPanel.stash.relinksUndonePartial': '{done, number} of {total, number} re-links undone. The others changed since or could not be saved.',
  'videoOptions.stash.live.refusedLinkChanged': 'It is now linked to {name}, which was left as it is.',
  // s1-fixup-main's new answers (SCRATCH/s1-fixup-main/ipc-changes.txt 3-5).
  'settingsPanel.stash.keyElsewhere': "The saved API key belongs to {address}, so FunSync does not send it to this address. Paste this Stash's key, or remove the saved one.",
  'settingsPanel.stash.keyElsewhereNoAddress': "The saved API key belongs to another address, so FunSync does not send it to this one. Paste this Stash's key, or remove the saved one.",
  'settingsPanel.stash.damagedRecovered': 'FunSync could not read its Stash data. It was kept aside as {name}, and the previous copy was used.',
  'settingsPanel.stash.recoveredMissing': "FunSync's Stash data file was missing. The previous copy was used.",
  'videoOptions.stash.sceneChanged': 'The Stash scene with this id no longer has this file (Stash may have been reset or rescanned). Its data is hidden. Unlink it, or link it again with Find in Stash…',
  'settingsPanel.stash.removeUndoneMerged': 'Stash data put back, together with what was synced since.',
  'settingsPanel.stash.undoFailedKept': "The Stash data could not be put back. It is kept aside in FunSync's data folder; you can try Undo again.",
});

/** en.json with `extra` laid over it (dotted keys). */
export function bundleWith(en, extra = STASH_STRINGS) {
  const b = structuredClone(en);
  for (const [key, value] of Object.entries(extra)) {
    const parts = key.split('.');
    let o = b;
    for (const p of parts.slice(0, -1)) {
      if (!o[p] || typeof o[p] !== 'object') o[p] = {};
      o = o[p];
    }
    o[parts[parts.length - 1]] = value;
  }
  return b;
}

export const SERVER = 'http://127.0.0.1:9999';
export const OLD_SERVER = 'http://192.168.1.20:9999';
export const HASH = '0123456789abcdef';
export const OTHER_HASH = 'fedcba9876543210';
export const SYNCED_AT = Date.UTC(2026, 10, 18, 14, 2);
export const BOX = 'https://stash-box.invalid/graphql';

function scene(id, extra = {}) {
  return {
    id,
    title: `Synthetic Scene ${id}`,
    code: null,
    date: null,
    director: null,
    details: null,
    urls: [],
    rating100: null,
    organized: false,
    studioId: null,
    performerIds: [],
    tagIds: [],
    markers: [],
    stashIds: [],
    files: [{ path: `/data/videos/scene-${id}.mp4`, size: 1000, duration: 60, oshash: HASH }],
    updatedAt: '2026-11-17T10:00:00Z',
    fetchedAt: SYNCED_AT,
    server: SERVER,
    ...extra,
  };
}

/**
 * The Stash data (main's projection): scene '1' is the linked one, with two
 * performers of one name kept apart by their Stash IDs, a studio with a
 * parent, two markers, a link and a description; '2' and '3' are the
 * candidates of a check.
 */
export function stashData({ videoPath, links = undefined, check = {}, refused = {}, lastSync = true, scenes = {} } = {}) {
  return {
    v: 1,
    rev: 3,
    server: { url: SERVER, version: 'v0.32.0' },
    lastSync: lastSync ? {
      at: SYNCED_AT, kind: 'full', ok: true, partial: false, error: null,
      counts: { linked: 1, check: 0, notInStash: 0, gone: 0, changed: 0, skipped: 0 },
    } : null,
    links: links !== undefined ? links : {
      [videoPath]: { sceneId: '1', server: SERVER, by: 'oshash', fp: { size: 1000, mtimeMs: 5, oshash: HASH }, linkedAt: 10, state: 'ok' },
    },
    check,
    refused,
    scenes: {
      1: scene('1', {
        title: 'Synthetic Scene Small',
        code: 'SYN-001',
        date: '2026-11-17',
        details: 'A synthetic scene for the tests.',
        urls: ['https://example.invalid/scenes/syn-001'],
        rating100: 80,
        organized: true,
        studioId: 's1',
        performerIds: ['p1', 'p2'],
        tagIds: ['t1', 't2'],
        markers: [
          { id: 'm2', title: null, seconds: 4, endSeconds: 6, tag: { id: 't2', name: 'Synthetic Tag B' } },
          { id: 'm1', title: 'Synthetic marker one', seconds: 1, endSeconds: null, tag: { id: 't1', name: 'POV' } },
        ],
      }),
      2: scene('2', { title: 'Synthetic Scene Two', date: '2026-11-01', studioId: 's1', files: [{ path: '/data/videos/two.mp4', size: 1000, duration: 61, oshash: HASH }] }),
      3: scene('3', { title: 'Synthetic Scene Three', date: '2026-11-02', files: [{ path: '/data/videos/three.mp4', size: 1000, duration: 75, oshash: HASH }] }),
      ...scenes,
    },
    performers: {
      p1: { id: 'p1', name: 'Jane Doe', disambiguation: 'blonde', stashIds: [{ endpoint: BOX, stashId: 'AAAA-3F2A' }] },
      p2: { id: 'p2', name: 'Jane Doe', disambiguation: null, stashIds: [{ endpoint: BOX, stashId: 'BBBB-9C1D' }] },
    },
    studios: {
      s1: { id: 's1', name: 'Synthetic Studio', parent: { id: 's0', name: 'Synthetic Network' }, parentId: 's0', stashIds: [] },
    },
    tags: {
      t1: { id: 't1', name: 'POV' },
      t2: { id: 't2', name: 'Synthetic Tag B' },
    },
  };
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

/** One video's link, check and refusal, as main's Undo keeps them (null = none). */
export function videoEntry(data, path) {
  return {
    links: own(data.links, path) ? clone(data.links[path]) : null,
    check: own(data.check, path) ? clone(data.check[path]) : null,
    refused: own(data.refused, path) ? clone(data.refused[path]) : null,
  };
}

/**
 * A fake host.stash (library.js `_stashHost()`'s interface) over `initial`.
 * `enabled` is read at each call. Every method is a vi.fn-like recorder in
 * `calls`; `answers` overrides what syncVideo / search answer.
 */
export function makeFakeStash(initial, { enabled = () => true, now = () => 1000 } = {}) {
  let data = clone(initial);
  let version = 1;
  let undoSeq = 0;
  const undos = new Map();
  const listeners = new Set();
  const calls = [];
  const answers = { syncVideo: null, search: null, failNext: null, restoreFails: false };
  const changed = () => {
    version += 1;
    data.rev = (data.rev || 0) + 1;
    for (const cb of [...listeners]) cb();
  };
  const keep = (path) => {
    const id = `undo-${++undoSeq}`;
    undos.set(id, { path, ...videoEntry(data, path) });
    return id;
  };
  const failing = (name) => {
    if (answers.failNext && answers.failNext.name === name) {
      const reply = answers.failNext.reply;
      answers.failNext = null;
      return reply;
    }
    return null;
  };

  const stash = {
    calls,
    answers,
    get raw() { return data; },
    set raw(next) { data = clone(next); changed(); },
    enabled: () => enabled() === true,
    view: (path, opts = {}) => stashVideoView(data, path, { ...opts, enabled: enabled() === true }),
    data: () => data,
    version: () => version,
    onChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    listenerCount: () => listeners.size,
    async syncVideo(path) {
      calls.push(['syncVideo', path]);
      const fail = failing('syncVideo');
      if (fail) return fail;
      const fn = answers.syncVideo;
      if (typeof fn === 'function') {
        const out = fn(data, path, { keep, changed, set: (next) => { data = next; } });
        return out;
      }
      return { ok: true, kind: 'video', written: false, counts: {}, relinked: [] };
    },
    async choose(path, sceneId) {
      calls.push(['choose', path, sceneId]);
      const fail = failing('choose');
      if (fail) return fail;
      const c = data.check[path];
      if (!c || !c.sceneIds.includes(sceneId)) return { ok: false, code: 'not-a-candidate' };
      const undoId = keep(path);
      data.links[path] = { sceneId, server: data.server.url, by: 'chosen', fp: clone(c.fp), linkedAt: now(), state: 'ok' };
      delete data.check[path];
      changed();
      return { ok: true, undoId };
    },
    // `sceneId` (s1-fixup-main's stash-refuse / stash-unlink, RA-S1-3): the
    // scene the dialog named. Refuse: a link that changed meanwhile is kept
    // and only the named scene is refused (`linkChanged`); no link and no
    // check any more: 'changed-since'. Unlink: another scene linked now:
    // 'changed-since', nothing changed.
    async refuse(path, target, sceneId) {
      calls.push(sceneId === undefined ? ['refuse', path, target] : ['refuse', path, target, sceneId]);
      const fail = failing('refuse');
      if (fail) return fail;
      const l = data.links[path];
      const c = data.check[path];
      const named = target === 'link' && sceneId != null ? String(sceneId) : null;
      if (named && !l && !c) return { ok: false, code: 'changed-since' };
      const moved = !!(named && l && l.sceneId !== named);
      const src = target === 'link' ? (l || (named ? c : null)) : c;
      if (!src) return { ok: false, code: 'nothing-to-refuse' };
      const ids = named ? [named] : (target === 'link' ? [src.sceneId] : [...src.sceneIds]);
      const undoId = keep(path);
      const prev = data.refused[path];
      const all = prev && prev.oshash === src.fp.oshash ? [...prev.sceneIds] : [];
      for (const id of ids) if (!all.includes(id)) all.push(id);
      data.refused[path] = { oshash: src.fp.oshash, sceneIds: all, at: now() };
      if (l && all.includes(l.sceneId)) delete data.links[path];
      if (c && c.sceneIds.every((id) => all.includes(id))) delete data.check[path];
      changed();
      return moved ? { ok: true, undoId, linkChanged: true, linkedSceneId: l.sceneId } : { ok: true, undoId };
    },
    async unlink(path, sceneId) {
      calls.push(sceneId === undefined ? ['unlink', path] : ['unlink', path, sceneId]);
      const fail = failing('unlink');
      if (fail) return fail;
      if (!own(data.links, path)) return { ok: false, code: 'not-linked' };
      if (sceneId != null && data.links[path].sceneId !== String(sceneId)) return { ok: false, code: 'changed-since' };
      const undoId = keep(path);
      delete data.links[path];
      changed();
      return { ok: true, undoId };
    },
    async link(path, sceneId) {
      calls.push(['link', path, sceneId]);
      const fail = failing('link');
      if (fail) return fail;
      const undoId = keep(path);
      data.links[path] = { sceneId, server: data.server.url, by: 'manual', fp: { size: 1000, mtimeMs: 5, oshash: OTHER_HASH }, linkedAt: now(), state: 'ok' };
      delete data.check[path];
      const r = data.refused[path];
      if (r && r.sceneIds.includes(sceneId)) {
        const rest = r.sceneIds.filter((x) => x !== sceneId);
        if (rest.length) data.refused[path] = { ...r, sceneIds: rest };
        else delete data.refused[path];
      }
      changed();
      return { ok: true, undoId };
    },
    async undo(path, token) {
      calls.push(['undo', path, token]);
      if (answers.restoreFails) return { ok: false, code: 'expired' };
      const entry = typeof token === 'string' ? undos.get(token) : null;
      if (!entry || entry.path !== path) return { ok: false, code: 'expired' };
      undos.delete(token);
      for (const key of ['links', 'check', 'refused']) {
        if (entry[key] === null) delete data[key][path];
        else data[key][path] = clone(entry[key]);
      }
      changed();
      return { ok: true };
    },
    async search(q) {
      calls.push(['search', q]);
      const fn = answers.search;
      if (typeof fn === 'function') return fn(q);
      return { ok: true, count: 0, scenes: [] };
    },
    async openInStash(path, sceneId) {
      calls.push(['openInStash', path, sceneId]);
      return { ok: true };
    },
  };
  return stash;
}

/** The calls that would reach Stash or change the Stash data. */
export const REQUEST_CALLS = Object.freeze(['syncVideo', 'choose', 'refuse', 'unlink', 'link', 'undo', 'search']);
