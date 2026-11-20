// A sandboxed Stash S1 main process for tests (Round 2, 2026-11-18): the
// REAL electron/stash-ipc.js service with the REAL data file, key file,
// client, matcher, mapper, fingerprinter and sync job, in a temp userData
// folder, talking to tests/helpers/fake-stash-server.js only.
//
//   makeVideos(dir, n)       n small video files with distinct content, and
//                            their {path, size, mtimeMs, oshash}
//   scenesFor(videos)        the recorded synthetic scenes (fixtures), one per
//                            video, each with that video's oshash
//   memoryStore(initial)     a store with electron/store.js's getSetting /
//                            setSetting shape and its stash defaults
//   createSandboxService(o)  the service, its events, the store and the dir
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fixtureScenes } from './fake-stash-server.js';

const require_ = createRequire(import.meta.url);
const { oshashOfBytes } = require_('../../electron/stash-fingerprint.js');
const { createStashService } = require_('../../electron/stash-ipc.js');
const { createStashSecret } = require_('../../electron/stash-secret.js');
const { createStashLibraryFile } = require_('../../electron/stash-library-file.js');

export const quietLog = { info() {}, warn() {}, error() {} };

/** `n` video files under `dir` with distinct bytes. */
export function makeVideos(dir, n, { folder = 'library' } = {}) {
  const lib = path.join(dir, folder);
  fs.mkdirSync(lib, { recursive: true });
  const out = [];
  for (let i = 1; i <= n; i++) {
    const p = path.join(lib, `Clip ${i}.mp4`);
    const bytes = crypto.createHash('sha256').update(`clip-${folder}-${i}`).digest();
    const data = Buffer.concat(Array.from({ length: 64 }, () => bytes)); // 2 KiB
    fs.writeFileSync(p, data);
    const st = fs.statSync(p);
    out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, oshash: oshashOfBytes(data) });
  }
  return out;
}

/** One recorded synthetic scene per video, with that video's oshash (and a Stash path elsewhere). */
export function scenesFor(videos) {
  const base = fixtureScenes();
  return videos.map((v, i) => {
    const s = structuredClone(base[i % base.length]);
    s.id = String(i + 1);
    s.files = [{ ...s.files[0], path: `/data/stash/clip-${i + 1}.mp4`, size: v.size, oshash: v.oshash }];
    return s;
  });
}

/** The stash part of electron/store.js, in memory. */
export function memoryStore(initial = {}) {
  const settings = {
    stash: { enabled: false, url: '', syncOnStart: false, pathRules: [], trustedCert: null, useTagRules: false, ...(initial.stash || {}) },
  };
  return {
    settings,
    getSetting(p) {
      return p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), settings);
    },
    setSetting(p, value) {
      const keys = p.split('.');
      let cur = settings;
      for (const k of keys.slice(0, -1)) cur = (cur[k] ||= {});
      cur[keys.at(-1)] = value;
    },
  };
}

/**
 * @param {object} [o]
 * @param {string} [o.dir] the userData folder (default: a new temp folder)
 * @param {object} [o.store] default memoryStore(o.settings)
 * @param {object} [o.settings] initial settings ({stash: {...}})
 * @param {object} [o.secret] a stash-secret.js instance (default: portable, plain)
 * @param {object} [o.clientOptions] extra createStashClient options
 * @param {object} [o.timers], [o.undoMs], [o.removeGraceMs], [o.now]
 */
export function createSandboxService(o = {}) {
  const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-stash-svc-'));
  const store = o.store || memoryStore(o.settings);
  const secret = o.secret || createStashSecret({ userDataDir: dir, portable: true, log: null, registerSecretLiterals: () => {} });
  const library = createStashLibraryFile({ dir: path.join(dir, 'stash'), log: quietLog });
  const events = [];
  const opened = [];
  const service = createStashService({
    userDataDir: dir,
    store,
    secret,
    library,
    send: (channel, payload) => events.push({ channel, payload: structuredClone(payload) }),
    openExternal: async (url) => { opened.push(url); },
    clientOptions: { log: null, timeouts: { test: 4000, sync: 4000 }, ...(o.clientOptions || {}) },
    log: quietLog,
    ...(o.timers ? { timers: o.timers } : {}),
    ...(o.undoMs !== undefined ? { undoMs: o.undoMs } : {}),
    ...(o.removeGraceMs !== undefined ? { removeGraceMs: o.removeGraceMs } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  const call = (channel, ...args) => service.handlers[channel](...args);
  return { dir, store, secret, library, service, events, opened, call };
}
