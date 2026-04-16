// Unit tests for FunscriptEngine — imports from real source
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FunscriptEngine, isAutoMatch } from '../../renderer/js/funscript-engine.js';

// --- isAutoMatch (standalone export) ---

describe('isAutoMatch', () => {
  it('matches same base name', () => {
    expect(isAutoMatch('video.mp4', 'video.funscript')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isAutoMatch('Video.MP4', 'video.funscript')).toBe(true);
  });

  it('does not match different names', () => {
    expect(isAutoMatch('video.mp4', 'other.funscript')).toBe(false);
  });

  it('matches with complex filenames', () => {
    expect(isAutoMatch('My.Video.File.mp4', 'My.Video.File.funscript')).toBe(true);
  });

  it('does not match partial names', () => {
    expect(isAutoMatch('video-full.mp4', 'video.funscript')).toBe(false);
  });

  it('normalizes underscores and hyphens', () => {
    expect(isAutoMatch('my_video.mp4', 'my-video.funscript')).toBe(true);
  });

  it('handles no extension', () => {
    expect(isAutoMatch('video', 'video')).toBe(true);
  });
});

// --- FunscriptEngine class ---

describe('FunscriptEngine', () => {
  let engine;

  const validFunscript = JSON.stringify({
    version: '1.0',
    inverted: false,
    range: 100,
    actions: [
      { at: 0, pos: 0 },
      { at: 500, pos: 100 },
      { at: 1000, pos: 50 },
    ],
  });

  beforeEach(() => {
    engine = new FunscriptEngine({ backendPort: 5123 });
    vi.clearAllMocks();
    window.funsync.convertFunscript.mockResolvedValue({
      csv: '0,0\n500,100\n1000,50',
      hash: 'abc123',
      local_url: 'http://localhost:5123/scripts/abc123.csv',
      size_bytes: 24,
      action_count: 3,
      duration_ms: 1000,
    });
  });

  describe('loadContent', () => {
    it('parses valid funscript JSON', async () => {
      const info = await engine.loadContent(validFunscript, 'test.funscript');
      expect(info.filename).toBe('test.funscript');
      expect(info.actionCount).toBe(3);
      expect(info.durationMs).toBe(1000);
      expect(info.version).toBe('1.0');
    });

    it('sorts actions by timestamp', async () => {
      const unsorted = JSON.stringify({
        actions: [
          { at: 1000, pos: 50 },
          { at: 0, pos: 0 },
          { at: 500, pos: 100 },
        ],
      });
      await engine.loadContent(unsorted);
      const actions = engine.getActions();
      expect(actions[0].at).toBe(0);
      expect(actions[1].at).toBe(500);
      expect(actions[2].at).toBe(1000);
    });

    it('throws on invalid JSON', async () => {
      await expect(engine.loadContent('not json')).rejects.toThrow('Invalid funscript JSON');
    });

    it('throws on missing actions array', async () => {
      await expect(engine.loadContent('{"version": "1.0"}')).rejects.toThrow('missing "actions"');
    });

    it('throws on empty actions', async () => {
      await expect(engine.loadContent('{"actions": []}')).rejects.toThrow('no actions');
    });

    it('calls convertFunscript via IPC', async () => {
      await engine.loadContent(validFunscript);
      expect(window.funsync.convertFunscript).toHaveBeenCalledWith(validFunscript);
    });

    it('handles backend conversion failure gracefully', async () => {
      window.funsync.convertFunscript.mockRejectedValue(new Error('fail'));
      const info = await engine.loadContent(validFunscript);
      expect(info.actionCount).toBe(3);
      expect(info.localUrl).toBeNull();
    });
  });

  describe('getPositionAt', () => {
    beforeEach(async () => {
      await engine.loadContent(validFunscript);
    });

    it('returns first position before first action', () => {
      expect(engine.getPositionAt(-100)).toBe(0);
    });

    it('returns last position after last action', () => {
      expect(engine.getPositionAt(2000)).toBe(50);
    });

    it('returns exact position at action time', () => {
      expect(engine.getPositionAt(0)).toBe(0);
      expect(engine.getPositionAt(500)).toBe(100);
      expect(engine.getPositionAt(1000)).toBe(50);
    });

    it('interpolates between actions', () => {
      expect(engine.getPositionAt(250)).toBe(50); // midpoint 0→100
    });

    it('interpolates second segment', () => {
      expect(engine.getPositionAt(750)).toBe(75); // midpoint 100→50
    });

    it('returns 50 when no funscript loaded', () => {
      const fresh = new FunscriptEngine({ backendPort: 5123 });
      expect(fresh.getPositionAt(100)).toBe(50);
    });
  });

  describe('getInfo', () => {
    it('returns null when nothing loaded', () => {
      expect(engine.getInfo()).toBeNull();
    });

    it('returns complete info after load', async () => {
      const info = await engine.loadContent(validFunscript, 'test.funscript');
      expect(info).toEqual({
        filename: 'test.funscript',
        version: '1.0',
        inverted: false,
        range: 100,
        actionCount: 3,
        durationMs: 1000,
        durationFormatted: '0:01',
        localUrl: 'http://localhost:5123/scripts/abc123.csv',
        csvHash: 'abc123',
        csvSizeBytes: 24,
      });
    });
  });

  describe('getActions', () => {
    it('returns null when nothing loaded', () => {
      expect(engine.getActions()).toBeNull();
    });

    it('returns actions array after load', async () => {
      await engine.loadContent(validFunscript);
      const actions = engine.getActions();
      expect(actions.length).toBe(3);
    });
  });

  describe('isLoaded', () => {
    it('is false initially', () => {
      expect(engine.isLoaded).toBe(false);
    });

    it('is true after loading', async () => {
      await engine.loadContent(validFunscript);
      expect(engine.isLoaded).toBe(true);
    });

    it('is false after clearing', async () => {
      await engine.loadContent(validFunscript);
      engine.clear();
      expect(engine.isLoaded).toBe(false);
    });
  });

  describe('clear', () => {
    it('resets all state', async () => {
      await engine.loadContent(validFunscript);
      engine.clear();
      expect(engine.getActions()).toBeNull();
      expect(engine.getInfo()).toBeNull();
      expect(engine.getRawContent()).toBeNull();
    });
  });

  describe('reloadActions', () => {
    it('replaces actions and re-sorts', async () => {
      await engine.loadContent(validFunscript);
      engine.reloadActions([
        { at: 2000, pos: 75 },
        { at: 500, pos: 25 },
      ]);
      const actions = engine.getActions();
      expect(actions.length).toBe(2);
      expect(actions[0].at).toBe(500);
      expect(actions[1].at).toBe(2000);
    });

    it('updates actionCount and durationMs', async () => {
      await engine.loadContent(validFunscript);
      engine.reloadActions([{ at: 3000, pos: 50 }]);
      const info = engine.getInfo();
      expect(info.actionCount).toBe(1);
      expect(info.durationMs).toBe(3000);
    });

    it('does nothing when nothing is loaded', () => {
      engine.reloadActions([{ at: 1000, pos: 50 }]);
      expect(engine.getActions()).toBeNull();
    });
  });

  describe('getMetadata', () => {
    it('returns metadata excluding actions', async () => {
      await engine.loadContent(validFunscript);
      const meta = engine.getMetadata();
      expect(meta.version).toBe('1.0');
      expect(meta.actions).toBeUndefined();
    });

    it('returns null when nothing loaded', () => {
      expect(engine.getMetadata()).toBeNull();
    });
  });

  describe('formatDuration (via getInfo)', () => {
    it('formats zero', async () => {
      const content = JSON.stringify({ actions: [{ at: 0, pos: 50 }] });
      await engine.loadContent(content);
      expect(engine.getInfo().durationFormatted).toBe('0:00');
    });

    it('formats minutes and seconds', async () => {
      const content = JSON.stringify({
        actions: [
          { at: 0, pos: 0 },
          { at: 125000, pos: 100 },
        ],
      });
      await engine.loadContent(content);
      expect(engine.getInfo().durationFormatted).toBe('2:05');
    });
  });
});
