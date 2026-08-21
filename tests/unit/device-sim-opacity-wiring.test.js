/**
 * @vitest-environment node
 * Source-consistency checks — no DOM. See notes/CLAUDE.md "Test environments".
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The device-simulator opacity setting spans three files that must agree on a
// settings key, a CSS custom property and a default. Nothing at runtime shouts
// if they drift: the slider still moves, the value still saves, and the widget
// simply never changes. That is the same silent failure the log-redaction
// toggle shipped with (settings path prefix mismatch), so the seam gets a test
// even though the panel itself is not constructible under jsdom.
const read = (p) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

const APP = read('renderer/js/app.js');
const PANEL = read('renderer/components/settings-panel.js');
const CSS = read('renderer/styles/player.css');

const SETTINGS_KEY = 'player.deviceSimOpacity';
const CSS_VAR = '--device-sim-opacity';

describe('device simulator opacity — the three layers agree', () => {
  it('uses the same settings key in the panel and the applier', () => {
    expect(PANEL, 'settings panel must read/write the key').toContain(SETTINGS_KEY);
    expect(APP, 'app applier must read the same key').toContain(SETTINGS_KEY);
  });

  it('sets the same CSS custom property the stylesheet consumes', () => {
    expect(APP).toContain(`setProperty('${CSS_VAR}'`);
    expect(CSS, 'stylesheet must consume the property').toContain(`var(${CSS_VAR}`);
  });

  it('falls back to the same default in all three places', () => {
    // CSS fallback, so the widget is correct before any JS runs.
    expect(CSS).toMatch(/var\(--device-sim-opacity,\s*0\.8\)/);
    expect(APP).toContain('const DEVICE_SIM_OPACITY_DEFAULT = 80;');
    expect(PANEL).toContain('const DEFAULT_SIM_OPACITY = 80;');
  });

  it('clamps rather than trusting the stored value', () => {
    // A hand-edited config must not be able to make the indicator invisible.
    // Anchor on the method definition, not the earlier callback wiring.
    const applier = APP.slice(APP.indexOf('_applyDeviceSimOpacity(value = null) {'));
    const body = applier.slice(0, applier.indexOf('\n  }'));
    expect(body).toContain('Math.min(100, Math.max(20,');
    expect(body).toContain('/ 100');
  });

  it('notifies the app when the slider moves, not only on close', () => {
    expect(PANEL).toContain('onDeviceSimOpacityChanged');
    expect(APP).toContain('onDeviceSimOpacityChanged:');
    // Live-apply: the callback must be wired to the input event, since the
    // whole point is judging it against the video while dragging.
    expect(PANEL).toMatch(/simOpacity\.addEventListener\('input'/);
  });

  it('keeps the slider bounds in step with the clamp', () => {
    // Anchor on the input's own id, not the label's `for=` which precedes it.
    const field = PANEL.slice(PANEL.indexOf('id="sp-device-sim-opacity"'));
    const input = field.slice(0, field.indexOf('>') + 1);
    expect(input).toContain('min="20"');
    expect(input).toContain('max="100"');
  });

  it('exposes a reset control back to the default', () => {
    expect(PANEL).toContain('sp-device-sim-opacity-reset');
    expect(PANEL).toMatch(/simOpacityReset\?\.addEventListener\('click'/);
  });
});
