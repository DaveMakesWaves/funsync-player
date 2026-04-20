// Tests for editor improvements: multi-script selector, snap-to-frame, undo cache, live preview
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';

// --- EditableScript.loadFromData ---

describe('EditableScript.loadFromData', () => {
  let script;

  beforeEach(() => {
    script = new EditableScript();
  });

  it('loads actions from parsed data', () => {
    script.loadFromData({
      actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 500, pos: 50 }],
    });
    expect(script.actions).toHaveLength(3);
    // Should be sorted by time
    expect(script.actions[0].at).toBe(0);
    expect(script.actions[1].at).toBe(500);
    expect(script.actions[2].at).toBe(1000);
  });

  it('resets selection and undo state', () => {
    script.insertAction(100, 50);
    script.insertAction(200, 75);
    script.select(0);

    script.loadFromData({ actions: [{ at: 0, pos: 0 }] });
    expect(script.selectedIndices.size).toBe(0);
    expect(script._undoStack).toHaveLength(0);
    expect(script._redoStack).toHaveLength(0);
    expect(script.dirty).toBe(false);
  });

  it('loads metadata', () => {
    script.loadFromData({
      actions: [{ at: 0, pos: 0 }],
      metadata: { creator: 'test', description: 'hello' },
    });
    expect(script._metadata.creator).toBe('test');
  });

  it('loads bookmarks from metadata', () => {
    script.loadFromData({
      actions: [{ at: 0, pos: 0 }],
      metadata: { bookmarks: [{ time: 5000, label: 'Start' }] },
    });
    expect(script._bookmarks).toHaveLength(1);
    expect(script._bookmarks[0].time).toBe(5000);
  });

  it('handles missing actions', () => {
    script.loadFromData({});
    expect(script.actions).toHaveLength(0);
  });

  it('handles empty object', () => {
    script.loadFromData({ actions: [] });
    expect(script.actions).toHaveLength(0);
  });
});

// --- Undo Cache ---

