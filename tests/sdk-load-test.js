// Quick test: verify the Handy SDK loads in Electron renderer context
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the actual index.html
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Test from the correct module context: renderer/js/ is where handy-manager.js lives
  // The import path in handy-manager.js is ../../node_modules/...
  // From renderer/index.html, the equivalent is ../node_modules/...
  // But dynamic import base URL in executeJavaScript is the HTML page.
  // So we test both paths.
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        // This path is relative to renderer/index.html
        const sdk = await import('../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js');
        const keys = Object.keys(sdk);
        const hasInit = typeof sdk.init === 'function';
        const hasGetTime = typeof sdk.getEstimatedServerTime === 'function';

        const h = sdk.init({ syncClientServerTime: false });
        const hasConnect = typeof h.connect === 'function';
        const hasHsspPlay = typeof h.hsspPlay === 'function';
        const hasSetScript = typeof h.setScript === 'function';
        const hasHdsp = typeof h.hdsp === 'function';

        return {
          success: true,
          exportCount: keys.length,
          hasInit,
          hasGetTime,
          hasConnect,
          hasHsspPlay,
          hasSetScript,
          hasHdsp,
        };
      } catch (err) {
        return { success: false, error: err.message, stack: err.stack };
      }
    })()
  `);

  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log('SDK LOAD: PASS');

    // Now test the real module import path
    const moduleResult = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          // Import our actual handy-manager.js module to verify SDK loads through it
          const { HandyManager } = await import('./js/handy-manager.js');
          const mgr = new HandyManager();
          await mgr.init();
          return { success: true, connected: mgr.connected, hasHandy: mgr._handy !== null };
        } catch (err) {
          return { success: false, error: err.message };
        }
      })()
    `);
    console.log('Module test:', JSON.stringify(moduleResult, null, 2));
    if (moduleResult.success) {
      console.log('MODULE LOAD: PASS');
    } else {
      console.log('MODULE LOAD: FAIL');
    }
  } else {
    console.log('SDK LOAD: FAIL');
  }

  app.quit();
});
