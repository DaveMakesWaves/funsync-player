// The VR modal's "Playing" label (app test 2026-11-02: V66, and the V63
// follow-up).
//
// jsdom on purpose (no node docblock): the REAL modal is opened through the
// REAL Modal component and its label read off the DOM. See notes/CLAUDE.md
// "Test environments".
//
// VRBridge calls onVideoChanged(normalisedName, rawPath). The first argument
// is a match key, lower-cased with separators stripped ("vr tagged 180 lr").
// While the modal was open its wrapper wrote THAT into the label and into
// `__vrModalLastVideo`, overwriting the file name app.js had just set, so the
// label changed to the key after a re-match and kept it on every reopen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openVRModal } from '../../renderer/components/vr-modal.js';

function fakeBridge() {
  const bridge = {
    linkState: 'receiving',
    host: '192.168.1.30',
    connected: true,
    proxy: { setOffset: vi.fn() },
    onConnect: null,
    onDisconnect: null,
    connect: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
  };
  // What app.js wires: sets the display name, then works asynchronously.
  bridge.onVideoChanged = (name, rawPath) => {
    bridge.__vrModalLastVideo = (rawPath || '').split(/[\\/]/).pop() || name;
    return new Promise(() => {});
  };
  return bridge;
}

const settings = { get: () => undefined, set: vi.fn() };
const label = () => document.querySelector('#vr-video-name')?.textContent;

async function open(bridge) {
  openVRModal({ settings, vrBridge: bridge });
  await vi.waitFor(() => expect(document.querySelector('#vr-video-name')).not.toBeNull());
}

function close(bridge) {
  bridge.__vrModalCleanup?.();
  delete bridge.__vrModalCleanup;
  document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ip: '192.168.1.10' }) }));
});

afterEach(() => {
  document.querySelectorAll('.modal-overlay').forEach((el) => el.remove());
  delete globalThis.fetch;
});

describe('VR modal "Playing" label', () => {
  it('shows the file name after a video change, not the match key', async () => {
    const bridge = fakeBridge();
    await open(bridge);
    bridge.onVideoChanged('vr tagged 180 lr', '/x/VR Tagged_180_LR.mp4');
    expect(label()).toBe('VR Tagged_180_LR.mp4');
    expect(bridge.__vrModalLastVideo).toBe('VR Tagged_180_LR.mp4');
    close(bridge);
  });

  it('still shows the file name when the modal is opened again', async () => {
    const bridge = fakeBridge();
    await open(bridge);
    bridge.onVideoChanged('vr tagged 180 lr', '/x/VR Tagged_180_LR.mp4');
    close(bridge);
    await open(bridge);
    expect(label()).toBe('VR Tagged_180_LR.mp4');
    close(bridge);
  });

  it('a URL-encoded path is shown decoded, without its query', async () => {
    const bridge = fakeBridge();
    await open(bridge);
    bridge.onVideoChanged('my scene', 'http://192.168.1.5:8080/media/My%20Scene.mp4?t=1');
    expect(label()).toBe('My Scene.mp4');
    close(bridge);
  });

  it('a name app.js resolves later (a FunSync stream URL) reaches the open modal', async () => {
    const bridge = fakeBridge();
    await open(bridge);
    bridge.onVideoChanged('0123456789ab', 'http://192.168.1.10:5123/api/media/stream/0123456789ab');
    expect(label()).toBe('0123456789ab');
    bridge.__vrModalLastVideo = 'Beach Day_180_LR.mp4';   // app.js, once the id resolves
    await vi.waitFor(() => expect(label()).toBe('Beach Day_180_LR.mp4'), { timeout: 2500 });
    close(bridge);
  });
});
