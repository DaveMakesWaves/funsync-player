// Shared vertex shader — a single full-screen quad. Each projection's
// fragment shader does its own work from gl_FragCoord / vUv. Pure
// pass-through so the same vertex code works for every projection.

export const PASSTHROUGH_VERT = /* glsl */ `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  // a_position is in [-1, 1] clip space; v_uv is the same range
  // (the shader can shift to [0, 1] if it needs texture coords).
  v_uv = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
