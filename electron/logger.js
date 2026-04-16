// Logger — electron-log configuration for main + renderer processes
const log = require('electron-log/main');

log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
log.initialize(); // enables IPC forwarding from renderer

module.exports = log;
