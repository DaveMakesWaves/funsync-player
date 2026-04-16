// Test: connect to a real Handy device, upload script, and play
const { app, BrowserWindow } = require('electron');
const path = require('path');

const CONNECTION_KEY = process.argv.find(a => !a.startsWith('-') && a.length >= 5 && a !== process.argv[0] && a !== process.argv[1] && !a.includes('/') && !a.includes('\\'))
  || 'eK6Qv3AH';

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

  console.log(`\n=== Handy Connection Test ===`);
  console.log(`Connection key: ${CONNECTION_KEY}\n`);

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const log = [];
      const l = (msg) => { log.push(msg); console.log('[TEST]', msg); };

      try {
        // 1. Load SDK
        l('Loading SDK...');
        const sdk = await import('../node_modules/@ohdoki/handy-sdk/dist/handy.esm.js');
        l('SDK loaded: ' + Object.keys(sdk).filter(k => typeof sdk[k] === 'function').join(', '));

        // 2. Init
        l('Initializing...');
        const handy = sdk.init({ syncClientServerTime: true });
        l('Handy instance created');

        // 3. Connect
        l('Connecting with key: ${CONNECTION_KEY}...');
        const connectResult = await handy.connect('${CONNECTION_KEY}');
        const code = typeof connectResult === 'number' ? connectResult : connectResult?.result;
        l('Connect result code: ' + code);

        if (code !== 1) {
          return { success: false, log, error: 'Connect failed with code ' + code };
        }
        l('Connected!');

        // 4. Get device info
        const state = handy.getState();
        l('Device info: ' + JSON.stringify(state?.info || 'none'));

        // 5. Time sync
        l('Running time sync (10 rounds)...');
        await handy.sync({ syncCount: 10, outliers: 3 }, { syncCount: 10, outliers: 3 });
        const latency = handy.getClientServerLatency();
        l('Sync done. RTD: ' + Math.round(latency?.avgRtd || 0) + 'ms, Offset: ' + Math.round(latency?.avgOffset || 0) + 'ms');

        // 6. Generate and upload a simple slow script (CSV)
        l('Generating slow test script...');
        const lines = [];
        for (let t = 0; t <= 30000; t += 1000) {
          const phase = (t % 4000) / 4000;
          const pos = phase < 0.5 ? Math.round(phase * 2 * 100) : Math.round((1 - phase) * 2 * 100);
          lines.push(t + ',' + pos);
        }
        const csv = lines.join('\\n');
        l('CSV: ' + lines.length + ' lines');

        l('Uploading script...');
        const scriptUrl = await sdk.uploadDataToServer(csv);
        l('Script URL: ' + scriptUrl);

        // 7. Set script
        l('Setting script on device...');
        const setupResult = await handy.setScript(scriptUrl);
        l('Setup result: ' + JSON.stringify(setupResult));

        // 8. Play for 5 seconds
        l('Starting playback...');
        const est = sdk.getEstimatedServerTime();
        const playResult = await handy.hsspPlay(0, est);
        l('Play result: ' + JSON.stringify(playResult));

        // Wait 5 seconds
        await new Promise(r => setTimeout(r, 5000));

        // 9. Stop
        l('Stopping...');
        const stopResult = await handy.hsspStop();
        l('Stop result: ' + JSON.stringify(stopResult));

        // 10. Disconnect
        l('Disconnecting...');
        await handy.disconnect();
        l('Done!');

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

  app.quit();
});
