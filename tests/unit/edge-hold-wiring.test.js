/**
 * @vitest-environment node
 * Source-consistency checks — no DOM. See notes/CLAUDE.md "Test environments".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Edge Hold (Z) — MattWritesNSFW, EroScripts #301: hold to stop all device
// output while the video keeps playing; release resumes in sync. The feature
// spans keyboard.js (binding), app.js (engine stop/resume orchestration) and
// keyboard-help.js + locales (discoverability). App isn't constructible under
// jsdom, so these pin the seams the way device-sim-opacity-wiring does; the
// clash guard (keyboard-shortcut-clash.test.js) separately proves Z is free.

const read = (p) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

const KEYBOARD = read('renderer/js/keyboard.js');
const APP = read('renderer/js/app.js');
const HELP = read('renderer/js/keyboard-help.js');
const EN = JSON.parse(read('renderer/locales/en.json'));

describe('Edge Hold — keyboard binding', () => {
  it('binds Z on keydown with a hold guard (auto-repeat fires once)', () => {
    expect(KEYBOARD).toMatch(/case 'z':\s*\n\s*case 'Z':/);
    expect(KEYBOARD).toContain('_edgeHoldActive');
    expect(KEYBOARD).toContain('onEdgeHold(true)');
  });

  it('releases on keyup even without focus (mirrors the X release rule)', () => {
    const keyUp = KEYBOARD.slice(KEYBOARD.indexOf('_onKeyUp(e) {'), KEYBOARD.indexOf('_onKeyDown(e) {'));
    expect(keyUp).toContain("e.key === 'z'");
    expect(keyUp).toContain('onEdgeHold(false)');
  });
});

describe('Edge Hold — app orchestration', () => {
  it('wires the keyboard callback to _onEdgeHold', () => {
    expect(APP).toContain('this._keyboard.onEdgeHold');
    expect(APP).toContain('_onEdgeHold(active');
  });

  it('activation stops the Handy DEVICE, not just the engine (HSSP plays device-side)', () => {
    const body = APP.slice(APP.indexOf('_onEdgeHold(active'), APP.indexOf('_resumeHandyAfterEdge()'));
    expect(body, 'engine stop alone leaves the device stroking to end of script')
      .toContain('hsspStop');
    expect(body, 'sustained outputs must be zeroed (2026-08-14 lesson)')
      .toContain('stopSustainedOutputs');
    expect(body, 'local devices must be idled, not just their engines')
      .toContain('_stopAllDevicesIdle');
  });

  it('release re-anchors the Handy with a forced resync (start() alone is unreliable)', () => {
    const resume = APP.slice(APP.indexOf('async _resumeHandyAfterEdge'), APP.indexOf('async _restoreHandyAfterOrgasm'));
    expect(resume).toContain('resync()');
  });

  it('never arms while the Orgasm Switch owns the devices', () => {
    const body = APP.slice(APP.indexOf('_onEdgeHold(active'), APP.indexOf('_resumeHandyAfterEdge()'));
    expect(body).toContain('orgasmSwitch?.active');
  });

  it('X forcibly releases an active Edge hold before arming the finisher', () => {
    const orgasm = APP.slice(APP.indexOf('_onOrgasmHold(active) {'), APP.indexOf('_onOrgasmHold(active) {') + 1500);
    expect(orgasm, 'else the finisher records no stopped engines and release strands them')
      .toContain('_onEdgeHold(false');
    expect(orgasm, 'the Handy resume must be skipped — the finisher takes the Handy over')
      .toContain('skipHandyResume');
  });
});

// Press-to-toggle (lr_x3, EroScripts #307). He asked for a toggle that pauses
// the devices with the video still running — the Z hold from #301 minus the
// holding. Mode lives in `player.edgeHoldMode`, mirroring the Orgasm Switch's
// `player.orgasmSwitchMode`. The overlay labels are covered behaviourally in
// keyboard-help.test.js; what can only be pinned here is the orchestration.
describe('Edge Hold — press-to-toggle mode', () => {
  const body = APP.slice(APP.indexOf('_onEdgeHold(active'), APP.indexOf('_resumeHandyAfterEdge()'));

  it('reads the mode from settings', () => {
    expect(body).toContain("player.edgeHoldMode");
  });

  it('ignores the key RELEASE in toggle mode', () => {
    // keyboard.js still reports Z as press+release. Acting on the release
    // would end the edge the instant the key came up — i.e. a hold with
    // extra steps.
    expect(body).toMatch(/mode === 'toggle'[\s\S]{0,200}if \(!active\) return;/);
  });

  it('the internal release from X bypasses the mode branch', () => {
    // _onOrgasmHold deactivates Z directly so the finisher can take over.
    // In toggle mode a bare active=false would be swallowed by the branch
    // above and the engines Z stopped would never restart.
    expect(body).toContain('force = false');
    expect(body).toMatch(/mode === 'toggle' && !force/);
    const orgasm = APP.slice(APP.indexOf('_onOrgasmHold(active) {'), APP.indexOf('_onOrgasmHold(active) {') + 1500);
    expect(orgasm).toMatch(/_onEdgeHold\(false, \{[^}]*force: true/);
  });

  it('is offered in the settings panel and persists', () => {
    const SETTINGS = read('renderer/components/settings-panel.js');
    expect(SETTINGS).toContain('sp-edge-mode');
    expect(SETTINGS).toMatch(/set\('player\.edgeHoldMode'/);
  });
});

describe('Edge Hold + Orgasm Switch — discoverability', () => {
  it('both hold keys appear in the ? overlay (X was missing — lettuce, EroScripts #302)', () => {
    const rows = HELP.slice(HELP.indexOf("t('kbd.devicesSync')"), HELP.indexOf("t('kbd.script')"));
    expect(rows).toMatch(/\['X',[\s\S]{0,200}kbd\.orgasmSwitch/);
    expect(rows).toMatch(/\['Z',[\s\S]{0,200}kbd\.edgeHold/);
  });

  it('the locale keys the overlay reads exist, in both modes', () => {
    expect(EN.kbd.orgasmSwitch).toBeTruthy();
    expect(EN.kbd.orgasmSwitchToggle).toBeTruthy();
    expect(EN.kbd.edgeHold).toBeTruthy();
    expect(EN.kbd.edgeHoldToggle).toBeTruthy();
  });

  it('the settings strings the Edge Hold section reads exist', () => {
    const pb = EN.settingsPanel.playback;
    for (const k of ['edgeHeader', 'edgeModeLabel', 'edgeModeHold', 'edgeModeToggle', 'edgeModeHint']) {
      expect(pb[k], `en.settingsPanel.playback.${k}`).toBeTruthy();
    }
  });
});
