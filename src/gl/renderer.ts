import type { RgbColor } from '../lib/colors';
import { binnedCdf } from '../lib/equalize';
import type { PolygonGeometry, SegmentGeometry } from '../lib/geometryMaker';
import {
  ACCUM_FRAG, ACCUM_VERT,
  FLAT_FRAG, FLAT_VERT,
  POINT_FRAG, POINT_VERT,
  RESOLVE_FRAG, RESOLVE_VERT,
} from './shaders';

export type View = { centerX: number; centerY: number; scaleX: number; scaleY: number };

// Everything the map can show at once. Only one of network / desireLines /
// agents is ever set -- the mode decides -- but zones can accompany any of
// them, hollow, as the basemap.
export type Scene = {
  view: View;
  pixelRatio: number;
  // fillColors null means hollow: only the (always black, always 1px)
  // borders are drawn, and the white background shows through.
  zones: { geometry: PolygonGeometry; fillColors: Uint8Array | null } | null;
  network: { geometry: SegmentGeometry; colors: Uint8Array } | null;
  agents: { positions: Float32Array; colors: Uint8Array; radiusCssPx: number } | null;
  desireLines: { positions: Float32Array; quantities: Float32Array; ramp: RgbColor[] } | null;
};

// What the desire-line pass measured off this exact frame. The legend needs
// it to label its ticks, and it can only be known after accumulating, so it
// comes back out of the draw rather than being computed alongside it.
export type FlowStats = { max: number; cdf: Float32Array };

const CDF_BINS = 256;

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

// readPixels on an RGBA16F attachment hands back half floats, which JS has no
// native type for. Accumulated flow stays far below half float's 65504
// ceiling for any dataset seen so far (a whole country peaked in the low
// hundreds), so the range is not the concern -- this only has to undo the
// encoding.
function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

type Cached = { buffer: WebGLBuffer; source: ArrayBufferView | null };

export class MapRenderer {
  private gl: WebGL2RenderingContext;
  private flat: WebGLProgram;
  private points: WebGLProgram;
  private accum: WebGLProgram;
  private resolve: WebGLProgram;
  private quad: WebGLBuffer;
  private cdfTexture: WebGLTexture;
  private rampTexture: WebGLTexture;
  private accumulator: {
    drawFramebuffer: WebGLFramebuffer;
    resolveFramebuffer: WebGLFramebuffer;
    renderbuffer: WebGLRenderbuffer | null;
    texture: WebGLTexture;
    width: number;
    height: number;
  } | null = null;
  private buffers = new Map<string, Cached>();
  private floatTargetsSupported: boolean;
  private readback: Uint16Array | null = null;

  constructor(canvas: HTMLCanvasElement) {
    // Antialiasing on: every line is 1px now, so almost all of a line is
    // edge, and multisampling is what keeps those edges from stair-stepping.
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    // Float render targets are what let the accumulator sum flow past 1
    // without clamping. Without them desire lines simply can't be drawn.
    this.floatTargetsSupported = !!gl.getExtension('EXT_color_buffer_float');

    this.flat = link(gl, FLAT_VERT, FLAT_FRAG);
    this.points = link(gl, POINT_VERT, POINT_FRAG);
    this.accum = link(gl, ACCUM_VERT, ACCUM_FRAG);
    this.resolve = link(gl, RESOLVE_VERT, RESOLVE_FRAG);

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.cdfTexture = this.makeLookup(gl.R32F, CDF_BINS);
    this.rampTexture = this.makeLookup(gl.RGBA8, 128);
  }

  get supportsFlow(): boolean {
    return this.floatTargetsSupported;
  }

  private makeLookup(internalFormat: number, width: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // NEAREST throughout: the ramp holds exactly the palette's own colors and
    // interpolating between them would invent colors that aren't on the
    // wheel.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, 1);
    return texture;
  }

  // Uploads only when the array identity changed. Positions never change once
  // a file is loaded, so this keeps zooming to a transform update.
  private upload(key: string, data: ArrayBufferView, usage: number): WebGLBuffer {
    const gl = this.gl;
    let entry = this.buffers.get(key);
    if (!entry) {
      entry = { buffer: gl.createBuffer()!, source: null };
      this.buffers.set(key, entry);
    }
    if (entry.source !== data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      entry.source = data;
    }
    return entry.buffer;
  }

  invalidate() {
    const gl = this.gl;
    for (const entry of this.buffers.values()) gl.deleteBuffer(entry.buffer);
    this.buffers.clear();
  }

  private setTransform(program: WebGLProgram, view: View) {
    const gl = this.gl;
    gl.uniform2f(gl.getUniformLocation(program, 'u_center'), view.centerX, view.centerY);
    gl.uniform2f(gl.getUniformLocation(program, 'u_scale'), view.scaleX, view.scaleY);
  }

