/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// "Trust this certificate" (Stash S1 Round 2; Dave's answer after Round 1,
// 2026-11-18): a Stash on a NAS with a self-signed https certificate. The
// REAL client (electron/stash-client.js) and its https transport
// (electron/stash-tls.js) against a LOCAL fake Stash served over https with
// one of two self-signed TEST certificates (tests/fixtures/stash/tls; no
// real certificate, no other host).
//
// Guards (each checked by reopening its hole, stage s1-2a-main):
//   - a certificate the system does not trust is refused with its SHA-256
//     fingerprint and subject, and the server gets NO request (no key, no
//     body) — hole: accept every certificate (a global "ignore errors")
//   - a pinned certificate is accepted at its own origin only — hole: the
//     pin counts at every origin
//   - any other certificate at that origin is refused (pinMismatch) — hole:
//     a pin accepts any certificate
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { startFakeStash, testCertificate } from '../helpers/fake-stash-server.js';

const require_ = createRequire(import.meta.url);
const { createStashClient, stashErrorReply, STASH_ERROR } = require_('../../electron/stash-client.js');
const { normalizeFingerprint, describeCertificate } = require_('../../electron/stash-tls.js');

const KEY = 'eyJhbGciOiJIUzI1NiJ9.VExTVEVTVEtFWTAwMDE.dGxzc2lnbmF0dXJl';
const A = testCertificate('a');
const B = testCertificate('b');

const servers = [];
afterEach(async () => { while (servers.length) await servers.pop().close(); });

async function httpsStash(cert, extra = {}) {
  const s = await startFakeStash({ tls: { key: cert.key, cert: cert.cert }, ...extra });
  servers.push(s);
  return s;
}

function client(address, extra = {}) {
  return createStashClient({ address, log: null, timeouts: { test: 4000, sync: 4000 }, ...extra });
}

async function failure(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected a failure');
}

describe('a certificate this PC does not trust', () => {
  it('is refused with its fingerprint and subject, and the server gets no request (no key, no body)', async () => {
    const stash = await httpsStash(A, { apiKey: KEY });
    const err = await failure(client(stash.address, { apiKey: KEY }).test());
    expect(err.code).toBe(STASH_ERROR.CERTIFICATE);
    expect(err.certificate).toMatchObject({
      origin: stash.address,
      fingerprint256: A.fingerprint256,
      pinMismatch: false,
    });
    expect(err.certificate.subject).toContain('CN=FunSync test Stash A');
    expect(err.certificate.altNames).toContain('127.0.0.1');
    // The handshake happened; nothing of the request reached the server.
    expect(stash.stats.connections).toBeGreaterThanOrEqual(1);
    expect(stash.requests).toEqual([]);
    // The IPC reply carries the facts for the trust step, never the key.
    const reply = stashErrorReply(err);
    expect(reply).toMatchObject({ ok: false, code: 'certificate', certificate: { fingerprint256: A.fingerprint256 } });
    expect(JSON.stringify(reply)).not.toContain(KEY);
  });
});

