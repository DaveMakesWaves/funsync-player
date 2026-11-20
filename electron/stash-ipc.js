'use strict';

// Stash S1 Round 2 (2026-11-18): the main-process service behind every
// `stash-*` IPC channel (notes/features/DESIGN-stash-s1.md (a)-(e); Dave's
// answers). electron/main.js builds ONE of these and registers every channel
// in STASH_IPC_CHANNELS through it; nothing else in main.js answers a
// `stash-*` channel (tests/unit/secret-settings-parity.test.js checks both).
//
// It wires Round 1's modules together: the client and key (stash-client.js,
// stash-tls.js, stash-secret.js), the matcher, mapper and fingerprinter
// (stash-match.js, stash-map.js, stash-fingerprint.js) and the data file and
// sync job (stash-library-file.js, stash-sync.js).
//
// The rules it keeps:
//   - NO KEY EVER LEAVES. No reply, event or log line carries the API key;
//     the key goes from stash-secret.js straight into the client, in main.
//     A saved key is used only for the address it was saved with: key.json
//     records that address (s1-fixup-main, S1RB-1), and every use compares
//     it (Test, Link, every sync, the start-up sync, search, a Find pick).
//     settings.stash.url changed any other way (a snapshot restore, the
//     boot-time recovery, applySettingWrite, an import) never takes the key
//     along: the key is not sent, and the replies say whose it is
//     (`key.elsewhere`, `keyElsewhere`).
//   - NEVER ON ITS OWN. Loading reads two local files and sends nothing. The
//     only requests are the ones the user starts (Test, Link, Sync now, Sync
//     this video, Find in Stash…, a Find pick), plus ONE full sync per
//     session from `stash-sync-on-start`, and only when "Sync with Stash when
//     FunSync starts" is on (stash-sync.js shouldSyncOnStart).
//   - ONE HOST. Every client is built for the address in settings.stash.url
//     (or the one being tested), never one taken from the Stash data.
//   - MAIN OWNS THE ADDRESS AND THE TRUST. settings.stash.url and
//     settings.stash.trustedCert are written here only; a renderer
//     `set-setting` of the Stash block goes through applySettingWrite.
//     "Trust this certificate" pins only a certificate this session saw at
//     that exact origin; changing the address drops the pin.
//   - UNDO. Every change to a video's Stash data hands back an opaque undo
//     id; Remove Stash data keeps the set-aside files and the key until its
//     Undo window has passed (discardRemoved only then).
//   - TAG RULES ARE OPT-IN (the "next" lot, 2026-11-19, Dave): the data's
//     `tagRules` (Stash's tag aliases and sub-tags) are handed to the
//     renderer only while Stash is on AND settings.stash.useTagRules is
//     true. Switching either so that this changes moves the data's `rev`
//     on (library.touch()), so the renderer reads the data again.

const path = require('path');
const crypto = require('crypto');

const {
  createStashClient, normalizeStashAddress, keyTravelsInClear, stashErrorReply, stashSceneUrl, isValidApiKey,
  StashError, STASH_ERROR,
} = require('./stash-client');
const { createStashSync, shouldSyncOnStart } = require('./stash-sync');
const { matchLibrary } = require('./stash-match');
const { mapScene, stashId, isWellFormedText } = require('./stash-map');
const {
  createFingerprinter, nodeFileIo, parseFingerprintCache, serializeFingerprintCache,
} = require('./stash-fingerprint');
const { parseProjectedId, serverKey } = require('./stash-keys');
const { normalizeFingerprint } = require('./stash-tls');

const STASH_IPC_CHANNELS = Object.freeze([
  'stash-status',
  'stash-get-data',
  'stash-test',
  'stash-link',
  'stash-set-options',
  'stash-save-key',
  'stash-remove-key',
  'stash-trust-certificate',
  'stash-forget-certificate',
  'stash-sync',
  'stash-sync-on-start',
  'stash-sync-video',
  'stash-cancel',
  'stash-search',
  'stash-link-scene',
  'stash-choose',
  'stash-refuse',
  'stash-unlink',
  'stash-undo',
  'stash-rehome',
  'stash-remove-data',
  'stash-open-scene',
]);

/** Events main sends to the main window. */
const STASH_EVENTS = Object.freeze({
  CHANGED: 'stash-changed',                   // {rev}: the Stash data was written; reload it
  PROGRESS: 'stash-progress',                 // {kind, step, done, total} | {kind, step: 'finished', result}
  SETTINGS_CHANGED: 'stash-settings-changed', // the settings.stash block main just wrote
});

const UNDO_MS = 8000;
// The Undo button lives 8 s; its click may still be on its way.
const REMOVE_GRACE_MS = 2000;
const PROGRESS_MS = 150;
const MAX_UNDO = 100;
const MAX_RULES = 50;
const MAX_PATH = 32768;
const MAX_VIDEOS = 500000;
const MAX_MOVES = 100000;
const FINGERPRINTS_FILE = 'fingerprints.json';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const validPath = (p) => (typeof p === 'string' && p.trim() !== '' && p.length <= MAX_PATH ? p : null);

