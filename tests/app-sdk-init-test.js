// Test: verify the full app initializes with SDK loaded (not just mocked)
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Stub IPC handlers the app needs
ipcMain.handle('get-backend-port', () => 5123);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Wait for the app to fully initialize
  await new Promise(r => setTimeout(r, 3000));

  // Check console messages
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      // Test: can we import the SDK through our module?
      try {
        const { HandyManager } = await import('./js/handy-manager.js');
        const mgr = new HandyManager();
        await mgr.init();
        return {
          sdkLoaded: mgr._handy !== null,
          hasConnect: typeof mgr.connect === 'function',
          hasHsspPlay: typeof mgr.hsspPlay === 'function',
          hasHdsp: typeof mgr.hdspMove === 'function',
        };
      } catch (err) {
        return { error: err.message };
      }
    })()
  `);

  console.log('App SDK init test:', JSON.stringify(result, null, 2));

  if (result.sdkLoaded) {
    console.log('RESULT: PASS — SDK loaded in app context');
  } else {
    console.log('RESULT: FAIL — ' + (result.error || 'SDK not loaded'));
  }

  app.quit();
});
