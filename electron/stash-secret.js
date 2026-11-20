// Stash S1: the API key of the user's own Stash server. Electron main only.
//
// Where the key lives (DESIGN-stash-s1.md (c), (d); Dave's answer 2,
// 2026-11-18, overrides the design's "memory only" for portable builds, and
// his answer after Round 1 does the same for installed builds without
// encryption):
//   installed build, encryption real   userData/stash/key.json,
//       {v: 1, storage: 'safeStorage', value: <base64>}, encrypted through
//       safe-key.js (its first user). Real means safeStorage says it is
//       available and, on Linux, its backend is not `basic_text`; and the
//       value really came back encrypted (safe-key.js returns the plain text
//       when encryption fails, so that is checked here, never trusted).
//   portable build                     the portable data folder's
//       stash/key.json, {v: 1, storage: 'plain', value: <key>}, in PLAIN
//       TEXT, as the Handy key and the EroScripts login are kept there.
//       Settings says so next to the key field (`saveStorage: 'plain'`,
//       `plainReason: 'portable'`).
//   installed build, encryption not real (Linux `basic_text`, no keyring,
//       or encryption that fails when tried): the same PLAIN TEXT file, with
//       the same note (`plainReason: 'noEncryption'`). Dave, 2026-11-18:
//       "Plain text, like portable". A key is never written in plain text
//       under the `safeStorage` label, and never in plain text while
//       encryption works.
//   memory only                        only when writing the file failed.
// The file path comes from secret-settings.js SECRET_FILES['stash.apiKey'].
//
// The key NEVER goes into config.json, getAll(), a config snapshot, a
// .funsync-backup, the renderer, the phone or a VR payload. status() is the
// only thing that leaves main: {hasKey, keyStorage, saveStorage, unreadable}.
// (status() also says `plainReason`.) getKey() is for building the Stash
// client, in main. Every key loaded or saved is registered with
// log-redact.js, so it is masked on every log line, even inside an error
// message.
//
// Absence is never destructive: a missing, damaged or undecryptable file is
// reported (`unreadable`) and left exactly where it is, until the user saves
// a new key or removes it.
//
// The key belongs to ONE address (s1-fixup-main, 2026-11-19, S1RB-1): the
// record also holds `address`, the normalized Stash address it was saved
// for, and electron/stash-ipc.js sends the key to that address only. A
// settings.stash.url changed any other way (a config snapshot restore, the
// boot-time recovery, a renderer write, an import) never takes the key along.
// A record from before the address was stored (no `address` field) is bound
// once, by the service at start-up, to the address in use then (bindLegacy).

const path = require('path');
const { SECRET_FILES } = require('./secret-settings');
const { isValidApiKey } = require('./stash-client');

const KEY_STORAGE = Object.freeze({
  SAFE_STORAGE: 'safeStorage',
  PLAIN: 'plain',
  MEMORY: 'memory',
});

// The file holds a few hundred bytes; anything this big is not ours.
const MAX_KEY_FILE_BYTES = 64 * 1024;

const KEY_FILE = SECRET_FILES['stash.apiKey'].file;

function _lazy(name) {
  try { return require(name); } catch { return null; }
}

/**
 * @param {object} options
 * @param {string} options.userDataDir app.getPath('userData') (the portable
 *   data folder in a portable build)
 * @param {boolean} [options.portable] default: FUNSYNC_PORTABLE=1 (main.js)
 * @param {string} [options.platform] default: process.platform
 * @param {object} [options.safeStorage] default: electron's
 * @param {{encryptKey: Function, decryptKey: Function}} [options.safeKey]
 *   default: ./safe-key
 * @param {typeof import('fs')} [options.fs]
 * @param {(values: string[]) => void} [options.registerSecretLiterals]
 *   default: ./log-redact's
 * @param {{info?: Function, warn?: Function}|null} [options.log]
 */