/** Text from Stash for a reply: well formed, at most `max`, no URL Stash built. */
function text(v, max = 200) {
  if (typeof v !== 'string' || !isWellFormedText(v) || /apikey=/i.test(v)) return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

function baseName(p) {
  return typeof p === 'string' ? (p.split(/[\\/]/).pop() || null) : null;
}

/** settings.stash.pathRules as stored: [{local, stash}], both non-empty strings. */
function cleanRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => isPlainObject(r) && typeof r.local === 'string' && typeof r.stash === 'string'
      && r.local.trim() && r.stash.trim() && r.local.length <= MAX_PATH && r.stash.length <= MAX_PATH)
    .slice(0, MAX_RULES)
    .map((r) => ({ local: r.local, stash: r.stash }));
}

/** settings.stash.trustedCert as stored, or null. */
function cleanPin(pin) {
  if (!isPlainObject(pin) || typeof pin.origin !== 'string') return null;
  let origin;
  try { origin = new URL(pin.origin).origin; } catch { return null; }
  const sha256 = normalizeFingerprint(pin.sha256);
  if (origin !== pin.origin || !origin.startsWith('https:') || !sha256) return null;
  return {
    origin,
    sha256,
    subject: typeof pin.subject === 'string' ? pin.subject.slice(0, 500) : null,
    at: num(pin.at),
  };
}

const originOf = (address) => {
  try { return new URL(address).origin; } catch { return null; }
};

/** An optional scene id from the page (a projected id): null when absent, false when not one. */
function sceneIdInput(v) {
  if (v === undefined || v === null) return null;
  const id = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
  if (typeof id !== 'string' || id.length > 600) return false;
  const parsed = parseProjectedId(id);
  return parsed && /^\d{1,12}$/.test(parsed.id) ? id : false;
}

/**
 * @param {object} deps
 * @param {string} deps.userDataDir app.getPath('userData')
 * @param {{getSetting: Function, setSetting: Function}} deps.store electron/store.js
 * @param {object} deps.secret a stash-secret.js instance
 * @param {object} deps.library a stash-library-file.js instance (userData/stash)
 * @param {(channel: string, payload: unknown) => void} [deps.send] to the main window
 * @param {(url: string) => Promise<void>} [deps.openExternal] shell.openExternal
 * @param {object} [deps.clientOptions] extra createStashClient options (tests: fetch, timeouts, log)
 * @param {object} [deps.fileIo] stash-fingerprint.js nodeFileIo()
 * @param {object} [deps.fsImpl] fs.promises (the fingerprint cache file)
 * @param {{info?: Function, warn?: Function}|null} [deps.log]
 * @param {() => number} [deps.now]
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers]
 * @param {number} [deps.undoMs] Remove Stash data's Undo window
 * @param {number} [deps.removeGraceMs]
 */
