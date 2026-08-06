// World coordinates reach clip space through one translate-then-scale, which
// is all pan and zoom ever change. Every off-screen primitive still runs the
// vertex shader, then gets clipped by the rasterizer for free -- far cheaper
// than culling on the CPU, and it's why zooming needs no data filtering.
const TRANSFORM = `
  uniform vec2 u_center;
  uniform vec2 u_scale;
  vec2 toClip(vec2 world) {
    return (world - u_center) * u_scale;
  }
`;

// Flat colored geometry: polygon fill triangles, polygon borders, network
// segments, and monochrome desire lines all share this.
export const FLAT_VERT = `#version 300 es
  in vec2 a_position;
  in vec3 a_color;
  out vec3 v_color;
  ${TRANSFORM}
  void main() {
    v_color = a_color;
    gl_Position = vec4(toClip(a_position), 0.0, 1.0);
  }
`;

export const FLAT_FRAG = `#version 300 es
  precision highp float;
  in vec3 v_color;
  out vec4 outColor;
  void main() {
    outColor = vec4(v_color, 1.0);
  }
`;

// Agents: one unit quad instanced per point, sized in pixels. Instancing
// rather than gl.POINTS because gl_PointSize has an implementation-defined
// ceiling that varies by driver; a quad has no such limit.
export const POINT_VERT = `#version 300 es
  in vec2 a_corner;
  in vec2 a_position;
  in vec3 a_color;
  uniform vec2 u_pixelRadius;
  out vec3 v_color;
  out vec2 v_corner;
  ${TRANSFORM}
  void main() {
    v_color = a_color;
    v_corner = a_corner;
    gl_Position = vec4(toClip(a_position) + a_corner * u_pixelRadius, 0.0, 1.0);
  }
`;

export const POINT_FRAG = `#version 300 es
  precision highp float;
  in vec3 v_color;
  in vec2 v_corner;
  out vec4 outColor;
  void main() {
    // Round the quad off into a disc; anything outside never becomes a
    // fragment at all, so agents need no outline geometry of their own.
    if (dot(v_corner, v_corner) > 1.0) discard;
    outColor = vec4(v_color, 1.0);
  }
`;

// Desire lines, colored: accumulate each line's hue as a unit vector plus a
// contribution count, additively, into a float target. Summing unit vectors
// and taking the angle of the sum is the circular mean -- the correct way to
// average angles, and the reason this works in hue space rather than RGB
// (averaging RGB drags mixtures toward gray).
export const HUE_VERT = `#version 300 es
  in vec2 a_position;
  in float a_hue;
  out float v_hue;
  ${TRANSFORM}
  void main() {
    v_hue = a_hue;
    gl_Position = vec4(toClip(a_position), 0.0, 1.0);
  }
`;

export const HUE_FRAG = `#version 300 es
  precision highp float;
  in float v_hue;
  out vec4 outColor;
  const float TWO_PI = 6.283185307179586;
  void main() {
    // a_hue arrives as a wheel index in [0,255]; the wheel is the unit circle
    // split 256 ways.
    float theta = (v_hue / 256.0) * TWO_PI;
    outColor = vec4(cos(theta), sin(theta), 0.0, 1.0);
  }
`;

// Resolve pass: read the accumulated sum, take its angle, and look the color
// back up on the wheel texture. A pixel touched by exactly one line recovers
// that line's own hue exactly, so unblended lines stay solid and pure; a
// pixel touched by several lands on their true circular mean.
export const RESOLVE_VERT = `#version 300 es
  in vec2 a_corner;
  out vec2 v_uv;
  void main() {
    v_uv = a_corner * 0.5 + 0.5;
    gl_Position = vec4(a_corner, 0.0, 1.0);
  }
`;

export const RESOLVE_FRAG = `#version 300 es
  precision highp float;
  in vec2 v_uv;
  uniform sampler2D u_accumulator;
  uniform sampler2D u_wheel;
  out vec4 outColor;
  const float TWO_PI = 6.283185307179586;
  void main() {
    vec4 sum = texture(u_accumulator, v_uv);
    if (sum.a < 0.5) discard;   // nothing drew here

    // Symmetrically opposed hues cancel to a zero-length sum, where a mean
    // direction genuinely doesn't exist. Rare, and gray is the honest answer.
    if (length(sum.xy) < 1e-5) {
      outColor = vec4(0.5, 0.5, 0.5, 1.0);
      return;
    }

    float theta = atan(sum.y, sum.x);
    if (theta < 0.0) theta += TWO_PI;
    float index = (theta / TWO_PI);
    outColor = vec4(texture(u_wheel, vec2(index, 0.5)).rgb, 1.0);
  }
`;
