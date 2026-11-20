// Logger — electron-log configuration for main + renderer processes
const log = require('electron-log/main');
const { maybeRedact, redactSecrets } = require('./log-redact');

log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

// Optional filename redaction, applied at the single chokepoint every line
// passes through: main-process logs, renderer console forwarding, and the
// Python backend's stdout all end up here. Doing it per call site would mean
// finding them all and would silently miss the next one.
//
// Off unless the user turns it on (Settings > Security). The setting is read
// through maybeRedact rather than captured here, because this module is
// required BEFORE the store exists — see the ordering note at the top of
// main.js.
//
// Secrets (keys, tokens, login cookies) are masked on every line, toggle or
// not (FT-010, redactSecrets in log-redact.js).
log.hooks.push((message) => {
  if (!Array.isArray(message.data)) return message;
  message.data = message.data.map((d) => (typeof d === 'string' ? maybeRedact(redactSecrets(d)) : d));
  return message;
});

// An object or an Error argument (`log.warn('failed:', err)`) only becomes
// text inside the transport, after the hook has run, so a key in a request
// URL inside err.message would reach the file untouched. The file transport's
// last step masks the finished line as well.
log.transports.file.transforms.push(({ data }) => (typeof data === 'string' ? redactSecrets(data) : data));

log.initialize(); // enables IPC forwarding from renderer

module.exports = log;
