// Integration tests using the real Test.funscript file through FunscriptEngine
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FunscriptEngine } from '../../renderer/js/funscript-engine.js';

// Read the actual test funscript
const funscriptPath = join(__dirname, '..', '..', 'Test.funscript');
const rawContent = readFileSync(funscriptPath, 'utf-8');
const funscriptData = JSON.parse(rawContent);

describe('Real Test.funscript parsing', () => {
  it('has valid structure', () => {
    expect(funscriptData.version).toBe('1.0');
    expect(funscriptData.inverted).toBe(false);
    expect(funscriptData.range).toBe(100);
    expect(Array.isArray(funscriptData.actions)).toBe(true);
  });

  it('has many actions', () => {
    expect(funscriptData.actions.length).toBeGreaterThan(100);
  });

  it('all actions have at and pos', () => {
    for (const action of funscriptData.actions) {
      expect(typeof action.at).toBe('number');
      expect(typeof action.pos).toBe('number');
    }
  });

  it('all positions are 0–100', () => {
    for (const action of funscriptData.actions) {
      expect(action.pos).toBeGreaterThanOrEqual(0);
      expect(action.pos).toBeLessThanOrEqual(100);
    }
  });

  it('actions are sorted by timestamp', () => {
    for (let i = 1; i < funscriptData.actions.length; i++) {
      expect(funscriptData.actions[i].at).toBeGreaterThanOrEqual(funscriptData.actions[i - 1].at);
    }
  });

  it('spans at least 100 seconds', () => {
    const lastAction = funscriptData.actions[funscriptData.actions.length - 1];
    expect(lastAction.at).toBeGreaterThan(100000);
  });

  it('has metadata with duration', () => {
    expect(funscriptData.metadata).toBeDefined();
    expect(funscriptData.metadata.duration).toBe(220);
  });
});

// Test through the real FunscriptEngine class
describe('FunscriptEngine with real Test.funscript', () => {
  let engine;

  beforeAll(async () => {
    vi.clearAllMocks();
    window.funsync.convertFunscript.mockResolvedValue({
      csv: funscriptData.actions.map((a) => `${a.at},${a.pos}`).join('\n'),
      hash: 'integration-test',
      local_url: 'http://localhost:5123/scripts/integration-test.csv',
      size_bytes: 1000,
      action_count: funscriptData.actions.length,
      duration_ms: funscriptData.actions[funscriptData.actions.length - 1].at,
    });
    engine = new FunscriptEngine({ backendPort: 5123 });
    await engine.loadContent(rawContent, 'Test.funscript');
  });

  it('loads correct action count', () => {
    expect(engine.getActions().length).toBe(funscriptData.actions.length);
  });

  it('reports correct duration', () => {
    const info = engine.getInfo();
    expect(info.durationMs).toBe(funscriptData.actions[funscriptData.actions.length - 1].at);
  });

  it('interpolates at exact action times', () => {
    const firstAction = funscriptData.actions[0];
    expect(engine.getPositionAt(firstAction.at)).toBe(firstAction.pos);
  });

  it('interpolates between actions', () => {
    const a = funscriptData.actions[0];
    const b = funscriptData.actions[1];
    const midTime = (a.at + b.at) / 2;
    const pos = engine.getPositionAt(midTime);
    const expectedPos = (a.pos + b.pos) / 2;
    expect(Math.abs(pos - expectedPos)).toBeLessThan(1);
  });

  it('returns valid position for any time in range', () => {
    const lastTime = funscriptData.actions[funscriptData.actions.length - 1].at;
    for (let i = 0; i < 100; i++) {
      const time = Math.random() * lastTime;
      const pos = engine.getPositionAt(time);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(100);
    }
  });
});

// Test heatmap speed calculations with real data
describe('Real funscript heatmap speeds', () => {
  it('produces valid speed values', () => {
    const actions = funscriptData.actions;
    for (let i = 0; i < actions.length - 1; i++) {
      const dt = actions[i + 1].at - actions[i].at;
      if (dt > 0) {
        const dp = Math.abs(actions[i + 1].pos - actions[i].pos);
        const speed = dp / dt;
        expect(speed).toBeGreaterThanOrEqual(0);
        expect(isFinite(speed)).toBe(true);
      }
    }
  });

  it('has varying speeds (not all the same)', () => {
    const actions = funscriptData.actions;
    const speeds = new Set();
    for (let i = 0; i < actions.length - 1; i++) {
      const dt = actions[i + 1].at - actions[i].at;
      if (dt > 0) {
        speeds.add(Math.round((Math.abs(actions[i + 1].pos - actions[i].pos) / dt) * 1000));
      }
    }
    expect(speeds.size).toBeGreaterThan(5);
  });
});
