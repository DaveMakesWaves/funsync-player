// Stash S1: the frozen list of GraphQL documents FunSync may send to the
// user's own Stash server. Read-only by construction (DESIGN-stash-s1.md (d)).
//
// electron/stash-client.js sends ONLY documents from this file, picked by
// name; it never takes a document from its caller. Every document here is a
// `query`: no `mutation`, no `subscription` (tests/unit/stash-queries.test.js
// parses each one). FunSync never changes anything in Stash.
//
// What the documents never ask for: `paths` (with a key, Stash puts
// `?apikey=<key>` into `paths.funscript`), `sceneStreams` (signed stream
// URLs), images, captions, play or O history (the "next" lot, 2026-11-19,
// reads the counts and the last play only, never the history lists).
// Nothing Stash builds is
// fetched or stored; the scene's own `urls` and the stash-box `endpoint`s
// are text the user typed, kept as text and never fetched.
//
// Each document was sent to the LOCAL test Stash (v0.32.0, synthetic library)
// and its answer saved under tests/fixtures/stash/s1-*.response.json with the
// document's sha256; a test fails when a document changes and its fixture was
// not recorded again. Record again only from the local test Stash
// (ROOT/../stash-test, 127.0.0.1:9999), never from another server.

// The most details requests may carry: one aliased `findScene` per id. A
// missing id answers `null` for its alias only, where `findScenes(ids:)`
// fails the whole request (checked on v0.32.0).
const DETAILS_MAX = 50;

// The most scenes one light-list page may ask for.
const LIST_PAGE_MAX = 1000;

// The most results Find in Stash… shows, and the most scenes that may share
// one oshash before the answer is cut (a file in more scenes than that is
// "several" all the same).
const SEARCH_PAGE = 20;

// What S1 keeps of a matched scene (DESIGN-stash-s1.md (a), (c)). The
// "next" lot (2026-11-19, appendix (j) #2, #3, #6, #10) adds the play count,
// the last play, the O-count, the scene's Groups with its place in each, and
// each file's phash. All read-only.
const SCENE_DETAIL_FRAGMENT = `fragment FunSyncSceneDetail on Scene {
  id
  title
  code
  date
  director
  details
  urls
  rating100
  organized
  play_count
  last_played_at
  o_counter
  updated_at
  files {
    path
    size
    duration
    oshash: fingerprint(type: "oshash")
    phash: fingerprint(type: "phash")
  }
  groups {
    scene_index
    group {
      id
      name
    }
  }
  studio {
    id
    name
    parent_studio {
      id
      name
    }
    stash_ids {
      endpoint
      stash_id
    }
  }
  performers {
    id
    name
    disambiguation
    stash_ids {
      endpoint
      stash_id
    }
  }
  tags {
    id
    name
  }
  scene_markers {
    id
    title
    seconds
    end_seconds
    primary_tag {
      id
      name
    }
  }
  stash_ids {
    endpoint
    stash_id
  }
}`;

// The light scene: enough to match on this PC ((b)) and to know what changed.
const SCENE_LIGHT_FIELDS = `id
      updated_at
      files {
        path
        size
        oshash: fingerprint(type: "oshash")
      }`;

// Test connection: the version (checked against the minimum by number, not by
// a field) and the scene count for the result line. Both fields exist on
// every Stash version FunSync could meet.
const TEST = `query FunSyncTest {
  version {
    version
  }
  findScenes(filter: { per_page: 1 }) {
    count
  }
}`;

// The light list a full sync pages through. Sorted by id: a scene added in
// Stash while FunSync pages gets a higher id and lands on a later page,
// instead of shifting every page after it (a path sort would).
//
// The "next" lot (2026-11-19) also reads here what changes WITHOUT the
// scene's `updated_at` changing, so every full sync has it fresh for the
// scenes FunSync keeps (their details are fetched again only when
// `updated_at` moved): the play count, the last play and the O-count
// (Stash records a play without touching the scene), the scene's Groups with
// their names (a renamed Group does not touch its scenes) and each file's
// phash (Stash's Generate task adds it to the file later).
const SCENE_LIST = `query FunSyncSceneList($page: Int!, $perPage: Int!) {
  findScenes(filter: { page: $page, per_page: $perPage, sort: "id", direction: ASC }) {
    count
    scenes {
      id
      updated_at
      play_count
      last_played_at
      o_counter
      groups {
        scene_index
        group {
          id
          name
        }
      }
      files {
        path
        size
        oshash: fingerprint(type: "oshash")
        phash: fingerprint(type: "phash")
      }
    }
  }
}`;

