/**
 * @vitest-environment node
 * No DOM required — skips jsdom construction. See notes/CLAUDE.md
 * "Test environments" before changing this or adding DOM here.
 */
// Pins the "can this video be popped out?" guard used in app.js
// (_currentPopoutVideo / _togglePlayerWindow). Phase 2b supports local
// library files only, and never while another external source (phone /
// VR headset) is already driving the devices.
//
// Mirrored as a pure function so the rules are testable without the App.

import { describe, it, expect } from 'vitest';

function canPopOut({ src, remoteActive, vrConnected }) {
  if (remoteActive || vrConnected) return false;         // another source drives
  if (typeof src !== 'string') return false;
  return src.startsWith('file:');                        // local library file only
}

describe('canPopOut (detached player eligibility)', () => {
  const local = 'file:///C:/videos/clip.mp4';

  it('allows a local file when nothing else is driving', () => {
    expect(canPopOut({ src: local, remoteActive: false, vrConnected: false })).toBe(true);
  });

  it('blocks while a phone (web-remote) is driving', () => {
    expect(canPopOut({ src: local, remoteActive: true, vrConnected: false })).toBe(false);
  });

  it('blocks while a VR headset is connected', () => {
    expect(canPopOut({ src: local, remoteActive: false, vrConnected: true })).toBe(false);
  });

  it('blocks blob: (drag-drop) and remote/HLS srcs', () => {
    expect(canPopOut({ src: 'blob:abc-123', remoteActive: false, vrConnected: false })).toBe(false);
    expect(canPopOut({ src: 'http://127.0.0.1:5123/hls/x.m3u8', remoteActive: false, vrConnected: false })).toBe(false);
  });

  it('blocks empty / non-string srcs', () => {
    expect(canPopOut({ src: '', remoteActive: false, vrConnected: false })).toBe(false);
    expect(canPopOut({ src: undefined, remoteActive: false, vrConnected: false })).toBe(false);
  });
});
