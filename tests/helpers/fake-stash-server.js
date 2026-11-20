// A fake Stash server for tests (Stash S1, DESIGN-stash-s1.md (g)).
//
// A real `node:http` server on 127.0.0.1, port 0, that answers POST
// `<prefix>/graphql` by GraphQL operation name (the names in
// electron/stash-queries.js) from the scenes recorded on the LOCAL test Stash
// (tests/fixtures/stash/s1-*.response.json, v0.32.0, synthetic library). It
// never forwards anything anywhere.
//
// Failure modes, as the real Stash (or what sits in front of it) gives them:
//   apiKey: null      a Stash with no password: any non-empty ApiKey header
//                     gets 401 FormBased, as v0.32.0 does (checked 2026-11-18)
//   apiKey: 'k'       a Stash with a password: no key or a wrong key, 401
//   mode 'slow'       answers after `delayMs`
//   mode 'forbidden'  403 (v0.32.0 refuses public addresses without credentials)
//   mode 'validation' 400 GRAPHQL_VALIDATION_FAILED (an older Stash, a newer field)
//   mode 'html'       200 text/html (another web app at that address)
//   mode 'notJson'    200 application/json that is not JSON
//   mode 'serverError' 500
//   mode 'redirect'   302 to `<redirectTo>/graphql` (point it at a second fake)
//   failListPage: n   that page of the light list answers 500 (a page failing
//                     mid-list)
//   deletedIds: [...] still in the light list, but their details answer null
//                     (deleted between the list and the details)
//   respond: {OpName: (variables, req) => ({status, headers, body})}
//                     a per-operation override; return undefined to fall through
//   tags: [...]       the tag list FunSyncTagList pages through (the "next"
//                     lot, 2026-11-19); default: the local test Stash's six
//                     tags (sn-tag-list.response.json); failTagPage: n
//                     makes that page of it answer 500
//
// Scenes from the "next" lot's recording (snFixtureScenes(): play count,
// last play, O-count, Groups, phash) show those fields in the light list as
// the next lot's document asks for them; S1's scenes (the default) have
// none, so the light list answers exactly as S1 recorded it.
// For "Stash not running" use closedPortAddress(): a port nothing listens on.
//   tls: {key, cert}  an https Stash (a NAS with a self-signed certificate,
//                     Round 2): testCertificate('a' | 'b') gives one of the two
//                     self-signed test certificates in tests/fixtures/stash/tls
//                     (test-only keys, never a real certificate)
//
// Every request is recorded in `requests` ({method, url, headers, body, json}),
// so a test can check where requests went and what they carried; `stats`
// keeps how many were open at once (`maxActive`) and how many connections
// were made (`connections`: over https, a refused certificate shows as a
// connection with no request).
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STASH_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'stash',
);

/** A fixture file from tests/fixtures/stash, parsed. */
export function loadStashFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(STASH_FIXTURE_DIR, name), 'utf8'));
}

/**
 * One of the two self-signed TEST certificates (127.0.0.1 and localhost,
 * valid until 2126): `{key, cert, fingerprint256, subject}`.
 * @param {'a'|'b'} name
 */
export function testCertificate(name) {
  const dir = path.join(STASH_FIXTURE_DIR, 'tls');
  const cert = fs.readFileSync(path.join(dir, `test-only-${name}.cert.pem`), 'utf8');
  const key = fs.readFileSync(path.join(dir, `test-only-${name}.key.pem`), 'utf8');
  const x = new crypto.X509Certificate(cert);
  return { key, cert, fingerprint256: x.fingerprint256, subject: x.subject };
}

/** The 9 synthetic scenes, as the details query returns them (fresh copies). */
export function fixtureScenes() {
  const data = loadStashFixture('s1-scene-details.response.json').body.data;
  return Object.values(data).filter(Boolean).map((s) => structuredClone(s));
}