// Stash's tags with their aliases and parents (the "next" lot, appendix (j)
// #5): what "Use Stash's tag aliases and sub-tags" is built from. Paged and
// sorted by id like the scene list; children are the parents read the other
// way, so they are not asked for twice.
const TAG_LIST = `query FunSyncTagList($page: Int!, $perPage: Int!) {
  findTags(filter: { page: $page, per_page: $perPage, sort: "id", direction: ASC }) {
    count
    tags {
      id
      name
      aliases
      parents {
        id
      }
    }
  }
}`;

// Every scene that has a file with this oshash ("Sync this video"). EQUALS on
// the whole lower-case hash: INCLUDES is a substring match (a 4-character
// piece matched on v0.32.0). A list, not findSceneByHash, so a file that two
// scenes share shows as "several" here too.
const SCENES_BY_OSHASH = `query FunSyncScenesByOshash($oshash: String!) {
  findScenes(scene_filter: { oshash: { value: $oshash, modifier: EQUALS } }, filter: { per_page: ${SEARCH_PAGE}, sort: "id", direction: ASC }) {
    count
    scenes {
      ${SCENE_LIGHT_FIELDS}
    }
  }
}`;

// Find in Stash…: one search per press of Search, never as you type.
const SCENE_SEARCH = `query FunSyncSceneSearch($q: String!) {
  findScenes(filter: { q: $q, per_page: ${SEARCH_PAGE} }) {
    count
    scenes {
      id
      title
      code
      date
      updated_at
      studio {
        id
        name
      }
      files {
        path
        size
        duration
        oshash: fingerprint(type: "oshash")
      }
    }
  }
}`;

/**
 * The details document for `n` ids: aliases `s0`..`s<n-1>`, variables
 * `$id0`..`$id<n-1>`.
 * @param {number} n
 * @returns {string}
 */
function _detailsDocument(n) {
  const vars = [];
  const fields = [];
  for (let i = 0; i < n; i++) {
    vars.push(`$id${i}: ID!`);
    fields.push(`  s${i}: findScene(id: $id${i}) {\n    ...FunSyncSceneDetail\n  }`);
  }
  return `query FunSyncSceneDetails(${vars.join(', ')}) {\n${fields.join('\n')}\n}\n\n${SCENE_DETAIL_FRAGMENT}`;
}

// Built once; index n-1 holds the document for n ids.
const DETAILS_DOCUMENTS = Object.freeze(
  Array.from({ length: DETAILS_MAX }, (_, i) => _detailsDocument(i + 1)),
);

// name -> the document. FunSyncSceneDetails is the one with a size.
const QUERIES = Object.freeze({
  FunSyncTest: TEST,
  FunSyncSceneList: SCENE_LIST,
  FunSyncScenesByOshash: SCENES_BY_OSHASH,
  FunSyncSceneSearch: SCENE_SEARCH,
  FunSyncTagList: TAG_LIST,
  FunSyncSceneDetails: null,
});

const QUERY_NAMES = Object.freeze(Object.keys(QUERIES));

/**
 * The document for a name from the list, or null for anything else (a raw
 * document, an unknown name, a details size outside 1..DETAILS_MAX).
 * @param {unknown} name
 * @param {number} [n] how many ids, for FunSyncSceneDetails only
 * @returns {string|null}
 */
function queryDocument(name, n) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(QUERIES, name)) return null;
  if (name === 'FunSyncSceneDetails') {
    return Number.isInteger(n) && n >= 1 && n <= DETAILS_MAX ? DETAILS_DOCUMENTS[n - 1] : null;
  }
  return QUERIES[name];
}

/**
 * Every document the list can produce, for the read-only test.
 * @returns {Array<{name: string, n?: number, document: string}>}
 */
function allDocuments() {
  const out = [];
  for (const name of QUERY_NAMES) {
    if (name === 'FunSyncSceneDetails') {
      DETAILS_DOCUMENTS.forEach((document, i) => out.push({ name, n: i + 1, document }));
    } else {
      out.push({ name, document: QUERIES[name] });
    }
  }
  return out;
}

module.exports = {
  QUERY_NAMES,
  DETAILS_MAX,
  LIST_PAGE_MAX,
  SEARCH_PAGE,
  queryDocument,
  allDocuments,
};
