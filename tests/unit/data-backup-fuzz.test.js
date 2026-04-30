// Property-based / fuzz tests for the retention math.
//
// The unit tests in `data-backup.test.js` cover the hand-picked edges
// (single-bucket dedupe, beyond-28-days drop, floor-of-3 invariant).
// These fuzz tests generate thousands of random inputs and assert the
// invariants hold for ALL of them. Catches the gnarly cases unit tests
// miss — clock-skew + huge backlog + every-bucket-occupied at once.
//
// Maps to SCOPE-data-backup.md §7.2.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const dataBackup = require_('../../electron/data-backup.js');

// Tiny deterministic PRNG. Seeded for reproducibility — failure
// messages include the seed so a regression can be replayed exactly
// without rerunning the whole fuzz run. Mulberry32 is a 32-bit PRNG
// good enough for property tests; not crypto-grade, doesn't need to be.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Generate a random batch of snapshot manifest entries. Distribution
 * is a mix of:
 *   - "now" tier (< 1h)
 *   - hourly tier (1–24h)
 *   - daily tier (1–7d)
 *   - weekly tier (7–28d)
 *   - beyond retention (28–120d)
 *   - pre-action (any age, weighted toward last 30d)
 *   - future-dated (clock skew paranoia)
 *
 * Returns the snapshots and the `now` reference used to date them.
 */
function generateSnapshots(rng, count, now) {
  const snapshots = [];
  for (let i = 0; i < count; i++) {
    const r = rng();
    const isPreAction = rng() < 0.1;
    const subdir = isPreAction ? 'pre-action' : 'snapshots';
    let ageMs;
    if (r < 0.10) {
      ageMs = rng() * HOUR;                       // < 1h "now"
    } else if (r < 0.40) {
      ageMs = HOUR + rng() * 23 * HOUR;          // 1–24h
    } else if (r < 0.65) {
      ageMs = DAY + rng() * 6 * DAY;             // 1–7d
    } else if (r < 0.85) {
      ageMs = 7 * DAY + rng() * 21 * DAY;        // 7–28d
    } else if (r < 0.97) {
      ageMs = 28 * DAY + rng() * 92 * DAY;       // 28–120d (beyond)
    } else {
      ageMs = -rng() * DAY;                       // future-dated
    }
    const ts = new Date(now.getTime() - ageMs);
    const isoStr = ts.toISOString();
    snapshots.push({
      filename: `snap-${i}-${isoStr.replace(/[:.]/g, '-')}.json`,
      subdir,
      timestamp: isoStr,
      label: isPreAction ? `op-${i}` : null,
      sizeBytes: Math.floor(rng() * 500_000),
    });
  }
  return snapshots;
}