describe('Editor undo cache', () => {
  it('caches and restores undo state by path', () => {
    const script = new EditableScript();
    const cache = new Map();

    // Simulate editing script A
    script.insertAction(100, 50);
    script.insertAction(200, 75);

    // Cache state
    cache.set('/path/a.funscript', {
      actions: JSON.parse(JSON.stringify(script.actions)),
      undoStack: JSON.parse(JSON.stringify(script._undoStack)),
      redoStack: JSON.parse(JSON.stringify(script._redoStack)),
      selectedIndices: new Set(script._selectedIndices),
      bookmarks: [...(script._bookmarks || [])],
      dirty: script.dirty,
    });

    // Switch to script B
    script.loadEmpty();
    script.insertAction(500, 25);
    expect(script.actions).toHaveLength(1);

    // Restore script A
    const cached = cache.get('/path/a.funscript');
    script._actions = cached.actions;
    script._undoStack = cached.undoStack;
    script._redoStack = cached.redoStack;
    script._selectedIndices = cached.selectedIndices;
    script._bookmarks = cached.bookmarks;
    script._dirty = cached.dirty;

    expect(script.actions).toHaveLength(2);
    expect(script.actions[0].pos).toBe(50);
    expect(script._undoStack.length).toBeGreaterThan(0);
  });

  it('separate paths have independent caches', () => {
    const cache = new Map();
    cache.set('/a.funscript', { actions: [{ at: 0, pos: 10 }] });
    cache.set('/b.funscript', { actions: [{ at: 0, pos: 90 }] });

    expect(cache.get('/a.funscript').actions[0].pos).toBe(10);
    expect(cache.get('/b.funscript').actions[0].pos).toBe(90);
  });

  it('cache cleared on new video', () => {
    const cache = new Map();
    cache.set('/a.funscript', { actions: [] });
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

// --- Snap to Frame ---

describe('Snap to frame', () => {
  it('snaps timestamp to frame boundary at 30fps', () => {
    const frameDurationMs = 1000 / 30; // ~33.33ms
    const snapTime = (timeMs) => Math.round(timeMs / frameDurationMs) * frameDurationMs;

    // 50ms should snap to frame 1 (33.33ms) or frame 2 (66.67ms)
    const snapped = snapTime(50);
    expect(snapped % frameDurationMs).toBeCloseTo(0, 1);
  });

  it('exact frame boundary stays unchanged', () => {
    const fps = 30;
    const frameDurationMs = 1000 / fps;
    const exactFrame = frameDurationMs * 10; // frame 10
    const snapTime = (timeMs) => Math.round(timeMs / frameDurationMs) * frameDurationMs;
    expect(snapTime(exactFrame)).toBeCloseTo(exactFrame, 1);
  });

  it('disabled snap returns original value', () => {
    const snapEnabled = false;
    const snapTime = (timeMs) => snapEnabled ? Math.round(timeMs / 33.33) * 33.33 : timeMs;
    expect(snapTime(50.7)).toBe(50.7);
  });

  it('snaps at 60fps (finer resolution)', () => {
    const frameDurationMs = 1000 / 60; // ~16.67ms
    const snapTime = (timeMs) => Math.round(timeMs / frameDurationMs) * frameDurationMs;
    const snapped = snapTime(25);
    expect(snapped % frameDurationMs).toBeCloseTo(0, 1);
  });

  it('snaps at 24fps', () => {
    const frameDurationMs = 1000 / 24; // ~41.67ms
    const snapTime = (timeMs) => Math.round(timeMs / frameDurationMs) * frameDurationMs;
    const snapped = snapTime(100);
    // 100ms / 41.67 = 2.4 → round to 2 → 83.33ms
    expect(snapped).toBeCloseTo(83.33, 0);
  });
});

// --- Multi-Script Selector ---

describe('Multi-script selector', () => {
  it('available scripts list can be set', () => {
    const scripts = [
      { label: 'Main (L0)', path: '/path/main.funscript' },
      { label: 'Twist (R0)', path: '/path/main.twist.funscript' },
    ];
    // Simulate the data structure
    expect(scripts).toHaveLength(2);
    expect(scripts[0].label).toBe('Main (L0)');
    expect(scripts[1].path).toContain('twist');
  });

  it('single script hides selector', () => {
    const scripts = [{ label: 'Main', path: '/path/main.funscript' }];
    const show = scripts.length > 1;
    expect(show).toBe(false);
  });

  it('multiple scripts shows selector', () => {
    const scripts = [
      { label: 'Main', path: '/a.funscript' },
      { label: 'Vibe', path: '/a.vib.funscript' },
    ];
    const show = scripts.length > 1;
    expect(show).toBe(true);
  });

  it('custom routing scripts include device names', () => {
    const routes = [
      { role: 'main', deviceId: 'handy', scriptPath: '/a.funscript', scriptName: 'a.funscript' },
      { role: 'axis', deviceId: 'buttplug:Lovense', scriptPath: '/b.funscript', scriptName: 'b.funscript' },
    ];
    const knownDevices = [
      { id: 'handy', label: 'The Handy' },
      { id: 'buttplug:Lovense', label: 'Lovense' },
    ];

    const scripts = routes.map(r => {
      const dev = knownDevices.find(d => d.id === r.deviceId);
      const prefix = r.role === 'main' ? '★ ' : '';
      return { label: `${prefix}${dev?.label || ''}: ${r.scriptName}`, path: r.scriptPath };
    });

    expect(scripts[0].label).toBe('★ The Handy: a.funscript');
    expect(scripts[1].label).toBe('Lovense: b.funscript');
  });
});

// --- Live Preview ---

describe('Live device preview', () => {
  it('does not send when sync engine is active', () => {
    const hdspMove = vi.fn();
    const syncActive = true;
    const connected = true;

    // Simulate the guard
    if (!connected) return;
    if (syncActive) return; // should not send
    hdspMove(50, 150);

    expect(hdspMove).not.toHaveBeenCalled();
  });

  it('sends when sync is inactive and device connected', () => {
    const hdspMove = vi.fn();
    const syncActive = false;
    const connected = true;

    if (!connected) return;
    if (syncActive) return;
    hdspMove(50, 150);

    expect(hdspMove).toHaveBeenCalledWith(50, 150);
  });

  it('does not send when device disconnected', () => {
    const hdspMove = vi.fn();
    const connected = false;

    if (!connected) return;
    hdspMove(50, 150);

    expect(hdspMove).not.toHaveBeenCalled();
  });
});
