// Equirectangular projection — VR180 (Phase 2a) and VR360 (Phase 2b).
//
// Math: each output pixel corresponds to a viewing direction in world
// space, computed from the rendered FOV plus yaw/pitch uniforms. The
// viewing direction is converted to (longitude, latitude) and looked
// up in the equirect-laid-out source texture.
//
//   longitude = atan2(dir.x, dir.z)     ∈ [-π, π]
//   latitude  = asin(dir.y)             ∈ [-π/2, π/2]
//
// For VR180 the source texture covers longitude ∈ [-π/2, π/2] only
// (the front hemisphere). For VR360 it covers the full -π to π range.
//
// Stereo: u_stereoMode selects how the source frame is split.
//   0 = mono (use the full frame; output is identical for both eyes)
//   1 = SBS-half — left eye samples u ∈ [0, 0.5], right eye u ∈ [0.5, 1]
//   2 = TB-half  — left eye samples v ∈ [0.5, 1] (top), right eye v ∈ [0, 0.5]
//
// Single-pass; no multi-render-target trickery. Sub-millisecond at
// 1080p on integrated graphics — the math is a few trig calls per
// pixel and a single texture sample.

export const EQUIRECT_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_video;
uniform float u_fov;          // viewport horizontal FOV in radians
uniform float u_aspect;       // canvas aspect ratio (width / height)
uniform float u_yaw;          // radians — pan horizontal
uniform float u_pitch;        // radians — pan vertical
uniform float u_roll;         // radians — rotate around forward axis (180° flips upside-down content)
uniform int u_eye;            // 0 = left/top eye, 1 = right/bottom eye
uniform int u_stereoMode;     // 0 = mono, 1 = sbs-half, 2 = tb-half
uniform float u_lonRange;     // π for VR180, 2π for VR360 (the full source-texture longitude span)

const float PI = 3.14159265358979;

void main() {
  // 1. Pixel direction in camera space, BEFORE yaw/pitch rotation.
  //    v_uv is in [-1, 1] (set by the vertex shader). The horizontal
  //    half-angle is u_fov/2; vertical is scaled by 1/aspect.
  float halfFov = u_fov * 0.5;
  vec3 dir = normalize(vec3(
    v_uv.x * tan(halfFov),
    v_uv.y * tan(halfFov) / u_aspect,
    1.0
  ));

  // 2. Apply yaw + pitch as rotations around Y then X.
  float cy = cos(u_yaw); float sy = sin(u_yaw);
  float cp = cos(u_pitch); float sp = sin(u_pitch);
  // Yaw rotates around Y
  vec3 rotated = vec3(
    dir.x * cy + dir.z * sy,
    dir.y,
    -dir.x * sy + dir.z * cy
  );
  // Pitch rotates around X
  rotated = vec3(
    rotated.x,
    rotated.y * cp - rotated.z * sp,
    rotated.y * sp + rotated.z * cp
  );
  // Roll rotates around Z (forward axis). Last in the chain so it
  // re-orients the already-aimed view — used to flip upside-down
  // source content (camera mounted inverted on the rig).
  float cr = cos(u_roll); float sr = sin(u_roll);
  rotated = vec3(
    rotated.x * cr - rotated.y * sr,
    rotated.x * sr + rotated.y * cr,
    rotated.z
  );

  // 3. Direction → (longitude, latitude).
  float lon = atan(rotated.x, rotated.z);
  float lat = asin(clamp(rotated.y, -1.0, 1.0));

  // For VR180, anything beyond ±π/2 longitude is outside the source
  // frame — paint black so the user can see the field-of-view edge
  // rather than mirroring or wrapping (which looks like a glitch).
  if (u_lonRange < PI && abs(lon) > PI * 0.5) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // 4. (lon, lat) → texture UV. Source covers lon ∈ [-u_lonRange/2,
  //    u_lonRange/2] horizontally and the full π vertical range.
  float u = (lon / u_lonRange) + 0.5;
  float v = (lat / PI) + 0.5;

  // 5. Stereo half-frame split.
  if (u_stereoMode == 1) {
    // SBS-half: each eye is half-width.
    u = u * 0.5 + (u_eye == 1 ? 0.5 : 0.0);
  } else if (u_stereoMode == 2) {
    // TB-half: typically left eye is the TOP half.
    v = v * 0.5 + (u_eye == 1 ? 0.0 : 0.5);
  }

  fragColor = texture(u_video, vec2(u, v));
}
`;
