/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Block E2 verify-2 (also in v0.9.2): opening the player's variant menu on a
// video replaced the backend's whole video list with that one folder's
// videos. /api/remote/videos went from 40 to 1, and the phone, its playlists
// and DeoVR / HereSphere lost the rest of the library until the next full
// registration. The menu rescans the video's folder through `scan-directory`
// (app.js _refreshCurrentVariantsFromDisk), and main.js's handler POSTed
// every scan's result to /api/media/register, which REPLACES the registry.
// The collection dialog's per-source scans did the same.
//
// The REAL handler is lifted out of main.js and runs the REAL scan
// (electron/library-scan.js) on a real temp folder. The backend is a fake
// that does what routes/media.py does with a registration: `videos` replaces
// the list. What is asserted is what the phone would list afterwards, and
// that the scan still answers the menu.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liftMainHandler } from './helpers/main-handlers.js';

const require_ = createRequire(import.meta.url);
const { scanLibrary } = require_('../../electron/library-scan.js');

const quietLog = () => ({ info() {}, warn() {}, error() {}, debug() {} });

let tmp;
let registry;   // the backend's video list, as /api/remote/videos serves it
let posts;

/** /api/media/register as routes/media.py applies it: `videos` replaces the list. */
async function fakeBackendFetch(url, init = {}) {
  if (String(url).endsWith('/api/media/register') && init.method === 'POST') {
    posts.push(url);
    const data = JSON.parse(init.body);
    if ('videos' in data) registry = (data.videos || []).map((v) => v.path);
    return { ok: true, status: 200, json: async () => ({ registered: registry.length }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}

function scanDirectoryHandler() {
  return liftMainHandler('scan-directory', {
    scanLibrary,
    store: { getSetting: () => false },
    log: quietLog(),
    // What the old handler also used, so the old code runs here as it did in
    // the app (and its POST lands on the fake backend).
    path,
    fetch: fakeBackendFetch,
    require: () => ({ app: { getPath: () => tmp } }),
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'funsync-scan-noregister-'));
  posts = [];
  // The library's own full registration (library.js _registerWithBackend):
  // 40 videos across the library, as in the verifier's sandbox.
  registry = Array.from({ length: 40 }, (_, i) => path.join(tmp, 'library', `Bulk ${i + 1}.mp4`));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a folder rescan does not replace the backend\'s library (block E2 verify-2)', () => {
  it('the variant menu\'s rescan of a one-video folder: the phone still lists all 40', async () => {
    const journey = path.join(tmp, 'library', 'Journey');
    fs.mkdirSync(journey, { recursive: true });
    fs.writeFileSync(path.join(journey, 'Journey Video.mp4'), '');
    fs.writeFileSync(path.join(journey, 'Journey Video.funscript'), '{"actions":[]}');
    fs.writeFileSync(path.join(journey, 'Journey Video (soft).funscript'), '{"actions":[]}');

    const result = await scanDirectoryHandler()({}, journey, {});

    // The menu still gets its answer...
    const v = result.videos.find((x) => x.name === 'Journey Video.mp4');
    expect(v).toBeTruthy();
    expect(v.variants.map((x) => x.label)).toEqual(['Default', 'soft']);
    // ...and the backend keeps the library it had.
    expect(posts).toEqual([]);
    expect(registry).toHaveLength(40);
  });

  it('a scan of one source of several (the collection dialog): the same', async () => {
    const src = path.join(tmp, 'other');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'Only.mp4'), '');
    const result = await scanDirectoryHandler()({}, src, { [src]: 'Other' });
    expect(result.videos.map((x) => x.name)).toEqual(['Only.mp4']);
    expect(registry).toHaveLength(40);
  });
});
