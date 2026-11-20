// connect-failure-reason.js — why a T-Code or Autoblow connect failed, in
// words the user can act on (FT-060; also in v0.9.2).
//
// Both managers report a failed connect only through `onError(message)`, and
// the Devices panel never listened: the tab went back to "Not connected" and
// the reason stayed in the log. The raw message comes from the transport or
// the Autoblow cloud, in English ("Opening COM3: File not found", "closed
// before open (1006)", "Device not connected — check power and WiFi"). A
// known cause gets a localised sentence saying what to do. A T-Code detail
// names the port or the address, so it stays after the sentence in brackets
// (a bug report still carries it); an Autoblow cause's raw text is the same
// sentence in English, so it is not repeated. Anything unknown reads
// "Connection failed: <detail>".
//
// Pure: the caller hands in `t`. A secret (the Autoblow token) never reaches
// the text, even if a message ever carried it.

/** [i18n key, test, keep the raw detail] per device; the first match wins. */
const CAUSES = {
  tcode: [
    ['connection.failure.tcodePortNotFound', /file not found|no such file|cannot find|ENOENT/i, true],
    ['connection.failure.tcodePortBusy', /access denied|permission denied|resource busy|EBUSY|EACCES|cannot lock|in use/i, true],
    ['connection.failure.tcodeWsRefused', /closed before open|connect failed|ECONNREFUSED|refused/i, true],
  ],
  autoblow: [
    ['connection.failure.autoblowOffline', /device not connected/i, false],
    ['connection.failure.autoblowRateLimited', /rate limited|\b429\b/i, false],
  ],
};

const MAX_DETAIL = 200;

/**
 * Classify a connect failure.
 * @param {'tcode'|'autoblow'} device
 * @param {string} message what the manager's onError was given
 * @param {{secret?: string}} [opts] a value that must never be shown (the token)
 * @returns {{key: string|null, detail: string, showDetail: boolean}}
 */
export function connectFailureReason(device, message, { secret } = {}) {
  // TCodeManager prefixes what the transport said.
  let detail = String(message ?? '').replace(/^Connection (?:failed|error):\s*/i, '').trim();
  if (typeof secret === 'string' && secret.length >= 4) detail = detail.split(secret).join('[hidden]');
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL - 1)}…`;
  const hit = (CAUSES[device] || []).find(([, re]) => re.test(detail));
  return hit
    ? { key: hit[0], detail, showDetail: hit[2] && detail.length > 0 }
    : { key: null, detail, showDetail: detail.length > 0 };
}

/**
 * The sentence the Devices tab and the toast show.
 * @param {'tcode'|'autoblow'} device
 * @param {string} message
 * @param {(key: string, params?: object) => string} t
 * @param {{secret?: string}} [opts]
 */
export function describeConnectFailure(device, message, t, opts) {
  const { key, detail, showDetail } = connectFailureReason(device, message, opts);
  if (!key) return detail ? t('connection.failure.generic', { detail }) : t('connection.status.failed');
  const reason = t(key);
  return showDetail ? t('connection.failure.withDetail', { reason, detail }) : reason;
}
