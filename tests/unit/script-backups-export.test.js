/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// The .funsync-backup export never carries the script backups (editor work
// list 3.1, 2026-11-24). <userData>/script-backups holds old versions of the
// user's scripts, up to 20 each: shipping them in a backup the user may share
// would hand out every earlier version of every edited script, and an import
// on another machine has no use for them. The export reads only named things
// (config.json, the referenced custom thumbnails, stash/library.json); this
// pins that a script-backups folder beside them in the same userData stays
// out. Temp dirs only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const JSZip = require_('jszip');
const dataExport = require_('../../electron/data-export.js');
const { createScriptBackups } = require_('../../electron/script-backups.js');

const MARK = 'EARLIER-VERSION-MARKER-7f3c';

let tmp;
let userData;
beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'funsync-script-backups-export-'));
  userData = path.join(tmp, 'userData');
  await fsp.mkdir(userData);
});
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

describe('export and script backups', () => {
  it('a script-backups folder in userData never reaches the zip', async () => {
    // A real backup, made the way the write handlers make one.
    const lib = path.join(tmp, 'library');
    await fsp.mkdir(lib);
    const file = path.join(lib, 'Clip.funscript');
    fs.writeFileSync(file, JSON.stringify({ actions: [], note: MARK }));
    const backups = createScriptBackups({ getUserDataDir: () => userData, log: { warn() {} } });
    expect((await backups.backupBeforeWrite(file, '{"actions":[]}')).backedUp).toBe(true);
    expect(fs.readdirSync(path.join(userData, 'script-backups'))).toHaveLength(1);

    // The export's other userData sources, present beside it.
    const customThumbsDir = path.join(userData, 'custom-thumbs');
    const stashDir = path.join(userData, 'stash');
    await fsp.mkdir(customThumbsDir);
    await fsp.mkdir(stashDir);
    fs.writeFileSync(path.join(customThumbsDir, 'abc.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    const config = {
      settings: { library: { customThumbnails: { [path.join(lib, 'Clip.mp4')]: { type: 'image', imagePath: path.join(customThumbsDir, 'abc.jpg') } } } },
      playlists: [], categories: [], videoCategories: {},
    };

    const out = path.join(tmp, 'out.zip');
    const res = await dataExport.exportData(config, out, { customThumbsDir, stashDir });
    expect(res.success).toBe(true);
    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    const names = Object.keys(zip.files);
    expect(names.some((n) => /script-backups/i.test(n))).toBe(false);
    expect(names.some((n) => /index\.json$/.test(n))).toBe(false);
    // The export still works as before (the thumbnail rides along).
    expect(names).toContain('custom-thumbs/abc.jpg');
    const text = (await Promise.all(names.filter((n) => !zip.files[n].dir).map((n) => zip.file(n).async('string')))).join('\n');
    expect(text).not.toContain(MARK);
  });
});
