// World coordinates reach clip space through one translate-then-scale, which
// is all zooming ever changes. Every off-screen primitive still runs the
// vertex shader, then gets clipped by the rasterizer for free -- far cheaper
// than culling on the CPU, and it's why zooming needs no data filtering.
const TRANSFORM = `
  uniform vec2 u_center;
  uniform vec2 u_scale;
  vec2 toClip(vec2 world) {
    return (world - u_center) * u_scale;
  }
`;

// Flat colored geometry: zone fill triangles, zone borders, and network
// links all share this. Every line in the app is now a plain gl.LINES at the
// spec-guaranteed width of 1 -- the only width gl.lineWidth is required to
// support, and the width the accumulation model actually prefers, since a
// thicker stroke manufactures crossings between lines that merely pass near
// each other.
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

// Agents: one unit quad instanced per point, at a single radius shared by
// every agent on screen. Instancing rather than gl.POINTS because
// gl_PointSize has an implementation-defined ceiling that varies by driver.
//
// The radius is uniform because the agents drawn have already been thinned
// so that none of them overlap -- sizing each one to its own neighbour
// instead would make identical data render at a dozen different sizes for no
// reason a reader could recover.
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

// Desire lines, pass one: every edge deposits its own flow into every pixel
// it touches, additively. Where lines cross, the flows add -- which is the
// whole point, and is why this has to be its own pass into its own buffer:
// a pixel's colour isn't knowable until every line has been drawn, so
// nothing can be resolved while drawing.
//
// Additive blending is order-independent, so there is no sorting, no
// z-order, and no "whichever line drew last wins" -- the classic failure of
// drawing many overlapping translucent lines straight to the screen.
export const ACCUM_VERT = `#version 300 es
  in vec2 a_position;
  in float a_quantity;
  out float v_quantity;
  ${TRANSFORM}
  void main() {
    v_quantity = a_quantity;
    gl_Position = vec4(toClip(a_position), 0.0, 1.0);
  }
`;

// Flow in red, a coverage count in alpha. Alpha is what separates "half a
// pixel covered by one line" from "a pixel covered by two", which the summed
// flow alone cannot distinguish.
export const ACCUM_FRAG = `#version 300 es
  precision highp float;
  in float v_quantity;
  out vec4 outColor;
  void main() {
    outColor = vec4(v_quantity, 0.0, 0.0, 1.0);
  }
`;

// Desire lines, pass two: turn each pixel's accumulated flow into a colour.
//
// Two lookups rather than arithmetic. u_cdf holds the equalized distribution
// -- built on the CPU from this exact frame's accumulator -- so sampling it
// converts a flow into its percentile among the flows actually on screen.
// u_ramp is the resource's own 128 colours. Equalizing is what stops a
// skewed distribution (most of any scene lightly crossed, a thin tail
// heavily so) from collapsing into a single colour.
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
  uniform sampler2D u_cdf;
  uniform sampler2D u_ramp;
  uniform float u_maxValue;
  out vec4 outColor;
  void main() {
    vec4 sum = texture(u_accumulator, v_uv);

    // Coverage past 1 just means several lines stacked here, which is still
    // only one pixel's worth of ink; below 1 it is a partially covered edge,
    // and handing that back as alpha is what preserves the multisampling.
    float coverage = min(sum.a, 1.0);
    if (coverage < 1e-4) discard;

    // Dividing by coverage recovers what the flow would have been had the
    // pixel been fully covered, so an antialiased edge keeps its line's
    // colour and only loses opacity -- without this an edge pixel would be
    // both fainter and the wrong hue.
    float value = sum.r / max(coverage, 1e-6);

    float norm = clamp(value / max(u_maxValue, 1e-6), 0.0, 1.0);
    float t = texture(u_cdf, vec2(norm, 0.5)).r;
    outColor = vec4(texture(u_ramp, vec2(t, 0.5)).rgb, coverage);
  }
`;
