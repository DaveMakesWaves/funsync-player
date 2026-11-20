'use strict';

// Stash S1 Round 2 (2026-11-18): https to the user's own Stash, and "Trust
// this certificate" (Dave's answer after Round 1: "Add a trust option").
//
// A fetch-shaped function (createStashFetch) that electron/stash-client.js
// uses for every `https:` address. What it guarantees, each with a test in
// tests/unit/stash-tls.test.js (against a local self-signed https server):
//
//   - NOTHING IS SENT BEFORE THE CERTIFICATE IS ACCEPTED. The TLS connection
//     is made first; the request (its headers, the ApiKey, the body) is
//     written only after the certificate passed, because the socket is
//     handed to the HTTP request only then.
//   - THE SYSTEM'S TRUST FIRST. A certificate the system trusts for that
//     host name is accepted, as any https client does (Node's own check:
//     the chain AND the name, `socket.authorized`).
//   - ONE PINNED CERTIFICATE, ONE ADDRESS. Otherwise the certificate is
//     accepted only when the user trusted THAT certificate (its SHA-256
//     fingerprint) for THAT exact origin (scheme, host, port): `pin`,
//     settings.stash.trustedCert. Any other certificate, or the pinned one
//     at another origin, is refused. Never a global "ignore certificate
//     errors": the check is per connection, here, and nowhere else.
//   - WORDS FOR THE TRUST STEP. A refused certificate fails with a
//     CertificateError (code STASH_CERT_UNTRUSTED) that carries what the
//     trust step shows: the fingerprint, the subject, the issuer, the names
//     and the dates (public facts about the certificate, never a secret),
//     and whether a pinned certificate was replaced (`pinMismatch`).
//   - NO REDIRECTS: node:http never follows one; a 3xx comes back as it is
//     (the client words it `redirect`).

const nodeTls = require('tls');
const nodeHttp = require('http');
const net = require('net');
const { Readable } = require('stream');

const FINGERPRINT_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const MAX_TEXT = 500;
const NAME_ORDER = ['CN', 'O', 'OU', 'L', 'ST', 'C'];
const CERT_ERROR_CODE = 'STASH_CERT_UNTRUSTED';

/** A SHA-256 fingerprint as Node writes it ('AB:CD:…', 32 pairs), or null. */
function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  return FINGERPRINT_RE.test(s) ? s : null;
}

// eslint-disable-next-line no-control-regex
const oneLine = (v) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_TEXT) : null);

/** `CN=…, O=…` from a certificate's subject or issuer object. */
function formatName(name) {
  if (!name || typeof name !== 'object') return null;
  const keys = Object.keys(name).sort((a, b) => {
    const ia = NAME_ORDER.indexOf(a);
    const ib = NAME_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : a > b ? 1 : 0);
  });
  const parts = [];
  for (const k of keys) {
    for (const v of Array.isArray(name[k]) ? name[k] : [name[k]]) {
      if (typeof v === 'string' && v) parts.push(`${k}=${v}`);
    }
  }
  return parts.length ? oneLine(parts.join(', ')) : null;
}

/**
 * What the trust step shows about a certificate. Public facts only.
 * @param {object} cert tls getPeerCertificate()
 * @param {{origin: string, reason?: string, pinMismatch?: boolean}} extra
 */
function describeCertificate(cert, extra = {}) {
  const c = cert && typeof cert === 'object' ? cert : {};
  return {
    origin: oneLine(extra.origin) || null,
    fingerprint256: normalizeFingerprint(c.fingerprint256),
    subject: formatName(c.subject),
    issuer: formatName(c.issuer),
    altNames: oneLine(c.subjectaltname) || null,
    validFrom: oneLine(c.valid_from) || null,
    validTo: oneLine(c.valid_to) || null,
    reason: typeof extra.reason === 'string' && /^[A-Z0-9_]{2,60}$/.test(extra.reason) ? extra.reason : null,
    pinMismatch: extra.pinMismatch === true,
  };
}

class CertificateError extends Error {
  constructor(certificate) {
    super('Stash: the https certificate is not trusted');
    this.name = 'CertificateError';
    this.code = CERT_ERROR_CODE;
    this.certificate = certificate;
  }
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/**
 * A fetch for one https Stash address.
 *
 * @param {object} [options]
 * @param {{origin: string, sha256: string}|null} [options.pin] the certificate
 *   the user trusted (settings.stash.trustedCert); used only at its origin
 * @param {Function} [options.connect] tls.connect (tests)
 * @param {Function} [options.request] http.request (tests)
 * @param {object} [options.tlsOptions] extra tls.connect options (tests: `ca`)
 * @returns {(url: string, init?: {method?: string, headers?: object, body?: string, signal?: AbortSignal}) => Promise<Response>}
 */
function createStashFetch(options = {}) {
  const connect = options.connect || nodeTls.connect;
  const request = options.request || nodeHttp.request;
  const tlsOptions = options.tlsOptions && typeof options.tlsOptions === 'object' ? options.tlsOptions : {};
  const pin = options.pin && typeof options.pin === 'object' ? options.pin : null;

  return function stashFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (err) { reject(err); return; }
      if (u.protocol !== 'https:') { reject(new TypeError('stash-tls: https addresses only')); return; }
      const signal = init.signal;
      if (signal && signal.aborted) { reject(abortError(signal)); return; }
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const port = Number(u.port) || 443;
      const origin = u.origin;
      // The pin counts at its own origin only.
      const pinned = pin && typeof pin.origin === 'string' && pin.origin === origin ? normalizeFingerprint(pin.sha256) : null;

      let socket = null;
      const onAbort = () => { if (socket) socket.destroy(); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };

      // The request gets its socket only after the certificate passed: until
      // then nothing of it (headers, key, body) can be written.
      const createConnection = (_opts, cb) => {
        let handed = false;
        const hand = (err, s) => { if (handed) return; handed = true; cb(err, s); };
        socket = connect({
          ...tlsOptions,
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          // The decision is made below, before anything is sent: the
          // system's trust, else the one pinned certificate for this origin.
          rejectUnauthorized: false,
          ALPNProtocols: ['http/1.1'],
        });
        socket.on('error', (err) => hand(err));
        socket.once('secureConnect', () => {
          if (socket.authorized === true) { hand(null, socket); return; }
          const cert = socket.getPeerCertificate();
          const fingerprint = normalizeFingerprint(cert && cert.fingerprint256);
          if (pinned && fingerprint && fingerprint === pinned) { hand(null, socket); return; }
          const reason = socket.authorizationError
            ? String(socket.authorizationError.code || socket.authorizationError) : null;
          const err = new CertificateError(describeCertificate(cert, { origin, reason, pinMismatch: !!pinned }));
          socket.destroy();
          hand(err);
        });
        return undefined;
      };

      const headers = { ...(init.headers || {}), Host: u.host };
      let req;
      try {
        req = request({
          host, port, path: `${u.pathname}${u.search}`, method: init.method || 'GET', headers, createConnection, signal,
        });
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      req.on('response', (res) => {
        cleanup();
        const status = res.statusCode;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) h.append(k, String(x));
          else if (v != null) h.set(k, String(v));
        }
        const nullBody = status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
        if (nullBody) res.resume();
        try {
          resolve(new Response(nullBody ? null : Readable.toWeb(res), { status, statusText: res.statusMessage || '', headers: h }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      });
      req.on('error', (err) => { cleanup(); reject(err); });
      if (init.body != null) req.write(init.body);
      req.end();
    });
  };
}

module.exports = {
  createStashFetch,
  normalizeFingerprint,
  describeCertificate,
  CertificateError,
  CERT_ERROR_CODE,
};