/**
 * The 10 synthetic scenes of the "next" lot's recording (2026-11-19: ratings,
 * plays, O-counts, two Groups, phashes, scene 10 a re-encode of scene 2), as
 * the next lot's details document returns them (fresh copies).
 */
export function snFixtureScenes() {
  const data = loadStashFixture('sn-scene-details.response.json').body.data;
  return Object.values(data).filter(Boolean).map((s) => structuredClone(s));
}

/** The local test Stash's tags with aliases and parents (fresh copies). */
export function snFixtureTags() {
  return structuredClone(loadStashFixture('sn-tag-list.response.json').body.data.findTags.tags);
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A detail scene cut to the light list's shape (with the next lot's fields it has). */
export function lightScene(scene) {
  const out = {
    id: scene.id,
    updated_at: scene.updated_at,
  };
  for (const k of ['play_count', 'last_played_at', 'o_counter', 'groups']) {
    if (has(scene, k)) out[k] = structuredClone(scene[k]);
  }
  out.files = (scene.files || []).map((f) => ({
    path: f.path, size: f.size, oshash: f.oshash, ...(has(f, 'phash') ? { phash: f.phash } : {}),
  }));
  return out;
}

function searchScene(scene) {
  return {
    id: scene.id,
    title: scene.title,
    code: scene.code,
    date: scene.date,
    updated_at: scene.updated_at,
    studio: scene.studio ? { id: scene.studio.id, name: scene.studio.name } : null,
    files: (scene.files || []).map((f) => ({ path: f.path, size: f.size, duration: f.duration, oshash: f.oshash })),
  };
}

const GQL_TYPE = 'application/graphql-response+json';

const json = (body, status = 200) => ({ status, headers: { 'content-type': GQL_TYPE }, body: JSON.stringify(body) });

function validationFailure() {
  return { status: 400, headers: { 'content-type': GQL_TYPE }, body: JSON.stringify(loadStashFixture('s1-validation-400.response.json').body) };
}

