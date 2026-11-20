// A fake Electron `safeStorage`, and the REAL electron/safe-key.js loaded
// against it (Stash S1: electron/stash-secret.js is safe-key.js's first user).
//
// safe-key.js takes `safeStorage` from `require('electron')` once, when it is
// loaded; under Vitest that require answers the Electron binary's path, so
// safeStorage would be undefined and every call would fall back to plain
// text. loadSafeKeyWith(fake) loads a fresh copy with a one-shot
// `Module._load` hook (as real-electron-conf.js does for electron-conf), so
// the real safe-key.js code runs against the fake below.
//
// The fake: encryptString puts a 16-byte header and an "account" tag in front
// of the XOR-ed text, so a value encrypted under one account does not decrypt
// under another (another PC or Windows account), like DPAPI. Its switches:
//   available        isEncryptionAvailable()
//   backend          getSelectedStorageBackend() (Linux: 'basic_text', ...)
//   account          which "account" encrypts and decrypts
//   failEncrypt      encryptString throws (safe-key.js then returns plain text)
import Module, { createRequire } from 'node:module';

const HEADER = Buffer.from('v10FAKEDPAPI0000', 'latin1');

export function createFakeSafeStorage(options = {}) {
  const fake = {
    available: true,
    backend: 'gnome_libsecret',
    account: 'acct',
    failEncrypt: false,
    ...options,
    isEncryptionAvailable() { return fake.available; },
    getSelectedStorageBackend() { return fake.backend; },
    encryptString(text) {
      if (fake.failEncrypt) throw new Error('Error while encrypting the text provided to safeStorage.encryptString.');
      const body = Buffer.from(text, 'utf8').map((b) => b ^ 0x5a);
      return Buffer.concat([HEADER, Buffer.from(fake.account.padEnd(4).slice(0, 4), 'latin1'), body]);
    },
    decryptString(buf) {
      const fail = () => new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      if (!Buffer.isBuffer(buf) || buf.length < 20 || !buf.subarray(0, 16).equals(HEADER)) throw fail();
      if (buf.subarray(16, 20).toString('latin1') !== fake.account.padEnd(4).slice(0, 4)) throw fail();
      return Buffer.from(buf.subarray(20).map((b) => b ^ 0x5a)).toString('utf8');
    },
  };
  return fake;
}

/** A fresh copy of the REAL electron/safe-key.js whose `safeStorage` is `fake`. */
export function loadSafeKeyWith(fake) {
  const req = createRequire(import.meta.url);
  const resolved = req.resolve('../../../electron/safe-key.js');
  delete req.cache[resolved];
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return { safeStorage: fake };
    return origLoad.call(this, request, ...rest);
  };
  try {
    return req(resolved);
  } finally {
    Module._load = origLoad;
  }
}
