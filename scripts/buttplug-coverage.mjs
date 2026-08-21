#!/usr/bin/env node
// Audit what Buttplug devices can do against what FunSync actually routes.
//
// Source: Device Reference/specs/buttplug-device-config-v5.json — the file
// Intiface itself loads. Every supported device is in it with its per-feature
// output types, so capability can be checked without owning the hardware.
//
//   npm run specs:coverage
//
// READ THIS BEFORE TRUSTING THE OUTPUT
//
// The config uses snake_case output names (`hw_position_with_duration`). The
// buttplug-js SDK exposes a CONSTRUCTOR called DeviceOutput
// .PositionWithDuration whose .percent() emits OutputType
// HwPositionWithDuration, and buttplug-manager probes for the EMITTED name.
// The first version of this audit compared against the constructor name and
// confidently reported 24 stroker configs (Kiiroo Onyx/Titan, Fredorch,
// Fleshy Thrust) as unsupported. They have always worked. A capability audit
// that does not model the name mapping invents gaps, and inventing gaps is
// worse than having none, because it sends you off building what exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = path.resolve(HERE, '..', '..', 'Funsync knowledgebase',
  'Device Reference', 'specs', 'buttplug-device-config-v5.json');

// Config output name -> is it routed, and by which FunSync capability flag.
const ROUTED = {
  vibrate: 'canVibrate',
  rotate: 'canRotate',
  oscillate: 'canOscillate',
  constrict: 'canScalar',
  inflate: 'canScalar',
  position: 'canLinear',
  hw_position_with_duration: 'canLinear',
};
// Present in the config, deliberately not driven from a stroke funscript.
const IGNORED = { temperature: 'not a motion output', spray: 'not a motion output', led: 'cosmetic' };

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const rows = [];
for (const [pname, pdata] of Object.entries(cfg.protocols)) {
  const configs = [...(pdata.configurations || [])];
  if (pdata.defaults) configs.push({ ...pdata.defaults, name: pdata.defaults.name || '(default)' });
  for (const c of configs) {
    const outs = new Map();
    for (const f of c.features || []) {
      for (const t of Object.keys(f.output || {})) {
        outs.set(t.toLowerCase(), (outs.get(t.toLowerCase()) || 0) + 1);
      }
    }
    if (outs.size) rows.push({ protocol: pname, name: c.name || '(unnamed)', outs });
  }
}

const freq = new Map();
for (const r of rows) for (const t of r.outs.keys()) freq.set(t, (freq.get(t) || 0) + 1);

console.log(`\nButtplug device config v${cfg.version.major}.${cfg.version.minor}`);
console.log(`${Object.keys(cfg.protocols).length} protocols, ${rows.length} device configs with outputs\n`);

console.log('OUTPUT TYPE COVERAGE');
for (const [t, n] of [...freq].sort((a, b) => b[1] - a[1])) {
  const state = ROUTED[t] ? `routed (${ROUTED[t]})` : (IGNORED[t] ? `ignored: ${IGNORED[t]}` : '*** UNKNOWN — investigate ***');
  console.log(`  ${t.padEnd(28)} ${String(n).padStart(4)}  ${state}`);
}

const unknown = [...freq.keys()].filter((t) => !ROUTED[t] && !IGNORED[t]);
console.log(`\n${unknown.length ? 'UNKNOWN OUTPUT TYPES: ' + unknown.join(', ') : 'No unknown output types. Every output the config defines is either routed or a deliberate no.'}`);

// Multi-actuator: runOutput() in the SDK iterates EVERY feature with the
// requested output type, so one command reaches all of them. Reported for
// visibility, not as a gap.
const multi = rows.filter((r) => [...r.outs.values()].some((n) => n > 1));
console.log(`\nMULTI-ACTUATOR: ${multi.length} device configs have >1 of the same output.`);
console.log('  SDK runOutput() fans out to every matching feature, so these are fully driven.');

// Mixed outputs where one path is capped and another is not — the shape that
// produced the Mirage 3 "Max slider does nothing" bug (fixed 2026-08-16).
const CAPPED = new Set(['constrict', 'inflate', 'oscillate']);
const UNCAPPED = new Set(['vibrate', 'rotate']);
const mixed = rows.filter((r) => {
  const k = [...r.outs.keys()];
  return k.some((t) => CAPPED.has(t)) && k.some((t) => UNCAPPED.has(t));
});
console.log(`\nCAPPED + UNCAPPED ON ONE DEVICE: ${mixed.length} configs (${(100 * mixed.length / rows.length).toFixed(0)}% of all).`);
console.log('  This is the Mirage 3 shape. Since 2026-08-16 the Max cap governs the whole');
console.log('  device, so these are covered — but any NEW output type must join that rule.');
