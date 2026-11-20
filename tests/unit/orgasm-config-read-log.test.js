/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here. The lifted
 * method touches only `window.funsync`, given here as a global fake.
 */
// FT-059 (also in v0.9.2): the Orgasm Switch logged "bad JSON" for a
// finisher script it could not read at all. readFunscript answers null for a
// missing file (main.js read-funscript: ENOENT -> null), parseFinisherActions
// (null) is null, and the log said "config script unusable (bad JSON / < 2
// actions)". Someone reading a log for "why does X do nothing" was sent to
// check a file that was fine, on a drive that was offline.
//
// Log only: the missing-path handling (recovery, the missing set the
// Settings row reads) is unchanged, and checked here too. The REAL
// _reloadOrgasmScripts is lifted out of app.js.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liftAppClass } from './helpers/app-methods.js';
import { patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround } from '../../renderer/js/pattern-choice.js';
import { parseFinisherActions, collectOrgasmScriptPaths } from '../../renderer/js/orgasm-plan.js';
import { normalizeAssociation, buildAssociationEntry } from '../../renderer/js/association-shape.js';
import { orgasmPatternSettings, orgasmPatternKey, buildOrgasmPatternContent } from '../../renderer/js/orgasm-pattern.js';

const FILE = 'E:\\Finishers\\finish.funscript';
const GOOD = JSON.stringify({ version: '1.0', actions: [{ at: 0, pos: 10 }, { at: 400, pos: 90 }] });

const Lifted = liftAppClass(['_reloadOrgasmScripts', '_orgasmLibrarySource', '_orgasmLibrarySettings'], {
  parseFinisherActions, collectOrgasmScriptPaths, normalizeAssociation,
  orgasmPatternSettings, orgasmPatternKey, buildOrgasmPatternContent,
  // the shared pattern choice (pattern settings unification, 2026-11-19)
  patternChoicePlayer, orgasmChoiceInUse, readPatternChoice, choiceSource, scriptRangeAround,
});

let warns;
function makeApp(readResult) {
  globalThis.window = { funsync: { readFunscript: vi.fn(async () => readResult()) } };
  const app = new Lifted();
  const store = { 'player.orgasmConfig': buildAssociationEntry('single', FILE, null, null) };
  app.settings = { get: (k) => store[k] };
  app._getOrgasmEntry = () => normalizeAssociation(store['player.orgasmConfig']);
  app._recoverOrgasmPaths = vi.fn(async () => false);   // nothing to re-point at
  app._refreshOrgasmPlan = vi.fn();
  return app;
}
const orgasmWarns = () => warns.filter((line) => line.startsWith('[OrgasmSwitch]'));

beforeEach(() => {
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...args) => { warns.push(args.join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.window;
});

describe('Orgasm Switch: a script it could not read is not "bad JSON" (FT-059)', () => {
  it('readFunscript -> null (missing / offline drive) logs "could not read", not "bad JSON"', async () => {
    const app = makeApp(() => null);
    await app._reloadOrgasmScripts();

    const lines = orgasmWarns();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not read config script (missing, or its drive is offline)');
    expect(lines[0]).toContain(FILE);
    expect(lines.join('\n')).not.toMatch(/bad JSON/);
    // The missing-path handling is what it was: one recovery try, then the
    // path is reported missing to the plan and the Settings row.
    expect(app._recoverOrgasmPaths).toHaveBeenCalledWith([FILE]);
    expect([...app._orgasmMissingPaths]).toEqual([FILE]);
    expect(app._orgasmActionsCache.size).toBe(0);
    expect(app._refreshOrgasmPlan).toHaveBeenCalledTimes(1);
  });

  it('content that is there but is not JSON still logs "bad JSON"', async () => {
    const app = makeApp(() => 'this is not a funscript');
    await app._reloadOrgasmScripts();

    const lines = orgasmWarns();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('config script unusable (bad JSON / < 2 actions)');
    expect(lines[0]).not.toContain('could not read');
    expect([...app._orgasmMissingPaths]).toEqual([FILE]);
  });

  it('a script with one action is "unusable", as before', async () => {
    const app = makeApp(() => JSON.stringify({ actions: [{ at: 0, pos: 50 }] }));
    await app._reloadOrgasmScripts();
    expect(orgasmWarns()[0]).toContain('config script unusable (bad JSON / < 2 actions)');
  });

  it('a readable script logs nothing and is cached', async () => {
    const app = makeApp(() => GOOD);
    await app._reloadOrgasmScripts();
    expect(orgasmWarns()).toEqual([]);
    expect(app._orgasmActionsCache.get(FILE)).toHaveLength(2);
    expect(app._orgasmMissingPaths.size).toBe(0);
    expect(app._recoverOrgasmPaths).not.toHaveBeenCalled();
  });
});
