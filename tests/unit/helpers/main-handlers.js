// Lift one `ipcMain.handle('<name>', …)` handler out of electron/main.js and
// run it with the collaborators a test hands in (main.js cannot be imported
// without Electron). The text is read from the file on every call, so a test
// always runs what main.js holds now, the same way read-funscript-log-level
// and log-redact-files lift theirs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A path, not a URL object: under jsdom the global URL is not Node's.
const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../electron/main.js');

/**
 * @param {string} name the IPC channel
 * @param {Record<string, unknown>} deps the free names the handler uses
 *   (`dialog`, `mainWindow`, `eroScripts`, `shell`, `log`, `fs`, …)
 * @returns {(...args: unknown[]) => unknown} the handler (first arg: the event)
 */
export function liftMainHandler(name, deps = {}) {
  const src = fs.readFileSync(MAIN, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf(`ipcMain.handle('${name}'`);
  if (start < 0) throw new Error(`${name} handler not found in main.js`);
  const end = src.indexOf('\n});\n', start);
  if (end < 0) throw new Error(`end of the ${name} handler not found`);
  let handler;
  const ipcMain = { handle: (_n, fn) => { handler = fn; } };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  new Function('ipcMain', ...names, src.slice(start, end + '\n});\n'.length))(ipcMain, ...names.map((k) => deps[k]));
  return handler;
}
