/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Stash S1 (DESIGN-stash-s1.md (c), (d), (e); Dave's answer 2, 2026-11-18):
// the Stash API key's file, electron/stash-secret.js, through the REAL
// electron/safe-key.js loaded against a fake safeStorage
// (tests/unit/helpers/fake-safe-storage.js), on real files in a temp folder.
//
//   installed build, encryption real  -> stash/key.json, encrypted
//   portable build                    -> stash/key.json, PLAIN TEXT (Dave)
//   installed, encryption not real    -> stash/key.json, PLAIN TEXT, with
//     (Linux basic_text; safeStorage      the same note (Dave's answer after
//      failing, where safe-key.js         Round 1, 2026-11-18: "Plain text,
//      would silently hand back the       like portable"); plainReason
//      plain text)                        'noEncryption'
//   memory only                       -> only when the write failed
//
// Guards checked by reopening their hole (stage s1-1a-client, 2026-11-18;
// the storage ones again in s1-2a-main after Dave's answer):
//   key storage    basic_text is labelled plain, never safeStorage (hole:
//                  trust isEncryptionAvailable() alone); a failing
//                  encryption never writes the plain key under the
//                  safeStorage label (hole: trust encryptKey's return);
//                  no encryption saves plain text (hole: memory only)
//   key never out  status() never carries the key (hole: return the key
//                  from status)
//   absence        an unreadable key file is left byte for byte (hole:
//                  delete it on a failed read); a portable build does not
//                  take the ciphertext for the key (hole: trust decryptKey's
//                  return)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeSafeStorage, loadSafeKeyWith } from './helpers/fake-safe-storage.js';

const require = createRequire(import.meta.url);
const { createStashSecret, KEY_STORAGE, KEY_FILE } = require('../../electron/stash-secret.js');
const { SECRET_FILES } = require('../../electron/secret-settings.js');
const logRedact = require('../../electron/log-redact.js');

const KEY = 'eyJhbGciOiJIUzI1NiJ9.U0FNUExFU1RBU0hLRVkwMDAx.c2FtcGxlc2lnbmF0dXJl';
const KEY2 = 'eyJhbGciOiJIUzI1NiJ9.U0FNUExFU1RBU0hLRVkwMDAy.c2FtcGxlc2lnbmF0dXJl';

let dir;
let fake;
let safeKey;
let prevPortableEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-stash-secret-'));
  fake = createFakeSafeStorage();
  safeKey = loadSafeKeyWith(fake);
  prevPortableEnv = process.env.FUNSYNC_PORTABLE;
  delete process.env.FUNSYNC_PORTABLE;
  logRedact.clearSecretLiterals();
});