describe('retention policy — fuzz invariants', () => {
  // Fixed `now` per fuzz batch so age math is deterministic given the
  // seed. Different from real-world `now()` because fuzz reproduction
  // requires the test to give identical output for identical seed.
  const now = new Date('2026-04-30T20:00:00Z');

  const ITERATIONS = 1000;

  it(`holds invariants over ${ITERATIONS} random batches`, () => {
    for (let seed = 1; seed <= ITERATIONS; seed++) {
      const rng = mulberry32(seed);
      const count = Math.floor(rng() * 200) + 1; // 1..200 snapshots
      const input = generateSnapshots(rng, count, now);
      const kept = dataBackup.applyRetentionPolicy(input, now);

      const ctx = `seed=${seed} count=${count}`;

      // Invariant 1: never synthesise — every kept entry was in input.
      const inputSet = new Set(input.map(s => s.filename));
      for (const k of kept) {
        if (!inputSet.has(k.filename)) {
          throw new Error(`${ctx}: kept synthesised snapshot "${k.filename}"`);
        }
      }

      // Invariant 2: no duplicates in kept set.
      const keptFilenames = kept.map(s => s.filename);
      if (new Set(keptFilenames).size !== keptFilenames.length) {
        throw new Error(`${ctx}: duplicates in kept set`);
      }

      // Invariant 3: kept.length ≤ input.length.
      if (kept.length > input.length) {
        throw new Error(`${ctx}: kept (${kept.length}) > input (${input.length})`);
      }

      // Invariant 4: floor — when total input snapshots ≥ minTotalFloor,
      // kept rolling count must be either ≥ minTotalFloor (normal prune)
      // OR equal to input rolling count (floor activated, full skip).
      const inputRolling = input.filter(s => s.subdir === 'snapshots');
      const keptRolling = kept.filter(s => s.subdir === 'snapshots');
      if (inputRolling.length >= dataBackup.RETENTION.minTotalFloor) {
        const meetsFloor = keptRolling.length >= dataBackup.RETENTION.minTotalFloor;
        const fullSkip = keptRolling.length === inputRolling.length;
        if (!meetsFloor && !fullSkip) {
          throw new Error(
            `${ctx}: floor violated — kept rolling=${keptRolling.length}, input rolling=${inputRolling.length}, floor=${dataBackup.RETENTION.minTotalFloor}`
          );
        }
      }

      // Invariant 5: pre-action snapshots beyond preActionDays MUST be
      // dropped (they don't have a floor protection).
      const cutoffMs = now.getTime() - dataBackup.RETENTION.preActionDays * DAY;
      for (const k of kept) {
        if (k.subdir !== 'pre-action') continue;
        const ageOk = new Date(k.timestamp).getTime() >= cutoffMs;
        if (!ageOk) {
          throw new Error(`${ctx}: pre-action older than ${dataBackup.RETENTION.preActionDays}d kept: ${k.filename}`);
        }
      }

      // Invariant 6: when prune fired (kept rolling < input rolling),
      // hourly/daily/weekly bucket caps are honoured. We can't easily
      // re-bucket here without duplicating algorithm internals, but we
      // CAN sanity-check the upper bound: rolling kept count ≤ floor +
      // the per-tier caps + some "now" slack. Loose but catches gross
      // miscounts.
      const maxPossible = dataBackup.RETENTION.hourly
        + dataBackup.RETENTION.daily
        + dataBackup.RETENTION.weekly
        + 100; // <1h "now" + future-dated, generous slack
      if (keptRolling.length > inputRolling.length + 0) {
        // already guarded by inv 3
      }
      if (keptRolling.length > maxPossible) {
        // Only matters when we're NOT in floor-skip mode (where we
        // keep everything as-is, which can be more than maxPossible
        // if input has lots of beyond-28d snapshots).
        const fullSkip = keptRolling.length === inputRolling.length;
        if (!fullSkip) {
          throw new Error(`${ctx}: kept rolling (${keptRolling.length}) exceeds reasonable upper bound (${maxPossible})`);
        }
      }
    }
  });

  it('empty and singleton inputs are stable', () => {
    expect(dataBackup.applyRetentionPolicy([])).toEqual([]);
    expect(dataBackup.applyRetentionPolicy([], new Date())).toEqual([]);
    const single = [{
      filename: 'a.json', subdir: 'snapshots', timestamp: now.toISOString(),
    }];
    // Single entry: floor activates (1 < 3), keep it.
    const kept = dataBackup.applyRetentionPolicy(single, now);
    expect(kept).toHaveLength(1);
  });

  it('idempotence: applying policy twice equals applying once', () => {
    // If the policy returns a stable subset, running it again on that
    // subset shouldn't drop anything new. Catches "policy is sensitive
    // to ordering" or "policy resorts and double-prunes" bugs.
    for (let seed = 1; seed <= 50; seed++) {
      const rng = mulberry32(seed * 13);
      const input = generateSnapshots(rng, 80, now);
      const once = dataBackup.applyRetentionPolicy(input, now);
      const twice = dataBackup.applyRetentionPolicy(once, now);
      const onceFilenames = once.map(s => s.filename).sort();
      const twiceFilenames = twice.map(s => s.filename).sort();
      expect(twiceFilenames, `seed=${seed * 13}`).toEqual(onceFilenames);
    }
  });
});

describe('blacklist filter — fuzz', () => {
  // Whatever random shape you throw at stripBlacklist, it must:
  //   1. Not throw.
  //   2. Not remove any non-blacklisted path.
  //   3. Remove every blacklisted path that was present.
  //   4. Not mutate the input.
  it(`holds invariants over 200 random configs`, () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      const lib = {};
      // Random presence of each blacklisted field.
      if (rng() < 0.7) lib.speedStatsCache = { '/a': 1 };
      if (rng() < 0.7) lib.durationCache = { '/a': 1 };
      if (rng() < 0.7) lib.thumbnailCache = { '/a': 'data:img' };
      // Random benign fields.
      if (rng() < 0.8) lib.sources = [{ id: 'x' }];
      if (rng() < 0.8) lib.collections = [{ id: 'c1' }, { id: 'c2' }];
      if (rng() < 0.5) lib.customRouting = { dev: 'L0' };
      const input = {
        settings: { library: lib, handy: { connectionKey: 'TEST' + seed } },
        playlists: [{ id: 'p1' }],
      };
      const inputCopy = JSON.parse(JSON.stringify(input));

      let out;
      expect(() => { out = dataBackup.stripBlacklist(input); }).not.toThrow();

      // Blacklisted fields gone.
      expect(out.settings.library.speedStatsCache).toBeUndefined();
      expect(out.settings.library.durationCache).toBeUndefined();
      expect(out.settings.library.thumbnailCache).toBeUndefined();

      // Non-blacklisted fields preserved.
      expect(out.settings.handy.connectionKey).toBe(`TEST${seed}`);
      if (lib.sources)        expect(out.settings.library.sources).toEqual(lib.sources);
      if (lib.collections)    expect(out.settings.library.collections).toEqual(lib.collections);
      if (lib.customRouting)  expect(out.settings.library.customRouting).toEqual(lib.customRouting);
      expect(out.playlists).toEqual(input.playlists);

      // Input not mutated.
      expect(input).toEqual(inputCopy);
    }
  });
});
