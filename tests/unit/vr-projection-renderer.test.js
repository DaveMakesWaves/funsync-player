// Tests for VRProjectionRenderer.
//
// jsdom has no real WebGL2 context, so we install a hand-rolled mock
// on `HTMLCanvasElement.prototype.getContext` for the lifetime of each
// test. The mock records every call into `_calls` so we can assert on
// shader compilation, uniform writes, and the render loop.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VRProjectionRenderer } from '../../renderer/js/vr-projection-renderer.js';

function makeGLMock() {
  const gl = {
    // Constants we use.
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88E4,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_2D: 0x0DE1,
    TEXTURE0: 0x84C0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812F,
    RGBA: 0x1908,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    TRIANGLES: 0x0004,

    _calls: [],
    _record(name, ...args) { this._calls.push([name, ...args]); },

    createShader: vi.fn(function (type) { this._record('createShader', type); return { type, _id: 'sh-' + Math.random() }; }),
    shaderSource: vi.fn(function (sh, src) { sh._src = src; this._record('shaderSource', sh, src); }),
    compileShader: vi.fn(function (sh) { this._record('compileShader', sh); }),
    getShaderParameter: vi.fn(function () { return true; }),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(function () { this._record('createProgram'); return { _id: 'prog-' + Math.random(), _uniforms: {} }; }),
    attachShader: vi.fn(function (p, sh) { p._shaders = (p._shaders || []).concat(sh); this._record('attachShader', p, sh); }),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    useProgram: vi.fn(function (p) { this._record('useProgram', p); this._currentProgram = p; }),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn(function (p, name) {
      if (!p._uniforms[name]) p._uniforms[name] = { name };
      return p._uniforms[name];
    }),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createBuffer: vi.fn(() => ({ _id: 'buf' })),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    createTexture: vi.fn(() => ({ _id: 'tex' })),
    deleteTexture: vi.fn(),
    deleteBuffer: vi.fn(),
    bindTexture: vi.fn(),
    activeTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(function () { this._record('texImage2D'); }),
    pixelStorei: vi.fn(),
    viewport: vi.fn(function (...args) { this._record('viewport', ...args); }),
    drawArrays: vi.fn(function (mode, first, count) { this._record('drawArrays', mode, first, count); }),
    uniform1f: vi.fn(function (loc, v) { this._record('uniform1f', loc, v); }),
    uniform1i: vi.fn(function (loc, v) { this._record('uniform1i', loc, v); }),
  };
  return gl;
}

let originalGetContext;
let glMock;

beforeEach(() => {
  glMock = makeGLMock();
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === 'webgl2') return glMock;
    return originalGetContext.call(this, type);
  };
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

function makeVideo() {
  // jsdom's <video> is fine but doesn't decode anything. We stub the
  // properties the renderer reads.
  const v = document.createElement('video');
  Object.defineProperty(v, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(v, 'videoWidth', { value: 1920, configurable: true });
  Object.defineProperty(v, 'videoHeight', { value: 1080, configurable: true });
  v.requestVideoFrameCallback = vi.fn(() => 42);
  v.cancelVideoFrameCallback = vi.fn();
  return v;
}

function makeContainer() {
  const div = document.createElement('div');
  // Give it non-zero dimensions; ResizeObserver in jsdom doesn't track
  // layout but we set the bounding rect manually.
  Object.defineProperty(div, 'clientWidth', { value: 1280, configurable: true });
  Object.defineProperty(div, 'clientHeight', { value: 720, configurable: true });
  document.body.appendChild(div);
  return div;
}

describe('VRProjectionRenderer — lifecycle', () => {
  it('mount installs canvas + compiles Phase 2a shaders', () => {
    const r = new VRProjectionRenderer();
    const video = makeVideo();
    const container = makeContainer();
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 450, configurable: true });

    r.mount(video, container);

    expect(r.mounted).toBe(true);
    expect(r.canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(container.contains(r.canvas)).toBe(true);
    // Compile + link called for each of equirect-180 + fisheye-180 = 2 programs.
    expect(glMock.createProgram).toHaveBeenCalledTimes(2);
    // Each program: 1 vertex + 1 fragment shader compiled.
    expect(glMock.createShader).toHaveBeenCalledTimes(4);
    r.unmount();
  });

  it('unmount removes canvas + clears GL resources', () => {
    const r = new VRProjectionRenderer();
    const video = makeVideo();
    const container = makeContainer();
    r.mount(video, container);
    const canvasRef = r.canvas;
    r.unmount();
    expect(r.mounted).toBe(false);
    expect(r.canvas).toBe(null);
    expect(container.contains(canvasRef)).toBe(false);
    // Texture, buffer, programs all deleted.
    expect(glMock.deleteTexture).toHaveBeenCalled();
    expect(glMock.deleteBuffer).toHaveBeenCalled();
    expect(glMock.deleteProgram).toHaveBeenCalledTimes(2);
  });

  it('mount is idempotent', () => {
    const r = new VRProjectionRenderer();
    const video = makeVideo();
    const container = makeContainer();
    r.mount(video, container);
    const firstCanvas = r.canvas;
    r.mount(video, container); // no-op
    expect(r.canvas).toBe(firstCanvas);
    r.unmount();
  });

  it('throws on missing WebGL2 (mount cleans up after itself)', () => {
    HTMLCanvasElement.prototype.getContext = function () { return null; };
    const r = new VRProjectionRenderer();
    expect(() => r.mount(makeVideo(), makeContainer())).toThrow(/WebGL2/);
    expect(r.mounted).toBe(false);
    expect(r.canvas).toBe(null);
  });

  it('drives requestVideoFrameCallback for the render loop', () => {
    const r = new VRProjectionRenderer();
    const video = makeVideo();
    r.mount(video, makeContainer());
    expect(video.requestVideoFrameCallback).toHaveBeenCalled();
    r.unmount();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
  });
});

