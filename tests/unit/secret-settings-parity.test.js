/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// R3-08 (from the block A review of FT-008 + FT-010): the credential settings
// were listed twice, SECRET_SETTINGS in electron/data-export.js (a merge
// import keeps a credential set here) and SECRET_SETTINGS /
// SECRET_SETTING_PATHS in electron/log-redact.js (every secret masked on
// every log line), and nothing kept them in step: a new key setting added to
// one would leak through the other.
//
// Both now read ONE list, electron/secret-settings.js. This checks every
// entry of it END TO END through both REAL modules: its value is masked in a
// log line, and a merge import with an older or empty backup keeps the value
// set here. An entry with no sample below fails, so a new credential cannot
// be added without being checked both ways.
//
// createRequire, not ESM imports: log-redact keeps the registered literals in
// module state, and an ESM import can be a second copy (log-secret-pipeline).
//
// Stash S1 adds SECRET_FILES: credentials kept in a file of their own, never
// in config.json. Each is checked at the bottom, with its REAL owner module,
// the REAL logger, the REAL store (real electron-conf) and the REAL export.
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeSafeStorage, loadSafeKeyWith } from './helpers/fake-safe-storage.js';
import { startFakeStash } from '../helpers/fake-stash-server.js';
import { createSandboxService, makeVideos, scenesFor } from '../helpers/stash-sandbox.js';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron-conf', async () => {
  const { loadRealConf } = await import('./helpers/real-electron-conf.js');
  return { default: loadRealConf(() => h.userData) };
});

const store = await import('../../electron/store.js');

const require = createRequire(import.meta.url);
const { SECRET_SETTINGS, SECRET_SETTING_PATHS, SECRET_FILES } = require('../../electron/secret-settings.js');
const logRedact = require('../../electron/log-redact.js');
const { mergeConfig, exportData } = require('../../electron/data-export.js');
const { createStashSecret } = require('../../electron/stash-secret.js');

// What a real value looks like at each path, an older backup copy, an empty
// backup, and the secret strings inside the value set here.
const SAMPLES = {
  'handy.connectionKey': { here: 'HANDYKEY0001', backup: 'OLDHANDYKEY9', empty: '', secrets: ['HANDYKEY0001'] },
  'autoblow.token': { here: 'ABTOKEN00001', backup: 'OLDABTOKEN99', empty: '', secrets: ['ABTOKEN00001'] },
  'eroscripts.session': {
    here: { cookie: 'COOKIEHERE01', username: 'me' },
    backup: { cookie: 'COOKIEOLD999', username: 'old' },
    empty: null,
    secrets: ['COOKIEHERE01'],
  },
  'audience.viewers': {
    here: [{ key: 'VIEWERKEY001', name: 'Ann' }],
    backup: [{ key: 'VIEWERKEY002', name: 'Bob' }],
    empty: [],
    secrets: ['VIEWERKEY001'],
  },
};

const setAt = (obj, dotted, value) => {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) cur = (cur[k] ||= {});
  cur[keys.at(-1)] = value;
  return obj;
};
const getAt = (obj, dotted) => dotted.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);

beforeEach(() => logRedact.clearSecretLiterals());

