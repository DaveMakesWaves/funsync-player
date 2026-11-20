/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL DragDrop listens on `document` and builds Files
 * (notes/CLAUDE.md "Test environments").
 */
// R3-16 (found while CB-01 review, also in v0.9.2, clean editor too): a drop
// or Browse pick whose subtitle or funscript came BEFORE the video in the
// file list loaded it onto the OLD video, and the new video's load then
// cleared the subtitle (`clearSubtitles`) or replaced the script. DragDrop
// handed the files over in the list's order. Now the video goes first,
// whatever the order, and what came with it lands on the new video.
//
// The REAL DragDrop and the REAL `_dragDropOptions` wiring (lifted from
// app.js) run against an app stand-in whose loadVideo does what the real one
// does to these two things: it clears the subtitle and the loaded script.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { DragDrop } from '../../renderer/js/drag-drop.js';

const VIDEO = 'C:\\sandbox\\library\\New Clip.mp4';
const SCRIPT = 'C:\\sandbox\\library\\New Clip.funscript';
const SUB = 'C:\\sandbox\\library\\New Clip.srt';
const PATHS = { 'New Clip.mp4': VIDEO, 'New Clip.funscript': SCRIPT, 'New Clip.srt': SUB };

let app;
let dragDrop;

function buildApp({ editor = null } = {}) {
  const Lifted = liftAppClass(['_dragDropOptions', '_clearPlaySession', '_editorAllowsReplace', '_readFunscriptFileAgain'], {
    showToast: vi.fn(),
    console: { warn: () => {}, log: () => {} },
  });
  const state = { video: 'C:\\sandbox\\library\\Old Clip.mp4', script: 'Old Clip.funscript', subtitle: null };
  const a = Object.assign(new Lifted(), {
    state,
    scriptEditor: editor,
    _playerWindowActive: false,
    // A dropped video ends any list (FT-074); nothing here plays a list.
    _setUpNextContext() {},
    _updateQueueUI() {},
    _updateQueuePanelState() {},
    // What the real loadVideo does to these: the old video's subtitle and
    // script go (videoPlayer.clearSubtitles, funscriptEngine.clear).
    loadVideo: vi.fn((file) => {
      state.video = file.path || file.name;
      state.subtitle = null;
      state.script = null;
    }),
    loadFunscript: vi.fn((file) => { state.script = `${file.name} on ${state.video.split('\\').pop()}`; }),
    videoPlayer: {
      loadSubtitles: vi.fn((file) => { state.subtitle = `${file.name} on ${state.video.split('\\').pop()}`; }),
    },
  });
  return a;
}

function dropFiles(names) {
  const files = names.map((n) => new File(['{"actions":[]}'], n));
  const e = new Event('drop', { bubbles: true, cancelable: true });
  e.dataTransfer = { types: ['Files'], files };
  document.dispatchEvent(e);
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.funsync = {
    getPathForFile: (file) => PATHS[file.name] || '',
    readFunscript: async () => '{"actions":[]}',
  };
});

afterEach(() => {
  delete window.funsync;
});

// DragDrop has no unbind: an earlier test's instance still hears later drops,
// but it drives that test's own app, never the one a test asserts on.
function wire(opts) {
  app = buildApp(opts);
  dragDrop = new DragDrop({ dropZoneElement: null, ...app._dragDropOptions() });
}

describe('R3-16: a drop loads the video first, whatever the file order', () => {
  const ORDERS = [
    ['New Clip.srt', 'New Clip.funscript', 'New Clip.mp4'],
    ['New Clip.funscript', 'New Clip.mp4', 'New Clip.srt'],
    ['New Clip.srt', 'New Clip.mp4', 'New Clip.funscript'],
    ['New Clip.mp4', 'New Clip.funscript', 'New Clip.srt'],
  ];

  for (const order of ORDERS) {
    it(`[${order.join(', ')}]: the script and the subtitle end up on New Clip`, async () => {
      wire();
      dropFiles(order);
      await new Promise((r) => setTimeout(r, 0));
      expect(app.state).toEqual({
        video: VIDEO,
        script: 'New Clip.funscript on New Clip.mp4',
        subtitle: 'New Clip.srt on New Clip.mp4',
      });
      expect(app.loadVideo).toHaveBeenCalledTimes(1);
    });
  }

  it('a script or subtitle dropped on its own still lands on the video that is open', async () => {
    wire();
    dropFiles(['New Clip.srt', 'New Clip.funscript']);
    await new Promise((r) => setTimeout(r, 0));
    expect(app.loadVideo).not.toHaveBeenCalled();
    expect(app.state.script).toBe('New Clip.funscript on Old Clip.mp4');
    expect(app.state.subtitle).toBe('New Clip.srt on Old Clip.mp4');
  });

  it('with unsaved edits: one question, and after it the same order (video, then script, then subtitle)', async () => {
    let release;
    const editor = {
      _unsavedPrompt: null,
      confirmBeforeReplace() {
        if (this._unsavedPrompt) return Promise.resolve(false);
        this._unsavedPrompt = new Promise((r) => { release = r; });
        return this._unsavedPrompt.then((go) => { this._unsavedPrompt = null; return go; });
      },
    };
    wire({ editor });
    dropFiles(['New Clip.funscript', 'New Clip.srt', 'New Clip.mp4']);
    await new Promise((r) => setTimeout(r, 0));
    expect(app.loadVideo).not.toHaveBeenCalled(); // waiting on the answer
    release(true);
    await vi.waitFor(() => expect(app.state.subtitle).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(app.state).toEqual({
      video: VIDEO,
      script: 'New Clip.funscript on New Clip.mp4',
      subtitle: 'New Clip.srt on New Clip.mp4',
    });
  });
});

describe('R3-16: a Browse pick does the same', () => {
  it('[subtitle, script, video] from the dialog: both land on New Clip', async () => {
    wire();
    window.funsync.openFileDialog = async () => [
      { name: 'New Clip.srt', path: SUB, textContent: '1\n00:00:01,000 --> 00:00:02,000\nhi\n' },
      { name: 'New Clip.funscript', path: SCRIPT, textContent: '{"actions":[]}' },
      { name: 'New Clip.mp4', path: VIDEO },
    ];
    await dragDrop._openNativeDialog();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.state).toEqual({
      video: VIDEO,
      script: 'New Clip.funscript on New Clip.mp4',
      subtitle: 'New Clip.srt on New Clip.mp4',
    });
  });
});
