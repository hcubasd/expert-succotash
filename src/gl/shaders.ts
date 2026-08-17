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

// Network links, as quads rather than gl.LINES. gl.lineWidth is required to
// support exactly one width -- 1.0 -- and every ANGLE-backed browser reports
// exactly that range, so any stroke thicker than a hairline has to be
// triangulated. This is the same instancing shape the agents use: one unit
// quad per link, stretched along it and extruded across it.
//
// The extrusion happens in pixel space rather than clip space. Clip space is
// not isotropic in general -- a fixed clip-space offset would be a different
// number of pixels horizontally than vertically -- so the endpoints are
// converted to pixels, offset perpendicular there, and converted back. That
// keeps a 2px road 2px wide whatever direction it runs.
export const THICK_VERT = `#version 300 es
  in vec2 a_corner;
  in vec4 a_endpoints;
  in vec3 a_color;
  uniform vec2 u_viewportPx;
  uniform float u_halfWidthPx;
  out vec3 v_color;
  ${TRANSFORM}
  void main() {
    v_color = a_color;
    // Not named "half": that is a reserved word in GLSL ES and fails to
    // compile.
    vec2 halfViewport = u_viewportPx * 0.5;
    vec2 p0 = toClip(a_endpoints.xy) * halfViewport;
    vec2 p1 = toClip(a_endpoints.zw) * halfViewport;

    vec2 delta = p1 - p0;
    float span = length(delta);
    // A zero-length link would make normalize produce NaN and take the whole
    // quad with it, so it falls back to an arbitrary direction and collapses
    // into an invisible sliver instead.
    vec2 direction = span > 1e-6 ? delta / span : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);

    vec2 pixel = mix(p0, p1, a_corner.x) + normal * (a_corner.y * u_halfWidthPx);
    gl_Position = vec4(pixel / halfViewport, 0.0, 1.0);
  }
`;

export const THICK_FRAG = `#version 300 es
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

// The quad is sized to the *outer* edge -- fill radius plus border, when
// there is one -- so a_corner covers the whole disc including its ring.
// u_innerRatio is where the fill stops and the border starts, as a fraction
// of that outer radius: 1.0 draws no border band at all (the joins' case,
// which share this shader but never get one), anything less carves a black
// ring off the edge inward.
export const POINT_FRAG = `#version 300 es
  precision highp float;
  in vec3 v_color;
  in vec2 v_corner;
  uniform float u_radiusPx;
  uniform float u_innerRatio;
  out vec4 outColor;
  void main() {
    // Round the quad off into a disc -- but only once there is enough of it
    // to round. The shader runs at the pixel centre, so the test asks
    // "is this pixel's centre inside the circle", and at a one-pixel mark
    // that is decided by where the mark happens to fall relative to the
    // pixel grid rather than by anything real: about a fifth of them land
    // in a corner and vanish outright, and the rest lose most of their
    // coverage. Below a two-pixel diameter the quad is left square, which
    // at that size is indistinguishable from a disc anyway and is the only
    // version that reliably puts ink down.
    float d2 = dot(v_corner, v_corner);
    if (u_radiusPx > 1.0 && d2 > 1.0) discard;
    outColor = d2 > u_innerRatio * u_innerRatio ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(v_color, 1.0);
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
// Triangulated the same way the network's links are, for the same reason:
// gl.lineWidth is required to support only 1.0. Thickness does not distort
// what gets resolved -- the resolve pass divides accumulated flow by
// accumulated coverage, and multisampling scales both channels of a fragment
// identically, so a wider stroke spreads the same value over more pixels
// rather than depositing more of it.
export const ACCUM_VERT = `#version 300 es
  in vec2 a_corner;
  in vec4 a_endpoints;
  in float a_quantity;
  uniform vec2 u_viewportPx;
  uniform float u_halfWidthPx;
  out float v_quantity;
  ${TRANSFORM}
  void main() {
    v_quantity = a_quantity;
    vec2 halfViewport = u_viewportPx * 0.5;
    vec2 p0 = toClip(a_endpoints.xy) * halfViewport;
    vec2 p1 = toClip(a_endpoints.zw) * halfViewport;

    vec2 delta = p1 - p0;
    float span = length(delta);
    vec2 direction = span > 1e-6 ? delta / span : vec2(1.0, 0.0);
    vec2 normal = vec2(-direction.y, direction.x);

    vec2 pixel = mix(p0, p1, a_corner.x) + normal * (a_corner.y * u_halfWidthPx);
    gl_Position = vec4(pixel / halfViewport, 0.0, 1.0);
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

// Desire-line joins: a disc at every endpoint, covering the seam where two
// flat-ended quads meet.
//
// These deposit nothing into the accumulator -- they only read it. Depositing
// would mean getting a quantity *and* a matching coverage right, and coverage
// added without matching flow drags the resolved value down rather than
// leaving it alone. Reading instead makes the join exactly the colour the
// lines meeting there already resolved to, with no way to skew the field.
//
// The sample is taken at the disc's centre, not per fragment: one texel for
// the whole disc, so it comes out a solid colour rather than fading off at
// its own rim where the lines' coverage tapers.
export const FLOW_JOINT_VERT = `#version 300 es
  in vec2 a_corner;
  in vec2 a_position;
  uniform vec2 u_pixelRadius;
  out vec2 v_corner;
  out vec2 v_center;
  ${TRANSFORM}
  void main() {
    v_corner = a_corner;
    vec2 clip = toClip(a_position);
    v_center = clip * 0.5 + 0.5;
    gl_Position = vec4(clip + a_corner * u_pixelRadius, 0.0, 1.0);
  }
`;

export const FLOW_JOINT_FRAG = `#version 300 es
  precision highp float;
  in vec2 v_corner;
  in vec2 v_center;
  uniform sampler2D u_accumulator;
  uniform sampler2D u_cdf;
  uniform sampler2D u_ramp;
  uniform float u_maxValue;
  out vec4 outColor;
  void main() {
    if (dot(v_corner, v_corner) > 1.0) discard;

    vec4 sum = texture(u_accumulator, v_center);
    float coverage = min(sum.a, 1.0);
    // Nothing accumulated here means no line actually reaches this point, so
    // there is no join to draw.
    if (coverage < 1e-4) discard;

    float value = sum.r / max(coverage, 1e-6);
    float norm = clamp(value / max(u_maxValue, 1e-6), 0.0, 1.0);
    float t = texture(u_cdf, vec2(norm, 0.5)).r;
    // Opaque: a join is a solid cap on the lines it sits between.
    outColor = vec4(texture(u_ramp, vec2(t, 0.5)).rgb, 1.0);
  }
`;
