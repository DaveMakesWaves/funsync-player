// Unit tests for DragDrop — imports from real source
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      Object.defineProperty(event, 'dataTransfer', {
        value: { files },
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
});
