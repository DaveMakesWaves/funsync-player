// Buttplug.io v4 vibration test — run with: node tests/buttplug-vibe-test.mjs
// Make sure Intiface Central is running first

import {
  ButtplugClient,
  ButtplugNodeWebsocketClientConnector,
  DeviceOutput,
  OutputType,
} from '../node_modules/buttplug/dist/main/src/index.js';

const PORT = 12345;

async function main() {
  console.log(`\n=== Buttplug v4 Vibration Test ===\n`);

  const client = new ButtplugClient('Vibe Test');
  const devices = new Map();

  client.addListener('deviceadded', (dev) => {
    devices.set(dev.index, dev);
    console.log(`  DEVICE: "${dev.name}" [index=${dev.index}]`);
    const caps = [];
    for (const t of ['Vibrate', 'Rotate', 'Oscillate', 'Position', 'Constrict', 'Inflate']) {
      try { if (dev.hasOutput(t)) caps.push(t); } catch(e) {}
    }
    console.log(`    outputs: ${caps.join(', ') || 'none detected'}`);
  });

  // Connect
  console.log(`Connecting to ws://127.0.0.1:${PORT}...`);
  try {
    const connector = new ButtplugNodeWebsocketClientConnector(`ws://127.0.0.1:${PORT}`);
    await client.connect(connector);
    console.log('Connected!\n');
  } catch (err) {
    console.error(`Connection failed: ${err?.message || err}`);
    process.exit(1);
  }

  // Scan
  console.log('Scanning (5s)...');
  await client.startScanning();
  await new Promise(r => setTimeout(r, 5000));
  try { await client.stopScanning(); } catch(e) {}

  if (devices.size === 0) {
    console.log('No devices found.');
    await client.disconnect();
    process.exit(0);
  }

  console.log(`\n${devices.size} device(s) found. Testing...\n`);

  for (const [idx, dev] of devices) {
    console.log(`--- "${dev.name}" ---`);

    // v4 API: DeviceOutput.Vibrate is a builder
    //   DeviceOutput.Vibrate.percent(0.3) → command object for runOutput()

    // Test vibrate
    console.log('  [1] Vibrate at 30% for 2 seconds...');
    try {
      const cmd = DeviceOutput.Vibrate.percent(0.3);
      console.log(`      cmd: outputType=${cmd.outputType}, value=${JSON.stringify(cmd.value)}`);
      await dev.runOutput(cmd);
      console.log('      SUCCESS — vibrating!');
      await new Promise(r => setTimeout(r, 2000));
      await dev.stop();
      console.log('      Stopped.');
    } catch (err) {
      console.log(`      FAILED: ${err?.message || err}`);
    }

    await new Promise(r => setTimeout(r, 500));

    // Test vibrate at higher intensity
    console.log('  [2] Vibrate at 70% for 2 seconds...');
    try {
      const cmd = DeviceOutput.Vibrate.percent(0.7);
      await dev.runOutput(cmd);
      console.log('      SUCCESS — vibrating!');
      await new Promise(r => setTimeout(r, 2000));
      await dev.stop();
      console.log('      Stopped.');
    } catch (err) {
      console.log(`      FAILED: ${err?.message || err}`);
    }
  }

  console.log('\nStopping all...');
  await client.stopAllDevices();
  await client.disconnect();
  console.log('Done.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
