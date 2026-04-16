// SafeKey — encrypt/decrypt Handy connection key using Electron safeStorage
const { safeStorage } = require('electron');

/**
 * Encrypt a plaintext string. Returns base64 if safeStorage is available,
 * otherwise returns the plaintext unchanged (graceful fallback).
 */
function encryptKey(plaintext) {
  if (!plaintext) return '';
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
