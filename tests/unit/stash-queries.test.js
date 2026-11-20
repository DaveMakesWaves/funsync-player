/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash S1 (DESIGN-stash-s1.md (d), (g)): FunSync is READ-ONLY towards the
// user's Stash by construction. electron/stash-client.js sends only the
// documents of electron/stash-queries.js, and every one of them is checked
// here, parsed: only `query` and `fragment` definitions, no `mutation`, no
// `subscription`, and none of the fields whose values are URLs Stash builds
// (with a key, `paths.funscript` carries `?apikey=<key>`).
//
// Each document was sent to the LOCAL test Stash (v0.32.0) and its answer
// recorded in tests/fixtures/stash/s1-*.response.json with the document's
// sha256. A changed document fails the pin below until its answer is
// recorded again, from the local test Stash only.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  QUERY_NAMES, DETAILS_MAX, LIST_PAGE_MAX, SEARCH_PAGE, queryDocument, allDocuments,
} = require('../../electron/stash-queries.js');

const FIXTURES = path.resolve('tests/fixtures/stash');

// A small GraphQL lexer: enough to find the top-level definitions and every
// name token, skipping strings and comments.
function tokens(doc) {
  const out = [];
  let i = 0;
  while (i < doc.length) {
    const c = doc[i];
    if (/[\s,﻿]/.test(c)) { i++; continue; }
    if (c === '#') { while (i < doc.length && doc[i] !== '\n') i++; continue; }
    if (c === '"') {
      if (doc.startsWith('"""', i)) {
        const end = doc.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        i = end + 3;
      } else {
        i++;
        while (i < doc.length && doc[i] !== '"') { if (doc[i] === '\\') i++; i++; }
        if (i >= doc.length) throw new Error('unterminated string');
        i++;
      }
      out.push({ t: 'string' });
      continue;
    }
    if (doc.startsWith('...', i)) { out.push({ t: 'punct', v: '...' }); i += 3; continue; }
    if ('{}()[]:!$=@|&'.includes(c)) { out.push({ t: 'punct', v: c }); i++; continue; }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(doc.slice(i));
    if (name) { out.push({ t: 'name', v: name[0] }); i += name[0].length; continue; }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(doc.slice(i));
    if (num) { out.push({ t: 'number' }); i += num[0].length; continue; }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return out;
}

/** The top-level definitions: [{kind, name}] (a bare `{` is a query). */
function definitions(doc) {
  const toks = tokens(doc);
  const defs = [];
  let braces = 0;
  let parens = 0;
  let expectDef = true;
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (expectDef && braces === 0 && parens === 0) {
      if (tk.v === '{') defs.push({ kind: 'query', name: null });
      else if (tk.t === 'name') defs.push({ kind: tk.v, name: toks[k + 1] && toks[k + 1].t === 'name' ? toks[k + 1].v : null });
      else throw new Error(`a definition cannot start with ${tk.v || tk.t}`);
      expectDef = false;
    }
    if (tk.v === '{') braces++;
    else if (tk.v === '}') { braces--; if (braces === 0) expectDef = true; }
    else if (tk.v === '(') parens++;
    else if (tk.v === ')') parens--;
    if (braces < 0 || parens < 0) throw new Error('unbalanced');
  }
  if (braces !== 0 || parens !== 0) throw new Error('unbalanced');
  return defs;
}

const names = (doc) => tokens(doc).filter((t) => t.t === 'name').map((t) => t.v);

// Fields whose values are URLs Stash builds (they can carry the key or a
// signature), or media FunSync never fetches in S1.
const NEVER_ASKED = [
  'paths', 'sceneStreams', 'screenshot', 'stream', 'funscript', 'caption', 'captions',
  'vtt', 'sprite', 'interactive_heatmap', 'image_path', 'preview', 'webp',
];

