/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Dave, 2026-11-26: "add the option to include them in but exclude them as
// default, like RDM would, reccomends its insecure to keep them in the backup
// but doesnt exclude it as an option". Found on the test day (T326): a backup
// file carried the EroScripts login cookie and the Handy key, so anyone it was
// sent to could use them. Now every credential of secret-settings.js's one
// list is left out unless the export asks for them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { exportData, stripSecrets, mergeConfig } = require_('../../electron/data-export.js');
const { SECRET_SETTING_PATHS } = require_('../../electron/secret-settings.js');
const JSZip = require_('jszip');

const withSecrets = () => ({
  settings: {
    handy: { connectionKey: 'HANDYKEY1', defaultOffset: -40 },
    autoblow: { token: 'ABTOKEN99' },
    eroscripts: { session: { cookie: '_t=SECRETCOOKIE', username: 'someone' }, tabFilters: { tags: ['pmv'] } },
    audience: { viewers: [{ key: 'VIEWERKEY1', label: 'Alice' }], enabled: true },
    player: { volume: 0.7 },
  },
  playlists: [{ id: 'p1', name: 'Mix', videoPaths: ['C:/v/a.mp4'] }],
  categories: [],
  videoCategories: {},
});
const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);

let tmp;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-secrets-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

async function readZip(file) {
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const raw = await zip.file('config.json').async('string');
  return {
    config: JSON.parse(raw),
    meta: JSON.parse(await zip.file('metadata.json').async('string')),
    raw,
  };
}

describe('Export Backup File: keys and logins', () => {
  it('left out by default: every credential in the one list, and no trace of their values', async () => {
    const out = path.join(tmp, 'b.funsync-backup');
    expect((await exportData(withSecrets(), out)).success).toBe(true);
    const { config, meta, raw } = await readZip(out);
    for (const p of SECRET_SETTING_PATHS) expect(get(config.settings, p), p).toBeUndefined();
    for (const value of ['HANDYKEY1', 'ABTOKEN99', 'SECRETCOOKIE', 'VIEWERKEY1']) expect(raw).not.toContain(value);
    expect(meta.secretsIncluded).toBe(false);
    // Everything else is there.
    expect(config.settings.handy.defaultOffset).toBe(-40);
    expect(config.settings.eroscripts.tabFilters).toEqual({ tags: ['pmv'] });
    expect(config.settings.audience.enabled).toBe(true);
    expect(config.settings.player.volume).toBe(0.7);
    expect(config.playlists).toHaveLength(1);
  });

  it('in only when asked for ("Include keys and logins")', async () => {
    const out = path.join(tmp, 'b.funsync-backup');
    await exportData(withSecrets(), out, { includeSecrets: true });
    const { config, meta } = await readZip(out);
    expect(config.settings.handy.connectionKey).toBe('HANDYKEY1');
    expect(config.settings.eroscripts.session.cookie).toBe('_t=SECRETCOOKIE');
    expect(config.settings.audience.viewers).toHaveLength(1);
    expect(meta.secretsIncluded).toBe(true);
    // Anything but true leaves them out.
    await exportData(withSecrets(), out, { includeSecrets: 'yes' });
    expect((await readZip(out)).config.settings.handy.connectionKey).toBeUndefined();
  });

  it('stripSecrets copies: the live config keeps its keys', () => {
    const live = withSecrets();
    const stripped = stripSecrets(live);
    expect(stripped.settings.handy.connectionKey).toBeUndefined();
    expect(live.settings.handy.connectionKey).toBe('HANDYKEY1');
    expect(stripSecrets({ playlists: [] })).toEqual({ playlists: [] });   // no settings: nothing to do
  });

  it('a backup without them, merged in, leaves the keys set here alone', () => {
    const live = withSecrets();
    const other = withSecrets();
    other.settings.player = { volume: 0.2 };
    const merged = mergeConfig(live, stripSecrets(other), 'merge');
    expect(merged.settings.handy.connectionKey).toBe('HANDYKEY1');
    expect(merged.settings.autoblow.token).toBe('ABTOKEN99');
    expect(merged.settings.eroscripts.session.cookie).toBe('_t=SECRETCOOKIE');
    expect(merged.settings.audience.viewers.map((v) => v.key)).toEqual(['VIEWERKEY1']);
    expect(merged.settings.player.volume).toBe(0.2);                    // the backup's settings still apply
  });
});

describe('the IPC passes the choice through', () => {
  it('preload sends includeSecrets as a strict boolean; main hands it to exportData', async () => {
    const preload = await fsp.readFile('electron/preload.js', 'utf8');
    expect(preload).toMatch(/exportData: \(opts\) => ipcRenderer\.invoke\('export-data', \{ includeSecrets: opts\?\.includeSecrets === true \}\)/);
    const main = await fsp.readFile('electron/main.js', 'utf8');
    expect(main).toMatch(/ipcMain\.handle\('export-data', async \(_event, opts = \{\}\) =>/);
    expect(main).toMatch(/includeSecrets: opts\?\.includeSecrets === true,/);
  });
});
