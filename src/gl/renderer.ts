import { wheel } from '../lib/colors';
import type { RgbColor } from '../lib/colors';
import type { Geometries } from '../lib/geometryMaker';
import {
  FLAT_FRAG, FLAT_VERT,
  HUE_FRAG,
  POINT_FRAG, POINT_VERT,
  RESOLVE_FRAG, RESOLVE_VERT,
  THICK_HUE_VERT, THICK_VERT,
} from './shaders';

export type View = { centerX: number; centerY: number; scaleX: number; scaleY: number };

// All sizes here are CSS pixels, not device pixels: the canvas backing store
// is scaled up by devicePixelRatio, so a size measured against it directly
// would come out half as big on a 2x display instead of the same apparent
// size at twice the sharpness. The ratio is applied at the uniform.

// Marks compete for a fixed area. fitView always scales the whole dataset to
// the canvas, so world density divides out entirely -- two datasets with the
// same count fill the screen identically however far apart their coordinates
// are. The only thing left varying is how many marks share that area, so
// count is the complete driver at zoom 1, not a stand-in for something
// better.
//
// One decay law for every mark type -- lines and agent radii both use this,
// `initial` (the size at count 0) the only thing that differs between them.
// Naturally bounded in (1, initial] with no explicit clamp: ln grows without
// bound as count grows, so the reciprocal -- and the whole expression --
// shrinks toward 1 (never quite reaching it), which also doubles as the
// antialiasing floor: below about a pixel the quad only partially covers
// its pixels and blends toward the background, the colour dilution that
// made thin lines hard to tell apart in the first place. At count 0 the
// e^(1/(initial-1)) term is chosen so the expression evaluates to exactly
// `initial` -- lines use initial=2, which is why 1 + 1/ln(count+e) is the
// same formula with that substitution already made.
function countDecay(count: number, initial: number): number {
  return 1 + 1 / Math.log(count + Math.exp(1 / (initial - 1)));
}

// The size at count 0 -- one mark alone on an empty map, with no crowding
// to shrink it, which is also what every mark converges to as the view
// closes in. Lines: exact, given. Agents: chosen aggressively, not derived
// -- a lone agent should read as unmistakably a single point.
const LINE_INITIAL_CSS_PX = 2;
const AGENT_INITIAL_CSS_PX = 32;

// Zoom interpolates from the count-driven baseline up to `initial`, rather
// than multiplying it. The distinction matters: a multiplier running 1 ->
// initial would scale the baseline *by* initial and overshoot it by however
// far the baseline sits above 1. Approaching `initial` from below can't
// overshoot, and is exact at both ends -- the baseline at zoom 1, `initial`
// in the limit.
//
// The fraction of the remaining gap closed is 1 - 1/zoom, which has no
// count in it at all: every layer is half way there at 2x and 90% there at
// 10x, however crowded it is. Crowding sets where the walk starts, never
// how fast it travels.
export function markSize(count: number, initial: number, zoom: number): number {
  const baseline = countDecay(count, initial);
  return initial - (initial - baseline) / Math.max(zoom, 1);
}

// What a single, uncrossed desire line is worth, as a function of how far
// the view has closed in. This is the floor the layer builds up from, not a
// ceiling it is scaled down to: crossings composite above it toward opaque.
// At the fitted view the layer is a dense mat, so one line is only worth
// about 24% and pile-up is what reads; zooming in thins the crossings out
// on its own, so a line is worth more and more on its own account. Bounded
// in (0, 1) with no clamp -- ln grows without bound, so the reciprocal
// decays to 0 and this never reaches or passes 1.
export function lineOpacity(zoom: number): number {
  return 1 - 1 / Math.log(Math.max(zoom, 1) + Math.E);
}

// Zone borders trace one shape's own outline rather than competing as N
// independent marks, so neither law has any claim on them -- there is no
// "N borders fighting for attention" the way there is for lines or points,
// and no reason their width should track the view either. Left as a flat
// constant on purpose, at every count and every zoom level.
const ZONE_BORDER_CSS_PX = 1;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const program = gl.createProgram()!;
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}

