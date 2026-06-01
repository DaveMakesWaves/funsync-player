// Angular fisheye projection — Phase 2a covers fisheye-180.
//
// Source format: a circular fisheye image where the centre of the
// circle is the forward viewing direction and the edge is half the
// source FOV. We compute the angle θ from the centre based on the
// viewing direction, then map r = θ / (sourceFov / 2).
//
// For SBS stereo, each eye occupies one circular half of the texture
// (left eye = left half, right eye = right half). The circle in each
// half is centred at u = 0.25 or u = 0.75; radius 0.5 in u, 1.0 in v.
//
// MKX200 + RF52 (Phase 2b) extend this with lens-distortion polynomials
// applied to `r` before the texture lookup — kept out of Phase 2a.

export const FISHEYE_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_video;
uniform float u_fov;          // viewport horizontal FOV in radians
uniform float u_aspect;       // canvas aspect (width / height)
uniform float u_yaw;          // radians
uniform float u_pitch;        // radians
uniform float u_roll;         // radians — rotate around forward axis (180° flips upside-down content)
uniform int u_eye;            // 0 = left, 1 = right
uniform int u_stereoMode;     // 0 = mono, 1 = sbs-half
uniform float u_sourceFov;    // source fisheye FOV in radians (π for 180°, …)

const float PI = 3.14159265358979;

void main() {
  // Viewing direction with yaw/pitch applied (matches equirect.frag).
  float halfFov = u_fov * 0.5;
  vec3 dir = normalize(vec3(
    v_uv.x * tan(halfFov),
    v_uv.y * tan(halfFov) / u_aspect,
    1.0
  ));
  float cy = cos(u_yaw); float sy = sin(u_yaw);
  float cp = cos(u_pitch); float sp = sin(u_pitch);
  vec3 rotated = vec3(
    dir.x * cy + dir.z * sy,
    dir.y,
    -dir.x * sy + dir.z * cy
  );
  rotated = vec3(
    rotated.x,
    rotated.y * cp - rotated.z * sp,
    rotated.y * sp + rotated.z * cp
  );
  // Roll rotates around Z (forward axis) — flips upside-down source.
  float cr = cos(u_roll); float sr = sin(u_roll);
  rotated = vec3(
    rotated.x * cr - rotated.y * sr,
    rotated.x * sr + rotated.y * cr,
    rotated.z
  );

  // Direction in front-hemisphere check — anything pointing backwards
  // is outside the source frame; paint black.
  if (rotated.z <= 0.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Angular fisheye math: θ is the angle from forward (+Z); r = θ / (sourceFov/2).
  float theta = acos(clamp(rotated.z, -1.0, 1.0));
  float r = theta / (u_sourceFov * 0.5);
  if (r > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Polar to texture-space within the unit circle.
  vec2 dirXY = rotated.xy;
  float len = length(dirXY);
  vec2 unit = (len > 1e-6) ? dirXY / len : vec2(0.0, 0.0);

  // Mono case: single circle filling the texture.
  float cx = 0.5;
  float cy_centre = 0.5;
  float circleRadiusU = 0.5;
  float circleRadiusV = 0.5;

  if (u_stereoMode == 1) {
    // SBS-half: two side-by-side circles. Each circle takes half the
    // width (u radius = 0.25) and the full height (v radius = 0.5).
    circleRadiusU = 0.25;
    cx = u_eye == 1 ? 0.75 : 0.25;
  }

  float u = cx + r * unit.x * circleRadiusU;
  // Flip V so that "up" in world space lands on the top of the texture.
  float v = cy_centre - r * unit.y * circleRadiusV;

  fragColor = texture(u_video, vec2(u, v));
}
`;
