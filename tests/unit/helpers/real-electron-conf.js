// Load the REAL electron-conf for a test, with only `electron` stubbed.
//
// Why not a fake: electron-conf's own behaviour is the thing under test.
// Its `store` getter returns a SHALLOW clone, so `set('settings.x.y', v)`
// mutates nested objects it shares with the value `onDidAnyChange` cached,
// and that listener then sees "no change" for almost every write (V05).
// store.test.js's MockConf deep-clones on every get and set, which is
// exactly why that bug sat behind a green suite. A fake can only ever
// reproduce the behaviour its author already knew about.
//
// The CJS build is loaded with a one-shot `Module._load` hook so its
// `require('electron')` gets an `app.getPath('userData')` pointing at the
// test's temp dir. Nothing else in electron-conf touches Electron unless
// `registerRendererListener` or `useConf` is called, which store.js never
// does.
//
// Usage (the factory must live in the test file, vi.mock is hoisted):
//   const h = vi.hoisted(() => ({ userData: '' }));
//   vi.mock('electron-conf', async () => {
//     const { loadRealConf } = await import('./helpers/real-electron-conf.js');
//     return { default: loadRealConf(() => h.userData) };
//   });
import Module, { createRequire } from 'node:module';

export function loadRealConf(getUserData) {
  const req = createRequire(import.meta.url);
  const resolved = req.resolve('electron-conf');
  delete req.cache[resolved];
  const fakeElectron = {
    app: { getPath: () => getUserData() },
    ipcMain: { eventNames: () => [], handle: () => {} },
    session: {},
  };
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return origLoad.call(this, request, ...rest);
  };
  try {
    return req('electron-conf').Conf;
  } finally {
    Module._load = origLoad;
  }
}
