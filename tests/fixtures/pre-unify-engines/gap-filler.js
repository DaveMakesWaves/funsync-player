// Gap Filler — detect gaps in funscript actions and fill them with patterns
import { generatePattern } from './script-modifiers.js';

/**
 * Detect gaps in the action timeline.
 * A gap is a region where the time between consecutive actions exceeds minGapMs.
 * @param {Array<{at: number, pos: number}>} actions — sorted by time
 * @param {number} minGapMs — minimum gap duration to detect (in ms)
 * @param {number} [totalDurationMs] — total video duration (for detecting trailing gap)
 * @returns {Array<{startMs: number, endMs: number, durationMs: number}>}
 */
export function detectGaps(actions, minGapMs, totalDurationMs) {
  const gaps = [];
  if (!actions || actions.length < 2) {
    // If we have a total duration and 0-1 actions, the whole thing is a gap
    if (totalDurationMs && totalDurationMs > 0) {
      const start = actions && actions.length > 0 ? actions[0].at : 0;
      const end = totalDurationMs;
      if (end - start >= minGapMs) {
        gaps.push({ startMs: start, endMs: end, durationMs: end - start });
      }
    }
    return gaps;
  }

  // Check leading gap (from 0 to first action)
  if (actions[0].at >= minGapMs) {
    gaps.push({
      startMs: 0,
      endMs: actions[0].at,
      durationMs: actions[0].at,
    });
  }

  // Check gaps between consecutive actions
  for (let i = 0; i < actions.length - 1; i++) {
    const gapMs = actions[i + 1].at - actions[i].at;
    if (gapMs >= minGapMs) {
      gaps.push({
        startMs: actions[i].at,
        endMs: actions[i + 1].at,
        durationMs: gapMs,
      });
    }
  }

  // Check trailing gap (from last action to total duration)
  if (totalDurationMs && totalDurationMs > 0) {
    const lastAt = actions[actions.length - 1].at;
    const trailingGap = totalDurationMs - lastAt;
    if (trailingGap >= minGapMs) {
      gaps.push({
        startMs: lastAt,
        endMs: totalDurationMs,
        durationMs: trailingGap,
      });
    }
  }

  return gaps;
}

/**
 * Fill a single gap with a generated pattern.
 * Delegates to generatePattern from script-modifiers.
 * @param {number} startMs
 * @param {number} endMs
 * @param {string} pattern — 'sine', 'sawtooth', 'square', 'triangle', 'escalating', 'random'
 * @param {number} bpm
 * @param {number} min — min position
 * @param {number} max — max position
 * @returns {Array<{at: number, pos: number}>}
 */
export function fillGap(startMs, endMs, pattern, bpm, min = 0, max = 100) {
  return generatePattern(pattern, startMs, endMs, bpm, min, max);
}

/**
 * Fill multiple gaps at once.
 * @param {Array<{startMs: number, endMs: number}>} gaps
 * @param {string} pattern
 * @param {number} bpm
 * @param {number} min
 * @param {number} max
 * @returns {Array<{at: number, pos: number}>}
 */
export function fillGaps(gaps, pattern, bpm, min = 0, max = 100) {
  const allActions = [];
  for (const gap of gaps) {
    const filled = fillGap(gap.startMs, gap.endMs, pattern, bpm, min, max);
    allActions.push(...filled);
  }
  // Sort by time and dedupe
  allActions.sort((a, b) => a.at - b.at);
  return allActions;
}