describe('one list of credential settings (R3-08)', () => {
  it('every entry has a sample here, and there is no sample for an entry that does not exist', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...SECRET_SETTING_PATHS].sort());
  });

  it('log-redact.js masks exactly the shared list', () => {
    expect([...logRedact.SECRET_SETTING_PATHS].sort()).toEqual([...SECRET_SETTING_PATHS].sort());
  });

  it('every entry says how a merge import treats it', () => {
    for (const [p, def] of Object.entries(SECRET_SETTINGS)) {
      expect(['keep-local', 'union-by-key'], p).toContain(def.import);
      if (def.import === 'keep-local') expect(typeof def.present, p).toBe('function');
      // _mergeAudienceViewers is the one union-by-key merge there is.
      if (def.import === 'union-by-key') expect(p).toBe('audience.viewers');
    }
  });

  describe.each(Object.keys(SAMPLES))('%s', (p) => {
    const s = SAMPLES[p];

    it('is masked in a log line once the setting is written', () => {
      expect(logRedact.secretLiteralsFromSetting(p, s.here)).toEqual(expect.arrayContaining(s.secrets));
      logRedact.noteSecretSetting(p, s.here);
      for (const secret of s.secrets) {
        const line = logRedact.redactSecrets(`[info] saved setting value ${secret} ok`);
        expect(line).not.toContain(secret);
      }
    });

    it('a merge import with an older backup copy keeps the value set here', () => {
      const merged = mergeConfig(
        { settings: setAt({}, p, structuredClone(s.here)) },
        { settings: setAt({}, p, structuredClone(s.backup)) },
        'merge',
      );
      const text = JSON.stringify(getAt(merged.settings, p));
      for (const secret of s.secrets) expect(text).toContain(secret);
    });

    it('a merge import with an empty backup value does not wipe it', () => {
      const merged = mergeConfig(
        { settings: setAt({}, p, structuredClone(s.here)) },
        { settings: setAt({}, p, structuredClone(s.empty)) },
        'merge',
      );
      const text = JSON.stringify(getAt(merged.settings, p));
      for (const secret of s.secrets) expect(text).toContain(secret);
    });
  });
});

// --- Secret FILES (Stash S1, DESIGN-stash-s1.md (d)) -------------------------
// Each SECRET_FILES entry, through its REAL owner module, in every way it is
// written: once saved (and once loaded by a fresh start) its value is masked
// in a real main.log line, and it is absent from getAll(), config.json, a
// .funsync-backup export (which never takes the file) and every status reply
// the owner gives (what its IPC handlers return). An entry with no sample
// here fails, so a new secret file cannot be added unchecked.
//
// Round 2 (s1-2a-main): every `stash-*` IPC reply and event, through the
// REAL service main.js registers them with (electron/stash-ipc.js), is
// checked for the sample key at the bottom of this file.

const fakeSafeStorage = createFakeSafeStorage();
const safeKey = loadSafeKeyWith(fakeSafeStorage);

const FILE_SAMPLES = {
  'stash.apiKey': {
    // A sample in a Stash API key's shape (a JWT). Not a real key.
    secret: 'eyJhbGciOiJIUzI1NiJ9.UEFSSVRZU1RBU0hLRVkwMDAx.cGFyaXR5c2lnbmF0dXJl',
    owners: {
      'installed build, encrypted': (userData) => createStashSecret({
        userDataDir: userData, portable: false, platform: 'win32', safeStorage: fakeSafeStorage, safeKey, log: null,
      }),
      // Dave, 2026-11-18: a portable build keeps it in plain text.
      'portable build, plain text': (userData) => createStashSecret({ userDataDir: userData, portable: true, log: null }),
    },
    save: (owner, value) => owner.save(value),
    load: (owner) => owner.load(),
    replies: (owner, value) => [owner.status(), owner.save(value), owner.status(), owner.remove(), owner.save(value)],
  },
};