  private drawFlat(key: string, positions: Float32Array, colors: Uint8Array, mode: number, view: View) {
    if (positions.length === 0) return;
    const gl = this.gl;

    gl.useProgram(this.flat);
    this.setTransform(this.flat, view);

    const positionLoc = gl.getAttribLocation(this.flat, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:pos`, positions, gl.STATIC_DRAW));
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const colorLoc = gl.getAttribLocation(this.flat, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload(`${key}:col`, colors, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawArrays(mode, 0, positions.length / 2);
  }

  private drawAgents(
    positions: Float32Array,
    colors: Uint8Array,
    radiusCssPx: number,
    view: View,
    width: number,
    height: number,
    pixelRatio: number,
  ) {
    if (positions.length === 0) return;
    const gl = this.gl;

    gl.useProgram(this.points);
    this.setTransform(this.points, view);
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload('agents:pos', positions, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(positionLoc, 1);

    const colorLoc = gl.getAttribLocation(this.points, 'a_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload('agents:col', colors, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(colorLoc, 1);

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, positions.length / 2);

    // Divisors live on the shared default VAO, so anything set to 1 has to
    // go back to 0 or the next draw inherits it.
    gl.vertexAttribDivisor(positionLoc, 0);
    gl.vertexAttribDivisor(colorLoc, 0);
  }

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

    // `antialias: true` only ever applied to the default framebuffer, so
    // without an explicitly multisampled target the accumulation pass would
    // be the one thing on the map with no antialiasing at all. Multisampled
    // RGBA16F is a step beyond plain float-renderability, so this checks
    // completeness rather than assuming, and falls back to accumulating
    // straight into the texture if a driver refuses.
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
    this.readback = new Uint16Array(width * height * 4);
    return this.accumulator;
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
    this.readback = null;
  }

  // Accumulate, measure, resolve. The measure step is a real GPU->CPU stall,
  // paid once per zoom or selection change rather than per frame -- there is
  // no continuous interaction left in the map for it to interrupt.
  private drawFlow(
    layer: NonNullable<Scene['desireLines']>,
    view: View,
    width: number,
    height: number,
  ): FlowStats | null {
    const gl = this.gl;
    if (!this.floatTargetsSupported || layer.positions.length === 0) return null;

    const target = this.ensureAccumulator(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.drawFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.accum);
    this.setTransform(this.accum, view);

    const positionLoc = gl.getAttribLocation(this.accum, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload('flow:pos', layer.positions, gl.STATIC_DRAW));
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    // One quantity per edge, but gl.LINES advances attributes per vertex, so
    // each edge's value is duplicated across its two endpoints.
    const perVertex = new Float32Array(layer.quantities.length * 2);
    for (let edge = 0; edge < layer.quantities.length; edge++) {
      perVertex[edge * 2] = layer.quantities[edge];
      perVertex[edge * 2 + 1] = layer.quantities[edge];
    }
    const quantityLoc = gl.getAttribLocation(this.accum, 'a_quantity');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.upload('flow:qty', perVertex, gl.DYNAMIC_DRAW));
    gl.enableVertexAttribArray(quantityLoc);
    gl.vertexAttribPointer(quantityLoc, 1, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.LINES, 0, layer.positions.length / 2);
    gl.disable(gl.BLEND);

    if (target.drawFramebuffer !== target.resolveFramebuffer) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.drawFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.resolveFramebuffer);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    // Measure: the same coverage correction the resolve shader applies, so
    // the histogram is built over exactly the values that will be colored.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.resolveFramebuffer);
    const raw = this.readback!;
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.HALF_FLOAT, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const pixels = width * height;
    const values = new Float32Array(pixels);
    let max = 0;
    for (let i = 0; i < pixels; i++) {
      const coverage = Math.min(halfToFloat(raw[i * 4 + 3]), 1);
      if (!(coverage > 1e-4)) continue;
      const value = halfToFloat(raw[i * 4]) / coverage;
      values[i] = value;
      if (value > max) max = value;
    }
    const cdf = binnedCdf(values, max, CDF_BINS);

    gl.bindTexture(gl.TEXTURE_2D, this.cdfTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CDF_BINS, 1, gl.RED, gl.FLOAT, cdf);

    const rampPixels = new Uint8Array(128 * 4);
    layer.ramp.forEach((c, i) => {
      rampPixels[i * 4] = c.r;
      rampPixels[i * 4 + 1] = c.g;
      rampPixels[i * 4 + 2] = c.b;
      rampPixels[i * 4 + 3] = 255;
    });
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RGBA, gl.UNSIGNED_BYTE, rampPixels);

    // Resolve onto the scene, blended so partially covered edges soften into
    // what's beneath instead of punching a hard silhouette.
    gl.viewport(0, 0, width, height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.resolve);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_accumulator'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.cdfTexture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_cdf'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.uniform1i(gl.getUniformLocation(this.resolve, 'u_ramp'), 2);
    gl.uniform1f(gl.getUniformLocation(this.resolve, 'u_maxValue'), max);

    const cornerLoc = gl.getAttribLocation(this.resolve, 'a_corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);

    return { max, cdf };
  }

  render(scene: Scene): FlowStats | null {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    // Always white. There is one mode now, and this is its paper.
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    if (scene.zones) {
      const { geometry, fillColors } = scene.zones;
      if (fillColors) {
        this.drawFlat('zoneFill', geometry.fillPositions, fillColors, gl.TRIANGLES, scene.view);
      }
      // borderColors is left zeroed, which is black -- the one colour zone
      // outlines ever take.
      this.drawFlat('zoneBorder', geometry.borderPositions, geometry.borderColors, gl.LINES, scene.view);
    }

    if (scene.network) {
      this.drawFlat('network', scene.network.geometry.positions, scene.network.colors, gl.LINES, scene.view);
    }

    let stats: FlowStats | null = null;
    if (scene.desireLines) {
      stats = this.drawFlow(scene.desireLines, scene.view, width, height);
    }

    if (scene.agents) {
      this.drawAgents(
        scene.agents.positions,
        scene.agents.colors,
        scene.agents.radiusCssPx,
        scene.view,
        width,
        height,
        scene.pixelRatio,
      );
    }

    return stats;
  }

  dispose() {
    const gl = this.gl;
    this.invalidate();
    gl.deleteBuffer(this.quad);
    gl.deleteTexture(this.cdfTexture);
    gl.deleteTexture(this.rampTexture);
    this.disposeAccumulator();
    gl.deleteProgram(this.flat);
    gl.deleteProgram(this.points);
    gl.deleteProgram(this.accum);
    gl.deleteProgram(this.resolve);
  }
}