describe('VRProjectionRenderer — state setters', () => {
  let r, video, container;

  beforeEach(() => {
    r = new VRProjectionRenderer();
    video = makeVideo();
    container = makeContainer();
    r.mount(video, container);
  });
  afterEach(() => { r.unmount(); });

  it('setFov clamps to [30, 160]', () => {
    r.setFov(10);
    expect(r._state.fov).toBeCloseTo(30 * Math.PI / 180);
    r.setFov(200);
    expect(r._state.fov).toBeCloseTo(160 * Math.PI / 180);
    r.setFov(90);
    expect(r._state.fov).toBeCloseTo(Math.PI / 2);
  });

  it('setYawPitch converts degrees → radians and clamps pitch ±85°', () => {
    r.setYawPitch(45, 30);
    expect(r._state.yaw).toBeCloseTo(45 * Math.PI / 180);
    expect(r._state.pitch).toBeCloseTo(30 * Math.PI / 180);
    r.setYawPitch(0, 200);
    expect(r._state.pitch).toBeCloseTo(85 * Math.PI / 180);
    r.setYawPitch(0, -200);
    expect(r._state.pitch).toBeCloseTo(-85 * Math.PI / 180);
  });

  it('recenter zeroes yaw + pitch', () => {
    r.setYawPitch(45, 30);
    r.recenter();
    expect(r._state.yaw).toBe(0);
    expect(r._state.pitch).toBe(0);
  });

  it('setEye normalises to left/right', () => {
    r.setEye('right');
    expect(r._state.eye).toBe('right');
    r.setEye('garbage');
    expect(r._state.eye).toBe('left');
  });

  it('setProjection throws on unknown name', () => {
    expect(() => r.setProjection('not-a-projection')).toThrow();
  });

  it('setProjection accepts equirect-180 and fisheye-180', () => {
    r.setProjection('equirect-180');
    expect(r._state.projection).toBe('equirect-180');
    r.setProjection('fisheye-180');
    expect(r._state.projection).toBe('fisheye-180');
  });
});

describe('VRProjectionRenderer — render writes uniforms', () => {
  it('renders write current state to the shader uniforms', () => {
    const r = new VRProjectionRenderer();
    const video = makeVideo();
    r.mount(video, makeContainer());
    r.setProjection('equirect-180');
    r.setEye('right');
    r.setFov(120);
    r.setYawPitch(30, -15);
    // Force a render directly (the RAF stub never schedules another).
    r._render();
    // The render must:
    //   - upload the video frame
    //   - set u_fov / u_yaw / u_pitch / u_eye
    //   - draw the quad
    expect(glMock.texImage2D).toHaveBeenCalled();
    const calls = glMock._calls;
    const uniformF = calls.filter(c => c[0] === 'uniform1f');
    const uniformI = calls.filter(c => c[0] === 'uniform1i');
    expect(uniformF.length).toBeGreaterThanOrEqual(4); // fov, aspect, yaw, pitch, lonRange
    expect(uniformI.length).toBeGreaterThanOrEqual(3); // sampler, eye, stereoMode
    expect(calls.some(c => c[0] === 'drawArrays')).toBe(true);
    r.unmount();
  });
});