function createStashService(deps = {}) {
  const {
    userDataDir, store, secret, library,
    send = () => {}, openExternal = async () => {}, clientOptions = {},
    fileIo = nodeFileIo(), fsImpl = require('fs').promises, log = null,
    now = Date.now, timers = { setTimeout, clearTimeout },
    undoMs = UNDO_MS, removeGraceMs = REMOVE_GRACE_MS,
  } = deps;
  if (typeof userDataDir !== 'string' || !userDataDir || !store || !secret || !library) {
    throw new TypeError('createStashService: userDataDir, store, secret and library are required');
  }
  const stashDir = path.join(userDataDir, 'stash');
  const fpFile = path.join(stashDir, FINGERPRINTS_FILE);
  const note = (level, msg) => { try { if (log && typeof log[level] === 'function') log[level](`[Stash] ${msg}`); } catch { /* no log */ } };
  const emit = (channel, payload) => { try { send(channel, payload); } catch { /* window gone */ } };

  let ready = null;
  let current = null;           // the running sync: {job, kind, progress, done}
  let startSyncDone = false;    // stash-sync-on-start ran this session
  let fper = null;              // the fingerprinter (its cache persists in fingerprints.json)
  let offline = new Set();      // videos the renderer says are on an offline drive (this sync)
  let lastCertificate = null;   // the last refused certificate's facts (for a sync's reply)
  const seenCerts = new Map();  // origin -> fingerprint256 refused this session (what Trust may pin)
  const versions = new Map();   // address -> Stash version from the last good Test
  const undos = new Map();      // undo id -> {kind: 'video', undo} | {kind: 'remove', undo, key, timer}

  // --- settings.stash ---

  function settings() {
    const raw = store.getSetting('stash');
    const s = isPlainObject(raw) ? raw : {};
    return {
      enabled: s.enabled === true,
      url: typeof s.url === 'string' ? s.url : '',
      syncOnStart: s.syncOnStart === true,
      pathRules: cleanRules(s.pathRules),
      trustedCert: cleanPin(s.trustedCert),
      useTagRules: s.useTagRules === true,
    };
  }

  /** Does the renderer get the tag rules now? Stash on and the opt-in ticked. */
  function tagRulesOn(s = settings()) {
    return s.enabled === true && s.useTagRules === true;
  }

  /** After a settings write: when the tag rules came or went, the renderer reads the data again. */
  function afterTagRulesSwitch(before) {
    if (tagRulesOn() === before) return Promise.resolve();
    return Promise.resolve()
      .then(() => library.touch())
      .catch((err) => note('warn', `Could not announce the tag rules change: ${err?.message || err}`));
  }

  function settingsChanged() {
    const s = settings();
    emit(STASH_EVENTS.SETTINGS_CHANGED, s);
    return s;
  }

  /** The address, written by main only: a new origin drops the trusted certificate. */
  function writeUrl(address) {
    const pin = settings().trustedCert;
    store.setSetting('stash.url', address);
    if (pin && pin.origin !== originOf(address)) store.setSetting('stash.trustedCert', null);
  }

  /** The pin for this address, when it is the pin's origin. */
  function tlsPinFor(address) {
    const pin = settings().trustedCert;
    return pin && pin.origin === originOf(address) ? { origin: pin.origin, sha256: pin.sha256 } : null;
  }

  /**
   * The saved key, but only for the address it was saved with (key.json
   * records it; settings.stash.url is NOT asked: it can change under the
   * key through a restore, a recovery or a renderer write).
   */
  function savedKeyFor(address) {
    const key = secret.getKey();
    if (!key || !address) return '';
    return secret.address() === address ? key : '';
  }

  /** The address a saved key belongs to when it is not `address` (so it is not sent), else null. */
  function keyElsewhereFor(address) {
    const k = secret.status();
    if (!k.hasKey) return null;
    const owner = typeof k.address === 'string' && k.address ? k.address : null;
    return owner === address && owner ? null : (owner || '');
  }

  /** `reply` with `keyElsewhere` when a saved key was withheld from `address`. */
  function withKeyNote(reply, address) {
    const elsewhere = address ? keyElsewhereFor(address) : null;
    if (elsewhere === null || !isPlainObject(reply)) return reply;
    note('info', 'The saved API key belongs to another Stash address; it was not sent');
    return { ...reply, keyElsewhere: elsewhere };
  }

  /** secret.status() plus whose the key is: `elsewhere` = saved for another address than settings.stash.url. */
  function keyStatus() {
    const k = secret.status();
    const url = normalizeStashAddress(settings().url);
    const owner = k.hasKey && typeof k.address === 'string' && k.address ? k.address : null;
    return { ...k, address: owner, elsewhere: k.hasKey === true && (!owner || owner !== url) };
  }

  function keyReply() {
    const s = settings();
    const k = keyStatus();
    return { ...k, keyTravelsInClear: keyTravelsInClear(s.url, k.hasKey && !k.elsewhere) };
  }

  // --- clients ---

  function noteCertificate(err) {
    if (!(err instanceof StashError) || err.code !== STASH_ERROR.CERTIFICATE || !err.certificate) return;
    const c = err.certificate;
    if (c.origin && c.fingerprint256) {
      seenCerts.set(c.origin, { sha256: c.fingerprint256, subject: c.subject || null });
      lastCertificate = { ...c };
    }
  }

  /** A client for this address and key; a refused certificate is remembered for Trust. */
  function makeClient(address, apiKey) {
    const client = createStashClient({ ...clientOptions, address, apiKey, tlsPin: tlsPinFor(address) });
    const wrap = (name) => async (...args) => {
      try {
        return await client[name](...args);
      } catch (err) {
        noteCertificate(err);
        throw err;
      }
    };
    return {
      address: client.address,
      hasKey: client.hasKey,
      test: wrap('test'),
      listScenes: wrap('listScenes'),
      listTags: wrap('listTags'),
      sceneDetails: wrap('sceneDetails'),
      scenesByOshash: wrap('scenesByOshash'),
      searchScenes: wrap('searchScenes'),
    };
  }

  /** The linked address and a client for it, or a reply saying why not. */
  function linkedClient() {
    const s = settings();
    const address = normalizeStashAddress(s.url);
    if (!address || !s.enabled) return { error: { ok: false, code: 'notLinked' } };
    try {
      return { address, client: makeClient(address, savedKeyFor(address)) };
    } catch (err) {
      return { error: stashErrorReply(err) };
    }
  }

  // --- undo ---

  function addUndo(entry) {
    const id = crypto.randomBytes(12).toString('hex');
    undos.set(id, entry);
    while (undos.size > MAX_UNDO) {
      const [oldest, old] = undos.entries().next().value;
      if (old.kind === 'remove') break; // a pending removal ends by its own timer
      undos.delete(oldest);
    }
    return id;
  }

  function libraryReply(res) {
    if (!res || res.ok !== true) return { ok: false, code: (res && typeof res.error === 'string') ? res.error : 'failed' };
    const out = { ok: true, undoId: res.undo ? addUndo({ kind: 'video', undo: res.undo }) : null };
    // Not this scene… when the link changed under the confirm (RA-S1-3).
    if (res.linkChanged === true) {
      out.linkChanged = true;
      out.linkedSceneId = typeof res.linkedSceneId === 'string' ? res.linkedSceneId : null;
    }
    return out;
  }

  async function expireRemoval(id) {
    const entry = undos.get(id);
    if (!entry || entry.kind !== 'remove') return;
    undos.delete(id);
    if (entry.undoFailed) {
      // The user asked for this data back and it could not be put back:
      // the set-aside files are kept (never deleted after a failed Undo).
      note('warn', 'Undo of Remove Stash data failed; the removed data is kept aside in the stash folder');
      return;
    }
    try { await library.discardRemoved(entry.undo); } catch (err) { note('warn', `Could not delete the removed Stash data: ${err?.message || err}`); }
  }

  // --- the fingerprint cache (derived; never in a backup) ---

  async function fingerprinter() {
    if (!fper) {
      let textIn = null;
      try { textIn = await fsImpl.readFile(fpFile, 'utf8'); } catch { textIn = null; }
      fper = createFingerprinter({
        io: fileIo,
        cache: parseFingerprintCache(textIn),
        isOffline: (p) => offline.has(p),
      });
    }
    return fper;
  }

  async function saveFingerprints(prunePaths) {
    if (!fper) return;
    if (prunePaths) fper.prune(prunePaths);
    const tmp = `${fpFile}.tmp`;
    await fsImpl.mkdir(stashDir, { recursive: true });
    await fsImpl.writeFile(tmp, serializeFingerprintCache(fper.getCache()), 'utf8');
    await fsImpl.rename(tmp, fpFile);
  }

  // --- sync ---

  function cleanVideos(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const v of list.slice(0, MAX_VIDEOS)) {
      const p = isPlainObject(v) ? validPath(v.path) : null;
      if (!p) continue;
      out.push({ path: p, size: num(v.size), mtimeMs: num(v.mtimeMs), offline: v.offline === true });
    }
    return out;
  }

  function syncReply(kind, res) {
    const r = isPlainObject(res) ? res : {};
    const code = isPlainObject(r.error) && typeof r.error.code === 'string' ? r.error.code : null;
    const error = code ? { code } : null;
    if (code === STASH_ERROR.CERTIFICATE && lastCertificate) error.certificate = { ...lastCertificate };
    return {
      ok: r.ok === true,
      kind,
      written: r.written === true,
      partial: r.partial === true,
      cancelled: r.cancelled === true,
      complete: r.complete === true,
      skipped: r.skipped === true,
      error,
      counts: isPlainObject(r.counts) ? { ...r.counts } : null,
      relinked: Array.isArray(r.relinked) ? r.relinked.map((x) => ({
        path: x.path, from: x.from, to: x.to, undoId: x.undo ? addUndo({ kind: 'video', undo: x.undo }) : null,
      })) : [],
      details: isPlainObject(r.details) ? { done: num(r.details.done), total: num(r.details.total) } : null,
      // The next lot: whether Stash's tag list was read whole (null: not asked).
      tags: isPlainObject(r.tags) ? {
        ok: r.tags.ok === true,
        count: num(r.tags.count),
        error: isPlainObject(r.tags.error) && typeof r.tags.error.code === 'string' ? r.tags.error.code : null,
      } : null,
    };
  }

  async function runSync(kind, videos) {
    await ready;
    if (current) return syncReply(kind, { ok: false, error: { code: 'busy' } });
    const linked = linkedClient();
    if (linked.error) return syncReply(kind, { ok: false, error: { code: linked.error.code } });
    const { address, client } = linked;
    const keyNote = (reply) => withKeyNote(reply, address);
    const s = settings();
    const fp = await fingerprinter();
    offline = new Set(videos.filter((v) => v.offline).map((v) => v.path));
    lastCertificate = null;
    const job = createStashSync({
      library,
      client,
      fingerprint: fp.fingerprint,
      saveFingerprints: () => saveFingerprints(kind === 'full' ? videos.map((v) => v.path) : null),
      // The adapter 1b asked for: the address links record, and the clock.
      match: (input) => matchLibrary({ ...input, server: address, now: now() }),
      mapScene: (raw) => mapScene(raw, { now: now() }),
      now,
      log: log || { info() {}, warn() {} },
    });
    const run = { job, kind, progress: null, done: null };
    current = run;
    let lastSent = 0;
    let lastStep = null;
    const onProgress = (p) => {
      run.progress = { kind: p.kind, step: p.step, done: p.done, total: p.total };
      const t = now();
      if (p.step !== lastStep || p.done === p.total || t - lastSent >= PROGRESS_MS) {
        lastStep = p.step;
        lastSent = t;
        emit(STASH_EVENTS.PROGRESS, run.progress);
      }
    };
    const stored = library.status().server;
    const server = {
      url: address,
      version: versions.get(address) ?? (stored && stored.url === address ? stored.version : null),
    };
    run.done = (async () => {
      try {
        const res = kind === 'full'
          ? await job.run({ videos: videos.map(({ path: p, size, mtimeMs }) => ({ path: p, size, mtimeMs })), server, pathRules: s.pathRules, onProgress })
          : await job.runVideo({ video: { path: videos[0].path, size: videos[0].size, mtimeMs: videos[0].mtimeMs }, server, pathRules: s.pathRules, onProgress });
        return keyNote(syncReply(kind, res));
      } catch (err) {
        note('warn', `Sync failed: ${err?.message || err}`);
        return keyNote(syncReply(kind, { ok: false, error: { code: 'failed' } }));
      } finally {
        if (current === run) current = null;
      }
    })();
    const reply = await run.done;
    emit(STASH_EVENTS.PROGRESS, { kind, step: 'finished', result: reply });
    return reply;
  }

  async function cancelAndWait() {
    const run = current;
    if (!run) return;
    run.job.cancel();
    try { await run.done; } catch { /* reported by the sync itself */ }
  }

  // --- connect: Test and Link ---

  /** `{address, apiKey}` from a Test or Link, or `{error}`. */
  function connectInput(input) {
    const o = isPlainObject(input) ? input : {};
    const address = normalizeStashAddress(o.address);
    if (!address) return { error: { ok: false, code: STASH_ERROR.BAD_ADDRESS } };
    let apiKey;
    let typed = false;
    if (o.apiKey === undefined || o.apiKey === null) {
      apiKey = savedKeyFor(address);
    } else if (typeof o.apiKey === 'string') {
      apiKey = o.apiKey.trim();
      typed = apiKey !== '';
      if (typed && !isValidApiKey(apiKey)) return { error: { ok: false, code: 'invalidKey', address } };
    } else {
      return { error: { ok: false, code: 'invalidKey', address } };
    }
    return { address, apiKey, typed };
  }

  async function doTest(address, apiKey) {
    let client;
    try {
      client = makeClient(address, apiKey);
    } catch (err) {
      return { ...stashErrorReply(err), address };
    }
    try {
      const r = await client.test();
      versions.set(address, r.version);
      return { ok: true, address, version: r.version, sceneCount: r.sceneCount, keyTravelsInClear: keyTravelsInClear(address, !!apiKey) };
    } catch (err) {
      return { ...stashErrorReply(err), address };
    }
  }

  // --- the handlers (each returns plain JSON and never throws) ---

  const api = {
    async 'stash-status'() {
      await ready;
      const run = current;
      return {
        ok: true,
        settings: settings(),
        key: keyStatus(),
        keyTravelsInClear: keyReply().keyTravelsInClear,
        library: library.status(),
        sync: { running: !!run, kind: run ? run.kind : null, progress: run && run.progress ? { ...run.progress } : null },
      };
    },

    async 'stash-get-data'() {
      await ready;
      return library.projection({ tagRules: tagRulesOn() });
    },

    async 'stash-test'(input) {
      const c = connectInput(input);
      if (c.error) return c.error;
      const res = await doTest(c.address, c.apiKey);
      return c.typed ? res : withKeyNote(res, c.address);
    },

    async 'stash-link'(input) {
      const c = connectInput(input);
      if (c.error) return c.error;
      const tested = await doTest(c.address, c.apiKey);
      if (!tested.ok) return c.typed ? tested : withKeyNote(tested, c.address);
      let keySave = null;
      if (c.typed) {
        keySave = secret.save(c.apiKey, { address: c.address });
      } else if (secret.status().hasKey && secret.address() !== c.address) {
        // The saved key belongs to another address; this one works without it.
        secret.remove();
      }
      const rulesBefore = tagRulesOn();
      writeUrl(c.address);
      store.setSetting('stash.enabled', true);
      const s = settingsChanged();
      await afterTagRulesSwitch(rulesBefore);
      note('info', `Linked (Stash ${tested.version || 'version unknown'})`);
      return {
        ok: true,
        settings: s,
        key: keyReply(),
        keySaved: keySave ? keySave.ok === true : null,
        version: tested.version,
        sceneCount: tested.sceneCount,
        keyTravelsInClear: keyReply().keyTravelsInClear,
      };
    },

    async 'stash-set-options'(input) {
      const o = isPlainObject(input) ? input : {};
      if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return { ok: false, code: 'badInput' };
      if (o.syncOnStart !== undefined && typeof o.syncOnStart !== 'boolean') return { ok: false, code: 'badInput' };
      if (o.pathRules !== undefined && (!Array.isArray(o.pathRules) || o.pathRules.length > MAX_RULES)) return { ok: false, code: 'badInput' };
      if (o.useTagRules !== undefined && typeof o.useTagRules !== 'boolean') return { ok: false, code: 'badInput' };
      const rulesBefore = tagRulesOn();
      if (o.enabled !== undefined) store.setSetting('stash.enabled', o.enabled);
      if (o.syncOnStart !== undefined) store.setSetting('stash.syncOnStart', o.syncOnStart);
      if (o.pathRules !== undefined) store.setSetting('stash.pathRules', cleanRules(o.pathRules));
      if (o.useTagRules !== undefined) store.setSetting('stash.useTagRules', o.useTagRules);
      const out = { ok: true, settings: settingsChanged() };
      await afterTagRulesSwitch(rulesBefore);
      return out;
    },

    async 'stash-save-key'(apiKey) {
      // Saved for the address Stash is linked to now (sent there only).
      const res = secret.save(apiKey, { address: normalizeStashAddress(settings().url) });
      const k = keyReply();
      return { ...res, address: k.address, elsewhere: k.elsewhere, keyTravelsInClear: k.keyTravelsInClear };
    },

    async 'stash-remove-key'() {
      const res = secret.remove();
      const k = keyReply();
      return { ...res, address: k.address, elsewhere: k.elsewhere, keyTravelsInClear: k.keyTravelsInClear };
    },

    async 'stash-trust-certificate'(input) {
      const o = isPlainObject(input) ? input : {};
      const address = normalizeStashAddress(o.address);
      const origin = address ? originOf(address) : null;
      if (!origin || !origin.startsWith('https:')) return { ok: false, code: STASH_ERROR.BAD_ADDRESS };
      const sha256 = normalizeFingerprint(o.fingerprint256);
      const seen = seenCerts.get(origin);
      // Only the certificate this session was shown at this exact origin.
      if (!sha256 || !seen || seen.sha256 !== sha256) return { ok: false, code: 'notSeen' };
      store.setSetting('stash.trustedCert', { origin, sha256, subject: seen.subject, at: now() });
      note('info', 'Trusted one https certificate for the Stash address');
      return { ok: true, settings: settingsChanged() };
    },

    async 'stash-forget-certificate'() {
      store.setSetting('stash.trustedCert', null);
      return { ok: true, settings: settingsChanged() };
    },

    async 'stash-sync'(input) {
      const videos = cleanVideos(isPlainObject(input) ? input.videos : null);
      if (!videos) return syncReply('full', { ok: false, error: { code: 'badInput' } });
      return runSync('full', videos);
    },

    async 'stash-sync-on-start'(input) {
      if (startSyncDone) return { ok: true, started: false, reason: 'done' };
      if (!shouldSyncOnStart(store.getSetting('stash'))) return { ok: true, started: false, reason: 'off' };
      const videos = cleanVideos(isPlainObject(input) ? input.videos : null);
      if (!videos) return { ok: false, started: false, code: 'badInput' };
      startSyncDone = true;
      return { ...(await runSync('full', videos)), started: true };
    },

    async 'stash-sync-video'(input) {
      const videos = cleanVideos(isPlainObject(input) ? [input] : null);
      if (!videos || videos.length !== 1) return syncReply('video', { ok: false, error: { code: 'badInput' } });
      return runSync('video', videos);
    },

    async 'stash-cancel'() {
      const run = current;
      return { ok: true, cancelled: run ? run.job.cancel() : false };
    },

    async 'stash-search'(input) {
      const q = isPlainObject(input) ? input.q : input;
      if (typeof q !== 'string' || !q.trim() || q.length > 200) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      const linked = linkedClient();
      if (linked.error) return linked.error;
      try {
        const found = await linked.client.searchScenes(q);
        const scenes = (Array.isArray(found.scenes) ? found.scenes : []).slice(0, 20).map((s) => ({
          id: stashId(s && s.id),
          title: text(s.title, 500),
          code: text(s.code),
          date: text(s.date, 40),
          studio: isPlainObject(s.studio) && stashId(s.studio.id) ? { id: stashId(s.studio.id), name: text(s.studio.name) } : null,
          files: (Array.isArray(s.files) ? s.files : []).filter(isPlainObject).slice(0, 10).map((f) => ({
            name: text(baseName(f.path), 1024), size: num(f.size), duration: num(f.duration),
          })),
        })).filter((s) => s.id);
        return withKeyNote({ ok: true, count: num(found.count) ?? scenes.length, scenes }, linked.address);
      } catch (err) {
        return withKeyNote(stashErrorReply(err), linked.address);
      }
    },

    async 'stash-link-scene'(input) {
      await ready;
      const o = isPlainObject(input) ? input : {};
      const p = validPath(o.path);
      const id = typeof o.sceneId === 'number' ? String(o.sceneId) : o.sceneId;
      if (!p || typeof id !== 'string' || !/^\d{1,12}$/.test(id)) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      const linked = linkedClient();
      if (linked.error) return linked.error;
      let raw;
      try {
        raw = (await linked.client.sceneDetails([id]))[id];
      } catch (err) {
        return withKeyNote(stashErrorReply(err), linked.address);
      }
      if (!raw) return { ok: false, code: 'notFound' };
      const mapped = mapScene(raw, { now: now() });
      if (!mapped) return { ok: false, code: STASH_ERROR.NOT_STASH };
      let fp = null;
      try { fp = await (await fingerprinter()).fingerprint({ path: p }); } catch { fp = null; }
      if (!fp) {
        try {
          const st = await fileIo.stat(p);
          fp = { size: num(st.size), mtimeMs: num(st.mtimeMs), oshash: null };
        } catch {
          return { ok: false, code: 'unreadable' };
        }
      }
      try { await saveFingerprints(null); } catch { /* derived; rebuilt next sync */ }
      return libraryReply(await library.link(p, { sceneId: id, fp, server: linked.address }, mapped));
    },

    async 'stash-choose'(input) {
      await ready;
      const o = isPlainObject(input) ? input : {};
      const p = validPath(o.path);
      if (!p || (typeof o.sceneId !== 'string' && typeof o.sceneId !== 'number')) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      return libraryReply(await library.choose(p, o.sceneId));
    },

    async 'stash-refuse'(input) {
      await ready;
      const o = isPlainObject(input) ? input : {};
      const p = validPath(o.path);
      if (!p || (o.target !== undefined && o.target !== 'link' && o.target !== 'check')) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      // The scene the confirm named (RA-S1-3): only that scene is refused; a
      // link that changed meanwhile is left as it is and reported.
      const sceneId = sceneIdInput(o.sceneId);
      if (sceneId === false || (sceneId !== null && o.target === 'check')) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      const opts = { target: o.target, sceneId };
      let res = await library.refuse(p, opts);
      if (res && res.ok !== true && res.error === 'no-fingerprint') {
        // A link stored without an oshash (Find in Stash… when hashing
        // failed): the refusal needs the file's content, so hash it now. A
        // file that cannot be read answers 'skipped' ("could not read this
        // video's file"), never "changed meanwhile".
        let fp = null;
        try { fp = await (await fingerprinter()).fingerprint({ path: p }); } catch { fp = null; }
        const oshash = isPlainObject(fp) && typeof fp.oshash === 'string' ? fp.oshash : null;
        if (!oshash) return { ok: false, code: 'skipped' };
        try { await saveFingerprints(null); } catch { /* derived; rebuilt next sync */ }
        res = await library.refuse(p, { ...opts, oshash });
        if (res && res.ok !== true && res.error === 'no-fingerprint') return { ok: false, code: 'skipped' };
      }
      return libraryReply(res);
    },

    async 'stash-unlink'(input) {
      await ready;
      const o = isPlainObject(input) ? input : {};
      const p = validPath(o.path);
      const sceneId = sceneIdInput(o.sceneId);
      if (!p || sceneId === false) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      return libraryReply(await library.unlink(p, { sceneId }));
    },

    async 'stash-undo'(undoId) {
      await ready;
      const entry = typeof undoId === 'string' ? undos.get(undoId) : null;
      if (!entry) return { ok: false, code: 'expired' };
      if (entry.kind === 'remove') {
        timers.clearTimeout(entry.timer);
        undos.delete(undoId);
        const res = await library.undoRemove(entry.undo);
        if (!res || res.ok !== true) {
          // The set-aside files stay; this Undo may be tried again until
          // its window ends, and they are never deleted after it failed.
          entry.undoFailed = true;
          undos.set(undoId, entry);
          entry.timer = timers.setTimeout(() => expireRemoval(undoId), undoMs + removeGraceMs);
          return { ok: false, code: (res && res.error) || 'failed' };
        }
        if (entry.key) secret.save(entry.key, { address: entry.keyAddress || null });
        return { ok: true, ...(res.merged === true ? { merged: true } : {}), key: keyReply() };
      }
      const res = await library.restore(entry.undo);
      if (!res || res.ok !== true) return { ok: false, code: (res && res.error) || 'failed' };
      undos.delete(undoId);
      return { ok: true };
    },

    async 'stash-rehome'(moves) {
      await ready;
      if (!Array.isArray(moves) || moves.length > MAX_MOVES) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      const list = moves.filter((m) => isPlainObject(m) && validPath(m.from) && validPath(m.to))
        .map((m) => ({ from: m.from, to: m.to, keepSource: m.keepSource === true }));
      const res = await library.rehome(list);
      if (!res || res.ok !== true) return { ok: false, code: (res && res.error) || 'failed' };
      return { ok: true, moved: res.moved || 0 };
    },

    async 'stash-remove-data'() {
      await ready;
      // A sync running now would write its results after the removal.
      await cancelAndWait();
      const res = await library.removeAll();
      if (!res || res.ok !== true) return { ok: false, code: (res && res.error) || 'failed' };
      const key = secret.getKey() || null;
      const keyAddress = key ? secret.address() : null;
      const keyRes = secret.remove();
      const entry = { kind: 'remove', undo: res.undo, key, keyAddress, timer: null };
      const id = addUndo(entry);
      // The set-aside files go only once the Undo window has passed.
      entry.timer = timers.setTimeout(() => expireRemoval(id), undoMs + removeGraceMs);
      note('info', 'Stash data removed (Undo for a few seconds)');
      const k = keyReply();
      return { ok: true, undoId: id, undoMs, key: { ...keyRes, address: k.address, elsewhere: k.elsewhere, keyTravelsInClear: k.keyTravelsInClear } };
    },

    async 'stash-open-scene'(input) {
      await ready;
      const o = isPlainObject(input) ? input : {};
      const p = validPath(o.path);
      const d = library.snapshot();
      const link = p && isPlainObject(d.links[p]) ? d.links[p] : null;
      const check = p && isPlainObject(d.check[p]) ? d.check[p] : null;
      const dataServer = isPlainObject(d.server) ? d.server.url : null;
      let server = null;
      let id = null;
      if (o.sceneId !== undefined && o.sceneId !== null) {
        const parsed = parseProjectedId(o.sceneId);
        if (!parsed) return { ok: false, code: STASH_ERROR.BAD_INPUT };
        id = parsed.id;
        if (parsed.server) {
          // Another server's scene: the server as its stored record names it.
          const rec = Object.values(d.scenes).find((s) => isPlainObject(s) && String(s.id) === id && serverKey(s.server) === parsed.server);
          server = rec ? rec.server : null;
        } else {
          server = (check && check.server) || (link && link.server) || dataServer || settings().url;
        }
      } else if (link) {
        id = String(link.sceneId);
        server = link.server || dataServer;
      }
      const url = server && id ? stashSceneUrl(server, id) : null;
      if (!url) return { ok: false, code: STASH_ERROR.BAD_INPUT };
      try {
        await openExternal(url);
      } catch {
        return { ok: false, code: 'failed' };
      }
      return { ok: true };
    },
  };

  const handlers = {};
  for (const channel of STASH_IPC_CHANNELS) {
    handlers[channel] = async (...args) => {
      try {
        return await api[channel](...args);
      } catch (err) {
        note('warn', `${channel} failed: ${err?.message || err}`);
        return { ok: false, code: 'failed' };
      }
    };
  }

  return {
    handlers,

    /** Read the Stash data and the key file. Sends nothing. */
    init() {
      if (!ready) {
        library.onChange(() => emit(STASH_EVENTS.CHANGED, { rev: library.status().rev }));
        ready = (async () => {
          try { await library.load(); } catch (err) { note('warn', `Could not load the Stash data: ${err?.message || err}`); }
          try { secret.load(); } catch { /* reported by status() */ }
          // A key file from before the address was stored belongs to the
          // address in use now (once; the file then records it).
          try {
            if (typeof secret.bindLegacy === 'function') secret.bindLegacy(normalizeStashAddress(settings().url));
          } catch { /* the key stays unbound: it is sent nowhere */ }
        })();
      }
      return ready;
    },

    /**
     * A renderer `set-setting` of 'stash' or 'stash.*'. Returns false for any
     * other path. The address is normalized (a new origin drops the trusted
     * certificate); the trusted certificate itself is never written from the
     * renderer; anything else of the block is checked and written.
     */
    ownsSetting(p) {
      return p === 'stash' || (typeof p === 'string' && p.startsWith('stash.'));
    },

    applySettingWrite(p, value) {
      const fields = p === 'stash' ? (isPlainObject(value) ? value : {}) : { [p.slice('stash.'.length)]: value };
      const rulesBefore = tagRulesOn();
      for (const [k, v] of Object.entries(fields)) {
        if ((k === 'enabled' || k === 'syncOnStart' || k === 'useTagRules') && typeof v === 'boolean') store.setSetting(`stash.${k}`, v);
        else if (k === 'pathRules' && Array.isArray(v)) store.setSetting('stash.pathRules', cleanRules(v));
        else if (k === 'url' && typeof v === 'string') {
          if (v.trim() === '') writeUrl('');
          else {
            const a = normalizeStashAddress(v);
            if (a) writeUrl(a);
          }
        }
        // trustedCert and anything else: main's own, or not a Stash setting.
      }
      const out = settingsChanged();
      afterTagRulesSwitch(rulesBefore);
      return out;
    },

    /** FunSync closing: stop a sync, finish a removal, wait for the last write. */
    async shutdown() {
      await cancelAndWait();
      for (const [id, entry] of [...undos]) {
        if (entry.kind === 'remove') {
          timers.clearTimeout(entry.timer);
          await expireRemoval(id);
        }
      }
      try { await library.idle(); } catch { /* nothing queued */ }
    },

    isSyncing: () => !!current,
  };
}

module.exports = {
  STASH_IPC_CHANNELS,
  STASH_EVENTS,
  UNDO_MS,
  REMOVE_GRACE_MS,
  createStashService,
  cleanPin,
  cleanRules,
};
