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

// Expands one segment into a quad of a given pixel width. gl.LINES can only
// portably draw 1px -- gl.lineWidth is allowed to clamp anything else, and
// ANGLE does -- so any real width has to be geometry.
//
// The offset is computed in pixel space, not clip space: clip space is
// anisotropic whenever the viewport isn't square, so offsetting there would
// make a line's thickness depend on its direction. Converting to pixels,
// offsetting, and converting back keeps every line the same width at every
// angle and every zoom level.
//
// Segments arrive already decomposed and independent (see makeSegments), so
// there are no joins to miter -- the hard part of thick-line rendering
// simply isn't in scope here. Caps are butt caps, so a polyline's bend can
// show a small notch; sub-pixel at these widths, and desire lines are
// single segments that can't bend at all.
const EXPAND = `
  uniform vec2 u_halfViewport;
  uniform float u_halfWidth;
  vec2 expand(vec2 start, vec2 end, vec2 corner) {
    vec2 pxStart = toClip(start) * u_halfViewport;
    vec2 pxEnd = toClip(end) * u_halfViewport;
    vec2 delta = pxEnd - pxStart;
    float len = length(delta);
    // A zero-length segment has no direction to be perpendicular to; it
    // collapses to nothing either way, so the fallback just avoids the NaN.
    vec2 dir = len > 0.0 ? delta / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    vec2 px = mix(pxStart, pxEnd, corner.x * 0.5 + 0.5) + normal * (corner.y * u_halfWidth);
    return px / u_halfViewport;
  }
`;

// One instance per segment, sharing the same unit quad the agents use.
export const THICK_VERT = `#version 300 es
  in vec2 a_corner;
  in vec2 a_start;
  in vec2 a_end;
  in vec3 a_color;
  out vec3 v_color;
  ${TRANSFORM}
  ${EXPAND}
  void main() {
    v_color = a_color;
    gl_Position = vec4(expand(a_start, a_end, a_corner), 0.0, 1.0);
  }
`;

// Desire lines, colored: accumulate each line's hue as a unit vector,
// additively, into a float target. Summing unit vectors and taking the angle
// of the sum is the circular mean -- the correct way to average angles, and
// the reason this works in hue space rather than RGB (averaging RGB drags
// mixtures toward gray). Same quad expansion as THICK_VERT: widening one
// without the other would leave blended desire lines hairline while
// everything else thickened.
export const THICK_HUE_VERT = `#version 300 es
  in vec2 a_corner;
  in vec2 a_start;
  in vec2 a_end;
  in float a_hue;
  out float v_hue;
  ${TRANSFORM}
  ${EXPAND}
  void main() {
    v_hue = a_hue;
    gl_Position = vec4(expand(a_start, a_end, a_corner), 0.0, 1.0);
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
// that line's own hue exactly; a pixel touched by several lands on their
// true circular mean. Hue and opacity come from different halves of the same
// buffer and never interfere: the mean angle out of sum.xy, the pile-up
// depth out of sum.a.
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
  // What a single, uncrossed line is worth. Zoom-driven: lowest at the
  // fitted view where the layer is a dense mat, rising as the view closes
  // in and crossings thin out. See lineOpacity in the renderer.
  uniform float u_opacity;
  out vec4 outColor;
  const float TWO_PI = 6.283185307179586;
  const float E_MINUS_1 = 1.718281828459045;
  void main() {
    vec4 sum = texture(u_accumulator, v_uv);
    // Alpha accumulated 1.0 per line per covered sample, then averaged by
    // the multisample resolve -- so it carries coverage as well as overlap
    // count. The threshold only has to separate "no sample was covered"
    // from "some were"; anything higher would clip the partially covered
    // edge pixels that are the whole point of multisampling.
    if (sum.a < 1e-4) discard;

    // Opacity from how many lines stacked here, not just whether any did.
    // Taking min(sum.a, 1) instead would throw the count away -- one line
    // and fifty would look identical -- and it is exactly the same-hue
    // crossings that go invisible under that, since the circular mean of
    // several identical angles is just that angle again.
    //
    // Two regimes over the same number, because sum.a carries multisample
    // coverage below 1 and pile-up depth above it.
    //
    // Below 1 a single line is only partly covering the pixel, so edge
    // ramps the floor in linearly and pile is still clamped off -- that
    // is the antialiasing, kept exactly proportional.
    //
    // At and above 1, pile walks from the floor up toward fully opaque,
    // logarithmically: the same 1 - 1/ln(x + shift) shape used for zoom and
    // for mark sizing, shifted by e-1 so it is exactly 0 at one line. That
    // makes the floor exact with no constant to tune, and keeps the climb
    // gentle -- alpha compositing (1 - (1-p)^n) reaches 81% by six lines,
    // this reaches 63%, so the busy middle of the range stays readable
    // instead of saturating almost immediately.
    float edge = min(sum.a, 1.0);
    float pile = max(0.0, 1.0 - 1.0 / log(sum.a + E_MINUS_1));
    float coverage = edge * u_opacity + (1.0 - u_opacity) * pile;

    // Symmetrically opposed hues cancel to a zero-length sum, where a mean
    // direction genuinely doesn't exist. Rare, and gray is the honest answer.
    if (length(sum.xy) < 1e-5) {
      outColor = vec4(0.5, 0.5, 0.5, coverage);
      return;
    }

    float theta = atan(sum.y, sum.x);
    if (theta < 0.0) theta += TWO_PI;
    float index = (theta / TWO_PI);
    outColor = vec4(texture(u_wheel, vec2(index, 0.5)).rgb, coverage);
  }
`;
