/**
 * @vitest-environment jsdom
 *
 * #426 (Fistemo, 2026-11-22): the phone's Flat view, a VR video shown as one
 * flat picture as the desktop's VR Format does, for watching VR without a
 * headset. The phone runs the desktop's own renderer (served at /vr-flatten/);
 * the desktop sends each video's saved spherical format with the library.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import {
  flatViewFormat, lookFromDrag, fovFromPinch, PhoneFlatView, DRAG_SLOP_PX, RENDERER_URL,
} from '../../backend/web-remote/vr-flat.js';
import { remoteVRFormat } from '../../renderer/js/remote-vr-format.js';

describe('what the desktop sends (remoteVRFormat)', () => {
  it('a saved spherical format, with its eye and view', () => {
    expect(remoteVRFormat({ projection: 'fisheye-180', eye: 'right', fov: 100, yaw: -24, pitch: 4, roll: 180, zoom: 1, source: 'manual' }))
      .toEqual({ projection: 'fisheye-180', eye: 'right', fov: 100, yaw: -24, pitch: 4, roll: 180 });
  });
  it('missing numbers get the defaults; a planar, "not VR" or missing entry sends nothing', () => {
    expect(remoteVRFormat({ projection: 'equirect-180' })).toEqual({ projection: 'equirect-180', eye: 'left', fov: 90, yaw: 0, pitch: 0, roll: 0 });
    expect(remoteVRFormat({ projection: 'sbs-half', eye: 'left' })).toBeNull();
    expect(remoteVRFormat({ projection: 'flat' })).toBeNull();
    expect(remoteVRFormat(null)).toBeNull();
  });
});

describe('what the phone opens with (flatViewFormat)', () => {
  it('the desktop\'s saved format when there is one', () => {
    expect(flatViewFormat({ name: 'Clip.mp4', vrFormat: { projection: 'fisheye-180', eye: 'right', fov: 110, yaw: 5, pitch: -3, roll: 0 } }))
      .toEqual({ projection: 'fisheye-180', eye: 'right', fov: 110, yaw: 5, pitch: -3, roll: 0 });
  });
  it('a VR video with none: Equirectangular 180, left eye, straight ahead', () => {
    expect(flatViewFormat({ name: 'AJVR-142-C_180_LR.mp4' })).toEqual({ projection: 'equirect-180', eye: 'left', fov: 90, yaw: 0, pitch: 0, roll: 0 });
  });
  it('a flat video: no Flat view', () => {
    expect(flatViewFormat({ name: 'Alpha Scene.mp4' })).toBeNull();
    expect(flatViewFormat(null)).toBeNull();
  });
});

describe('gestures, as numbers', () => {
  it('a drag across the whole width turns the view by one field of view, the picture following the finger', () => {
    expect(lookFromDrag({ yaw: 0, pitch: 0 }, 400, 0, 400, 90)).toEqual({ yaw: -90, pitch: 0 });
    expect(lookFromDrag({ yaw: 10, pitch: 0 }, -200, 0, 400, 90).yaw).toBe(55);
  });
  it('looking up or down stops at 85 degrees', () => {
    expect(lookFromDrag({ yaw: 0, pitch: 80 }, 0, 400, 400, 90).pitch).toBe(85);
    expect(lookFromDrag({ yaw: 0, pitch: -80 }, 0, -400, 400, 90).pitch).toBe(-85);
  });
  it('fingers apart zoom in, together zoom out, between 30 and 160 degrees', () => {
    expect(fovFromPinch(90, 100, 200)).toBe(45);
    expect(fovFromPinch(90, 200, 100)).toBe(160);
    expect(fovFromPinch(40, 100, 400)).toBe(30);
    expect(fovFromPinch(90, 0, 100)).toBe(90);
  });
});

describe('PhoneFlatView', () => {
  let wrap, video, overlay, made, taps;
  class FakeRenderer {
    constructor() { made.push(this); this.calls = []; this.mounted = false; }
    mount(v, c) { this.canvas = document.createElement('canvas'); c.appendChild(this.canvas); this.mounted = true; }
    unmount() { this.canvas.remove(); this.mounted = false; this.calls.push(['unmount']); }
    setProjection(p) { this.calls.push(['projection', p]); }
    setEye(e) { this.calls.push(['eye', e]); }
    setStereoMode(m) { this.calls.push(['stereo', m]); }
    setFov(f) { this.calls.push(['fov', f]); }
    setYawPitch(y, p) { this.calls.push(['yawPitch', y, p]); }
    setRoll(r) { this.calls.push(['roll', r]); }
  }
  const fmt = { projection: 'equirect-180', eye: 'left', fov: 90, yaw: 0, pitch: 0, roll: 0 };
  const flatView = (importRenderer = async () => ({ VRProjectionRenderer: FakeRenderer })) =>
    new PhoneFlatView({ videoWrap: wrap, videoEl: video, format: fmt, importRenderer });
  function pointer(type, target, id, x, y) {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: id });
    target.dispatchEvent(e);
    return e;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    made = [];
    taps = 0;
    wrap = document.createElement('div');
    video = document.createElement('video');
    overlay = document.createElement('div');
    overlay.className = 'pcx';
    wrap.append(video, overlay);
    Object.defineProperty(wrap, 'clientWidth', { value: 400, configurable: true });
    document.body.appendChild(wrap);
    // The controls' own tap handler on the wrap (app.js: pointerup, bubble phase).
    wrap.addEventListener('pointerup', () => { taps++; });
  });

  it('on: the desktop\'s format is set, the canvas sits right after the video (under the controls), the video is hidden', async () => {
    const fv = flatView();
    expect(await fv.enable()).toBe(true);
    const r = made[0];
    expect(r.calls.slice(0, 6)).toEqual([['projection', 'equirect-180'], ['eye', 'left'], ['stereo', 1], ['fov', 90], ['yawPitch', 0, 0], ['roll', 0]]);
    expect(video.nextSibling).toBe(r.canvas);
    expect(wrap.lastChild).toBe(overlay);
    expect(wrap.classList.contains('player__video-wrap--flat')).toBe(true);
    fv.disable();
    expect(r.calls.at(-1)).toEqual(['unmount']);
    expect(wrap.classList.contains('player__video-wrap--flat')).toBe(false);
  });

  it('no WebGL2 (the mount throws) or the renderer did not load: false, and nothing changes', async () => {
    class NoGL extends FakeRenderer { mount() { throw new Error('WebGL2 not available'); } }
    expect(await flatView(async () => ({ VRProjectionRenderer: NoGL })).enable()).toBe(false);
    expect(await flatView(async () => { throw new Error('404'); }).enable()).toBe(false);
    expect(wrap.classList.contains('player__video-wrap--flat')).toBe(false);
  });

  it('a drag looks around, and is not a tap for the controls', async () => {
    const fv = flatView();
    await fv.enable();
    pointer('pointerdown', overlay, 1, 200, 100);
    pointer('pointermove', overlay, 1, 300, 100);       // 100 px right of a 400 px view at 90 degrees
    pointer('pointerup', overlay, 1, 300, 100);
    expect(made[0].calls.at(-1)).toEqual(['yawPitch', -22.5, 0]);
    expect(taps).toBe(0);
  });

  it('a press that hardly moves is still a tap: the controls show, the view does not turn', async () => {
    const fv = flatView();
    await fv.enable();
    const n = made[0].calls.length;
    pointer('pointerdown', overlay, 1, 200, 100);
    pointer('pointermove', overlay, 1, 200 + DRAG_SLOP_PX - 3, 100);
    pointer('pointerup', overlay, 1, 200 + DRAG_SLOP_PX - 3, 100);
    expect(made[0].calls.length).toBe(n);
    expect(taps).toBe(1);
  });

  it('two fingers pinch the field of view', async () => {
    const fv = flatView();
    await fv.enable();
    pointer('pointerdown', overlay, 1, 100, 100);
    pointer('pointerdown', overlay, 2, 200, 100);        // 100 px apart
    pointer('pointermove', overlay, 2, 300, 100);        // 200 px apart: zoom in
    expect(made[0].calls.at(-1)).toEqual(['fov', 45]);
    pointer('pointerup', overlay, 2, 300, 100);
    pointer('pointerup', overlay, 1, 100, 100);
    expect(taps).toBe(0);
  });

  it('off: drags reach nothing any more', async () => {
    const fv = flatView();
    await fv.enable();
    fv.disable();
    const n = made[0].calls.length;
    pointer('pointerdown', overlay, 1, 200, 100);
    pointer('pointermove', overlay, 1, 300, 100);
    pointer('pointerup', overlay, 1, 300, 100);
    expect(made[0].calls.length).toBe(n);
    expect(taps).toBe(1);
  });
});

describe('the wiring', () => {
  it('the phone loads the renderer from the backend route, which serves only the renderer and its shaders', () => {
    expect(RENDERER_URL).toBe('/vr-flatten/vr-projection-renderer.js');
    const main = fs.readFileSync('backend/main.py', 'utf8');
    for (const f of ['vr-projection-renderer.js', 'shaders/_passthrough.vert.js', 'shaders/equirect.frag.js', 'shaders/fisheye.frag.js']) {
      expect(main).toContain(`"${f}"`);
      expect(fs.existsSync(`renderer/js/${f}`)).toBe(true);
    }
    const spec = fs.readFileSync('backend/funsync-backend.spec', 'utf8');
    expect(spec).toContain("('../renderer/js/vr-projection-renderer.js', 'vr-flatten')");
    expect(spec).toContain("('../renderer/js/shaders', 'vr-flatten/shaders')");
  });

  it('the renderer imports nothing but its shaders (the phone can load nothing else)', () => {
    const src = fs.readFileSync('renderer/js/vr-projection-renderer.js', 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports.every((p) => p.startsWith('./shaders/'))).toBe(true);
  });

  it('the phone player offers the button on a VR video; the desktop sends vrFormat and re-sends it on a change', () => {
    const app = fs.readFileSync('backend/web-remote/app.js', 'utf8');
    expect(app).toMatch(/const flatBtn = buildFlatViewButton\(videoWrap, videoEl, video\);/);
    const lib = fs.readFileSync('renderer/components/library.js', 'utf8');
    expect(lib).toMatch(/const vrFormat = remoteVRFormat\(vrFormats\[v\.path\]\);/);
    const desk = fs.readFileSync('renderer/js/app.js', 'utf8');
    expect(desk).toMatch(/path === 'library\.manualVariants' \|\| path === 'library\.vrFormat'\) scheduleVideos\(\);/);
  });
});
