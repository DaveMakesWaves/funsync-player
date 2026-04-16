// Test: upload a raw funscript JSON via SDK (same flow as the app) and play
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const CONNECTION_KEY = process.argv.find(a => !a.startsWith('-') && a.length >= 5 && a !== process.argv[0] && a !== process.argv[1] && !a.includes('/') && !a.includes('\\'))
  || 'eK6Qv3AH';

// Read the test funscript file
const funscriptPath = path.join(__dirname, '..', 'Test-slow.funscript');
const funscriptContent = fs.readFileSync(funscriptPath, 'utf-8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  console.log(`\n=== Funscript Play Test (App-like Flow) ===`);
  console.log(`Connection key: ${CONNECTION_KEY}`);
  console.log(`Funscript: ${funscriptPath}\n`);

  // Pass the funscript content as a string literal in the JS
  const escaped = funscriptContent.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const log = [];
      const l = (msg) => { log.push(msg); console.log('[TEST]', msg); };

      try {
        // 1. Load SDK
        l('Loading SDK...');
        const sdk = await import('../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js');
        l('SDK exports: ' + Object.keys(sdk).filter(k => typeof sdk[k] === 'function').join(', '));

        // 2. Init
        const handy = sdk.init({ syncClientServerTime: true });
        l('SDK initialized');

        // 3. Connect
        l('Connecting with key: ${CONNECTION_KEY}...');
        const connectResult = await handy.connect('${CONNECTION_KEY}');
        const code = typeof connectResult === 'number' ? connectResult : connectResult?.result;
        if (code !== 1) {
          return { success: false, log, error: 'Connect failed: code ' + code };
        }
        l('Connected!');

        // 4. Time sync
        l('Syncing time...');
        await handy.sync({ syncCount: 10, outliers: 3 }, { syncCount: 10, outliers: 3 });
        const latency = handy.getClientServerLatency();
        l('RTD: ' + Math.round(latency?.avgRtd || 0) + 'ms, Offset: ' + Math.round(latency?.avgOffset || 0) + 'ms');

        // 5. Upload RAW FUNSCRIPT JSON (same as app does)
        const funscriptJson = '${escaped}';
        l('Uploading raw funscript JSON (' + funscriptJson.length + ' chars)...');
        const cloudUrl = await sdk.uploadDataToServer(funscriptJson);
        l('Cloud URL: ' + cloudUrl);

        // 6. Set script on device
        l('Setting script...');
        const setupResult = await handy.setScript(cloudUrl);
        l('Setup result: ' + JSON.stringify(setupResult));

        // Check state
        const state = handy.getState();
        l('Mode: ' + state?.mode + ', scriptSet: ' + state?.hssp?.scriptSet);

        // 7. Play for 8 seconds
        l('Starting HSSP playback at t=0...');
        const est = sdk.getEstimatedServerTime();
        l('Estimated server time: ' + est);
        const playResult = await handy.hsspPlay(0, est);
        l('Play result: ' + JSON.stringify(playResult));

        // Wait 8 seconds — should see slow 0→100→0 pattern (2s per stroke)
        l('Playing for 8 seconds — watch for slow up/down pattern...');
        await new Promise(r => setTimeout(r, 8000));

        // 8. Stop
        l('Stopping...');
        await handy.hsspStop();
        l('Stopped');

        // 9. Disconnect
        await handy.disconnect();
        l('Disconnected');

        return { success: true, log };
      } catch (err) {
        l('ERROR: ' + err.message);
        return { success: false, log, error: err.message, stack: err.stack };
      }
    })()
  `);

  console.log('\n--- Test Log ---');
  for (const line of result.log) {
    console.log('  ' + line);
  }
  console.log('\n' + (result.success ? 'RESULT: PASS' : 'RESULT: FAIL - ' + result.error));
  if (result.stack) console.log('Stack:', result.stack);

  app.quit();
});
