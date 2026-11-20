/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL index.html player markup, the REAL ScriptEditor
 * panel and the REAL player.css + editor.css through jsdom's cascade
 * (getComputedStyle). See notes/CLAUDE.md "Test environments".
 */
// R4 fix-up (real-app verifier 2, low, also in v0.9.2): with the script editor
// open, Back into the mini player docked the whole player container, editor
// included, into the 340x191 corner. The corner showed the editor's graph
// instead of the video, and its canvas lay over the mini bar: Play / pause,
// Back to player and Close could not be clicked (elementFromPoint on all
// three found CANVAS.editor__canvas). Esc closing the editor was the only way
// out.
//
// jsdom has no layout (no elementFromPoint), so what is asserted is what the
// cascade gives: the editor panel is not displayed in the mini player, the
// video wrapper fills the corner again, and the expanded player shows the
// editor as before (it stays open underneath, with its edits).
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../renderer/js/toast.js', () => ({ showToast: vi.fn() }));

const { ScriptEditor } = await import('../../renderer/components/script-editor.js');

const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(fs.readFileSync('renderer/index.html', 'utf8'))[1]
  .replace(/<script[\s\S]*?<\/script>/g, '');
const SHEETS = ['player.css', 'editor.css'];
let css = '';

beforeAll(() => {
  css = SHEETS.map((f) => fs.readFileSync(`renderer/styles/${f}`, 'utf8')).join('\n');
});

let ed;
const container = () => document.getElementById('player-container');
const wrapper = () => document.getElementById('video-wrapper');
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(async () => {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = BODY;
  container().hidden = false;
  window.funsync = {
    filesExist: async (paths) => paths.map(() => false),
    readFunscript: async () => null,
    writeFunscript: async (_json, p) => p,
  };
  const video = Object.assign(new EventTarget(), { currentTime: 2, duration: 60, paused: false });
  const videoPlayer = Object.assign(new EventTarget(), { video, duration: 60, currentTime: 2 });
  ed = new ScriptEditor({
    videoPlayer,
    funscriptEngine: { isLoaded: false, getActions: () => [], getMetadata: () => null },
    progressBar: { renderHeatmap() {} },
    settings: { get: () => undefined, set() {} },
  });
  ed._sendLivePreview = () => {};
  ed.show(); // E in the player view
  await settle();
  ed.editableScript.insertAction(1000, 50); // an unsaved edit
});

afterEach(() => {
  delete window.funsync;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('the mini player with the script editor open (R4 fix-up)', () => {
  it('in the full player the editor shows and the video sits above it, as before', () => {
    expect(container().classList.contains('player-container--editor-open')).toBe(true);
    expect(getComputedStyle(ed._panel).display).not.toBe('none');
    expect(getComputedStyle(wrapper()).height).not.toBe('100%');
  });

  it('Back into the mini player (app.js _enterMiniplayer): the editor is not drawn, the video fills the corner', () => {
    container().classList.add('player-container--mini');
    expect(getComputedStyle(ed._panel).display).toBe('none');
    expect(getComputedStyle(wrapper()).height).toBe('100%');
    // The mini bar is drawn in the corner (the editor no longer lies over it).
    expect(getComputedStyle(document.getElementById('miniplayer-bar')).display).toBe('flex');
  });

  it('expanded again: the editor is back, still open, with its unsaved edit', () => {
    container().classList.add('player-container--mini');
    container().classList.remove('player-container--mini');
    expect(getComputedStyle(ed._panel).display).not.toBe('none');
    expect(ed.isOpen).toBe(true);
    expect(ed.editableScript.actionCount).toBe(1);
    expect(ed.hasUnsavedChanges()).toBe(true);
  });
});