function answer(state, op, variables) {
  const scenes = [...state.scenes].sort((a, b) => Number(a.id) - Number(b.id));
  switch (op) {
    case 'FunSyncTest':
      return json({ data: { version: { version: state.version }, findScenes: { count: scenes.length } } });
    case 'FunSyncSceneList': {
      const page = Number(variables.page) || 1;
      const perPage = Number(variables.perPage) || 1000;
      if (state.failListPage === page) {
        return { status: 500, headers: { 'content-type': 'text/plain' }, body: 'internal error' };
      }
      const slice = scenes.slice((page - 1) * perPage, page * perPage).map(lightScene);
      return json({ data: { findScenes: { count: scenes.length, scenes: slice } } });
    }
    case 'FunSyncSceneDetails': {
      const data = {};
      for (let i = 0; Object.prototype.hasOwnProperty.call(variables, `id${i}`); i++) {
        const id = String(variables[`id${i}`]);
        const scene = state.deletedIds.has(id) ? null : scenes.find((s) => String(s.id) === id) || null;
        data[`s${i}`] = scene ? structuredClone(scene) : null;
      }
      return json({ data });
    }
    case 'FunSyncScenesByOshash': {
      const hits = scenes.filter((s) => (s.files || []).some((f) => f.oshash === variables.oshash));
      return json({ data: { findScenes: { count: hits.length, scenes: hits.slice(0, 20).map(lightScene) } } });
    }
    case 'FunSyncSceneSearch': {
      const q = String(variables.q || '').toLowerCase();
      const hits = scenes.filter((s) => String(s.title || '').toLowerCase().includes(q));
      return json({ data: { findScenes: { count: hits.length, scenes: hits.slice(0, 20).map(searchScene) } } });
    }
    case 'FunSyncTagList': {
      const page = Number(variables.page) || 1;
      const perPage = Number(variables.perPage) || 1000;
      if (state.failTagPage === page) {
        return { status: 500, headers: { 'content-type': 'text/plain' }, body: 'internal error' };
      }
      const tags = [...state.tags].sort((a, b) => Number(a.id) - Number(b.id));
      const slice = tags.slice((page - 1) * perPage, page * perPage).map((t) => structuredClone(t));
      return json({ data: { findTags: { count: tags.length, tags: slice } } });
    }
    default:
      // A Stash does not know a query it was never written for.
      return validationFailure();
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * @param {object} [options] see the header
 * @returns {Promise<{address: string, port: number, requests: object[],
 *   state: object, set: (patch: object) => void, reset: () => void,
 *   close: () => Promise<void>}>}
 */
export async function startFakeStash(options = {}) {
  const state = {
    mode: 'ok',
    apiKey: null,
    delayMs: 0,
    redirectTo: null,
    failListPage: null,
    version: 'v0.32.0',
    prefix: '',
    respond: {},
    ...options,
  };
  state.scenes = options.scenes ? options.scenes.map((s) => structuredClone(s)) : fixtureScenes();
  state.tags = options.tags ? options.tags.map((t) => structuredClone(t)) : snFixtureTags();
  state.deletedIds = new Set((options.deletedIds || []).map(String));
  const requests = [];
  const timers = new Set();
  // How many requests were open at once (one request at a time, (d)).
  const stats = { active: 0, maxActive: 0, connections: 0 };

  const handler = async (req, res) => {
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    res.on('close', () => { stats.active -= 1; });
    const body = await readBody(req);
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body, json: parsed });
    const send = ({ status, headers = {}, body: out = '' }) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, headers);
      res.end(out);
    };
    const reply = () => {
      if (state.mode === 'redirect') {
        return send({ status: 302, headers: { location: `${state.redirectTo}/graphql` } });
      }
      // The web UI answers every other path with its HTML page (v0.32.0).
      if (req.url !== `${state.prefix}/graphql` || req.method !== 'POST') {
        return send({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>Stash</title>' });
      }
      const sentKey = typeof req.headers.apikey === 'string' ? req.headers.apikey : '';
      if (state.apiKey ? sentKey !== state.apiKey : sentKey !== '') {
        return send({ status: 401, headers: { 'www-authenticate': 'FormBased' } });
      }
      switch (state.mode) {
        case 'forbidden': return send({ status: 403, headers: { 'content-type': 'text/plain' }, body: 'forbidden' });
        case 'validation': return send(validationFailure());
        case 'html': return send({ status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><body>Not Stash</body></html>' });
        case 'notJson': return send({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"data": ' });
        case 'serverError': return send({ status: 500, headers: { 'content-type': 'text/plain' }, body: 'internal error' });
        default: break;
      }
      const op = parsed && typeof parsed.operationName === 'string' ? parsed.operationName : '';
      const variables = parsed && parsed.variables && typeof parsed.variables === 'object' ? parsed.variables : {};
      const custom = state.respond && typeof state.respond[op] === 'function' ? state.respond[op](variables, req) : undefined;
      return send(custom || answer(state, op, variables));
    };
    if (state.mode === 'slow' && state.delayMs > 0) {
      const t = setTimeout(() => { timers.delete(t); reply(); }, state.delayMs);
      timers.add(t);
    } else {
      reply();
    }
  };
  const server = options.tls
    ? https.createServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : http.createServer(handler);
  server.on('connection', () => { stats.connections += 1; });
  // A client that refuses the certificate closes the connection mid-handshake.
  server.on('tlsClientError', () => {});

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    address: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}${state.prefix}`,
    port,
    requests,
    state,
    stats,
    set(patch) {
      Object.assign(state, patch);
      if (patch.deletedIds) state.deletedIds = new Set(patch.deletedIds.map(String));
    },
    reset() { requests.length = 0; stats.maxActive = stats.active; },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    },
  };
}

/** An address on 127.0.0.1 where nothing listens: "Stash is not running". */
export async function closedPortAddress() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