function createStashSecret(options = {}) {
  if (typeof options.userDataDir !== 'string' || !options.userDataDir) {
    throw new TypeError('createStashSecret: userDataDir is required');
  }
  const fs = options.fs || require('fs');
  const portable = options.portable === undefined ? process.env.FUNSYNC_PORTABLE === '1' : !!options.portable;
  const platform = options.platform || process.platform;
  const filePath = path.join(options.userDataDir, ...KEY_FILE.split('/'));

  let _safeStorage = options.safeStorage;
  const safeStorage = () => {
    if (_safeStorage === undefined) {
      const electron = _lazy('electron');
      _safeStorage = electron && typeof electron === 'object' ? electron.safeStorage || null : null;
    }
    return _safeStorage;
  };
  let _safeKey = options.safeKey;
  const safeKey = () => {
    if (_safeKey === undefined) _safeKey = _lazy('./safe-key');
    return _safeKey;
  };
  const register = (values) => {
    try {
      const fn = options.registerSecretLiterals || (_lazy('./log-redact') || {}).registerSecretLiterals;
      if (typeof fn === 'function') fn(values);
    } catch { /* masking must never break saving */ }
  };
  const log = options.log === undefined ? _lazy('./logger') : options.log;
  const _note = (level, msg) => {
    try { if (log && typeof log[level] === 'function') log[level](`[Stash] ${msg}`); } catch { /* no log */ }
  };

  let _loaded = false;
  let _key = '';
  let _keyStorage = null;
  let _unreadable = false;
  let _address = null;        // the address the key belongs to (null: none recorded)
  let _legacy = false;        // the file's record has no `address` field (bindLegacy binds it)
  let _record = null;         // the record as read or written (bindLegacy rewrites it)

  /** Is encryption real here, now? */
  function _encryptionReal() {
    const ss = safeStorage();
    try {
      if (!ss || typeof ss.isEncryptionAvailable !== 'function' || !ss.isEncryptionAvailable()) return false;
      if (platform === 'linux') {
        if (typeof ss.getSelectedStorageBackend !== 'function') return false;
        const backend = ss.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Where a key saved now would be kept: encrypted when encryption is real
   * here, else in plain text (portable builds, and installed builds without
   * encryption: Dave, 2026-11-18).
   */
  function saveStorage() {
    if (portable) return KEY_STORAGE.PLAIN;
    return _encryptionReal() ? KEY_STORAGE.SAFE_STORAGE : KEY_STORAGE.PLAIN;
  }

  // Set when a save found encryption claiming to work but failing.
  let _encryptionFailed = false;

  /**
   * Why a key is (or would be) kept in plain text, for the note next to the
   * key field: 'portable', 'noEncryption', or null when it is not.
   */
  function plainReason() {
    if (portable) return 'portable';
    const plainNow = saveStorage() === KEY_STORAGE.PLAIN || (_key && _keyStorage === KEY_STORAGE.PLAIN);
    return plainNow || _encryptionFailed ? 'noEncryption' : null;
  }

  /** The only reply about the key that may leave main. Never the key. */
  function status() {
    load();
    return {
      hasKey: !!_key,
      keyStorage: _key ? _keyStorage : null,
      saveStorage: _encryptionFailed && !portable ? KEY_STORAGE.PLAIN : saveStorage(),
      plainReason: plainReason(),
      unreadable: _unreadable,
      // Not a secret: the address the key belongs to (stash-ipc.js compares it).
      address: _key ? _address : null,
    };
  }

  function _readRecord() {
    let st;
    try {
      st = fs.statSync(filePath);
    } catch (err) {
      return err && err.code === 'ENOENT' ? { absent: true } : { unreadable: true };
    }
    if (!st.isFile() || st.size > MAX_KEY_FILE_BYTES) return { unreadable: true };
    try {
      const rec = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!rec || typeof rec !== 'object' || rec.v !== 1 || typeof rec.value !== 'string' || !rec.value) {
        return { unreadable: true };
      }
      return { rec };
    } catch {
      return { unreadable: true };
    }
  }

  /**
   * Read the key file once. A key saved earlier in this session wins.
   * @returns {void}
   */
  function load() {
    if (_loaded) return;
    _loaded = true;
    const { rec, unreadable } = _readRecord();
    if (!rec) {
      _unreadable = !!unreadable;
      if (unreadable) _note('warn', 'The saved API key file could not be read; it is left as it is.');
      return;
    }
    let key = null;
    if (rec.storage === KEY_STORAGE.PLAIN) {
      key = rec.value;
    } else if (rec.storage === KEY_STORAGE.SAFE_STORAGE) {
      const sk = safeKey();
      try {
        const plain = sk ? sk.decryptKey(rec.value) : null;
        // safe-key.js hands back the stored text when it cannot decrypt
        // (another PC or account, a portable build): that is not the key.
        key = typeof plain === 'string' && plain && plain !== rec.value ? plain : null;
      } catch {
        key = null;
      }
    }
    if (!key || !isValidApiKey(key)) {
      _unreadable = true;
      _note('warn', "The saved API key can't be read on this computer; the file is left as it is.");
      return;
    }
    register([key]);
    _key = key;
    _keyStorage = rec.storage;
    _address = typeof rec.address === 'string' && rec.address ? rec.address : null;
    _legacy = !Object.prototype.hasOwnProperty.call(rec, 'address');
    _record = rec;
  }

  /** The key, for the Stash client in main. '' when there is none. */
  function getKey() {
    load();
    return _key;
  }

  /** The address the saved key belongs to, or null (no key, or none recorded). */
  function address() {
    load();
    return _key ? _address : null;
  }

  function _writeAtomic(text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      throw err;
    }
  }

  /**
   * A key saved before the address was stored belongs to `addr` (the
   * address in use when the service first loads it). Only a record with no
   * `address` field is bound, once; the file is rewritten with the address
   * (the stored value is kept as it is). Returns true when it bound one.
   */
  function bindLegacy(addr) {
    load();
    if (!_key || !_legacy) return false;
    _legacy = false;
    _address = typeof addr === 'string' && addr ? addr : null;
    if (_record) {
      try {
        _writeAtomic(`${JSON.stringify({ ..._record, address: _address })}\n`);
      } catch (err) {
        _note('warn', `The API key file could not be updated (${err && err.code ? err.code : 'error'}); its address is kept until FunSync closes.`);
      }
    }
    return true;
  }

  function _encryptedRecord(key) {
    const sk = safeKey();
    if (!sk) return null;
    let value = null;
    let back = null;
    try {
      value = sk.encryptKey(key);
      back = typeof value === 'string' && value ? sk.decryptKey(value) : null;
    } catch {
      return null;
    }
    // safe-key.js falls back to the plain text when encryption fails: only
    // a value that is not the key, does not contain it, and decrypts back
    // to it is written.
    if (typeof value !== 'string' || !value || value === key || value.includes(key) || back !== key) return null;
    return { v: 1, storage: KEY_STORAGE.SAFE_STORAGE, value };
  }

  /**
   * Save a key the user typed (Test or Link). Replaces any saved key.
   * @param {unknown} input
   * @param {{address?: string|null}} [opts] the normalized address the key
   *   belongs to; it is sent to that address only (none: to no address)
   * @returns {{ok: boolean, code?: string, hasKey: boolean, keyStorage: string|null,
   *   saveStorage: string, unreadable: boolean, address: string|null}}
   */
  function save(input, opts = {}) {
    load();
    const owner = opts && typeof opts.address === 'string' && opts.address ? opts.address : null;
    const key = typeof input === 'string' ? input.trim() : '';
    if (!key || !isValidApiKey(key)) return { ok: false, code: 'invalidKey', ...status() };
    register([key]);
    const mode = saveStorage();
    let record = null;
    if (mode === KEY_STORAGE.SAFE_STORAGE) {
      record = _encryptedRecord(key);
      if (!record) {
        // Encryption said it works and did not: the key is kept as it is
        // where there is no encryption (Dave: "Plain text, like portable"),
        // labelled plain, so Settings shows the note. Never plain text
        // under the safeStorage label.
        _encryptionFailed = true;
        _note('warn', 'Encryption did not work; the API key is saved unencrypted, as on a PC without encryption.');
      }
    }
    if (!record) record = { v: 1, storage: KEY_STORAGE.PLAIN, value: key };
    record.address = owner;
    try {
      _writeAtomic(`${JSON.stringify(record)}\n`);
    } catch (err) {
      _key = key;
      _keyStorage = KEY_STORAGE.MEMORY;
      _address = owner;
      _legacy = false;
      _record = null;
      _note('warn', `The API key could not be saved (${err && err.code ? err.code : 'error'}); it is kept until FunSync closes.`);
      return { ok: false, code: 'writeFailed', ...status() };
    }
    _key = key;
    _keyStorage = record.storage;
    _address = owner;
    _legacy = false;
    _record = record;
    _unreadable = false;
    _note('info', `API key saved (${_keyStorage}).`);
    return { ok: true, ...status() };
  }

  /**
   * Remove the saved key (Remove, or Remove Stash data…): the file and the
   * copy in memory.
   */
  function remove() {
    load();
    _key = '';
    _keyStorage = null;
    _address = null;
    _legacy = false;
    _record = null;
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        _note('warn', `The API key file could not be removed (${err && err.code ? err.code : 'error'}).`);
        return { ok: false, code: 'removeFailed', ...status() };
      }
    }
    _unreadable = false;
    _note('info', 'API key removed.');
    return { ok: true, ...status() };
  }

  return Object.freeze({ filePath, load, status, getKey, address, bindLegacy, save, remove, saveStorage, plainReason });
}

module.exports = {
  createStashSecret,
  KEY_STORAGE,
  KEY_FILE,
  MAX_KEY_FILE_BYTES,
};