type Buffers = {
  position: WebGLBuffer;
  color: WebGLBuffer;
  hue?: WebGLBuffer;
  vertexCount: number;
  // Colors are rewritten in place when the selection changes, so the arrays
  // keep their identity and can't be compared by reference. This is the
  // stamp that says whether the GPU copy is still current -- without it a
  // pan would re-upload every color buffer on every frame.
  colorVersion: number;
};

export class MapRenderer {
  private gl: WebGL2RenderingContext;
  private flat: WebGLProgram;
  private points: WebGLProgram;
  private thick: WebGLProgram;
  private thickHue: WebGLProgram;
  private resolve: WebGLProgram;
  private quad: WebGLBuffer;
  private wheelTexture: WebGLTexture;
  private accumulator: {
    // Equal to resolveFramebuffer when multisampling wasn't available.
    drawFramebuffer: WebGLFramebuffer;
    resolveFramebuffer: WebGLFramebuffer;
    renderbuffer: WebGLRenderbuffer | null;
    texture: WebGLTexture;
    width: number;
    height: number;
  } | null = null;
  private uploaded = new Map<string, Buffers>();
  private floatTargetsSupported: boolean;
  // Which luminance the wheel texture currently holds, so a repeated
  // setLuminance for the same mode (most frames) is a no-op rather than a
  // re-upload.
  private wheelLuminance: number | null = null;

  constructor(canvas: HTMLCanvasElement, luminance: number) {
    // On: lines are real geometry now, so most of a line's cross-section is
    // interior that renders at full color either way, and the softening is
    // confined to a thin strip along each edge. That also buys back the
    // smoothing on agent dots and zone fill edges, which is the same single
    // context-wide switch.
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    // Float render targets are what let the hue accumulator sum unit vectors
    // without clamping to [0,1]. Universally present on desktop GPUs; if it's
    // missing we simply fall back to drawing desire lines opaque.
    this.floatTargetsSupported = !!gl.getExtension('EXT_color_buffer_float');

    this.flat = link(gl, FLAT_VERT, FLAT_FRAG);
    this.points = link(gl, POINT_VERT, POINT_FRAG);
    // Both thick programs reuse the existing fragment shaders unchanged --
    // widening a line is entirely a vertex-stage concern.
    this.thick = link(gl, THICK_VERT, FLAT_FRAG);
    this.thickHue = link(gl, THICK_HUE_VERT, HUE_FRAG);
    this.resolve = link(gl, RESOLVE_VERT, RESOLVE_FRAG);

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.wheelTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.wheelTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // REPEAT so an angle landing just past the last vertex wraps to the first,
    // which is what a wheel should do.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setLuminance(luminance);
  }

