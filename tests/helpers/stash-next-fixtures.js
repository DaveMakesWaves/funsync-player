// The Stash "next" lot's data in the shape the renderer reads (stage
// sn-library, 2026-11-19): the seeded local test Stash's scenes
// (tests/fixtures/stash/sn-scenes.response.json: ratings 20/60/80/100,
// organised, plays, last played, O-counts, and a re-encode whose phash
// equals synthetic_large.mkv's) mapped to the lot's SHARED DATA CONTRACT
// (scene.rating100 / organized / playCount / lastPlayedAt / oCounter /
// phash; RULES-S1-NEXT.txt), as main's projection hands it to the renderer
// (stash-store.js stashData()). Each scene's file is a video in a FunSync
// library at C:\Lib, linked by its fingerprint with the size Stash has, so
// the trust check passes. Nothing here talks to any Stash.

import fs from 'node:fs';

export const SERVER = 'http://127.0.0.1:9999';
export const LIB = 'C:\\Lib';

/**
 * The English words of stage sn-library's new keys (SCRATCH/sn-library/
 * strings.json, en), laid over en.json by the tests until the merge puts
 * them in the locales.
 */
export const NEXT_STRINGS = Object.freeze({
  'library.sortStashRatingDesc': 'Stash Rating High-Low',
  'library.sortStashRatingAsc': 'Stash Rating Low-High',
  'library.sortStashLastPlayedDesc': 'Recently Played in Stash',
  'library.sortStashLastPlayedAsc': 'Played Longest Ago in Stash',
  'library.filterStash': 'Stash',
  'library.filterStashRating': 'Stash rating',
  'library.filterStashRatingAny': 'Any rating',
  'library.filterStashRatingAtLeast': '{count, plural, one {Rated # star or more} other {Rated # stars or more}}',
  'library.filterStashOrganised': 'Organised in Stash',
  'library.filterChipStashRating': '{count, plural, one {Stash: # star or more} other {Stash: # stars or more}}',
  'videoOptions.stash.plays': 'Plays',
  'videoOptions.stash.lastPlayed': 'Last played',
  'videoOptions.stash.lastPlayedNever': 'never',
  'videoOptions.stash.oCount': 'O-count',
  'settingsPanel.duplicates.tierStash': 'Looks the same (Stash)',
  'settingsPanel.duplicates.whyStash': 'Your Stash gives them the same picture fingerprint (phash), probably a re-encode',
  'settingsPanel.duplicates.selectTierStash': 'Select spares that look the same in Stash ({count})',
});

const RAW = JSON.parse(fs.readFileSync('tests/fixtures/stash/sn-scenes.response.json', 'utf8')).data.findScenes.scenes;

/** FunSync's path for a Stash file name. */
export const libPath = (basename) => `${LIB}\\${basename}`;

/** The fixture's videos by a short name. */
export const P = Object.freeze({
  large: libPath('synthetic_large.mkv'),          // scene 2: 100, organised, 5 plays, O 3, phash ab63…
  reencode: libPath('synthetic_large_reencode.mp4'), // scene 10: unrated, 0 plays, same phash as large
  mid: libPath('synthetic_mid.mp4'),              // scene 3: 60, 2 plays, O 0
  tiny: libPath('synthetic_tiny.mp4'),            // scene 4: 20, organised, 0 plays, no phash
  small: libPath('Synthetic Clip Small.mp4'),     // scene 1: 80, organised, 1 play, O 1
  edge131072: libPath('synthetic_edge_131072.mp4'), // scene 5: 80, 0 plays, O 2
  edge65535: libPath('synthetic_edge_65535.mp4'),
  edge65536: libPath('synthetic_edge_65536.mp4'),
  edge65543: libPath('synthetic_edge_65543.mp4'),
  edge131079: libPath('synthetic_edge_131079.mp4'),
});

/** One raw Stash scene as the contract carries it (`omitNext`: an older library.json, without the lot's fields). */
export function contractScene(raw, { omitNext = false } = {}) {
  const file = raw.files[0];
  const phash = file.fingerprints.find((f) => f.type === 'phash')?.value ?? null;
  const scene = {
    id: raw.id,
    title: raw.title || null,
    rating100: raw.rating100,
    organized: raw.organized === true,
    tagIds: [],
    performerIds: [],
    markers: [],
    urls: [],
    files: [{ path: file.path, size: file.size, duration: file.duration, oshash: file.fingerprints.find((f) => f.type === 'oshash')?.value ?? null }],
    server: SERVER,
    fetchedAt: Date.UTC(2026, 10, 19, 9, 0),
  };
  if (!omitNext) {
    Object.assign(scene, {
      playCount: raw.play_count,
      lastPlayedAt: raw.last_played_at,
      oCounter: raw.o_counter,
      phash,
      groups: (raw.groups || []).map((g) => ({ groupId: String(g.group.id), sceneIndex: g.scene_index ?? null })),
    });
  }
  return scene;
}

/** The library videos (FunSync's scan entries), one per fixture scene. */
export function snVideos() {
  return RAW.map((raw) => {
    const file = raw.files[0];
    return {
      name: file.basename,
      path: libPath(file.basename),
      size: file.size,
      duration: file.duration,
      dateAdded: 5,
      hasFunscript: false,
      funscriptPath: null,
      hasSubtitle: false,
      subtitlePath: null,
      variants: [],
    };
  });
}

/**
 * main's projection over the fixture: every scene linked to its library
 * video (state ok, by fingerprint, the file's size) unless `unlinked` names
 * it; `scenes` overrides fields per scene id; `omitNext` drops the lot's
 * fields from every scene (an older library.json).
 */
export function snProjection({ rev = 1, unlinked = [], links = {}, scenes = {}, omitNext = false } = {}) {
  const out = {
    v: 1,
    rev,
    server: { url: SERVER, version: 'v0.32.0' },
    lastSync: { at: Date.UTC(2026, 10, 19, 9, 0), kind: 'full', ok: true, partial: false },
    links: {},
    check: {},
    refused: {},
    scenes: {},
    performers: {},
    studios: {},
    tags: {},
  };
  for (const raw of RAW) {
    const file = raw.files[0];
    out.scenes[raw.id] = { ...contractScene(raw, { omitNext }), ...(scenes[raw.id] || {}) };
    const path = libPath(file.basename);
    if (unlinked.includes(path)) continue;
    out.links[path] = {
      sceneId: raw.id,
      server: SERVER,
      by: 'oshash',
      fp: { size: file.size, mtimeMs: 5, oshash: file.fingerprints.find((f) => f.type === 'oshash')?.value ?? null },
      linkedAt: 2,
      state: 'ok',
    };
  }
  Object.assign(out.links, links);
  return out;
}