describe('stash-queries.js: read-only by construction', () => {
  const docs = allDocuments();

  it('lists the six named queries, the details one in every size 1..50', () => {
    // FunSyncTagList: the "next" lot (2026-11-19), Stash's tags with aliases and parents.
    expect([...QUERY_NAMES].sort()).toEqual([
      'FunSyncSceneDetails', 'FunSyncSceneList', 'FunSyncSceneSearch', 'FunSyncScenesByOshash', 'FunSyncTagList', 'FunSyncTest',
    ]);
    expect(DETAILS_MAX).toBe(50);
    expect(docs).toHaveLength(QUERY_NAMES.length - 1 + DETAILS_MAX);
  });

  it('every document is one named query (plus fragments): no mutation, no subscription', () => {
    for (const { name, document } of docs) {
      const defs = definitions(document);
      expect(defs.filter((d) => d.kind === 'query'), name).toHaveLength(1);
      for (const d of defs) expect(['query', 'fragment'], name).toContain(d.kind);
      expect(defs.find((d) => d.kind === 'query').name, name).toBe(name);
      expect(names(document), name).not.toContain('mutation');
      expect(names(document), name).not.toContain('subscription');
    }
  });

  it('the lexer used here does see a mutation (the check above can fail)', () => {
    expect(definitions('mutation X { sceneDestroy(input: {id: "1"}) }')[0].kind).toBe('mutation');
    expect(definitions('query A { a } subscription B { b }').map((d) => d.kind)).toEqual(['query', 'subscription']);
  });

  it('every fragment a document spreads is defined in it', () => {
    for (const { name, document } of docs) {
      const toks = tokens(document);
      const spread = toks.flatMap((t, k) => (t.v === '...' && toks[k + 1].t === 'name' && toks[k + 1].v !== 'on' ? [toks[k + 1].v] : []));
      const defined = definitions(document).filter((d) => d.kind === 'fragment').map((d) => d.name);
      for (const f of spread) expect(defined, `${name} spreads ${f}`).toContain(f);
    }
  });

  it('no document asks for a URL Stash builds (paths, sceneStreams) or for media', () => {
    for (const { name, document } of docs) {
      const used = new Set(names(document));
      for (const field of NEVER_ASKED) expect(used.has(field), `${name} asks for ${field}`).toBe(false);
      expect(document.toLowerCase(), name).not.toContain('apikey');
    }
  });

  it('the details document for n ids has aliases s0..s(n-1) over $id0..$id(n-1)', () => {
    for (const n of [1, 2, 10, DETAILS_MAX]) {
      const doc = queryDocument('FunSyncSceneDetails', n);
      const aliases = [...doc.matchAll(/\bs(\d+): findScene\(id: \$id(\d+)\)/g)];
      expect(aliases).toHaveLength(n);
      aliases.forEach((m, i) => { expect(m[1]).toBe(String(i)); expect(m[2]).toBe(String(i)); });
      expect([...doc.matchAll(/\$id\d+: ID!/g)]).toHaveLength(n);
    }
  });

  it('the list and search sizes are the design\'s (1,000 per page, 20 results)', () => {
    expect(LIST_PAGE_MAX).toBe(1000);
    expect(SEARCH_PAGE).toBe(20);
    expect(queryDocument('FunSyncSceneSearch')).toContain('per_page: 20');
    expect(queryDocument('FunSyncScenesByOshash')).toContain('modifier: EQUALS');
  });
});

describe('queryDocument refuses anything that is not in the list', () => {
  it.each([
    ['a raw mutation', 'mutation { sceneDestroy(input: {id: "1"}) }'],
    ['a raw query', 'query { version { version } }'],
    ['an unknown name', 'FunSyncSceneUpdate'],
    ['a prototype key', '__proto__'],
    ['a prototype key', 'constructor'],
    ['a prototype key', 'hasOwnProperty'],
    ['not a string', { name: 'FunSyncTest' }],
    ['not a string', null],
  ])('%s: %s', (_label, name) => {
    expect(queryDocument(name)).toBeNull();
  });

  it.each([0, -1, 1.5, DETAILS_MAX + 1, undefined, '2'])('details with %s ids', (n) => {
    expect(queryDocument('FunSyncSceneDetails', n)).toBeNull();
  });
});

describe('every document matches the answer recorded from the local test Stash', () => {
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  // s1-*: S1's recordings; sn-*: the "next" lot's (2026-11-19), which pin the
  // documents it changed (the S1 answers to those keep their old sha256 as
  // s1DocumentSha256 and are no longer pinned).
  const recorded = fs.readdirSync(FIXTURES)
    .filter((f) => /^s[1n]-.*\.response\.json$/.test(f))
    .map((f) => ({ file: f, fx: JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')) }))
    .filter(({ fx }) => fx.documentSha256);

  it('there is a recorded answer for every named query', () => {
    const covered = new Set(recorded.map(({ fx }) => fx.operationName));
    for (const name of QUERY_NAMES) expect(covered.has(name), name).toBe(true);
  });

  it.each(recorded.map(({ file, fx }) => [file, fx]))('%s was recorded with today\'s document', (_file, fx) => {
    const doc = queryDocument(fx.operationName, fx.n);
    expect(doc).toBeTruthy();
    expect(sha(doc)).toBe(fx.documentSha256);
  });

  it('the recorded answers hold no apikey= and no URL Stash built', () => {
    for (const { file } of recorded) {
      const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
      expect(text, file).not.toMatch(/apikey=/i);
      expect(text, file).not.toMatch(/\/scene\/\d+\/(stream|screenshot|funscript)/);
    }
  });
});