  // The 256 wheel vertices as a lookup texture, so the resolve pass can turn
  // an averaged angle straight back into the exact palette color instead of
  // reimplementing CIELAB conversion in GLSL. The wheel's colors depend on
  // luminance (dark vs. light mode draw from different points on the gamut),
  // so this has to be callable again whenever the mode changes, not just
  // once at construction.
  setLuminance(luminance: number) {
    if (this.wheelLuminance === luminance) return;
    const gl = this.gl;
    const colors = wheel(luminance);
    const pixels = new Uint8Array(colors.length * 4);
    colors.forEach((c, i) => {
      pixels[i * 4] = c.r;
      pixels[i * 4 + 1] = c.g;
      pixels[i * 4 + 2] = c.b;
      pixels[i * 4 + 3] = 255;
    });
    gl.bindTexture(gl.TEXTURE_2D, this.wheelTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, colors.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.wheelLuminance = luminance;
  }

  private buffers(
    key: string,
    positions: Float32Array,
    colors: Uint8Array,
    colorVersion: number,
    hues?: Uint8Array,
  ): Buffers {
    const gl = this.gl;
    let entry = this.uploaded.get(key);
    if (!entry) {
      entry = {
        position: gl.createBuffer()!,
        color: gl.createBuffer()!,
        hue: hues ? gl.createBuffer()! : undefined,
        vertexCount: positions.length / 2,
        colorVersion: -1,
      };
      // Positions are uploaded once and never touched again: panning and
      // zooming are transform changes, not geometry changes.
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.position);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      this.uploaded.set(key, entry);
    }
    entry.vertexCount = positions.length / 2;

    if (entry.colorVersion !== colorVersion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.color);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
      if (hues && entry.hue) {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.hue);
        gl.bufferData(gl.ARRAY_BUFFER, hues, gl.DYNAMIC_DRAW);
      }
      entry.colorVersion = colorVersion;
    }
    return entry;
  }

  invalidate() {
    const gl = this.gl;
    for (const entry of this.uploaded.values()) {
      gl.deleteBuffer(entry.position);
      gl.deleteBuffer(entry.color);
      if (entry.hue) gl.deleteBuffer(entry.hue);
    }
    this.uploaded.clear();
  }

  private setTransform(program: WebGLProgram, view: View) {
    const gl = this.gl;
    gl.uniform2f(gl.getUniformLocation(program, 'u_center'), view.centerX, view.centerY);
    gl.uniform2f(gl.getUniformLocation(program, 'u_scale'), view.scaleX, view.scaleY);
  }

  // Binds the unit quad plus the start/end pair of each segment. The two
  // endpoints come from one buffer read at two offsets of the same stride,
  // because the segment buffer is already laid out x1,y1,x2,y2 per segment.
  private bindSegments(program: WebGLProgram, positions: WebGLBuffer, view: View, width: number, height: number) {
    const gl = this.gl;
    gl.useProgram(program);
    this.setTransform(program, view);
    gl.uniform2f(gl.getUniformLocation(program, 'u_halfViewport'), width / 2, height / 2);

    const cornerLoc = gl.getAttribLocation(program, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLoc, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, positions);
    const startLoc = gl.getAttribLocation(program, 'a_start');
    gl.enableVertexAttribArray(startLoc);
    gl.vertexAttribPointer(startLoc, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(startLoc, 1);

    const endLoc = gl.getAttribLocation(program, 'a_end');
    gl.enableVertexAttribArray(endLoc);
    gl.vertexAttribPointer(endLoc, 2, gl.FLOAT, false, 16, 8);
    gl.vertexAttribDivisor(endLoc, 1);

    return { startLoc, endLoc };
  }

  // Divisors live on the shared default VAO, so anything set to 1 has to go
  // back to 0 or the next draw inherits it.
  private clearDivisors(...locations: number[]) {
    for (const location of locations) {
      if (location >= 0) this.gl.vertexAttribDivisor(location, 0);
    }
  }

  private drawThickLines(
    key: string,
    positions: Float32Array,
    colors: Uint8Array,
    view: View,
    width: number,
    height: number,
    colorVersion: number,
    pixelRatio: number,
    widthCssPx: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;
    const entry = this.buffers(key, positions, colors, colorVersion);

    const { startLoc, endLoc } = this.bindSegments(this.thick, entry.position, view, width, height);
    gl.uniform1f(
      gl.getUniformLocation(this.thick, 'u_halfWidth'),
      (widthCssPx * pixelRatio) / 2,
    );

    const colorLoc = gl.getAttribLocation(this.thick, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.color);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, positions.length / 4);
    this.clearDivisors(startLoc, endLoc, colorLoc);
  }

  private drawFlat(
    key: string,
    positions: Float32Array,
    colors: Uint8Array,
    mode: number,
    view: View,
    colorVersion: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;
    const entry = this.buffers(key, positions, colors, colorVersion);

    gl.useProgram(this.flat);
    this.setTransform(this.flat, view);

    const positionLoc = gl.getAttribLocation(this.flat, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.position);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const colorLoc = gl.getAttribLocation(this.flat, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.color);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawArrays(mode, 0, entry.vertexCount);
  }

  private drawPoints(
    positions: Float32Array,
    colors: Uint8Array,
    view: View,
    width: number,
    height: number,
    colorVersion: number,
    pixelRatio: number,
    radiusCssPx: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;
    const entry = this.buffers('agents', positions, colors, colorVersion);

    gl.useProgram(this.points);
    this.setTransform(this.points, view);
    // Radius is in pixels, so agents don't grow with the world as the view
    // zooms. width/height are the backing store's device pixels, so the CSS
    // radius is scaled by the ratio first.
    const radius = radiusCssPx * pixelRatio;
    gl.uniform2f(
      gl.getUniformLocation(this.points, 'u_pixelRadius'),
      (radius * 2) / width,
      (radius * 2) / height,
    );

    const cornerLoc = gl.getAttribLocation(this.points, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(cornerLoc, 0);

    const positionLoc = gl.getAttribLocation(this.points, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.position);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(positionLoc, 1);

    const colorLoc = gl.getAttribLocation(this.points, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.color);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, entry.vertexCount);

    gl.vertexAttribDivisor(positionLoc, 0);
    gl.vertexAttribDivisor(colorLoc, 0);
  }

  private disposeAccumulator() {
    const gl = this.gl;
    if (!this.accumulator) return;
    gl.deleteFramebuffer(this.accumulator.resolveFramebuffer);
    gl.deleteTexture(this.accumulator.texture);
    if (this.accumulator.renderbuffer) gl.deleteRenderbuffer(this.accumulator.renderbuffer);
    if (this.accumulator.drawFramebuffer !== this.accumulator.resolveFramebuffer) {
      gl.deleteFramebuffer(this.accumulator.drawFramebuffer);
    }
    this.accumulator = null;
  }

  // Two targets, not one: `antialias: true` only ever applied to the default
  // framebuffer, so accumulating into a plain offscreen texture meant the
  // hue-blend path was the one thing on the map rendering with no
  // multisampling at all -- hard stair-stepped edges on every colored desire
  // line. Lines now accumulate into a multisampled renderbuffer and get
  // blitted down into the texture the resolve pass samples.
  private ensureAccumulator(width: number, height: number) {
    const gl = this.gl;
    if (this.accumulator && this.accumulator.width === width && this.accumulator.height === height) {
      return this.accumulator;
    }
    this.disposeAccumulator();

    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const resolveFramebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolveFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    // RGBA16F is only color-renderable via EXT_color_buffer_float, and
    // multisampled storage in that format is a step further again, so this
    // checks completeness rather than assuming: a driver that refuses it
    // falls back to accumulating straight into the texture -- aliased, but
    // exactly what the old code did, so never worse.
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    let renderbuffer: WebGLRenderbuffer | null = null;
    let drawFramebuffer = resolveFramebuffer;

    if (samples > 1) {
      renderbuffer = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, width, height);
      const multisampled = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, multisampled);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        drawFramebuffer = multisampled;
      } else {
        gl.deleteFramebuffer(multisampled);
        gl.deleteRenderbuffer(renderbuffer);
        renderbuffer = null;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.accumulator = { drawFramebuffer, resolveFramebuffer, renderbuffer, texture, width, height };
    return this.accumulator;
  }

  // Desire lines in hue-averaging mode: sum unit vectors into an offscreen
  // float target, then resolve to real colors in one full-screen pass. Two
  // passes rather than plain blending because ordinary alpha blending would
  // either dilute a lone line against the scene beneath it or let whichever
  // line drew last simply win -- neither of which is an average.
  private drawBlendedLines(
    positions: Float32Array,
    hues: Uint8Array,
    colors: Uint8Array,
    view: View,
    width: number,
    height: number,
    colorVersion: number,
    pixelRatio: number,
    widthCssPx: number,
    zoom: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;
    // A key of its own: this path needs a hue buffer alongside the position
    // buffer, and buffer sets are created once per key on first use.
    const entry = this.buffers('desireLinesBlend', positions, colors, colorVersion, hues);
    const target = this.ensureAccumulator(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.drawFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    const { startLoc, endLoc } = this.bindSegments(this.thickHue, entry.position, view, width, height);
    gl.uniform1f(
      gl.getUniformLocation(this.thickHue, 'u_halfWidth'),
      (widthCssPx * pixelRatio) / 2,
    );

    const hueLoc = gl.getAttribLocation(this.thickHue, 'a_hue');
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.hue!);
    gl.enableVertexAttribArray(hueLoc);
    gl.vertexAttribPointer(hueLoc, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.vertexAttribDivisor(hueLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, positions.length / 4);
    this.clearDivisors(startLoc, endLoc, hueLoc);
    gl.disable(gl.BLEND);

    // Average the samples down into the texture the resolve pass reads.
    // Averaging a summed hue vector against uncovered zeroes scales its
    // magnitude but leaves its angle alone, and the resolve only reads the
    // angle -- so the circular mean survives multisampling untouched.
    if (target.drawFramebuffer !== target.resolveFramebuffer) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.drawFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolveFramebuffer);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    // The resolve now emits partial coverage as alpha, so it has to blend
    // against the scene underneath -- drawing it opaque would put every
    // edge pixel back to fully hard and waste the multisampling entirely.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_accumulator'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.wheelTexture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_wheel'), 1);
    gl.uniform1f(gl.getUniformLocation(this.resolve, 'u_opacity'), lineOpacity(zoom));

    const cornerLoc = gl.getAttribLocation(this.resolve, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
  }

  render(
    geometries: Geometries,
    view: View,
    paper: RgbColor,
    lineLayer: 'network' | 'desireLines' | null,
    blendDesireLines: boolean,
    colorVersion: number,
    pixelRatio: number,
    // 1 at the fitted view, 2 when the view has closed in twice as far.
    zoom: number,
  ) {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(paper.r / 255, paper.g / 255, paper.b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    // Fixed stacking: zones behind, one line layer over them, agents on top.
    // Only the polygon fill is still plain triangles -- everything linear
    // goes through the instanced quad path.
    if (geometries.zones) {
      this.drawFlat('zoneFill', geometries.zones.fillPositions, geometries.zones.fillColors, gl.TRIANGLES, view, colorVersion);
      this.drawThickLines(
        'zoneBorder', geometries.zones.borderPositions, geometries.zones.borderColors,
        view, width, height, colorVersion, pixelRatio, ZONE_BORDER_CSS_PX,
      );
    }

    // Counts are of drawn primitives -- segments, not rows -- since that's
    // what actually shares the screen.
    if (lineLayer === 'network' && geometries.network) {
      const network = geometries.network;
      this.drawThickLines(
        'network', network.positions, network.colors, view, width, height, colorVersion, pixelRatio,
        markSize(network.positions.length / 4, LINE_INITIAL_CSS_PX, zoom),
      );
    } else if (lineLayer === 'desireLines' && geometries.desireLines) {
      const lines = geometries.desireLines;
      const lineWidth = markSize(lines.positions.length / 4, LINE_INITIAL_CSS_PX, zoom);
      if (blendDesireLines && this.floatTargetsSupported) {
        this.drawBlendedLines(
          lines.positions, lines.hues, lines.colors, view, width, height, colorVersion, pixelRatio,
          lineWidth, zoom,
        );
      } else {
        this.drawThickLines(
          'desireLines', lines.positions, lines.colors, view, width, height, colorVersion, pixelRatio, lineWidth,
        );
      }
    }

    if (geometries.agents) {
      const agents = geometries.agents;
      this.drawPoints(
        agents.positions, agents.colors, view, width, height, colorVersion, pixelRatio,
        markSize(agents.positions.length / 2, AGENT_INITIAL_CSS_PX, zoom),
      );
    }
  }

  dispose() {
    const gl = this.gl;
    this.invalidate();
    gl.deleteBuffer(this.quad);
    gl.deleteTexture(this.wheelTexture);
    this.disposeAccumulator();
    gl.deleteProgram(this.flat);
    gl.deleteProgram(this.points);
    gl.deleteProgram(this.thick);
    gl.deleteProgram(this.thickHue);
    gl.deleteProgram(this.resolve);
  }
}
