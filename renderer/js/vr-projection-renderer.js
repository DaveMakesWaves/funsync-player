// VRProjectionRenderer — WebGL2 canvas overlay that resamples a
// non-planar VR video (equirect / fisheye) onto a flat viewport for
// users without a headset.
//
// Phase 2a (2026-05-21) of `notes/features/SCOPE-vr-flatten-full.md`.
// Ships equirect-180 + fisheye-180. Phase 2b adds equirect-360,
// fisheye-190/200, MKX200, RF52, EAC.
//
// Lifecycle:
//   - Lazily mounted by `video-player.js::setVRFlatten` the first time
//     a non-planar projection is requested. Kept alive until the
//     VideoPlayer is disposed (cheap idle state — canvas hidden, no
//     RAF running when paused).
//   - `requestVideoFrameCallback` paces the render loop — fires once
//     per decoded video frame, naturally pauses with the video.
//   - texImage2D(TEXTURE_2D, ..., videoElement) is zero-copy on
//     hardware-decoded sources in modern Chromium (Windows + Linux).
//     Software-decoded fallback uses a CPU readback path which is
//     still ≤16ms per frame at 1080p — playable but warmer.
//
// What it does NOT do:
//   - No drag-to-pan logic here — the renderer just exposes
//     setYawPitch / setFov. Caller (vr-format-panel) wires user input.
//   - No projection auto-detection — the caller picks which shader
//     to use based on the per-video config.

import { PASSTHROUGH_VERT } from './shaders/_passthrough.vert.js';
import { EQUIRECT_FRAG } from './shaders/equirect.frag.js';
import { FISHEYE_FRAG } from './shaders/fisheye.frag.js';

// Projection-name → shader source. Adding a new projection means:
//   1. Write its fragment shader.
//   2. Add an entry here.
//   3. Wire its `sourceFov` / `lonRange` defaults in setProjection().
const FRAGMENT_SOURCES = {
  'equirect-180': EQUIRECT_FRAG,
  'equirect-360': EQUIRECT_FRAG, // shares shader; lonRange uniform differs
  'fisheye-180':  FISHEYE_FRAG,
  'fisheye-190':  FISHEYE_FRAG, // Phase 2b — same shader, different sourceFov
  'fisheye-200':  FISHEYE_FRAG,
};

// Phase 2a only enables equirect-180 + fisheye-180; the others are
// listed for forwards compatibility but the panel currently disables
// them.
const PHASE_2A_PROJECTIONS = new Set(['equirect-180', 'fisheye-180']);

export class VRProjectionRenderer {
  constructor() {
    this.canvas = null;
    this.gl = null;
    this._mounted = false;
    this._videoEl = null;
    this._programs = new Map(); // projection name → compiled program + uniforms
    this._currentProjection = null;
    this._texture = null;
    this._rvfcHandle = null;
    this._resizeObserver = null;

    // State (uniforms).
    this._state = {
      projection: 'equirect-180',
      eye: 'left',          // 'left' | 'right'
      stereoMode: 1,        // 0 mono, 1 sbs-half, 2 tb-half
      fov: 90 * Math.PI / 180,
      yaw: 0,
      pitch: 0,
      roll: 0,              // radians — for upside-down source content; persisted per-video
    };

    // Whether the last render produced anything. Useful for tests.
    this._renderCount = 0;
  }

  /**
   * Attach the renderer to a video element + container. Creates the
   * canvas inside the container, initialises the GL context, and
   * starts the render loop. Idempotent — calling twice does nothing.
   *
   * @param {HTMLVideoElement} videoEl
   * @param {HTMLElement} container — the element the canvas is added to
   */
  mount(videoEl, container) {
    if (this._mounted) return;
    if (!videoEl || !container) {
      throw new Error('VRProjectionRenderer.mount requires videoEl + container');
    }
    this._videoEl = videoEl;

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'vr-projection-canvas';
    this.canvas.className = 'vr-projection-canvas';
    container.appendChild(this.canvas);

    const gl = this.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) {
      this.canvas.remove();
      this.canvas = null;
      throw new Error('WebGL2 not available — VR projection rendering disabled');
    }
    this.gl = gl;

    // Single quad covering the whole clip space.
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
    this._quadVbo = vbo;