describe('a pinned certificate', () => {
  it('is accepted at its own origin: the key goes in the header, POST /graphql only', async () => {
    const stash = await httpsStash(A, { apiKey: KEY });
    const origin = new URL(stash.address).origin;
    const res = await client(stash.address, { apiKey: KEY, tlsPin: { origin, sha256: A.fingerprint256 } }).test();
    expect(res).toEqual({ version: 'v0.32.0', sceneCount: 9 });
    expect(stash.requests.map((r) => [r.method, r.url, r.headers.apikey])).toEqual([['POST', '/graphql', KEY]]);
    expect(stash.requests[0].headers.host).toBe(new URL(stash.address).host);
  });

  it('a whole page of scenes comes through the pinned connection', async () => {
    const stash = await httpsStash(A);
    const origin = new URL(stash.address).origin;
    const page = await client(stash.address, { tlsPin: { origin, sha256: A.fingerprint256 } }).listScenes();
    expect(page.count).toBe(9);
    expect(page.scenes).toHaveLength(9);
  });

  it('any other certificate at that origin is refused, and says the trusted one changed', async () => {
    const stash = await httpsStash(A, { apiKey: KEY });
    const origin = new URL(stash.address).origin;
    const err = await failure(client(stash.address, { apiKey: KEY, tlsPin: { origin, sha256: B.fingerprint256 } }).test());
    expect(err.code).toBe(STASH_ERROR.CERTIFICATE);
    expect(err.certificate).toMatchObject({ fingerprint256: A.fingerprint256, pinMismatch: true });
    expect(stash.requests).toEqual([]);
  });

  it('counts at its own origin only: the same certificate at another address is refused', async () => {
    const stash = await httpsStash(A);
    const u = new URL(stash.address);
    const elsewhere = [`https://localhost:${u.port}`, `https://127.0.0.1:${Number(u.port) + 1}`, `http://127.0.0.1:${u.port}`];
    for (const origin of elsewhere) {
      const err = await failure(client(stash.address, { tlsPin: { origin, sha256: A.fingerprint256 } }).test());
      expect(err.code, origin).toBe(STASH_ERROR.CERTIFICATE);
      expect(err.certificate.pinMismatch, origin).toBe(false);
    }
    // And the pinned origin at another address does not reach this server.
    const other = await httpsStash(B);
    const err = await failure(client(other.address, { tlsPin: { origin: u.origin, sha256: A.fingerprint256 } }).test());
    expect(err.certificate.fingerprint256).toBe(B.fingerprint256);
    expect(stash.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it('a malformed pin pins nothing', async () => {
    const stash = await httpsStash(A);
    const origin = new URL(stash.address).origin;
    for (const sha256 of ['', 'x', A.fingerprint256.replace(/:/g, ''), null]) {
      const err = await failure(client(stash.address, { tlsPin: { origin, sha256 } }).test());
      expect(err.code).toBe(STASH_ERROR.CERTIFICATE);
    }
    expect(stash.requests).toEqual([]);
  });
});

describe('the system\'s trust', () => {
  // `ca` stands in for the system's certificate store (tests only).
  it('a certificate the system trusts is accepted without a pin, as any https client does', async () => {
    const stash = await httpsStash(A);
    const res = await client(stash.address, { tlsOptions: { ca: [A.cert] } }).test();
    expect(res.sceneCount).toBe(9);
  });

  it('a pin does not take away the system\'s trust (a NAS that later gets a real certificate keeps working)', async () => {
    const stash = await httpsStash(A);
    const origin = new URL(stash.address).origin;
    const res = await client(stash.address, { tlsOptions: { ca: [A.cert] }, tlsPin: { origin, sha256: B.fingerprint256 } }).test();
    expect(res.sceneCount).toBe(9);
  });
});

describe('helpers', () => {
  it('normalizeFingerprint takes only a full SHA-256 fingerprint', () => {
    expect(normalizeFingerprint(A.fingerprint256.toLowerCase())).toBe(A.fingerprint256);
    expect(normalizeFingerprint('AB:CD')).toBeNull();
    expect(normalizeFingerprint(null)).toBeNull();
  });

  it('describeCertificate keeps public facts on one line, and nothing it does not know', () => {
    const d = describeCertificate({
      subject: { CN: 'nas\r\n.local', O: ['A', 'B'] }, issuer: { CN: 'nas.local' },
      fingerprint256: A.fingerprint256, subjectaltname: 'DNS:nas.local', valid_from: 'x', valid_to: 'y', raw: Buffer.from('z'),
    }, { origin: 'https://nas.local:9999', reason: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(d).toEqual({
      origin: 'https://nas.local:9999', fingerprint256: A.fingerprint256, subject: 'CN=nas .local, O=A, O=B', issuer: 'CN=nas.local',
      altNames: 'DNS:nas.local', validFrom: 'x', validTo: 'y', reason: 'DEPTH_ZERO_SELF_SIGNED_CERT', pinMismatch: false,
    });
  });
});
