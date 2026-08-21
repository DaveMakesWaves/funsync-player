// Logger — electron-log configuration for main + renderer processes
const log = require('electron-log/main');
const { maybeRedact } = require('./log-redact');

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
log.hooks.push((message) => {
  if (!Array.isArray(message.data)) return message;
  message.data = message.data.map((d) => (typeof d === 'string' ? maybeRedact(d) : d));
  return message;
});

log.initialize(); // enables IPC forwarding from renderer

module.exports = log;
