/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// refreshScriptMeta keeps asking while the backend's harvest pass is still
// at it (r3-fixup R3R-3, 2026-11-18). It stopped after 60 asks (2 minutes)
// even with `pending` > 0, so on a long first harvest (Dave: ~2,318 scripts,
// a slow or network disk) every record stored after that never reached the
// desktop or the phone in that session. Now it backs off from 2 s to 10 s
// and stops only when the pass is done, the backend stops answering, or
// nothing moves for a long while. The backend is a fake; the waits are
// recorded, not slept.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  scriptMetaMap, refreshScriptMeta,
  _resetScriptMetaStoreForTests, _setScriptMetaFetcherForTests,
} from '../../renderer/js/script-meta-store.js';

const LATE = 'C:/Library/Late.funscript';

let waits;
function backend(answerFor) {
  let asks = 0;
  waits = [];
  _setScriptMetaFetcherForTests(async () => answerFor(++asks), async (ms) => { waits.push(ms); });
  return { asks: () => asks };
}

const answer = (n, { pending, records = {}, registered = 2318 }) => ({
  records, pending, registered, cacheId: 'c0ffee', seq: n,
});

beforeEach(() => { _resetScriptMetaStoreForTests(); });

describe('a long first harvest', () => {
  it('a record the pass stores after two minutes still arrives', async () => {
    // 70 asks' worth of scripts to check; the late script is stored at ask 65.
    const b = backend((n) => answer(n, {
      pending: Math.max(0, 70 - n),
      records: n >= 65 ? { [LATE]: { metadata: { tags: ['pov'] }, readAt: 1 } } : {},
    }));
    await refreshScriptMeta();
    expect(scriptMetaMap()[LATE]?.tags).toEqual(['pov']);
    expect(b.asks()).toBe(70);                 // and it stopped when the pass was done
  });

  it('backs off from 2 s to 10 s between asks', async () => {
    backend((n) => answer(n, { pending: Math.max(0, 9 - n) }));
    await refreshScriptMeta();
    expect(waits).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000, 10000]);
  });
});

describe('it still stops', () => {
  it('when the backend stops answering (three misses in a row)', async () => {
    const b = backend((n) => (n <= 2 ? answer(n, { pending: 50 - n }) : null));
    await refreshScriptMeta();
    expect(b.asks()).toBe(5);
  });

  it('when nothing moves for 30 answers in a row (a pass stuck on a dead drive)', async () => {
    const b = backend((n) => answer(n, { pending: 7 }));
    await refreshScriptMeta();
    expect(b.asks()).toBe(31);                 // the first answer counts as news, then 30 idle ones
    expect(Math.max(...waits)).toBe(10000);
  });

  it('and a pass that keeps moving is never cut short', async () => {
    const b = backend((n) => answer(n, { pending: Math.max(0, 400 - n) }));
    await refreshScriptMeta();
    expect(b.asks()).toBe(400);
  });
});
