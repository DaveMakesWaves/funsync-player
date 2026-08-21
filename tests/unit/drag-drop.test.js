// Unit tests for DragDrop — imports from real source
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DragDrop } from '../../renderer/js/drag-drop.js';

describe('DragDrop', () => {
  let dd, onVideo, onFunscript, onSubtitle;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    onVideo = vi.fn();
    onFunscript = vi.fn();
    onSubtitle = vi.fn();
    dd = new DragDrop({
      dropZoneElement: null,
      onVideoFile: onVideo,
      onFunscriptFile: onFunscript,
      onSubtitleFile: onSubtitle,
    });
  });

  describe('file type routing on drop', () => {
    function dropFiles(files) {
      const event = new Event('drop', { bubbles: true });
      // Real OS file drops always expose `types: ['Files']`. DragDrop uses
      // that to ignore INTERNAL element drags (e.g. queue-panel row
      // reorder), which bubble to document but carry `text/*`, not Files.
      Object.defineProperty(event, 'dataTransfer', {
        value: { files, types: ['Files'] },
      });
      event.preventDefault = vi.fn();
      document.dispatchEvent(event);
    }

    it('routes .mp4 to onVideoFile', () => {
      dropFiles([new File([''], 'video.mp4')]);
      expect(onVideo).toHaveBeenCalledTimes(1);
      expect(onFunscript).not.toHaveBeenCalled();
    });

    it('routes .mkv to onVideoFile', () => {
      dropFiles([new File([''], 'video.mkv')]);
      expect(onVideo).toHaveBeenCalledTimes(1);
    });

    it('routes .webm to onVideoFile', () => {
      dropFiles([new File([''], 'clip.webm')]);
      expect(onVideo).toHaveBeenCalledTimes(1);
    });

    it('routes .funscript to onFunscriptFile', () => {
      dropFiles([new File(['{}'], 'script.funscript')]);
      expect(onFunscript).toHaveBeenCalledTimes(1);
      expect(onVideo).not.toHaveBeenCalled();
    });

    it('routes .srt to onSubtitleFile', () => {
      dropFiles([new File([''], 'subs.srt')]);
      expect(onSubtitle).toHaveBeenCalledTimes(1);
    });

    it('routes .vtt to onSubtitleFile', () => {
      dropFiles([new File([''], 'subs.vtt')]);
      expect(onSubtitle).toHaveBeenCalledTimes(1);
    });

    it('ignores unknown file types', () => {
      dropFiles([new File([''], 'readme.txt')]);
      expect(onVideo).not.toHaveBeenCalled();
      expect(onFunscript).not.toHaveBeenCalled();
      expect(onSubtitle).not.toHaveBeenCalled();
    });

    it('routes multiple files of different types', () => {
      dropFiles([
        new File([''], 'video.mp4'),
        new File(['{}'], 'script.funscript'),
      ]);
      expect(onVideo).toHaveBeenCalledTimes(1);
      expect(onFunscript).toHaveBeenCalledTimes(1);
    });

    it('ignores INTERNAL drags (no Files type) — e.g. queue-panel reorder', () => {
      // An internal HTML5 element drag bubbles to document but carries
      // text/* data, not Files. DragDrop must not treat it as a file drop
      // (previously it did → drop-zone overlay covered the queue and the
      // reorder drop never landed).
      const event = new Event('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { files: [new File([''], 'video.mp4')], types: ['text/plain'] },
      });
      event.preventDefault = vi.fn();
      document.dispatchEvent(event);
      expect(onVideo).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('drag events with no drop zone', () => {
    it('does not throw on dragenter without drop zone', () => {
      const event = new Event('dragenter', { bubbles: true });
      event.preventDefault = vi.fn();
      expect(() => document.dispatchEvent(event)).not.toThrow();
    });

    it('does not throw on drop without drop zone', () => {
      const event = new Event('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [] } });
      event.preventDefault = vi.fn();
      expect(() => document.dispatchEvent(event)).not.toThrow();
    });
  });

  describe('native dialog (browse button)', () => {
    it('calls openFileDialog on button click', async () => {
      // Add a browse button to DOM
      const btn = document.createElement('button');
      btn.id = 'btn-browse';
      document.body.appendChild(btn);

      // Recreate DragDrop to pick up the button
      const dd2 = new DragDrop({
        dropZoneElement: null,
        onVideoFile: onVideo,
        onFunscriptFile: onFunscript,
      });

      window.funsync.openFileDialog.mockResolvedValue([
        { name: 'clip.mp4', path: '/path/clip.mp4', _isPathBased: true },
      ]);

      btn.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(window.funsync.openFileDialog).toHaveBeenCalled();
    });
  });

  // terijapl, thread #284: "when drag-and-dropping a video onto the program
  // window, the ctrl+shift+R shortcut does not work and displays the 'no
  // video loaded' message".
  //
  // Electron REMOVED the non-standard `File.path` in v32 and this project is
  // on 41, so a dropped File arrived with `path === undefined`. app.js does
  //     this._currentVideoPath = file._remote ? null : (file.path || null)
  // which left it NULL, switching off every path-keyed feature: the VR format
  // panel he hit, plus funscript auto-pairing, resume, script variations,
  // queue context, screenshots, remux-on-decode-error and the editor's
  // autosave target. Playback still worked, because it falls back to a blob
  // URL — which is precisely why this survived. The drop looked successful.
  //
  // The native-dialog path never had the bug: it gets a real path over IPC
  // and tags the object `_isPathBased`. So the fix is to make a drop produce
  // the SAME shape, via webUtils.getPathForFile exposed through the preload.
  describe('resolving the real path of a dropped file', () => {
    function dropFiles(files) {
      const event = new Event('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { files, types: ['Files'] },
      });
      document.dispatchEvent(event);
    }

    afterEach(() => { delete window.funsync; });

    it('hands a video to loadVideo in the path-based shape the dialog uses', () => {
      window.funsync = { getPathForFile: vi.fn(() => 'D:\VR\clip.mp4') };
      dropFiles([new File([''], 'clip.mp4')]);

      const arg = onVideo.mock.calls[0][0];
      expect(arg.path).toBe('D:\VR\clip.mp4');
      // Without this flag app.js takes the blob branch and never builds a
      // file:// URL, so the path would be carried but unused.
      expect(arg._isPathBased).toBe(true);
      expect(arg.name).toBe('clip.mp4');
    });

    // The actual regression, stated as app.js states it.
    it('yields a non-null _currentVideoPath, which is what Ctrl+Shift+R needs', () => {
      window.funsync = { getPathForFile: () => '/home/teri/vr/clip.mp4' };
      dropFiles([new File([''], 'clip.mp4')]);

      const file = onVideo.mock.calls[0][0];
      const currentVideoPath = file._remote ? null : (file.path || null);
      expect(currentVideoPath, 'null here is the "no video loaded" toast').not.toBeNull();
    });

    it('gives a dropped funscript a path for the editor autosave target', () => {
      window.funsync = { getPathForFile: () => '/home/teri/vr/clip.funscript' };
      dropFiles([new File(['{}'], 'clip.funscript')]);
      expect(onFunscript.mock.calls[0][0].path).toBe('/home/teri/vr/clip.funscript');
    });

    it('keeps a dropped funscript readable as a File', async () => {
      window.funsync = { getPathForFile: () => '/x/clip.funscript' };
      dropFiles([new File(['{"actions":[]}'], 'clip.funscript')]);
      // Assigning .path must not replace the File — app.js still calls
      // file.text() on the drop path.
      const f = onFunscript.mock.calls[0][0];
      expect(typeof f.text).toBe('function');
      expect(await f.text()).toContain('actions');
    });

    it('resolves a path for subtitles too', () => {
      window.funsync = { getPathForFile: () => '/x/subs.srt' };
      dropFiles([new File([''], 'subs.srt')]);
      expect(onSubtitle.mock.calls[0][0].path).toBe('/x/subs.srt');
    });

    // Everything below is the fallback: playback must never regress just
    // because a path could not be resolved.
    it('falls back to the raw File when there is no real path', () => {
      window.funsync = { getPathForFile: () => '' };
      const f = new File([''], 'clip.mp4');
      dropFiles([f]);
      expect(onVideo).toHaveBeenCalledWith(f);
    });

    it('falls back when the bridge is missing entirely', () => {
      const f = new File([''], 'clip.mp4');
      dropFiles([f]);
      expect(onVideo).toHaveBeenCalledWith(f);
    });

    it('falls back when the resolver throws', () => {
      window.funsync = { getPathForFile: () => { throw new Error('no path'); } };
      const f = new File([''], 'clip.mp4');
      dropFiles([f]);
      expect(onVideo).toHaveBeenCalledWith(f);
    });

    it('resolves each file in a multi-file drop independently', () => {
      window.funsync = {
        getPathForFile: (f) => (f.name.endsWith('.mp4') ? '/x/clip.mp4' : '/x/clip.funscript'),
      };
      dropFiles([new File([''], 'clip.mp4'), new File(['{}'], 'clip.funscript')]);
      expect(onVideo.mock.calls[0][0].path).toBe('/x/clip.mp4');
      expect(onFunscript.mock.calls[0][0].path).toBe('/x/clip.funscript');
    });
  });
});