afterEach(() => {
  if (prevPortableEnv === undefined) delete process.env.FUNSYNC_PORTABLE;
  else process.env.FUNSYNC_PORTABLE = prevPortableEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

const keyPath = () => path.join(dir, 'stash', 'key.json');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function secret(extra = {}) {
  return createStashSecret({
    userDataDir: dir, portable: false, platform: 'win32', safeStorage: fake, safeKey, log: null, ...extra,
  });
}

describe('where the key is kept', () => {
  it('the file is the one SECRET_FILES names, under userData', () => {
    expect(KEY_FILE).toBe(SECRET_FILES['stash.apiKey'].file);
    expect(secret().filePath).toBe(keyPath());
  });

  it('installed build, encryption real: stash/key.json, encrypted; a fresh start reads it back', () => {
    const s = secret();
    expect(s.status().saveStorage).toBe(KEY_STORAGE.SAFE_STORAGE);
    const r = s.save(KEY);
    expect(r).toEqual({ ok: true, hasKey: true, keyStorage: 'safeStorage', saveStorage: 'safeStorage', plainReason: null, unreadable: false, address: null });
    const text = fs.readFileSync(keyPath(), 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(Buffer.from(KEY).toString('base64'));
    const rec = JSON.parse(text);
    expect(rec).toEqual({ v: 1, storage: 'safeStorage', value: expect.any(String), address: null });
    expect(fake.decryptString(Buffer.from(rec.value, 'base64'))).toBe(KEY);
    const again = secret();
    expect(again.getKey()).toBe(KEY);
    expect(again.status()).toEqual({ hasKey: true, keyStorage: 'safeStorage', saveStorage: 'safeStorage', plainReason: null, unreadable: false, address: null });
  });

  it('macOS and Linux with a real keyring count as real', () => {
    expect(secret({ platform: 'darwin' }).saveStorage()).toBe('safeStorage');
    fake.backend = 'gnome_libsecret';
    expect(secret({ platform: 'linux' }).saveStorage()).toBe('safeStorage');
    fake.backend = 'kwallet5';
    expect(secret({ platform: 'linux' }).saveStorage()).toBe('safeStorage');
  });

  it('portable build (Dave, 2026-11-18): stash/key.json in plain text, said before any key is typed', () => {
    const s = secret({ portable: true });
    expect(s.status()).toEqual({ hasKey: false, keyStorage: null, saveStorage: 'plain', plainReason: 'portable', unreadable: false, address: null });
    expect(s.save(KEY)).toEqual({ ok: true, hasKey: true, keyStorage: 'plain', saveStorage: 'plain', plainReason: 'portable', unreadable: false, address: null });
    expect(JSON.parse(fs.readFileSync(keyPath(), 'utf8'))).toEqual({ v: 1, storage: 'plain', value: KEY, address: null });
    expect(secret({ portable: true }).getKey()).toBe(KEY);
  });

  it('portable is read from FUNSYNC_PORTABLE (main.js sets it) when not given', () => {
    process.env.FUNSYNC_PORTABLE = '1';
    expect(createStashSecret({ userDataDir: dir, safeStorage: fake, safeKey, log: null }).saveStorage()).toBe('plain');
    delete process.env.FUNSYNC_PORTABLE;
    expect(createStashSecret({ userDataDir: dir, platform: 'win32', safeStorage: fake, safeKey, log: null }).saveStorage()).toBe('safeStorage');
  });

  // Dave, after Round 1 (2026-11-18): an installed build where encryption is
  // not available keeps the key in plain text, like a portable build, and
  // Settings shows the same note (saveStorage 'plain', plainReason
  // 'noEncryption').
  it('Linux basic_text (guard): plain text, labelled plain and said before any key is typed; a fresh start reads it', () => {
    fake.backend = 'basic_text';
    const s = secret({ platform: 'linux' });
    expect(s.saveStorage()).toBe('plain');
    expect(s.status()).toEqual({ hasKey: false, keyStorage: null, saveStorage: 'plain', plainReason: 'noEncryption', unreadable: false, address: null });
    expect(s.save(KEY)).toEqual({ ok: true, hasKey: true, keyStorage: 'plain', saveStorage: 'plain', plainReason: 'noEncryption', unreadable: false, address: null });
    expect(JSON.parse(fs.readFileSync(keyPath(), 'utf8'))).toEqual({ v: 1, storage: 'plain', value: KEY, address: null });
    expect(secret({ platform: 'linux' }).getKey()).toBe(KEY);
  });

  it('encryption not available at all: plain text, with the note', () => {
    fake.available = false;
    const s = secret();
    expect(s.save(KEY)).toMatchObject({ ok: true, keyStorage: 'plain', plainReason: 'noEncryption' });
    expect(JSON.parse(fs.readFileSync(keyPath(), 'utf8'))).toEqual({ v: 1, storage: 'plain', value: KEY, address: null });
    expect(secret().getKey()).toBe(KEY);
  });

  it('encryption that fails while claiming to work (guard): never plain text under the safeStorage label', () => {
    // safe-key.js catches the throw and returns the plain text unchanged.
    fake.failEncrypt = true;
    expect(safeKey.encryptKey(KEY)).toBe(KEY);
    const s = secret();
    expect(s.save(KEY)).toMatchObject({ ok: true, hasKey: true, keyStorage: 'plain', saveStorage: 'plain', plainReason: 'noEncryption' });
    const rec = JSON.parse(fs.readFileSync(keyPath(), 'utf8'));
    expect(rec).toEqual({ v: 1, storage: 'plain', value: KEY, address: null });
  });

  it('no Electron safeStorage at all (a test run, a broken install): plain text, with the note', () => {
    const s = createStashSecret({ userDataDir: dir, portable: false, platform: 'win32', safeStorage: null, log: null });
    expect(s.save(KEY)).toMatchObject({ keyStorage: 'plain', plainReason: 'noEncryption' });
    expect(fs.existsSync(keyPath())).toBe(true);
  });

  it('while encryption works the key is never written in plain text (guard)', () => {
    const s = secret();
    expect(s.save(KEY)).toMatchObject({ keyStorage: 'safeStorage', plainReason: null });
    expect(fs.readFileSync(keyPath(), 'utf8')).not.toContain(KEY);
  });

  it('a key saved where encryption went away replaces the older encrypted file (the replaced key must not come back)', () => {
    secret().save(KEY);
    expect(fs.existsSync(keyPath())).toBe(true);
    fake.available = false;
    const s = secret();
    expect(s.save(KEY2).keyStorage).toBe('plain');
    expect(JSON.parse(fs.readFileSync(keyPath(), 'utf8'))).toEqual({ v: 1, storage: 'plain', value: KEY2, address: null });
    expect(s.getKey()).toBe(KEY2);
  });
});

describe('the key never leaves main (guard): status replies carry no key', () => {
  it.each([
    ['installed', {}],
    ['portable', { portable: true }],
    ['no encryption', { safeStorage: null }],
  ])('%s: status, save and remove replies', (_label, extra) => {
    const s = secret(extra);
    const replies = [s.status(), s.save(KEY), s.status(), s.save(KEY2), s.remove(), s.status()];
    for (const r of replies) {
      const text = JSON.stringify(r);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(KEY2);
      expect(Object.keys(r).filter((k) => k !== 'ok' && k !== 'code').sort())
        .toEqual(['address', 'hasKey', 'keyStorage', 'plainReason', 'saveStorage', 'unreadable']);
    }
  });
});

describe('the key is masked on every log line', () => {
  it('once saved', () => {
    secret().save(KEY);
    expect(logRedact.redactSecrets(`request failed for key ${KEY} today`)).not.toContain(KEY);
  });

  it('once loaded by a fresh start', () => {
    secret().save(KEY);
    logRedact.clearSecretLiterals();
    expect(logRedact.redactSecrets(`x ${KEY} y`)).toContain(KEY);
    secret().load();
    expect(logRedact.redactSecrets(`x ${KEY} y`)).not.toContain(KEY);
  });
});

describe('absence and failure: nothing is lost or cleared', () => {
  it('no file: no key, nothing written', () => {
    const s = secret();
    expect(s.status()).toEqual({ hasKey: false, keyStorage: null, saveStorage: 'safeStorage', plainReason: null, unreadable: false, address: null });
    expect(s.getKey()).toBe('');
    expect(fs.existsSync(path.join(dir, 'stash'))).toBe(false);
  });

  it('a key from another PC or Windows account (guard): unreadable, and the file stays byte for byte', () => {
    secret().save(KEY);
    const before = sha(keyPath());
    fake.account = 'othr';
    const s = secret();
    expect(s.status()).toEqual({ hasKey: false, keyStorage: null, saveStorage: 'safeStorage', plainReason: null, unreadable: true, address: null });
    expect(s.getKey()).toBe('');
    expect(sha(keyPath())).toBe(before);
    // Pasting the key again replaces it.
    expect(s.save(KEY2)).toMatchObject({ ok: true, hasKey: true, unreadable: false });
    expect(secret().getKey()).toBe(KEY2);
  });

  it('a portable build never takes an encrypted file\'s text for the key (guard)', () => {
    secret().save(KEY);
    const before = sha(keyPath());
    process.env.FUNSYNC_PORTABLE = '1';
    const portableSafeKey = loadSafeKeyWith(fake);
    const s = createStashSecret({ userDataDir: dir, portable: true, safeStorage: fake, safeKey: portableSafeKey, log: null });
    expect(s.getKey()).toBe('');
    expect(s.status().unreadable).toBe(true);
    expect(sha(keyPath())).toBe(before);
  });

  it.each([
    ['not JSON', '{"v":1,'],
    ['an unknown storage', '{"v":1,"storage":"rot13","value":"abc"}'],
    ['a newer version', '{"v":2,"storage":"plain","value":"abc"}'],
    ['an empty value', '{"v":1,"storage":"plain","value":""}'],
    ['a value that is not a key', '{"v":1,"storage":"plain","value":"two words"}'],
  ])('a damaged file (%s): unreadable, left as it is', (_label, text) => {
    fs.mkdirSync(path.join(dir, 'stash'));
    fs.writeFileSync(keyPath(), text);
    const before = sha(keyPath());
    const s = secret();
    expect(s.status()).toMatchObject({ hasKey: false, unreadable: true });
    expect(sha(keyPath())).toBe(before);
  });

  it('a file too big to be a key file is not read', () => {
    fs.mkdirSync(path.join(dir, 'stash'));
    fs.writeFileSync(keyPath(), JSON.stringify({ v: 1, storage: 'plain', value: KEY, pad: 'x'.repeat(70 * 1024) }));
    expect(secret().status()).toMatchObject({ hasKey: false, unreadable: true });
  });

  it('a write that fails leaves the old file whole, leaves no temp file, and keeps the new key for this session', () => {
    secret().save(KEY);
    const before = sha(keyPath());
    const failingFs = { ...fs, renameSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
    const s = secret({ fs: failingFs });
    s.load();
    expect(s.save(KEY2)).toEqual({ ok: false, code: 'writeFailed', hasKey: true, keyStorage: 'memory', saveStorage: 'safeStorage', plainReason: null, unreadable: false, address: null });
    expect(sha(keyPath())).toBe(before);
    expect(fs.readdirSync(path.join(dir, 'stash'))).toEqual(['key.json']);
    expect(s.getKey()).toBe(KEY2);
  });

  it('a key that cannot be a key is refused and nothing changes', () => {
    const s = secret();
    s.save(KEY);
    const before = sha(keyPath());
    for (const bad of ['', '   ', 'two words', `${KEY}\r\nX: 1`, 'x'.repeat(4097), null, 42]) {
      expect(s.save(bad)).toMatchObject({ ok: false, code: 'invalidKey', hasKey: true });
    }
    expect(sha(keyPath())).toBe(before);
    expect(s.getKey()).toBe(KEY);
  });

  it('a key pasted with spaces around it is saved trimmed', () => {
    const s = secret();
    s.save(`  ${KEY}\n`);
    expect(secret().getKey()).toBe(KEY);
  });
});

describe('the key belongs to one address (s1-fixup-main, 2026-11-19, S1RB-1)', () => {
  it('the address is saved with the key, read back by a fresh start, and said in status (never the key)', () => {
    const s = secret({ portable: true });
    expect(s.save(KEY, { address: 'http://127.0.0.1:9999' })).toMatchObject({ ok: true, hasKey: true, address: 'http://127.0.0.1:9999' });
    expect(JSON.parse(fs.readFileSync(keyPath(), 'utf8'))).toEqual({ v: 1, storage: 'plain', value: KEY, address: 'http://127.0.0.1:9999' });
    const again = secret({ portable: true });
    expect(again.address()).toBe('http://127.0.0.1:9999');
    expect(again.status().address).toBe('http://127.0.0.1:9999');
    expect(again.bindLegacy('http://192.168.1.20:9999')).toBe(false); // it has its address already
    expect(again.address()).toBe('http://127.0.0.1:9999');
    again.remove();
    expect(again.address()).toBeNull();
  });

  it('a file from before the address was stored is bound once (bindLegacy), and the file then records it; its value is kept as it was', () => {
    fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
    fs.writeFileSync(keyPath(), `${JSON.stringify({ v: 1, storage: 'plain', value: KEY })}\n`);
    const s = secret({ portable: true });
    expect(s.address()).toBeNull();
    expect(s.bindLegacy('http://127.0.0.1:9999')).toBe(true);
    expect(s.bindLegacy('http://192.168.1.20:9999')).toBe(false);
    expect(s.address()).toBe('http://127.0.0.1:9999');
    expect(JSON.parse(fs.readFileSync(keyPath(), 'utf8'))).toEqual({ v: 1, storage: 'plain', value: KEY, address: 'http://127.0.0.1:9999' });
    expect(secret({ portable: true }).getKey()).toBe(KEY);
  });
});

describe('remove', () => {
  it('removes the file and the copy in memory', () => {
    const s = secret();
    s.save(KEY);
    expect(s.remove()).toEqual({ ok: true, hasKey: false, keyStorage: null, saveStorage: 'safeStorage', plainReason: null, unreadable: false, address: null });
    expect(fs.existsSync(keyPath())).toBe(false);
    expect(s.getKey()).toBe('');
    expect(secret().status().hasKey).toBe(false);
  });

  it('with nothing saved is fine', () => {
    expect(secret().remove()).toMatchObject({ ok: true, hasKey: false });
  });

  it('removes an unreadable file too (the user asked)', () => {
    secret().save(KEY);
    fake.account = 'othr';
    const s = secret();
    expect(s.status().unreadable).toBe(true);
    expect(s.remove()).toMatchObject({ ok: true, unreadable: false });
    expect(fs.existsSync(keyPath())).toBe(false);
  });
});
