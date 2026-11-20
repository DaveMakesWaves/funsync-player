/**
 * @vitest-environment jsdom
 * jsdom on purpose: the REAL ConnectionPanel builds the Devices tabs, and
 * i18n.js branches on `typeof window` (notes/CLAUDE.md "Test environments").
 */
// Privacy (Handy session 2026-11-17, also in v0.9.2): the Devices > Handy
// tab showed the connection key in plain text (`#connection-key-input` was
// `type="text"`), so a screenshot, a screen share or a stream of that tab
// showed it; it happened in the session's own screenshot. The key is a
// password: the field is masked by default, an eye beside it shows it while
// pressed, and the panel masks it again when it closes. Paste, Enter and the
// Connect button read the value exactly as before, and nothing logs it. The
// Autoblow token (already masked) gets the same eye.
//
// Asserted on what a screenshot would show (the field's type), the eye's
// pressed state and accessible name, and what Connect sends the device.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { _setBundlesForTests, t } from '../../renderer/js/i18n.js';
import { ConnectionPanel } from '../../renderer/components/connection-panel.js';

const EN = JSON.parse(fs.readFileSync('renderer/locales/en.json', 'utf8'));
const KEY = 'TESTKEY01';
const TOKEN = 'FAKETOKEN99';

afterAll(() => _setBundlesForTests('en', EN, EN));

let logged;
beforeEach(() => {
  _setBundlesForTests('en', EN, EN);
  document.body.innerHTML = '<div id="app"></div>';
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    vi.spyOn(console, level).mockImplementation((...args) => { logged.push(args.map(String).join(' ')); });
  }
});
// show() arms its outside-click close on a timer: every panel a test built
// is closed after that timer, or its document listener would swallow the
// next test's clicks.
let built = [];
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const p of built) p.hide();
  built = [];
  vi.restoreAllMocks();
});

const settingsFake = () => {
  const map = new Map();
  return {
    get: (k) => map.get(k), set: (k, v) => map.set(k, v),
    getPlaylists: () => [], getPlaylist: () => null,
    getCategories: () => [], getCategory: () => null, getVideosByCategory: () => [],
  };
};

function build({ savedKey = null } = {}) {
  const settings = settingsFake();
  if (savedKey) settings.set('handy.connectionKey', savedKey);
  const handyManager = {
    on() {}, off() {}, connected: false,
    connect: vi.fn(async () => false),
  };
  const autoblowManager = {
    connected: false,
    connect: vi.fn(async () => false),
    disconnect: vi.fn(async () => {}),
  };
  const panel = new ConnectionPanel({ handyManager, autoblowManager, settings });
  built.push(panel);
  const $ = (sel) => panel._panel.querySelector(sel);
  return {
    panel, handyManager, autoblowManager,
    key: $('#connection-key-input'),
    eye: $('#btn-connection-key-reveal'),
    token: $('#ab-token-input'),
    tokenEye: $('#btn-ab-token-reveal'),
  };
}

describe('the Handy connection key is masked (privacy)', () => {
  it('renders masked, with no autofill or spellcheck, and the eye off', () => {
    const { key, eye } = build({ savedKey: KEY });
    expect(key.value).toBe(KEY);          // the saved key is there ...
    expect(key.type).toBe('password');    // ... and a screenshot shows dots
    expect(key.getAttribute('autocomplete')).toBe('off');
    expect(key.getAttribute('spellcheck')).toBe('false');
    expect(eye).not.toBeNull();
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    expect(eye.getAttribute('aria-controls')).toBe('connection-key-input');
    expect(eye.getAttribute('aria-label')).toBe(t('connection.handy.showKey'));
    expect(eye.querySelector('svg')).not.toBeNull();
  });

  it('the eye shows the key, and a second press masks it again', () => {
    const { key, eye } = build({ savedKey: KEY });
    eye.click();
    expect(key.type).toBe('text');
    // A toggle (bf-review BF-R4): aria-pressed says it is on, and the name
    // stays "Show connection key"; a name flipping to "Hide" was read as
    // "Hide connection key, toggle button, pressed". The tooltip says what a
    // press does, and a language switch re-reads both attributes.
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    expect(eye.getAttribute('aria-label')).toBe(t('connection.handy.showKey'));
    expect(eye.getAttribute('data-i18n-aria-label')).toBe('connection.handy.showKey');
    expect(eye.title).toBe(t('connection.handy.hideKey'));
    expect(eye.getAttribute('data-i18n-title')).toBe('connection.handy.hideKey');
    eye.click();
    expect(key.type).toBe('password');
    expect(eye.getAttribute('aria-pressed')).toBe('false');
    expect(eye.getAttribute('aria-label')).toBe(t('connection.handy.showKey'));
    expect(eye.title).toBe(t('connection.handy.showKey'));
    expect(eye.getAttribute('data-i18n-title')).toBe('connection.handy.showKey');
  });

  it('closing the panel masks a shown key, so the next open starts hidden', () => {
    const { panel, key, eye } = build({ savedKey: KEY });
    panel.show();
    eye.click();
    expect(key.type).toBe('text');
    panel.hide();
    expect(key.type).toBe('password');
    panel.show();
    expect(key.type).toBe('password');
    expect(eye.getAttribute('aria-pressed')).toBe('false');
  });

  it('Connect and Enter still send the typed or pasted key, masked or shown', async () => {
    const { panel, handyManager, key, eye } = build();
    key.value = `  ${KEY} `;   // a paste with spaces round it
    panel._panel.querySelector('#btn-connect').click();
    await vi.waitFor(() => expect(handyManager.connect).toHaveBeenCalledWith(KEY));

    eye.click();
    key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(handyManager.connect).toHaveBeenCalledTimes(2));
    expect(handyManager.connect).toHaveBeenLastCalledWith(KEY);
  });

  it('nothing it does writes the key to the log', async () => {
    const { panel, key, eye } = build({ savedKey: KEY });
    panel.show();
    eye.click();
    eye.click();
    key.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    panel.hide();
    await new Promise((r) => setTimeout(r, 0));
    expect(logged.filter((line) => line.includes(KEY))).toEqual([]);
  });
});

describe('the Autoblow device token uses the same masking', () => {
  it('masked by default with the same eye; closing the panel masks it again', () => {
    const { panel, token, tokenEye } = build();
    token.value = TOKEN;
    expect(token.type).toBe('password');
    expect(token.getAttribute('autocomplete')).toBe('off');
    expect(tokenEye.getAttribute('aria-pressed')).toBe('false');
    expect(tokenEye.getAttribute('aria-label')).toBe(t('connection.autoblow.showToken'));
    panel.show();
    tokenEye.click();
    expect(token.type).toBe('text');
    expect(tokenEye.getAttribute('aria-pressed')).toBe('true');
    expect(tokenEye.getAttribute('aria-label')).toBe(t('connection.autoblow.showToken'));
    expect(tokenEye.title).toBe(t('connection.autoblow.hideToken'));
    panel.hide();
    expect(token.type).toBe('password');
  });

  it('Connect still sends the token', async () => {
    const { panel, autoblowManager, token } = build();
    token.value = TOKEN;
    panel._panel.querySelector('#ab-connect-btn').click();
    await vi.waitFor(() => expect(autoblowManager.connect).toHaveBeenCalled());
    expect(autoblowManager.connect.mock.calls[0][0]).toBe(TOKEN);
    expect(logged.filter((line) => line.includes(TOKEN))).toEqual([]);
  });
});