    // Texture — uploaded from the video element on every render.
    this._texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Compile both Phase-2a shaders up front — cheap, ~1ms each, and
    // avoids a stutter on first projection switch.
    for (const name of PHASE_2A_PROJECTIONS) this._ensureProgram(name);

    // Size the canvas to match the container, keep it sized.
    const sync = () => this._resizeCanvas();
    sync();
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(sync);
      this._resizeObserver.observe(container);
    }

    this._mounted = true;
    this._startRenderLoop();
  }

  /** Tear down the renderer and remove the canvas. */
  unmount() {
    if (!this._mounted) return;
    this._stopRenderLoop();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    // GL objects: release in reverse-construction order.
    if (this.gl) {
      if (this._texture) this.gl.deleteTexture(this._texture);
      if (this._quadVbo) this.gl.deleteBuffer(this._quadVbo);
      for (const program of this._programs.values()) {
        this.gl.deleteProgram(program.program);
      }
      this._programs.clear();
      // No `gl.deleteContext` API — let the canvas removal collect it.
      this.gl = null;
    }
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
    this._texture = null;
    this._quadVbo = null;
    this._videoEl = null;
    this._mounted = false;
  }

  /** Returns true while mounted (test helper). */
  get mounted() { return this._mounted; }

  /** Change the active projection. */
  setProjection(name) {
    if (!FRAGMENT_SOURCES[name]) {
      throw new Error(`Unknown projection: ${name}`);
    }
    this._state.projection = name;
    if (this._mounted) this._ensureProgram(name);
  }

  /** Eye selector — 'left' (or 'top') vs 'right' (or 'bottom'). */
  setEye(eye) {
    this._state.eye = eye === 'right' ? 'right' : 'left';
  }

  /** Stereo mode: 0 mono, 1 sbs-half, 2 tb-half. */
  setStereoMode(mode) {
    this._state.stereoMode = (mode === 0 || mode === 1 || mode === 2) ? mode : 1;
  }

  /** Viewport FOV in degrees (clamped 30-160). */
  setFov(degrees) {
    const clamped = Math.max(30, Math.min(160, Number(degrees) || 90));
    this._state.fov = clamped * Math.PI / 180;
  }

  /** Pan offsets in degrees. */
  setYawPitch(yawDeg, pitchDeg) {
    this._state.yaw = (Number(yawDeg) || 0) * Math.PI / 180;
    // Clamp pitch to ±85° — straight up/down is a singularity for the
    // viewing-direction math and causes the image to twist as the user
    // crosses the pole.
    const pitch = Math.max(-85, Math.min(85, Number(pitchDeg) || 0));
    this._state.pitch = pitch * Math.PI / 180;
  }

  /** Reset yaw + pitch to 0 (double-click recenter callsite).
   *  Roll is NOT reset — it's a per-video orientation flag, not a pan. */
  recenter() {
    this._state.yaw = 0;
    this._state.pitch = 0;
  }

  /** Roll in degrees (rotates around the forward axis). 180° flips
   *  upside-down source content. No clamp — full ±360° is valid. */
  setRoll(degrees) {
    this._state.roll = (Number(degrees) || 0) * Math.PI / 180;
  }

  /**
   * Pure-JS mirror of the centre-pixel direction the GLSL computes.
   * Exposed so unit tests can verify the math without WebGL.
   *
   * @returns {{x:number, y:number, z:number}}
   */
  computeCenterDirection() {
    const yaw = this._state.yaw;
    const pitch = this._state.pitch;
    // Centre pixel: v_uv = (0, 0) → dir before rotation = (0, 0, 1).
    let dx = 0, dy = 0, dz = 1;
    // Yaw around Y
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let rx = dx * cy + dz * sy;
    let ry = dy;
    let rz = -dx * sy + dz * cy;
    // Pitch around X
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const ry2 = ry * cp - rz * sp;
    const rz2 = ry * sp + rz * cp;
    return { x: rx, y: ry2, z: rz2 };
  }

  // --- Internals ---

  _resizeCanvas() {
    if (!this.canvas || !this.gl) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  _ensureProgram(name) {
    if (this._programs.has(name)) return this._programs.get(name);
    const gl = this.gl;
    const program = this._compile(PASSTHROUGH_VERT, FRAGMENT_SOURCES[name]);
    const aPos = gl.getAttribLocation(program, 'a_position');
    const uniforms = {
      u_video:      gl.getUniformLocation(program, 'u_video'),
      u_fov:        gl.getUniformLocation(program, 'u_fov'),
      u_aspect:     gl.getUniformLocation(program, 'u_aspect'),
      u_yaw:        gl.getUniformLocation(program, 'u_yaw'),
      u_pitch:      gl.getUniformLocation(program, 'u_pitch'),
      u_roll:       gl.getUniformLocation(program, 'u_roll'),
      u_eye:        gl.getUniformLocation(program, 'u_eye'),
      u_stereoMode: gl.getUniformLocation(program, 'u_stereoMode'),
      u_lonRange:   gl.getUniformLocation(program, 'u_lonRange'),
      u_sourceFov:  gl.getUniformLocation(program, 'u_sourceFov'),
    };
    const entry = { program, aPos, uniforms };
    this._programs.set(name, entry);
    return entry;
  }

  _compile(vertSrc, fragSrc) {
    const gl = this.gl;
    const vs = this._compileShader(gl.VERTEX_SHADER, vertSrc);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Shader link failed: ${log}`);
    }
    return program;
  }

  _compileShader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return sh;
  }

  _startRenderLoop() {
    const tick = () => {
      this._render();
      // Schedule next frame from the video — only fires once per
      // decoded frame; naturally pauses on pause/buffer.
      if (this._videoEl && typeof this._videoEl.requestVideoFrameCallback === 'function') {
        this._rvfcHandle = this._videoEl.requestVideoFrameCallback(tick);
      } else {
        // Fallback: rAF at display rate. Real video clock still drives
        // currentTime; we just paint more often than needed.
        this._rvfcHandle = requestAnimationFrame(tick);
      }
    };
    tick();
  }

  _stopRenderLoop() {
    if (this._rvfcHandle == null) return;
    if (this._videoEl && typeof this._videoEl.cancelVideoFrameCallback === 'function') {
      try { this._videoEl.cancelVideoFrameCallback(this._rvfcHandle); } catch { /* swallow */ }
    } else {
      try { cancelAnimationFrame(this._rvfcHandle); } catch { /* swallow */ }
    }
    this._rvfcHandle = null;
  }

  _render() {
    if (!this.gl || !this._videoEl) return;
    const gl = this.gl;
    const video = this._videoEl;
    // Don't try to upload a video frame that doesn't exist yet.
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

    const entry = this._ensureProgram(this._state.projection);
    gl.useProgram(entry.program);

    // Texture upload — zero-copy on Windows/Linux with hardware decode.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

    // Quad attribute binding.
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadVbo);
    gl.enableVertexAttribArray(entry.aPos);
    gl.vertexAttribPointer(entry.aPos, 2, gl.FLOAT, false, 0, 0);

    // Uniforms.
    const aspect = (this.canvas.width || 1) / (this.canvas.height || 1);
    const proj = this._state.projection;
    const isEquirect = proj === 'equirect-180' || proj === 'equirect-360';
    const lonRange = proj === 'equirect-360' ? 2 * Math.PI : Math.PI;
    const sourceFov = {
      'fisheye-180': Math.PI,
      'fisheye-190': 190 * Math.PI / 180,
      'fisheye-200': 200 * Math.PI / 180,
    }[proj] || Math.PI;

    gl.uniform1i(entry.uniforms.u_video, 0);
    gl.uniform1f(entry.uniforms.u_fov, this._state.fov);
    gl.uniform1f(entry.uniforms.u_aspect, aspect);
    gl.uniform1f(entry.uniforms.u_yaw, this._state.yaw);
    gl.uniform1f(entry.uniforms.u_pitch, this._state.pitch);
    gl.uniform1f(entry.uniforms.u_roll, this._state.roll);
    gl.uniform1i(entry.uniforms.u_eye, this._state.eye === 'right' ? 1 : 0);
    gl.uniform1i(entry.uniforms.u_stereoMode, this._state.stereoMode);
    if (isEquirect) gl.uniform1f(entry.uniforms.u_lonRange, lonRange);
    else gl.uniform1f(entry.uniforms.u_sourceFov, sourceFov);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this._renderCount++;
  }
}
