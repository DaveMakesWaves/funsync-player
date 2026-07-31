// SafeKey — encrypt/decrypt Handy connection key using Electron safeStorage
const { safeStorage } = require('electron');

// Portable mode: safeStorage is backed by the OS keychain/DPAPI, which is
// bound to the originating machine + user — an encrypted blob carried on a
// USB stick will NOT decrypt on another machine (and the plaintext fallback
// would then return garbage). So in portable mode we deliberately store the
// key as plaintext in the portable `data/` folder. The Handy key is a
// low-sensitivity pairing code, and physical possession of the stick already
// implies access. See SCOPE-portable-install.md §3.
function isPortable() {
  return process.env.FUNSYNC_PORTABLE === '1';
}

/**
 * Encrypt a plaintext string. Returns base64 if safeStorage is available,
 * otherwise (or in portable mode) returns the plaintext unchanged.
 */
function encryptKey(plaintext) {
  if (!plaintext) return '';
  if (isPortable()) return plaintext; // keychain-bound encryption can't travel
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(plaintext);
      return encrypted.toString('base64');
    }
  } catch {
    // Fall through to plaintext
  }
  return plaintext;
}

/**
 * Decrypt a stored value. If it looks like base64-encoded encrypted data,
 * decrypt it. Otherwise return as-is (plaintext fallback or legacy data).
 */
function decryptKey(stored) {
  if (!stored) return '';
  if (isPortable()) return stored; // stored plaintext in portable mode
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(stored, 'base64');
      // Validate it's actually encrypted data (not a plain connection key)
      // safeStorage encrypted buffers are longer than typical 8-char keys
      if (buf.length > 16) {
        return safeStorage.decryptString(buf);
      }
    }
  } catch {
    // Decryption failed — probably plaintext legacy data
  }
  return stored;
}

module.exports = { encryptKey, decryptKey };
