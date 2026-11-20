/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ScriptEditor builds its panel in the document,
 * and script-editor.js imports DOM-branching modules (notes/CLAUDE.md "Test
 * environments").
 */
// R3-20 (by reading in CB-01, also in v0.9.2): with a phone (or VR) session
// driving, the shared engine holds the PHONE video's script while the
// editor's path is still this window's video's. Opening the editor on an
// empty, clean script ran loadScript() from the engine, so the phone video's
// points appeared under this video's path, and a save wrote them over this
// video's script. A save of this window's edits also pushed them into the
// engine and the Handy the phone was driving.
//
// app.js tells the editor when the engine is not this window's
// (`engineHeldByRemote`, tests/unit/editor-remote-engine-app.test.js). Here a
// REAL ScriptEditor runs against an engine holding the phone's 12 points;
// what is asserted is what the editor shows and what lands on disk.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { showToast } = await import('../../renderer/js/toast.js');
const { _setBundlesForTests } = await import('../../renderer/js/i18n.js');
const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

// The toast's words, pinned so a missing key fails here. Added to the
// locales by the strings stage (strings-editor.json).
const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const ENX = structuredClone(EN);
ENX.editor.toast.remoteScriptNotShown = 'Your phone or VR headset is playing its own script, so the editor doesn\'t show it. The editor edits the video in this window.';

const LOCAL = 'C:\\sandbox\\library\\Alpha Scene.funscript';
const PHONE_POINTS = Array.from({ length: 12 }, (_, i) => ({ at: i * 400, pos: i % 2 ? 80 : 20 }));
const LOCAL_POINTS = Array.from({ length: 33 }, (_, i) => ({ at: i * 250, pos: i % 2 ? 90 : 10 }));

let disk;
let writes;

/** The shared engine, holding the phone video's script. */
function phoneEngine() {
  return {
    isLoaded: true,
    getActions: () => PHONE_POINTS.map((a) => ({ ...a })),
    getMetadata: () => null,
    reloadActions: vi.fn(),
    loadContent: vi.fn(async () => {}),
    getRawContent: () => JSON.stringify({ actions: PHONE_POINTS }),
  };
}

function realEditor({ engine, heldByRemote, localPoints }) {
  document.body.innerHTML = '<div id="player-container" data-video-path="C:\\sandbox\\library\\Alpha Scene.mp4"></div>';
  const video = Object.assign(new EventTarget(), { currentTime: 2, duration: 60, paused: true });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 2 });
  const handyManager = { connected: true };
  const ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: engine,
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
    syncEngine: { stop: vi.fn(), start: vi.fn() },
    handyManager,
    engineHeldByRemote: () => heldByRemote,
  });
  ed._sendLivePreview = () => {};
  ed.onReuploadHandy = vi.fn();
  // This window's video and its script, as the local load left them.
  ed.setFunscriptPath(LOCAL);
  if (localPoints) ed.editableScript.loadFromData({ version: '1.0', actions: localPoints });
  return ed;
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const pointsOnDisk = () => JSON.parse(disk[LOCAL]).actions.length;

beforeEach(() => {
  _setBundlesForTests('en', ENX, ENX);
  showToast.mockClear();
  // This video's script on disk is empty (made by the editor earlier).
  disk = { [LOCAL]: JSON.stringify({ version: '1.0', actions: [] }) };
  writes = [];
  window.funsync = {
    filesExist: async (paths) => paths.map((p) => p in disk),
    readFunscript: async (p) => disk[p] ?? null,
    writeFunscript: async (json, p) => { writes.push(p); disk[p] = json; return p; },
    saveFunscript: async () => null,
  };
});

afterEach(() => {
  delete window.funsync;
  document.body.innerHTML = '';
});

describe('the editor never shows or saves the phone\'s script as this video\'s (R3-20)', () => {
  it('opening it on this video\'s empty script does not pull in the phone\'s 12 points, and says why', async () => {
    const ed = realEditor({ engine: phoneEngine(), heldByRemote: true });
    ed.show();
    await settle();
    expect(ed.editableScript.actionCount).toBe(0);
    expect(ed.hasUnsavedChanges()).toBe(false);
    expect(showToast).toHaveBeenCalledWith(ENX.editor.toast.remoteScriptNotShown, 'info', 6000);
  });

  it('a save then writes this video\'s points, never the phone\'s, to this video\'s file', async () => {
    const ed = realEditor({ engine: phoneEngine(), heldByRemote: true });
    ed.show();
    await settle();
    ed.editableScript.insertAction(1000, 50);
    await ed._save();
    expect(writes).toEqual([LOCAL]);
    expect(JSON.parse(disk[LOCAL]).actions).toEqual([{ at: 1000, pos: 50 }]);
  });

  it('this window\'s edits saved during the session are not pushed into the engine the phone drives', async () => {
    const engine = phoneEngine();
    const ed = realEditor({ engine, heldByRemote: true, localPoints: LOCAL_POINTS });
    ed.show();
    await settle();
    expect(ed.editableScript.actionCount).toBe(33); // this video's own script
    ed.editableScript.insertAction(9000, 50);
    await ed._save();
    await settle();
    expect(pointsOnDisk()).toBe(34);
    expect(engine.reloadActions).not.toHaveBeenCalled();
    expect(ed.onReuploadHandy).not.toHaveBeenCalled();
  });

  it('with the engine on this window\'s own script, opening loads it as before', async () => {
    const engine = phoneEngine(); // here: this video's script
    const ed = realEditor({ engine, heldByRemote: false });
    ed.show();
    await settle();
    expect(ed.editableScript.actionCount).toBe(12);
    expect(showToast).not.toHaveBeenCalledWith(ENX.editor.toast.remoteScriptNotShown, expect.anything(), expect.anything());
    ed.editableScript.insertAction(9100, 50);
    await ed._save();
    await settle();
    expect(engine.reloadActions).toHaveBeenCalledTimes(1);
  });
});