describe('one list of secret files (Stash S1)', () => {
  let log;
  let logFile;
  let logDir;
  let restoreLog;

  beforeAll(() => {
    log = require('../../electron/logger.js');
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-secretfile-log-'));
    logFile = path.join(logDir, 'main.log');
    const prevResolve = log.transports.file.resolvePathFn;
    const prevConsole = log.transports.console.level;
    log.transports.file.resolvePathFn = () => logFile;
    log.transports.console.level = false;
    restoreLog = () => {
      log.transports.file.resolvePathFn = prevResolve;
      log.transports.console.level = prevConsole;
    };
  });

  afterAll(() => {
    restoreLog();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('every entry has a sample here, and there is no sample for an entry that does not exist', () => {
    expect(Object.keys(FILE_SAMPLES).sort()).toEqual(Object.keys(SECRET_FILES).sort());
  });

  it('every entry names its own file under userData, never config.json, and how to find its secrets', () => {
    for (const [name, def] of Object.entries(SECRET_FILES)) {
      expect(def.file, name).toMatch(/^[a-z0-9-]+(\/[a-z0-9.-]+)+$/i);
      expect(def.file.split('/'), name).not.toContain('..');
      expect(def.file, name).not.toMatch(/(^|\/)config\.json$/);
      expect(typeof def.literals, name).toBe('function');
      expect(SECRET_SETTING_PATHS, name).not.toContain(name);
    }
  });

  describe.each(Object.keys(FILE_SAMPLES))('%s', (name) => {
    const s = FILE_SAMPLES[name];
    const def = SECRET_FILES[name];

    describe.each(Object.keys(s.owners))('%s', (ownerLabel) => {
      const make = s.owners[ownerLabel];
      let userData;

      beforeEach(async () => {
        userData = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-secretfile-'));
        h.userData = userData;
        await store.initStore();
        fs.writeFileSync(logFile, '');
      });

      afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

      it('is saved in the file SECRET_FILES names', () => {
        expect(s.save(make(userData), s.secret)).toMatchObject({ ok: true, hasKey: true });
        expect(fs.existsSync(path.join(userData, ...def.file.split('/')))).toBe(true);
        expect(def.literals(s.secret)).toEqual([s.secret]);
      });

      it('is masked in a real log line once saved, and once loaded by a fresh start', () => {
        s.save(make(userData), s.secret);
        log.error('[Stash] request failed:', new Error(`while sending ${s.secret} to the server`));
        logRedact.clearSecretLiterals();
        s.load(make(userData));
        log.info(`[Stash] after a restart: ${s.secret}`);
        const written = fs.readFileSync(logFile, 'utf8');
        expect(written).toContain('[Stash] request failed:');
        expect(written).toContain('[Stash] after a restart:');
        expect(written).not.toContain(s.secret);
      });

      it('is absent from getAll() and config.json', () => {
        store.setSetting('stash.url', 'http://127.0.0.1:9999');
        s.save(make(userData), s.secret);
        store.setSetting('stash.enabled', true);
        expect(JSON.stringify(store.getAll())).not.toContain(s.secret);
        const configFile = path.join(userData, 'config.json');
        expect(fs.existsSync(configFile)).toBe(true);
        expect(fs.readFileSync(configFile, 'utf8')).toContain('127.0.0.1:9999');
        expect(fs.readFileSync(configFile, 'utf8')).not.toContain(s.secret);
      });

      it('is absent from a .funsync-backup export, which never takes its file', async () => {
        s.save(make(userData), s.secret);
        const zipPath = path.join(userData, 'out.funsync-backup');
        const result = await exportData(store.getAll(), zipPath, {
          customThumbsDir: path.join(userData, 'custom-thumbs'),
          stashDir: path.join(userData, 'stash'),
        });
        expect(result.success).toBe(true);
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
        const entries = Object.keys(zip.files);
        expect(entries).toContain('config.json');
        expect(entries).not.toContain(def.file);
        for (const entry of entries) {
          if (zip.files[entry].dir) continue;
          expect(await zip.files[entry].async('string'), entry).not.toContain(s.secret);
        }
      });

      it('is absent from every status reply (what its IPC handlers return)', () => {
        for (const reply of s.replies(make(userData), s.secret)) {
          expect(JSON.stringify(reply)).not.toContain(s.secret);
        }
      });
    });
  });
});

// --- Every stash-* IPC reply (Stash S1 Round 2, s1-2a-main) -----------------
// main.js answers every `stash-*` channel through electron/stash-ipc.js and
// nowhere else; the preload exposes exactly those channels. Each channel is
// then called for real (the REAL service, data file, key file, client and
// sync, against the local fake Stash that requires the sample key), in each
// way the key can be kept, and no reply and no event the page receives
// carries the key. A new channel without a step below fails the coverage
// check, so it cannot be added unchecked.
const { STASH_IPC_CHANNELS } = require('../../electron/stash-ipc.js');

describe('every stash-* IPC reply carries no key (Round 2)', () => {
  const SECRET = FILE_SAMPLES['stash.apiKey'].secret;
  const mainSrc = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.resolve('electron/preload.js'), 'utf8');

  it('main.js registers every stash-* channel through the service, and no other stash-* handler', () => {
    expect(mainSrc).toMatch(/for \(const channel of STASH_IPC_CHANNELS\) \{\s*ipcMain\.handle\(channel, \(_event, \.\.\.args\) => stash\.handlers\[channel\]\(\.\.\.args\)\);/);
    expect(mainSrc).not.toMatch(/ipcMain\.(handle|on|once)\(\s*['"`]stash-/);
    const preloadChannels = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('(stash-[a-z-]+)'/g)].map((m) => m[1]);
    expect([...new Set(preloadChannels)].sort()).toEqual([...STASH_IPC_CHANNELS].sort());
  });

  const OWNERS = {
    'installed build, encrypted': (dir) => createStashSecret({
      userDataDir: dir, portable: false, platform: 'win32', safeStorage: fakeSafeStorage, safeKey, log: null,
    }),
    'portable build, plain text': (dir) => createStashSecret({ userDataDir: dir, portable: true, log: null }),
    'installed build without encryption, plain text': (dir) => createStashSecret({
      userDataDir: dir, portable: false, platform: 'linux', safeStorage: null, log: null,
    }),
  };

  describe.each(Object.keys(OWNERS))('%s', (label) => {
    let stash;
    let other;
    let sb;
    beforeEach(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-stash-parity-'));
      sb = createSandboxService({ dir, secret: OWNERS[label](dir) });
      sb.videos = makeVideos(dir, 3);
      stash = await startFakeStash({ scenes: scenesFor(sb.videos), apiKey: SECRET });
      other = await startFakeStash();
      await sb.service.init();
    });
    afterEach(async () => {
      await sb.service.shutdown();
      await stash.close();
      await other.close();
      fs.rmSync(sb.dir, { recursive: true, force: true });
    });

    it('no reply and no event carries the key, across every channel', async () => {
      const v = sb.videos.map((x) => x.path);
      const videos = sb.videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs }));
      const replies = [];
      const called = new Set();
      const call = async (channel, ...args) => {
        called.add(channel);
        const reply = await sb.call(channel, ...args);
        replies.push([channel, reply]);
        return reply;
      };
      await call('stash-status');
      await call('stash-test', { address: stash.address, apiKey: SECRET });
      expect((await call('stash-link', { address: stash.address, apiKey: SECRET })).ok).toBe(true);
      await call('stash-save-key', SECRET);
      await call('stash-status'); // with the key saved
      await call('stash-test', { address: stash.address });
      await call('stash-test', { address: other.address, apiKey: SECRET }); // a Stash with no password: badKey
      await call('stash-set-options', { syncOnStart: true, pathRules: [{ local: 'C:\\lib', stash: '/data' }] });
      await call('stash-sync-on-start', { videos });
      await call('stash-sync', { videos });
      await call('stash-sync-video', videos[1]);
      await call('stash-get-data');
      await call('stash-search', { q: 'synthetic' });
      await call('stash-link-scene', { path: v[0], sceneId: '2' });
      await call('stash-choose', { path: v[1], sceneId: '1' });
      const refused = await call('stash-refuse', { path: v[1], target: 'link' });
      await call('stash-undo', refused.undoId);
      await call('stash-unlink', { path: v[2] });
      await call('stash-rehome', [{ from: v[0], to: path.join(sb.dir, 'moved.mp4') }]);
      await call('stash-open-scene', { path: v[1] });
      await call('stash-cancel');
      await call('stash-trust-certificate', { address: 'https://127.0.0.1:1', fingerprint256: 'AB' });
      await call('stash-forget-certificate');
      const removed = await call('stash-remove-data');
      await call('stash-undo', removed.undoId);
      await call('stash-remove-key');
      await call('stash-status');

      expect([...called].sort()).toEqual([...STASH_IPC_CHANNELS].sort());
      // The calls really used the key (the fake Stash refuses anything else).
      expect(stash.requests.some((r) => r.headers.apikey === SECRET)).toBe(true);
      for (const [channel, reply] of replies) {
        expect(JSON.stringify(reply), channel).not.toContain(SECRET);
      }
      for (const e of sb.events) expect(JSON.stringify(e.payload), e.channel).not.toContain(SECRET);
      // Nor is it anywhere in what main keeps beside the key file.
      for (const name of fs.readdirSync(path.join(sb.dir, 'stash'))) {
        if (name === 'key.json') continue;
        expect(fs.readFileSync(path.join(sb.dir, 'stash', name), 'utf8'), name).not.toContain(SECRET);
      }
    });
  });
});
